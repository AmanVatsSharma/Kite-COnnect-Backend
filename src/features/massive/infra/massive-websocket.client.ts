/**
 * @file massive-websocket.client.ts
 * @module massive
 * @description WebSocket ticker facade for Massive real-time feed.
 *   Implements the duck-typed TickerLike interface expected by MarketDataStreamService
 *   (on/subscribe/unsubscribe/connect/disconnect).
 *   Translates Massive WS events → canonical tick objects keyed by symbol string.
 * @author BharatERP
 * @created 2026-04-18
 * @updated 2026-04-27
 */
import { Injectable, Logger } from '@nestjs/common';
import * as WebSocket from 'ws';
import {
  MASSIVE_WS_REALTIME_BASE,
  MASSIVE_WS_DELAYED_BASE,
  MassiveAssetClass,
  MASSIVE_WS_EVENTS,
} from '../massive.constants';
import type {
  MassiveTradeEvent,
  MassiveQuoteEvent,
  MassiveMinuteAggEvent,
  MassiveCryptoTradeEvent,
  MassiveCryptoAggEvent,
  MassiveCryptoQuoteEvent,
  MassiveForexQuoteEvent,
  MassiveForexAggEvent,
  MassiveWsEvent,
} from '../dto/massive-ws-event.dto';

type TickerEvent = 'ticks' | 'connect' | 'disconnect' | 'error';
type TickerHandler = (...args: any[]) => void;

/**
 * Canonical tick shape emitted to the streaming layer.
 * instrument_token is the symbol string (e.g. "AAPL") since Massive has no numeric tokens.
 */
export interface MassiveCanonicalTick {
  instrument_token: string;
  last_price: number;
  exchange: string;
  volume?: number;
  last_trade_time?: number;
  ohlc?: { open: number; high: number; low: number; close: number };
}

@Injectable()
export class MassiveWebSocketClient {
  private readonly logger = new Logger(MassiveWebSocketClient.name);

  private ws: WebSocket | null = null;
  private apiKey: string | null = null;
  private wsBase: string = MASSIVE_WS_REALTIME_BASE;
  private assetClass: MassiveAssetClass = 'stocks';

  private isConnected = false;
  private isAuthenticated = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = false;
  private authFailed = false;

  /** Active symbol subscriptions kept for re-subscribe after reconnect. */
  private subscribedSymbols: Set<string> = new Set();

  private handlers = new Map<TickerEvent, TickerHandler[]>();

  init(apiKey: string, realtime: boolean, assetClass: MassiveAssetClass = 'stocks'): void {
    this.apiKey = apiKey;
    this.wsBase = realtime ? MASSIVE_WS_REALTIME_BASE : MASSIVE_WS_DELAYED_BASE;
    this.assetClass = assetClass;
    this.authFailed = false;
    this.logger.log(`[Massive WS] Configured for ${assetClass} (${realtime ? 'realtime' : 'delayed'})`);
  }

  isReady(): boolean {
    return !!this.apiKey;
  }

  /** Register event handler (duck-typed KiteTicker interface). */
  on(event: TickerEvent, handler: TickerHandler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
  }

  private emit(event: TickerEvent, ...args: any[]): void {
    for (const h of this.handlers.get(event) ?? []) {
      try { h(...args); } catch {}
    }
  }

  connect(): void {
    if (!this.apiKey) {
      this.logger.warn('[Massive WS] connect(): API key not configured');
      return;
    }
    this.shouldReconnect = true;
    this.openConnection();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.isConnected = false;
    this.isAuthenticated = false;
    this.logger.log('[Massive WS] Disconnected');
  }

  /**
   * Subscribe to symbols. Called by the streaming layer with an array of tokens.
   * For Massive, tokens are symbol strings (e.g. ["AAPL", "MSFT"]).
   * The streaming layer may also pass numeric UIR IDs — these are ignored since
   * the instrument registry maps `massive:<symbol>` keys, not numeric tokens.
   */
  subscribe(tokens: (string | number)[], _mode?: string): void {
    const symbols = tokens
      .map(String)
      .filter((t) => t && !/^\d+$/.test(t)); // keep non-numeric strings only

    if (!symbols.length) return;

    for (const sym of symbols) this.subscribedSymbols.add(sym);

    if (this.isAuthenticated) {
      this.sendSubscribe(symbols);
    }
  }

  unsubscribe(tokens: (string | number)[]): void {
    const symbols = tokens
      .map(String)
      .filter((t) => t && !/^\d+$/.test(t));

    if (!symbols.length) return;

    for (const sym of symbols) this.subscribedSymbols.delete(sym);

    if (this.isAuthenticated && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        action: 'unsubscribe',
        params: symbols.map((s) => `T.${s}`).join(','),
      }));
    }
  }

  private openConnection(): void {
    // Massive requires the API key as a query parameter on the upgrade request — 403 without it.
    const url = `${this.wsBase}/${this.assetClass}?apiKey=${this.apiKey}`;
    this.logger.log(`[Massive WS] Connecting to ${this.wsBase}/${this.assetClass}`);

    // MASSIVE_WS_REJECT_UNAUTHORIZED=false disables TLS verification for self-signed / proxy certs.
    // Default is secure (true). Only set false in dev environments.
    const rejectUnauthorized = process.env.MASSIVE_WS_REJECT_UNAUTHORIZED !== 'false';
    const wsOptions: WebSocket.ClientOptions = rejectUnauthorized ? {} : { rejectUnauthorized: false };

    try {
      this.ws = new WebSocket(url, wsOptions);
    } catch (err) {
      this.logger.error('[Massive WS] Failed to create WebSocket', err as any);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.logger.log('[Massive WS] Connection opened — sending auth');
    });

    this.ws.on('message', (raw: Buffer | string) => {
      this.handleMessage(raw.toString());
    });

    this.ws.on('close', (_code: number, reason: Buffer) => {
      const wasConnected = this.isConnected;
      this.isConnected = false;
      this.isAuthenticated = false;
      this.logger.warn(`[Massive WS] Closed (reason=${reason?.toString() || 'none'})`);
      if (wasConnected) this.emit('disconnect');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      this.logger.error('[Massive WS] Error', err as any);
      this.emit('error', err);
    });
  }

  private handleMessage(raw: string): void {
    let events: MassiveWsEvent[];
    try {
      events = JSON.parse(raw);
      if (!Array.isArray(events)) events = [events];
    } catch {
      this.logger.debug('[Massive WS] Non-JSON message received');
      return;
    }

    for (const event of events) {
      if (event.ev === MASSIVE_WS_EVENTS.STATUS) {
        this.handleStatus(event as any);
        continue;
      }
      const tick = this.eventToTick(event);
      if (tick) this.emit('ticks', [tick]);
    }
  }

  private handleStatus(event: { ev: 'status'; status: string; message: string }): void {
    this.logger.log(`[Massive WS] Status: ${event.status} — ${event.message}`);

    if (event.status === 'connected') {
      // Send auth immediately after connect acknowledgement
      this.ws?.send(JSON.stringify({ action: 'auth', params: this.apiKey }));
      return;
    }

    if (event.status === 'auth_success' || event.status === 'success') {
      this.isAuthenticated = true;
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.logger.log('[Massive WS] Authenticated successfully');
      this.emit('connect');

      // Re-subscribe to all tracked symbols
      if (this.subscribedSymbols.size > 0) {
        this.sendSubscribe(Array.from(this.subscribedSymbols));
      }
      return;
    }

    if (event.status === 'auth_failed') {
      this.logger.error('[Massive WS] Auth failed — disabling reconnect');
      this.authFailed = true;
      this.shouldReconnect = false;
      this.emit('error', new Error('Massive WS auth failed'));
    }
  }

  private sendSubscribe(symbols: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Polygon channel prefixes differ by asset class:
    //   stocks:  T.AAPL (trades) + AM.AAPL (minute aggs)
    //   forex:   C.EURUSD (forex quotes — strip any "C:" prefix from the symbol first)
    //   crypto:  XT.BTCUSD (trades) + XA.BTCUSD (minute aggs)
    let params: string;
    if (this.assetClass === 'forex') {
      params = symbols.map((s) => `C.${s.replace(/^C:/i, '')}`).join(',');
    } else if (this.assetClass === 'crypto') {
      params = symbols.map((s) => { const c = s.replace(/^X:/i, ''); return `XT.${c},XA.${c}`; }).join(',');
    } else {
      params = symbols.map((s) => `T.${s},AM.${s}`).join(',');
    }
    this.ws.send(JSON.stringify({ action: 'subscribe', params }));
    this.logger.log(`[Massive WS] Subscribed: ${symbols.slice(0, 5).join(',')}${symbols.length > 5 ? `…+${symbols.length - 5}` : ''}`);
  }

  private eventToTick(event: MassiveWsEvent): MassiveCanonicalTick | null {
    try {
      switch (event.ev) {
        case MASSIVE_WS_EVENTS.TRADE: {
          const t = event as MassiveTradeEvent;
          return {
            instrument_token: t.sym,
            last_price: t.p,
            exchange: this.assetClass,
            volume: t.s,
            last_trade_time: t.t,
          };
        }
        case MASSIVE_WS_EVENTS.MINUTE_AGG:
        case MASSIVE_WS_EVENTS.SECOND_AGG: {
          const a = event as MassiveMinuteAggEvent;
          return {
            instrument_token: a.sym,
            last_price: a.c,
            exchange: this.assetClass,
            volume: a.v,
            last_trade_time: a.s,
            ohlc: { open: a.o, high: a.h, low: a.l, close: a.c },
          };
        }
        case MASSIVE_WS_EVENTS.QUOTE: {
          const q = event as MassiveQuoteEvent;
          // Use midpoint as last_price for quote events
          return {
            instrument_token: q.sym,
            last_price: (q.bp + q.ap) / 2,
            exchange: this.assetClass,
            last_trade_time: q.t,
          };
        }
        case MASSIVE_WS_EVENTS.CRYPTO_TRADE: {
          const c = event as MassiveCryptoTradeEvent;
          return {
            instrument_token: c.pair,
            last_price: c.p,
            exchange: 'crypto',
            volume: c.s,
            last_trade_time: c.t,
          };
        }
        case MASSIVE_WS_EVENTS.CRYPTO_AGG: {
          const ca = event as MassiveCryptoAggEvent;
          return {
            instrument_token: ca.pair,
            last_price: ca.c,
            exchange: 'crypto',
            volume: ca.v,
            last_trade_time: ca.s,
            ohlc: { open: ca.o, high: ca.h, low: ca.l, close: ca.c },
          };
        }
        case MASSIVE_WS_EVENTS.CRYPTO_QUOTE: {
          const cq = event as MassiveCryptoQuoteEvent;
          return {
            instrument_token: cq.pair,
            last_price: (cq.bp + cq.ap) / 2,
            exchange: 'crypto',
            last_trade_time: cq.t,
          };
        }
        case MASSIVE_WS_EVENTS.FOREX_QUOTE: {
          const f = event as MassiveForexQuoteEvent;
          // Polygon sends pair as "EUR/USD" (slash); strip to match clean provider_token "EURUSD" in registry
          const sym = f.p.replace('/', '');
          return {
            instrument_token: sym,
            last_price: (f.a + f.b) / 2,
            exchange: 'forex',
            last_trade_time: f.t,
          };
        }
        case MASSIVE_WS_EVENTS.FOREX_AGG: {
          const fa = event as MassiveForexAggEvent;
          const fsym = fa.p.replace('/', '');
          return {
            instrument_token: fsym,
            last_price: fa.c,
            exchange: 'forex',
            last_trade_time: fa.s,
            ohlc: { open: fa.o, high: fa.h, low: fa.l, close: fa.c },
          };
        }
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('[Massive WS] Max reconnect attempts reached — giving up');
      return;
    }
    const delayMs = Math.min(60_000, 1000 * Math.pow(2, this.reconnectAttempts)) + Math.random() * 1000;
    this.reconnectAttempts++;
    this.logger.log(`[Massive WS] Reconnect attempt ${this.reconnectAttempts} in ${Math.round(delayMs)}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openConnection();
    }, delayMs);
  }

  /** Active symbol count for health/debug endpoints. */
  getSubscribedCount(): number {
    return this.subscribedSymbols.size;
  }

  /** All currently subscribed symbols — used by the REST polling fallback. */
  getSubscribedTokens(): string[] {
    return Array.from(this.subscribedSymbols);
  }

  /** True after a plan-level auth_failed — signals the composite to start REST polling. */
  isAuthFailed(): boolean {
    return this.authFailed;
  }

  isWsConnected(): boolean {
    return this.isConnected && this.isAuthenticated;
  }
}
