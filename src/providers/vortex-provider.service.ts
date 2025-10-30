import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketDataProvider, TickerLike } from './market-data.provider';
import axios, { AxiosInstance } from 'axios';
import * as WebSocket from 'ws';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { VortexSession } from '../entities/vortex-session.entity';
import { Instrument } from '../entities/instrument.entity';

// Minimal safe no-op ticker used when Vortex streaming is not configured
class NoopTicker {
  private readonly logger: Logger;
  private handlers: Record<string, Function[]> = {};
  constructor(logger: Logger) {
    this.logger = logger;
  }
  on(event: string, handler: Function) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
  }
  connect() {
    this.logger.warn(
      '[Vortex] NoopTicker.connect called (stream not configured)',
    );
  }
  disconnect() {
    this.logger.warn('[Vortex] NoopTicker.disconnect called');
  }
  subscribe(_tokens: number[]) {
    this.logger.warn('[Vortex] NoopTicker.subscribe called');
  }
  unsubscribe(_tokens: number[]) {
    this.logger.warn('[Vortex] NoopTicker.unsubscribe called');
  }
  setMode(_mode: string, _tokens: number[]) {
    this.logger.warn('[Vortex] NoopTicker.setMode called');
  }
}

@Injectable()
export class VortexProviderService implements OnModuleInit, MarketDataProvider {
  private readonly logger = new Logger(VortexProviderService.name);
  private ticker: TickerLike;
  private initialized = false;
  private http: AxiosInstance | null = null;
  private accessToken: string | null = null;
  private wsConnected = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 8;
  private readonly maxSubscriptionsPerSocket = 1000;

  constructor(
    private configService: ConfigService,
    @InjectRepository(VortexSession)
    private vortexSessionRepo: Repository<VortexSession>,
    @InjectRepository(Instrument)
    private instrumentRepo: Repository<Instrument>,
  ) {}

  async onModuleInit() {
    await this.initialize();
    // Auto-load saved access token on startup
    await this.loadSavedToken();
  }

  async initialize(): Promise<void> {
    try {
      // For now, we do not fail if creds are missing; the provider stays in degraded mode
      const apiKey = this.configService.get('VORTEX_API_KEY');
      const baseUrl = this.configService.get('VORTEX_BASE_URL');
      if (!apiKey || !baseUrl) {
        this.logger.warn(
          '[Vortex] API key or base URL not configured. REST methods will return empty.',
        );
      } else {
        this.http = axios.create({
          baseURL: baseUrl,
          timeout: 10000,
          headers: { 'x-api-key': apiKey },
        });
        this.logger.log('[Vortex] HTTP client initialized');
      }
      this.initialized = true;
    } catch (error) {
      this.logger.error('[Vortex] initialize failed (non-fatal)', error as any);
      this.initialized = false; // but keep provider usable with stubs
    }
  }

  async getInstruments(
    exchange?: string,
    opts?: { csvUrl?: string },
  ): Promise<any[]> {
    try {
      const csvUrl =
        opts?.csvUrl || this.configService.get('VORTEX_INSTRUMENTS_CSV_URL');
      if (!csvUrl) {
        this.logger.warn(
          '[Vortex] CSV URL not configured for instruments. Returning empty list.',
        );
        return [];
      }
      // Download with basic retry/backoff
      let attempt = 0;
      let res: Response | null = null;
      let lastErr: any = null;
      while (attempt < 3) {
        try {
          // Lazy import to avoid hard dependency if unused
          res = await fetch(csvUrl, {
            headers: { 'Accept-Encoding': 'gzip, deflate' } as any,
          });
          if (res.ok) break;
          lastErr = new Error('HTTP ' + res.status);
        } catch (e) {
          lastErr = e;
        }
        const delay = 500 * Math.pow(2, attempt++);
        await new Promise((r) => setTimeout(r, delay));
      }
      if (!res || !res.ok) {
        this.logger.warn(
          `[Vortex] Failed to download CSV from ${csvUrl}: ${lastErr?.message || 'unknown'}`,
        );
        return [];
      }
      if (!res.ok) {
        this.logger.warn(
          `[Vortex] Failed to download CSV from ${csvUrl}: ${res.status}`,
        );
        return [];
      }
      const text = await res.text();
      const rows = this.parseCsv(text);
      const items: any[] = [];
      for (const row of rows) {
        // Map Vortex CSV fields according to API documentation
        const token = Number(row['token']);
        if (!Number.isFinite(token)) {
          this.logger.debug(
            `[Vortex] Skipping row with invalid token: ${row['token']}`,
          );
          continue;
        }

        // Parse strike price - handle both string and number formats
        let strike_price = 0;
        if (row['strike_price']) {
          strike_price = Number(row['strike_price']);
          if (!Number.isFinite(strike_price)) {
            this.logger.debug(
              `[Vortex] Invalid strike_price for token ${token}: ${row['strike_price']}`,
            );
            strike_price = 0;
          }
        }

        // Parse tick size - handle both string and number formats
        let tick = 0.05;
        if (row['tick']) {
          tick = Number(row['tick']);
          if (!Number.isFinite(tick) || tick <= 0) {
            this.logger.debug(
              `[Vortex] Invalid tick for token ${token}: ${row['tick']}, using default 0.05`,
            );
            tick = 0.05;
          }
        }

        // Parse lot size - handle both string and number formats
        let lot_size = 1;
        if (row['lot_size']) {
          lot_size = Number(row['lot_size']);
          if (!Number.isFinite(lot_size) || lot_size <= 0) {
            this.logger.debug(
              `[Vortex] Invalid lot_size for token ${token}: ${row['lot_size']}, using default 1`,
            );
            lot_size = 1;
          }
        }

        const instrument = {
          token,
          exchange: row['exchange'] || exchange || 'NSE_EQ',
          symbol: row['symbol'] || '',
          instrument_name: row['instrument_name'] || '',
          expiry_date: row['expiry_date'] || null,
          option_type: row['option_type'] || null,
          strike_price,
          tick,
          lot_size,
        };

        // Log first few instruments for debugging
        if (items.length < 5) {
          this.logger.debug(
            `[Vortex] Parsed instrument ${items.length + 1}:`,
            instrument,
          );
        }

        items.push(instrument);
      }
      this.logger.log(`[Vortex] Parsed ${items.length} instruments from CSV`);
      return items;
    } catch (error) {
      this.logger.error(
        '[Vortex] Failed to fetch/parse instruments CSV',
        error as any,
      );
      return [];
    }
  }

  async getQuote(tokens: string[]): Promise<Record<string, any>> {
    try {
      await this.ensureTokenLoaded();
      if (!this.http) {
        this.logger.warn(
          '[Vortex] getQuote called without credentials. Returning empty result.',
        );
        return {};
      }
      // Rate limit per Vortex docs (1 req/sec per endpoint)
      await this.rateLimit('quotes');
      // Build query q=exchange-token pairs using DB-backed exchange mapping
      const exMap = await this.getExchangesForTokens(tokens);
      const qParams = tokens
        .map((t) => {
          const ex = exMap.get(t) || 'NSE_EQ';
          return `q=${encodeURIComponent(`${ex}-${t}`)}`;
        })
        .join('&');
      const mode = 'full';
      const url = `/data/quotes?${qParams}&mode=${mode}`;
      this.logger.debug(
        `[Vortex] getQuote request: tokens=${tokens.length}, url=${url}`,
      );
      const resp = await this.http.get(url, { headers: this.authHeaders() });
      const data = resp?.data?.data || {};
      const out: Record<string, any> = {};
      for (const [exToken, quote] of Object.entries<any>(data)) {
        const tokenPart = exToken.split('-').pop();
        if (!tokenPart) continue;
        out[tokenPart] = this.normalizeQuote(quote);
      }
      // Enrichment: ensure last_price is present by fetching LTP for missing tokens in one shot
      const missingLtp = Object.entries(out)
        .filter(
          ([, v]) =>
            !Number.isFinite(v?.last_price) || (v?.last_price ?? 0) <= 0,
        )
        .map(([k]) => k);
      if (missingLtp.length) {
        this.logger.warn(
          `[Vortex] getQuote missing LTP for ${missingLtp.length}/${tokens.length} tokens → fetching LTP fallback`,
        );
        try {
          const ltpMap = await this.getLTP(missingLtp);
          for (const tok of missingLtp) {
            const lv = ltpMap?.[tok]?.last_price;
            if (Number.isFinite(lv) && lv > 0) {
              out[tok] = { ...(out[tok] || {}), last_price: lv };
            }
          }
        } catch (e) {
          this.logger.warn(
            '[Vortex] LTP fallback during getQuote failed',
            e as any,
          );
        }
      }
      this.logger.debug(
        `[Vortex] getQuote result coverage: total=${tokens.length}, withLTP=${Object.values(out).filter((v) => Number.isFinite((v as any)?.last_price) && (v as any).last_price > 0).length}`,
      );
      return out;
    } catch (error) {
      this.logger.error('[Vortex] getQuote failed (non-fatal)', error as any);
      return {};
    }
  }

  async getLTP(tokens: string[]): Promise<Record<string, any>> {
    try {
      await this.ensureTokenLoaded();
      if (!this.http) {
        this.logger.warn(
          '[Vortex] getLTP called without credentials. Returning empty result.',
        );
        return {};
      }
      await this.rateLimit('ltp');
      const exMap = await this.getExchangesForTokens(tokens);
      const qParams = tokens
        .map((t) => {
          const ex = exMap.get(t) || 'NSE_EQ';
          return `q=${encodeURIComponent(`${ex}-${t}`)}`;
        })
        .join('&');
      const mode = 'ltp';
      const url = `/data/quotes?${qParams}&mode=${mode}`;
      this.logger.debug(
        `[Vortex] getLTP request: tokens=${tokens.length}, url=${url}`,
      );
      const resp = await this.http.get(url, { headers: this.authHeaders() });
      const data = resp?.data?.data || {};
      const out: Record<string, any> = {};
      for (const [exToken, quote] of Object.entries<any>(data)) {
        const tokenPart = exToken.split('-').pop();
        if (!tokenPart) continue;
        const raw = Number(quote?.last_trade_price);
        out[tokenPart] = {
          last_price: Number.isFinite(raw) && raw > 0 ? raw : null,
        };
      }
      this.logger.debug(
        `[Vortex] getLTP result coverage: total=${tokens.length}, withLTP=${Object.values(out).filter((v) => Number.isFinite((v as any)?.last_price) && (v as any).last_price > 0).length}`,
      );
      return out;
    } catch (error) {
      this.logger.error('[Vortex] getLTP failed (non-fatal)', error as any);
      return {};
    }
  }

  async getOHLC(tokens: string[]): Promise<Record<string, any>> {
    try {
      await this.ensureTokenLoaded();
      if (!this.http) {
        this.logger.warn(
          '[Vortex] getOHLC called without credentials. Returning empty result.',
        );
        return {};
      }
      await this.rateLimit('ohlc');
      const exMap = await this.getExchangesForTokens(tokens);
      const qParams = tokens
        .map(
          (t) => `q=${encodeURIComponent(`${exMap.get(t) || 'NSE_EQ'}-${t}`)}`,
        )
        .join('&');
      const mode = 'ohlc';
      const url = `/data/quotes?${qParams}&mode=${mode}`;
      const resp = await this.http.get(url, { headers: this.authHeaders() });
      const data = resp?.data?.data || {};
      const out: Record<string, any> = {};
      for (const [exToken, quote] of Object.entries<any>(data)) {
        const tokenPart = exToken.split('-').pop();
        if (!tokenPart) continue;
        out[tokenPart] = {
          last_price: quote?.last_trade_price,
          ohlc: {
            open: quote?.open_price,
            high: quote?.high_price,
            low: quote?.low_price,
            close: quote?.close_price,
          },
        };
      }
      // Enrichment: fetch LTP for any tokens without a valid last_price
      const missingLtp = Object.entries(out)
        .filter(
          ([, v]) =>
            !Number.isFinite(v?.last_price) || (v?.last_price ?? 0) <= 0,
        )
        .map(([k]) => k);
      if (missingLtp.length) {
        this.logger.warn(
          `[Vortex] getOHLC missing LTP for ${missingLtp.length}/${tokens.length} tokens → fetching LTP fallback`,
        );
        try {
          const ltpMap = await this.getLTP(missingLtp);
          for (const tok of missingLtp) {
            const lv = ltpMap?.[tok]?.last_price;
            if (Number.isFinite(lv) && lv > 0) {
              out[tok] = { ...(out[tok] || {}), last_price: lv };
            }
          }
        } catch (e) {
          this.logger.warn(
            '[Vortex] LTP fallback during getOHLC failed',
            e as any,
          );
        }
      }
      return out;
    } catch (error) {
      this.logger.error('[Vortex] getOHLC failed (non-fatal)', error as any);
      return {};
    }
  }

  async getHistoricalData(
    token: number,
    from: string,
    to: string,
    interval: string,
  ): Promise<any> {
    try {
      await this.ensureTokenLoaded();
      if (!this.http) {
        this.logger.warn(
          '[Vortex] getHistoricalData called without credentials. Returning empty candles.',
        );
        return { candles: [] };
      }
      await this.rateLimit('history');
      const exMap = await this.getExchangesForTokens([String(token)]);
      const exchange = exMap.get(String(token)) || 'NSE_EQ';
      const fromSec = Math.floor(new Date(from).getTime() / 1000);
      const toSec = Math.floor(new Date(to).getTime() / 1000);
      const resolution = this.mapInterval(interval);
      const url = `/data/history?exchange=${exchange}&token=${token}&to=${toSec}&from=${fromSec}&resolution=${resolution}`;
      const resp = await this.http.get(url, { headers: this.authHeaders() });
      const d = resp?.data || {};
      if (d?.s !== 'ok') return { candles: [] };
      const candles: any[] = [];
      const len = Math.min(
        d.t?.length || 0,
        d.o?.length || 0,
        d.h?.length || 0,
        d.l?.length || 0,
        d.c?.length || 0,
      );
      for (let i = 0; i < len; i++) {
        const ts = new Date((d.t[i] || 0) * 1000).toISOString();
        candles.push([ts, d.o[i], d.h[i], d.l[i], d.c[i]]);
      }
      return { candles };
    } catch (error) {
      this.logger.error(
        '[Vortex] getHistoricalData failed (non-fatal)',
        error as any,
      );
      return { candles: [] };
    }
  }

  initializeTicker(): TickerLike {
    if (this.ticker) return this.ticker;
    const streamUrl =
      this.configService.get('VORTEX_WS_URL') || 'wss://wire.rupeezy.in/ws';
    this.logger.log(
      `[Vortex] Using WebSocket URL: ${streamUrl.replace(/auth_token=[^&]*/, 'auth_token=***')}`,
    );
    const self = this;
    class VortexTicker {
      private ws: WebSocket | null = null;
      private handlers: Record<string, Function[]> = {};
      private subscribed: Set<number> = new Set();
      private modeByToken: Map<number, 'ltp' | 'ohlcv' | 'full'> = new Map();
      private exchangeByToken: Map<
        number,
        'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'
      > = new Map();
      private pingTimer: NodeJS.Timeout | null = null;
      private lastPongAt: number = 0;

      on(event: string, fn: Function) {
        if (!this.handlers[event]) this.handlers[event] = [];
        this.handlers[event].push(fn);
      }
      emit(event: string, ...args: any[]) {
        (this.handlers[event] || []).forEach((h) => {
          try {
            h(...args);
          } catch {}
        });
      }

      connect() {
        const token =
          self.accessToken || self.configService.get('VORTEX_ACCESS_TOKEN');
        if (!token) {
          self.logger.warn('[Vortex] No access_token for WS; did you login?');
          return;
        }
        const url = `${streamUrl}?auth_token=${encodeURIComponent(token)}`;
        self.logger.log(
          `[Vortex] WS connecting to ${url.replace(token, '***')}`,
        );
        this.ws = new WebSocket(url);
        this.ws.on('open', () => {
          self.wsConnected = true;
          self.reconnectAttempts = 0;
          self.logger.log('[Vortex] WS connected successfully');
          this.startHeartbeat();
          // Resubscribe previously subscribed tokens on reconnect
          if (this.subscribed.size > 0) {
            self.logger.log(
              `[Vortex] Resubscribing to ${this.subscribed.size} previously subscribed tokens`,
            );
            this.resubscribeAll();
          }
          this.emit('connect');
        });
        this.ws.on('close', (code, reason) => {
          self.wsConnected = false;
          self.logger.warn(
            `[Vortex] WS disconnected with code ${code}: ${reason}`,
          );
          this.stopHeartbeat();
          this.emit('disconnect');
          this.scheduleReconnect();
        });
        this.ws.on('error', (e) => {
          self.logger.error('[Vortex] WS error', e as any);
          this.emit('error', e);
        });
        this.ws.on('ping', () => {
          try {
            this.ws?.pong();
          } catch {}
        });
        this.ws.on('pong', () => {
          this.lastPongAt = Date.now();
        });
        this.ws.on('message', (data: any) => {
          if (typeof data === 'string') {
            try {
              const j = JSON.parse(data.toString());

              // Handle subscription confirmations and errors
              // Vortex may send confirmation/error messages for subscriptions
              if (
                j?.message_type === 'subscribed' ||
                j?.status === 'subscribed' ||
                (j?.type === 'subscription' && j?.status === 'success')
              ) {
                const token = j?.token;
                const exchange = j?.exchange;
                if (token) {
                  // Confirm subscription was successful
                  if (!this.subscribed.has(token)) {
                    this.subscribed.add(token);
                    self.logger.log(
                      `[Vortex] Subscription confirmed by server for token ${token} (exchange: ${exchange || 'unknown'})`,
                    );
                  }
                }
              } else if (
                j?.message_type === 'unsubscribed' ||
                j?.status === 'unsubscribed'
              ) {
                const token = j?.token;
                if (token) {
                  this.subscribed.delete(token);
                  self.logger.log(
                    `[Vortex] Unsubscription confirmed by server for token ${token}`,
                  );
                }
              } else if (
                j?.error ||
                j?.status === 'error' ||
                j?.message_type === 'error'
              ) {
                const token = j?.token;
                const errorMsg = j?.error || j?.message || 'Unknown error';
                if (token) {
                  // Remove from subscribed Set if subscription failed
                  this.subscribed.delete(token);
                  this.modeByToken.delete(token);
                  this.exchangeByToken.delete(token);
                  self.logger.error(
                    `[Vortex] Subscription error for token ${token}: ${errorMsg}`,
                  );
                } else {
                  self.logger.error(
                    `[Vortex] Received error message: ${errorMsg}`,
                  );
                }
              } else if (j?.type === 'postback') {
                self.logger.debug('[Vortex] Received postback message');
              } else {
                // Log other text messages for debugging
                self.logger.debug(
                  `[Vortex] Received text message: ${data.toString()}`,
                );
              }
            } catch (e) {
              self.logger.warn(
                '[Vortex] Failed to parse text message',
                e as any,
              );
            }
          } else if (Buffer.isBuffer(data)) {
            try {
              const ticks = self.parseBinaryTicks(data);
              if (ticks.length) {
                self.logger.debug(
                  `[Vortex] Parsed ${ticks.length} binary ticks`,
                );
                this.emit('ticks', ticks);
              }
            } catch (e) {
              self.logger.error(
                '[Vortex] Failed to parse binary tick packet',
                e as any,
              );
            }
          }
        });
      }
      disconnect() {
        try {
          this.ws?.close();
        } catch {}
      }
      subscribe(tokens: number[], mode: 'ltp' | 'ohlcv' | 'full' = 'ltp') {
        // Filter out tokens that are already subscribed
        const unique = tokens.filter((t) => !this.subscribed.has(t));
        const available = Math.max(
          0,
          self.maxSubscriptionsPerSocket - this.subscribed.size,
        );
        const toAdd = unique.slice(0, available);
        const dropped = unique.slice(available);

        if (toAdd.length === 0 && unique.length > 0) {
          self.logger.warn(
            `[Vortex] Subscription limit (${self.maxSubscriptionsPerSocket}) reached; dropping ${unique.length} tokens`,
          );
        }

        // Check WebSocket state before proceeding
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          self.logger.warn(
            `[Vortex] Cannot subscribe to ${toAdd.length} tokens: WebSocket is not OPEN (state: ${this.ws?.readyState ?? 'null'})`,
          );
          return;
        }

        // Set mode for all tokens before subscribing
        toAdd.forEach((token) => {
          this.modeByToken.set(token, mode);
        });

        self.logger.log(
          `[Vortex] Processing subscription for ${toAdd.length} tokens with mode=${mode}`,
        );

        // Fire-and-forget: resolve exchanges per token and send subscribe frames
        (async () => {
          try {
            const exMapRaw = await self.getExchangesForTokens(
              toAdd.map((t) => String(t)),
            );
            const successfullySubscribed: number[] = [];

            for (const t of toAdd) {
              // Double-check WebSocket state before each send
              if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                self.logger.warn(
                  `[Vortex] WebSocket disconnected while subscribing token ${t}, skipping remaining tokens`,
                );
                break;
              }

              try {
                const tokenMode = this.modeByToken.get(t) || mode;
                const ex = (exMapRaw.get(String(t)) || 'NSE_EQ') as
                  | 'NSE_EQ'
                  | 'NSE_FO'
                  | 'NSE_CUR'
                  | 'MCX_FO';
                this.exchangeByToken.set(t, ex);

                // Send subscription message
                this.send({
                  exchange: ex,
                  token: t,
                  mode: tokenMode,
                  message_type: 'subscribe',
                });

                // Only mark as subscribed AFTER successfully sending
                // Note: We assume send() succeeded if WebSocket is OPEN (send() catches errors but doesn't throw)
                // In production, Vortex server should send confirmation which we'll handle separately
                this.subscribed.add(t);
                successfullySubscribed.push(t);

                self.logger.debug(
                  `[Vortex] Sent subscription request for token ${t} (exchange: ${ex}, mode: ${tokenMode})`,
                );
              } catch (tokenError) {
                self.logger.error(
                  `[Vortex] Failed to subscribe token ${t}`,
                  tokenError as any,
                );
                // Don't add to subscribed Set if send failed
              }
            }

            if (successfullySubscribed.length > 0) {
              self.logger.log(
                `[Vortex] Successfully sent subscription requests for ${successfullySubscribed.length}/${toAdd.length} tokens with mode=${mode}`,
              );
              self.logger.debug(
                `[Vortex] Subscribed tokens: ${successfullySubscribed.map((t) => `${t}:${this.exchangeByToken.get(t)}`).join(', ')}`,
              );
            }
          } catch (e) {
            self.logger.error(
              '[Vortex] subscribe exchange resolution failed, using NSE_EQ fallback',
              e as any,
            );
            // Fallback: send with NSE_EQ to avoid silent failure
            const fallbackSubscribed: number[] = [];
            for (const t of toAdd) {
              // Double-check WebSocket state
              if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                self.logger.warn(
                  `[Vortex] WebSocket disconnected during fallback subscription, skipping token ${t}`,
                );
                break;
              }

              try {
                const tokenMode = this.modeByToken.get(t) || mode;
                this.exchangeByToken.set(t, 'NSE_EQ');
                this.send({
                  exchange: 'NSE_EQ',
                  token: t,
                  mode: tokenMode,
                  message_type: 'subscribe',
                });
                this.subscribed.add(t);
                fallbackSubscribed.push(t);
                self.logger.debug(
                  `[Vortex] Sent fallback subscription for token ${t} with NSE_EQ`,
                );
              } catch (tokenError) {
                self.logger.error(
                  `[Vortex] Failed fallback subscription for token ${t}`,
                  tokenError as any,
                );
              }
            }
            if (fallbackSubscribed.length > 0) {
              self.logger.log(
                `[Vortex] Fallback subscribed ${fallbackSubscribed.length} tokens with NSE_EQ`,
              );
            }
          }
        })();

        if (dropped.length) {
          self.logger.warn(
            `[Vortex] Dropped ${dropped.length} subscriptions due to limit (${this.subscribed.size}/${self.maxSubscriptionsPerSocket})`,
          );
        }
      }
      unsubscribe(tokens: number[]) {
        // Fire-and-forget: ensure exchange mapping exists for tokens
        (async () => {
          try {
            const missing = tokens.filter((t) => !this.exchangeByToken.has(t));
            if (missing.length) {
              const exMapRaw = await self.getExchangesForTokens(
                missing.map((t) => String(t)),
              );
              missing.forEach((t) => {
                const ex = (exMapRaw.get(String(t)) || 'NSE_EQ') as
                  | 'NSE_EQ'
                  | 'NSE_FO'
                  | 'NSE_CUR'
                  | 'MCX_FO';
                this.exchangeByToken.set(t, ex);
              });
            }
          } catch (e) {
            self.logger.warn(
              '[Vortex] unsubscribe exchange resolution failed; using NSE_EQ fallback',
              e as any,
            );
          }
          tokens.forEach((t) => {
            const ex = this.exchangeByToken.get(t) || 'NSE_EQ';
            const mode = this.modeByToken.get(t) || 'ltp';
            this.send({
              exchange: ex,
              token: t,
              mode,
              message_type: 'unsubscribe',
            });
            this.subscribed.delete(t);
            this.modeByToken.delete(t);
            this.exchangeByToken.delete(t);
          });
          if (tokens.length)
            self.logger.log(`[Vortex] Unsubscribed ${tokens.length} tokens`);
        })();
      }
      setMode(mode: string, tokens: number[]) {
        const m = mode as any as 'ltp' | 'ohlcv' | 'full';
        const target = tokens.filter((t) => this.subscribed.has(t));
        target.forEach((t) => this.modeByToken.set(t, m));
        // Fire-and-forget mapping and send
        (async () => {
          try {
            const missing = target.filter((t) => !this.exchangeByToken.has(t));
            if (missing.length) {
              const exMapRaw = await self.getExchangesForTokens(
                missing.map((t) => String(t)),
              );
              missing.forEach((t) => {
                const ex = (exMapRaw.get(String(t)) || 'NSE_EQ') as
                  | 'NSE_EQ'
                  | 'NSE_FO'
                  | 'NSE_CUR'
                  | 'MCX_FO';
                this.exchangeByToken.set(t, ex);
              });
            }
          } catch (e) {
            self.logger.warn(
              '[Vortex] setMode exchange resolution failed; using NSE_EQ fallback',
              e as any,
            );
          }
          target.forEach((t) => {
            const ex = this.exchangeByToken.get(t) || 'NSE_EQ';
            this.send({
              exchange: ex,
              token: t,
              mode: m,
              message_type: 'subscribe',
            });
          });
          if (target.length)
            self.logger.log(
              `[Vortex] Mode set to ${m} for ${target.length} tokens`,
            );
        })();
      }
      private send(obj: any) {
        try {
          const message = JSON.stringify(obj);
          this.ws?.send(message);
          self.logger.debug(`[Vortex] Sent WS message: ${message}`);
        } catch (e) {
          self.logger.error('[Vortex] WS send failed', e as any);
        }
      }
      private scheduleReconnect() {
        if (self.reconnectAttempts >= self.maxReconnectAttempts) return;
        const base = 1000 * Math.pow(1.5, self.reconnectAttempts++);
        const jitter = Math.floor(Math.random() * 300);
        const delay = base + jitter;
        setTimeout(() => this.connect(), delay);
      }
      private startHeartbeat() {
        this.stopHeartbeat();
        this.lastPongAt = Date.now();
        this.pingTimer = setInterval(() => {
          try {
            // If server supports ping/pong, send ping
            this.ws?.ping?.();
            // Fallback: send a lightweight text heartbeat to avoid idling
            this.send({ type: 'ping', t: Date.now() });
          } catch {}
          // If no pong for 60s, force reconnect
          if (Date.now() - this.lastPongAt > 60000) {
            try {
              this.ws?.terminate?.();
            } catch {}
          }
        }, 15000);
      }
      private stopHeartbeat() {
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
      }
      private resubscribeAll() {
        const tokens = Array.from(this.subscribed);
        if (tokens.length === 0) return;
        (async () => {
          try {
            const missing = tokens.filter((t) => !this.exchangeByToken.has(t));
            if (missing.length) {
              const exMapRaw = await self.getExchangesForTokens(
                missing.map((t) => String(t)),
              );
              missing.forEach((t) => {
                const ex = (exMapRaw.get(String(t)) || 'NSE_EQ') as
                  | 'NSE_EQ'
                  | 'NSE_FO'
                  | 'NSE_CUR'
                  | 'MCX_FO';
                this.exchangeByToken.set(t, ex);
              });
            }
          } catch (e) {
            self.logger.warn(
              '[Vortex] resubscribeAll exchange resolution failed; using NSE_EQ fallback',
              e as any,
            );
          }
          for (const t of tokens) {
            const mode = this.modeByToken.get(t) || 'ltp';
            const ex = this.exchangeByToken.get(t) || 'NSE_EQ';
            this.send({
              exchange: ex,
              token: t,
              mode,
              message_type: 'subscribe',
            });
          }
          self.logger.log(`[Vortex] Resubscribed ${tokens.length} tokens`);
        })();
      }
    }
    this.ticker = new VortexTicker();
    return this.ticker;
  }

  getTicker(): TickerLike {
    return this.ticker;
  }

  async updateAccessToken(token: string) {
    this.accessToken = token;
  }

  // CSV parser (no external deps to keep light). Handles simple CSV with header.
  private parseCsv(text: string): Record<string, string>[] {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return [];
    const header = this.splitCsvLine(lines[0]);
    const rows: Record<string, string>[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = this.splitCsvLine(lines[i]);
      const row: Record<string, string> = {};
      for (let j = 0; j < header.length; j++) {
        row[header[j]] = parts[j] ?? '';
      }
      rows.push(row);
    }
    return rows;
  }

  private authHeaders(): Record<string, string> {
    const apiKey = this.configService.get('VORTEX_API_KEY') || '';
    const bearer = this.accessToken || '';
    const h: Record<string, string> = { 'x-api-key': apiKey };
    if (bearer) h['Authorization'] = `Bearer ${bearer}`;
    return h;
  }

  private normalizeQuote(q: any) {
    const lp = Number(q?.last_trade_price);
    const open = Number(q?.open_price);
    const high = Number(q?.high_price);
    const low = Number(q?.low_price);
    const close = Number(q?.close_price);
    const volume = Number(q?.volume);
    const normalized = {
      last_price: Number.isFinite(lp) && lp > 0 ? lp : null,
      ohlc: {
        open: Number.isFinite(open) ? open : null,
        high: Number.isFinite(high) ? high : null,
        low: Number.isFinite(low) ? low : null,
        close: Number.isFinite(close) ? close : null,
      },
      volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
    } as any;
    if (normalized.last_price === null) {
      this.logger.debug(
        '[Vortex] normalizeQuote: missing/invalid last_trade_price in provider response',
      );
    }
    return normalized;
  }

  // Parse binary websocket packets per vortex_live.md
  // Each message contains multiple quotes, each preceded by 2 bytes (int16 LE) length
  // Lengths: 22 (ltp), 62 (ohlcv), 266 (full). Fields are LE.
  private parseBinaryTicks(buf: Buffer): any[] {
    const ticks: any[] = [];
    let offset = 0;
    try {
      // Attempt to detect optional header: [int16 tickCount] followed by framed records
      let headerDetected = false;
      if (buf.length >= 2) {
        const possibleCount = buf.readUInt16LE(0);
        // Heuristic: if count is small and remaining bytes sufficient for at least that many frames, treat as header
        if (possibleCount > 0 && possibleCount < 2000) {
          headerDetected = true;
          offset = 2;
          let parsed = 0;
          while (parsed < possibleCount && offset + 2 <= buf.length) {
            const size = buf.readUInt16LE(offset);
            offset += 2;
            if (size <= 0 || offset + size > buf.length) break;
            const slice = buf.subarray(offset, offset + size);
            offset += size;
            const one = this.parseOneTick(slice);
            if (one) ticks.push(one);
            parsed++;
          }
          // If parsed less than declared, log for diagnostics
          if (parsed !== possibleCount) {
            this.logger.debug?.(
              `[Vortex] Header count=${possibleCount} parsed=${parsed} totalBytes=${buf.length}`,
            );
          }
        }
      }

      // Fallback: length-prefixed frames until buffer end
      if (!headerDetected) {
        offset = 0;
        while (offset + 2 <= buf.length) {
          const size = buf.readUInt16LE(offset);
          offset += 2;
          if (size <= 0 || offset + size > buf.length) break;
          const slice = buf.subarray(offset, offset + size);
          offset += size;
          const one = this.parseOneTick(slice);
          if (one) ticks.push(one);
        }
      }
    } catch (e) {
      this.logger.error('[Vortex] parseBinaryTicks error', e as any);
    }
    return ticks;
  }

  private parseOneTick(payload: Buffer): any | null {
    try {
      const len = payload.length;
      // Exchange: first 10 bytes ASCII, zero-padded
      const exchange = payload
        .subarray(0, 10)
        .toString('ascii')
        .replace(/\u0000/g, '')
        .trim();
      const token = payload.readInt32LE(10);

      if (len === 22) {
        // LTP mode: 22 bytes
        const ltp = payload.readDoubleLE(14);
        this.logger.debug(
          `[Vortex] Parsed LTP tick: token=${token}, exchange=${exchange}, price=${ltp}`,
        );
        return { instrument_token: token, exchange, last_price: ltp };
      }

      if (len === 62) {
        // OHLCV mode: 62 bytes
        const ltp = payload.readDoubleLE(14);
        const lastTradeTime = payload.readInt32LE(22);
        const open = payload.readDoubleLE(26);
        const high = payload.readDoubleLE(34);
        const low = payload.readDoubleLE(42);
        const close = payload.readDoubleLE(50);
        const volume = payload.readInt32LE(58);
        this.logger.debug(
          `[Vortex] Parsed OHLCV tick: token=${token}, exchange=${exchange}, OHLC=${open}/${high}/${low}/${close}, volume=${volume}`,
        );
        return {
          instrument_token: token,
          exchange,
          last_price: ltp,
          last_trade_time: lastTradeTime,
          volume,
          ohlc: { open, high, low, close },
        };
      }

      if (len === 266) {
        // Full mode: 266 bytes with depth data
        const ltp = payload.readDoubleLE(14);
        const lastTradeTime = payload.readInt32LE(22);
        const open = payload.readDoubleLE(26);
        const high = payload.readDoubleLE(34);
        const low = payload.readDoubleLE(42);
        const close = payload.readDoubleLE(50);
        const volume = payload.readInt32LE(58);
        const lastUpdateTime = payload.readInt32LE(62);
        const lastTradeQuantity = payload.readInt32LE(66);
        const averageTradePrice = payload.readDoubleLE(70);
        const totalBuyQuantity = payload.readBigInt64LE(78);
        const totalSellQuantity = payload.readBigInt64LE(86);
        const openInterest = payload.readInt32LE(94);

        // Parse depth data (simplified - first 5 levels each for buy/sell)
        const depth = { buy: [], sell: [] };
        let offset = 98; // After basic fields

        // Parse buy depth (5 levels)
        for (let i = 0; i < 5; i++) {
          if (offset + 16 <= payload.length) {
            const price = payload.readDoubleLE(offset);
            const quantity = payload.readInt32LE(offset + 8);
            const orders = payload.readInt32LE(offset + 12);
            depth.buy.push({ price, quantity, orders });
            offset += 16;
          }
        }

        // Parse sell depth (5 levels)
        for (let i = 0; i < 5; i++) {
          if (offset + 16 <= payload.length) {
            const price = payload.readDoubleLE(offset);
            const quantity = payload.readInt32LE(offset + 8);
            const orders = payload.readInt32LE(offset + 12);
            depth.sell.push({ price, quantity, orders });
            offset += 16;
          }
        }

        this.logger.debug(
          `[Vortex] Parsed FULL tick: token=${token}, exchange=${exchange}, price=${ltp}, depth=${depth.buy.length}/${depth.sell.length} levels`,
        );
        return {
          instrument_token: token,
          exchange,
          last_price: ltp,
          last_trade_time: lastTradeTime,
          volume,
          last_update_time: lastUpdateTime,
          last_trade_quantity: lastTradeQuantity,
          average_trade_price: averageTradePrice,
          total_buy_quantity: Number(totalBuyQuantity),
          total_sell_quantity: Number(totalSellQuantity),
          open_interest: openInterest,
          ohlc: { open, high, low, close },
          depth,
        };
      }

      // Unknown length; log for debugging
      this.logger.warn(
        `[Vortex] Unknown tick length: ${len} bytes, expected 22/62/266`,
      );
      return null;
    } catch (e) {
      this.logger.error(
        `[Vortex] parseOneTick failed for payload length ${payload.length}`,
        e as any,
      );
      return null;
    }
  }

  getDebugStatus() {
    return {
      initialized: this.initialized,
      httpConfigured: !!this.http,
      wsConnected: this.wsConnected,
      reconnectAttempts: this.reconnectAttempts,
      hasAccessToken: !!this.accessToken,
    };
  }

  private mapInterval(interval: string): string {
    const i = (interval || '').toLowerCase();
    if (i.includes('day')) return '1D';
    if (i.includes('week')) return '1W';
    if (i.includes('month')) return '1M';
    const m = parseInt(i) || 1;
    return String(Math.max(1, Math.min(240, m)));
  }

  // Map tokens to Vortex exchange using DB instruments; fallback to NSE_EQ
  private async getExchangesForTokens(
    tokens: string[],
  ): Promise<Map<string, 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'>> {
    const map = new Map<string, any>();
    try {
      const nums = tokens
        .map((t) => Number(t))
        .filter((n) => Number.isFinite(n));
      if (!nums.length) {
        // No valid tokens, return empty map (will use NSE_EQ fallback in callers)
        return map;
      }
      const rows = await this.instrumentRepo.find({
        where: { instrument_token: In(nums) } as any,
        select: ['instrument_token', 'exchange', 'segment'] as any,
      });
      for (const r of rows) {
        const ex = this.normalizeExchange(r.exchange || r.segment || '');
        if (ex) map.set(String(r.instrument_token), ex);
      }
      // If an instrument explicitly indicates derivatives, prefer NSE_FO over NSE_EQ
      // This avoids defaulting to NSE_EQ for FO/CUR/MCX instruments when DB has segment info
      // Log fallback usage for tokens not found in DB
      const notFound = tokens.filter((t) => !map.has(t));
      if (notFound.length > 0) {
        this.logger.debug(
          `[Vortex] Using NSE_EQ fallback for ${notFound.length} tokens not in DB: ${notFound.slice(0, 5).join(',')}`,
        );
      }
    } catch (e) {
      this.logger.warn(
        '[Vortex] getExchangesForTokens failed; all tokens will use NSE_EQ fallback',
        e as any,
      );
    }
    return map;
  }

  private normalizeExchange(
    ex: string,
  ): 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO' | null {
    const s = (ex || '').toUpperCase();
    if (
      s.includes('NSE_EQ') ||
      s === 'NSE' ||
      s === 'EQ' ||
      s.includes('EQUITY')
    )
      return 'NSE_EQ';
    if (
      s.includes('NSE_FO') ||
      s.includes('FO') ||
      s.includes('FUT') ||
      s.includes('FNO')
    )
      return 'NSE_FO';
    if (s.includes('NSE_CUR') || s.includes('CDS') || s.includes('CUR'))
      return 'NSE_CUR';
    if (s.includes('MCX')) return 'MCX_FO';
    return null;
  }

  // Simple per-endpoint rate limiter for Vortex REST (1 req/sec)
  private lastReqAt: Record<string, number> = {};
  private async rateLimit(key: 'quotes' | 'ltp' | 'ohlc' | 'history') {
    try {
      const now = Date.now();
      const last = this.lastReqAt[key] || 0;
      const elapsed = now - last;
      const minInterval = 1000;
      if (elapsed < minInterval) {
        const sleep = minInterval - elapsed;
        await new Promise((r) => setTimeout(r, sleep));
      }
      this.lastReqAt[key] = Date.now();
    } catch {}
  }

  private async loadSavedToken(): Promise<void> {
    try {
      const active = await this.vortexSessionRepo.findOne({
        where: { is_active: true },
        order: { created_at: 'DESC' },
      });
      if (active?.access_token) {
        // If expired, skip
        if (active.expires_at && active.expires_at.getTime() <= Date.now()) {
          this.logger.warn(
            '[Vortex] Saved token is expired; please login again',
          );
          return;
        }
        this.accessToken = active.access_token;
        this.logger.log('[Vortex] Auto-loaded access token from DB on startup');
      } else {
        this.logger.log('[Vortex] No active token found in DB; login required');
      }
    } catch (e) {
      this.logger.warn('[Vortex] Failed to load saved token from DB', e as any);
    }
  }

  private async ensureTokenLoaded(): Promise<void> {
    if (this.accessToken) return;
    try {
      const active = await this.vortexSessionRepo.findOne({
        where: { is_active: true },
        order: { created_at: 'DESC' },
      });
      if (active?.access_token) {
        // If expired, skip
        if (active.expires_at && active.expires_at.getTime() <= Date.now()) {
          this.logger.warn(
            '[Vortex] Active DB token is expired; please login again',
          );
          return;
        }
        this.accessToken = active.access_token;
        this.logger.log('[Vortex] Loaded access token from DB');
      }
    } catch (e) {
      this.logger.warn('[Vortex] Failed to load token from DB', e as any);
    }
  }

  private splitCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // escaped quote
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result.map((s) => s.trim());
  }

  // Lightweight provider health ping; does not throw
  async ping(): Promise<{ httpOk: boolean; reason?: string }> {
    try {
      await this.ensureTokenLoaded();
      if (!this.http) return { httpOk: false, reason: 'http_not_configured' };
      const url = `/data/quotes?q=NSE_EQ-26000&mode=ltp`;
      try {
        const resp = await this.http.get(url, {
          headers: this.authHeaders(),
          timeout: 3000,
        });
        const ok = !!resp?.data;
        this.logger.debug(`[Vortex] Health ping successful: ${ok}`);
        return { httpOk: ok };
      } catch (e: any) {
        const status = e?.response?.status;
        if (status === 401 || status === 403) {
          // Service reachable but auth missing/expired
          this.logger.warn(
            `[Vortex] Health ping failed: auth error (${status})`,
          );
          return { httpOk: true, reason: 'auth_error' };
        }
        if (status === 429) {
          // Rate limit exceeded
          this.logger.warn('[Vortex] Health ping failed: rate limit exceeded');
          return { httpOk: true, reason: 'rate_limit' };
        }
        this.logger.error(
          `[Vortex] Health ping failed: ${status ? `HTTP ${status}` : e?.code || 'network_error'}`,
        );
        return {
          httpOk: false,
          reason: status ? `http_${status}` : e?.code || 'network_error',
        };
      }
    } catch (e: any) {
      this.logger.error(
        `[Vortex] Health ping error: ${e?.message || 'unknown'}`,
      );
      return { httpOk: false, reason: e?.message || 'unknown' };
    }
  }
}
