/**
 * File:        src/features/massive/infra/massive-multi-stream.client.ts
 * Module:      massive
 * Purpose:     Composite TickerLike facade that runs three parallel Massive WS connections
 *              (stocks, forex, crypto) and fans all tick events to a single handler chain.
 *              When WS auth fails (plan does not include WS), automatically falls back to
 *              periodic REST polling and emits ticks via the same event interface.
 *
 * Exports:
 *   - classifyMassiveSymbol(sym) → 'stocks' | 'forex' | 'crypto'  — asset-class classifier
 *   - MassiveMultiStreamClient                                      — composite ticker facade
 *
 * Depends on:
 *   - MassiveWebSocketClient — one instance per asset class, created directly (no DI)
 *   - MassiveRestClient      — injected at init() time; used only for REST polling fallback
 *
 * Side-effects:
 *   - Opens three outbound WebSocket connections when connect() is called
 *   - Starts a setInterval REST poller when WS auth fails (plan-level restriction)
 *
 * Key invariants:
 *   - classifyMassiveSymbol uses strict 6-char forex test first, then crypto base/quote lookup;
 *     anything else is stocks. False-positives are impossible for forex (both halves must be
 *     known ISO-4217 codes); crypto mis-classification falls back to stocks harmlessly.
 *   - REST polling starts on the FIRST auth_failed event across any sub-client.
 *     All three WS clients share the same API key, so if one fails auth all will.
 *   - isWsConnected() returns true during active REST polling so the streaming layer
 *     treats the provider as live and does not retry the connect loop.
 *   - Polling emits a synthetic 'connect' event on startup so the streaming layer
 *     begins forwarding ticks without waiting for a WS connect handshake.
 *   - MASSIVE_POLL_INTERVAL_MS env var (default 5000 ms) controls the polling cadence.
 *     Keep it ≥ 2000 ms to avoid REST rate-limit exhaustion.
 *
 * Read order:
 *   1. classifyMassiveSymbol — routing logic
 *   2. MassiveMultiStreamClient — facade wiring
 *   3. pollOnce / pollClass — REST fallback tick emission
 *
 * Author:      BharatERP
 * Last-updated: 2026-04-27
 */
import { Logger } from '@nestjs/common';
import {
  MassiveWebSocketClient,
  MassiveCanonicalTick,
} from './massive-websocket.client';
import { MassiveRestClient } from './massive-rest.client';

// ─── Asset-class classifier ───────────────────────────────────────────────────

/** ISO 4217 3-letter currency codes actively traded as forex pairs on Massive. */
const FOREX_CURRENCIES = new Set([
  'AED',
  'AFN',
  'ALL',
  'AMD',
  'ANG',
  'AOA',
  'ARS',
  'AUD',
  'AWG',
  'AZN',
  'BAM',
  'BBD',
  'BDT',
  'BGN',
  'BHD',
  'BND',
  'BOB',
  'BRL',
  'BSD',
  'BWP',
  'BYN',
  'BZD',
  'CAD',
  'CDF',
  'CHF',
  'CLP',
  'CNH',
  'CNY',
  'COP',
  'CRC',
  'CZK',
  'DJF',
  'DKK',
  'DOP',
  'DZD',
  'EGP',
  'ETB',
  'EUR',
  'FJD',
  'GBP',
  'GEL',
  'GHS',
  'GMD',
  'GTQ',
  'GYD',
  'HKD',
  'HNL',
  'HRK',
  'HTG',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'IQD',
  'IRR',
  'ISK',
  'JMD',
  'JOD',
  'JPY',
  'KES',
  'KGS',
  'KHR',
  'KRW',
  'KWD',
  'KZT',
  'LAK',
  'LBP',
  'LKR',
  'LYD',
  'MAD',
  'MDL',
  'MKD',
  'MMK',
  'MNT',
  'MOP',
  'MUR',
  'MVR',
  'MWK',
  'MXN',
  'MYR',
  'MZN',
  'NAD',
  'NGN',
  'NIO',
  'NOK',
  'NPR',
  'NZD',
  'OMR',
  'PAB',
  'PEN',
  'PHP',
  'PKR',
  'PLN',
  'PYG',
  'QAR',
  'RON',
  'RSD',
  'RUB',
  'RWF',
  'SAR',
  'SCR',
  'SDG',
  'SEK',
  'SGD',
  'SLL',
  'SOS',
  'SRD',
  'STD',
  'SVC',
  'SYP',
  'SZL',
  'THB',
  'TJS',
  'TMT',
  'TND',
  'TRY',
  'TTD',
  'TWD',
  'TZS',
  'UAH',
  'UGX',
  'USD',
  'UYU',
  'UZS',
  'VEF',
  'VND',
  'VUV',
  'WST',
  'XAF',
  'XCD',
  'XOF',
  'XPF',
  'YER',
  'ZAR',
  'ZMW',
]);

/** Well-known crypto base tokens traded on Massive. */
const CRYPTO_BASES = new Set([
  'AAVE',
  'ADA',
  'ALGO',
  'APE',
  'APT',
  'ARB',
  'ATOM',
  'AVAX',
  'AXS',
  'BAL',
  'BAT',
  'BCH',
  'BNB',
  'BTC',
  'BUSD',
  'CHZ',
  'COMP',
  'CRV',
  'DAI',
  'DASH',
  'DOGE',
  'DOT',
  'EOS',
  'ETC',
  'ETH',
  'FIL',
  'FTM',
  'FLOW',
  'GALA',
  'GRT',
  'HBAR',
  'ICP',
  'IMX',
  'INJ',
  'LINK',
  'LRC',
  'LTC',
  'LUNA',
  'MANA',
  'MATIC',
  'MKR',
  'NEAR',
  'NEO',
  'ONE',
  'OP',
  'PEPE',
  'QNT',
  'RUNE',
  'SAND',
  'SHIB',
  'SNX',
  'SOL',
  'STX',
  'SUSHI',
  'THETA',
  'TRX',
  'UNI',
  'VET',
  'WAVES',
  'XLM',
  'XMR',
  'XRP',
  'XTZ',
  'YFI',
  'ZEC',
  'ZRX',
]);

/** Quote currencies for crypto pairs — ordered longest-first to avoid prefix shadowing. */
const CRYPTO_QUOTES = [
  'USDT',
  'USDC',
  'BUSD',
  'USD',
  'BTC',
  'ETH',
  'EUR',
  'GBP',
] as const;

/**
 * Classifies a Massive provider_token into its asset class.
 * Priority: forex (strict 6-char ISO test) → crypto (base+quote lookup) → stocks.
 */
export function classifyMassiveSymbol(
  sym: string,
): 'stocks' | 'forex' | 'crypto' {
  const s = sym.toUpperCase();

  if (s.length === 6) {
    const base = s.slice(0, 3);
    const quote = s.slice(3);
    if (FOREX_CURRENCIES.has(base) && FOREX_CURRENCIES.has(quote))
      return 'forex';
  }

  for (const q of CRYPTO_QUOTES) {
    if (s.endsWith(q) && s.length > q.length) {
      if (CRYPTO_BASES.has(s.slice(0, -q.length))) return 'crypto';
    }
  }

  return 'stocks';
}

// ─── Composite facade ─────────────────────────────────────────────────────────

type TickerEvent = 'ticks' | 'connect' | 'disconnect' | 'error';
type TickerHandler = (...args: any[]) => void;

/**
 * Aggregates three MassiveWebSocketClient connections (stocks / forex / crypto)
 * into a single TickerLike facade expected by MarketDataStreamService.
 *
 * When WS auth fails (plan restriction), automatically switches to REST polling mode:
 *   - Polls all three asset classes on the same interval
 *   - Converts REST snapshots to canonical MassiveCanonicalTick objects
 *   - Emits them via the same 'ticks' event so callers need no special handling
 */
export class MassiveMultiStreamClient {
  private readonly logger = new Logger(MassiveMultiStreamClient.name);

  readonly stocks = new MassiveWebSocketClient();
  readonly forex = new MassiveWebSocketClient();
  readonly crypto = new MassiveWebSocketClient();

  private readonly subClients: ReadonlyArray<
    readonly [MassiveWebSocketClient, string]
  > = [
    [this.stocks, 'stocks'],
    [this.forex, 'forex'],
    [this.crypto, 'crypto'],
  ] as const;

  private handlers = new Map<TickerEvent, TickerHandler[]>();

  // REST polling fallback state
  private rest: MassiveRestClient | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private isPollingActive = false;
  private pollInFlight = false;
  private readonly pollIntervalMs: number = parseInt(
    process.env.MASSIVE_POLL_INTERVAL_MS ?? '5000',
    10,
  );

  constructor() {
    for (const [client] of this.subClients) {
      client.on('ticks', (ticks) => this.emit('ticks', ticks));
      client.on('connect', () => this.emit('connect'));
      client.on('disconnect', () => this.emit('disconnect'));
      client.on('error', (err: Error) => {
        this.emit('error', err);
        // Auth-failed means no WS access on this plan — fall back to REST polling.
        if (err?.message === 'Massive WS auth failed') {
          this.maybeStartRestPolling();
        }
      });
    }
  }

  on(event: TickerEvent, handler: TickerHandler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
  }

  private emit(event: TickerEvent, ...args: any[]): void {
    for (const h of this.handlers.get(event) ?? []) {
      try {
        h(...args);
      } catch {}
    }
  }

  /** Sets the API key on all three sub-clients and stores the REST client for polling. */
  init(apiKey: string, rest?: MassiveRestClient): void {
    this.rest = rest ?? null;
    this.stocks.init(apiKey, true, 'stocks');
    this.forex.init(apiKey, true, 'forex');
    this.crypto.init(apiKey, true, 'crypto');
  }

  isReady(): boolean {
    return this.stocks.isReady();
  }

  connect(): void {
    for (const [client, name] of this.subClients) {
      this.logger.log(`[MultiStream] Connecting ${name}`);
      client.connect();
    }
  }

  disconnect(): void {
    for (const [client] of this.subClients) client.disconnect();
    this.stopRestPolling();
  }

  subscribe(tokens: (string | number)[], mode?: string): void {
    const b = this.bucket(tokens);
    if (b.stocks.length) this.stocks.subscribe(b.stocks, mode);
    if (b.forex.length) this.forex.subscribe(b.forex, mode);
    if (b.crypto.length) this.crypto.subscribe(b.crypto, mode);
  }

  unsubscribe(tokens: (string | number)[]): void {
    const b = this.bucket(tokens);
    if (b.stocks.length) this.stocks.unsubscribe(b.stocks);
    if (b.forex.length) this.forex.unsubscribe(b.forex);
    if (b.crypto.length) this.crypto.unsubscribe(b.crypto);
  }

  private bucket(
    tokens: (string | number)[],
  ): Record<'stocks' | 'forex' | 'crypto', string[]> {
    const out: Record<'stocks' | 'forex' | 'crypto', string[]> = {
      stocks: [],
      forex: [],
      crypto: [],
    };
    for (const t of tokens) {
      const s = String(t);
      if (!s || /^\d+$/.test(s)) continue;
      out[classifyMassiveSymbol(s)].push(s);
    }
    return out;
  }

  /**
   * Returns true when either WS connections are live OR REST polling is active.
   * Returning true during polling prevents the streaming layer's connect-retry loop.
   */
  isWsConnected(): boolean {
    return (
      this.isPollingActive || this.subClients.some(([c]) => c.isWsConnected())
    );
  }

  getSubscribedCount(): number {
    return this.subClients.reduce((n, [c]) => n + c.getSubscribedCount(), 0);
  }

  getClientStatuses(): Array<{
    name: string;
    isConnected: boolean;
    subscribedCount: number;
  }> {
    return this.subClients.map(([c, name]) => ({
      name,
      isConnected: c.isWsConnected() || this.isPollingActive,
      subscribedCount: c.getSubscribedCount(),
    }));
  }

  // ─── REST polling fallback ────────────────────────────────────────────────

  private maybeStartRestPolling(): void {
    if (this.isPollingActive) return;
    if (!this.rest?.isReady()) {
      this.logger.warn(
        '[MultiStream] REST client not ready — cannot start polling fallback',
      );
      return;
    }
    this.logger.warn(
      `[MultiStream] WS plan restriction detected — starting REST polling fallback ` +
        `(interval=${this.pollIntervalMs}ms) for stocks + forex + crypto`,
    );
    this.isPollingActive = true;
    // Emit a synthetic connect so the streaming layer stops retrying and starts routing ticks.
    this.emit('connect');
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    // Fire immediately so first ticks arrive without waiting one full interval.
    void this.pollOnce();
  }

  private stopRestPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.isPollingActive = false;
    this.logger.log('[MultiStream] REST polling stopped');
  }

  private async pollOnce(): Promise<void> {
    if (this.pollInFlight || !this.rest) return;
    this.pollInFlight = true;
    try {
      const [stockTicks, forexTicks, cryptoTicks] = await Promise.all([
        this.pollClass(this.stocks.getSubscribedTokens(), 'stocks'),
        this.pollClass(this.forex.getSubscribedTokens(), 'forex'),
        this.pollClass(this.crypto.getSubscribedTokens(), 'crypto'),
      ]);
      const all = [...stockTicks, ...forexTicks, ...cryptoTicks];
      if (all.length) this.emit('ticks', all);
    } catch (err) {
      this.logger.error('[MultiStream] REST poll error', err as any);
    } finally {
      this.pollInFlight = false;
    }
  }

  private async pollClass(
    tokens: string[],
    assetClass: 'stocks' | 'forex' | 'crypto',
  ): Promise<MassiveCanonicalTick[]> {
    if (!tokens.length || !this.rest) return [];

    // Massive REST requires asset-class-specific prefixes and locale/market params.
    // Stocks:  tickers=AAPL          locale=us     market=stocks  → key "AAPL"
    // Forex:   tickers=C:EURUSD      locale=global market=fx      → key "C:EURUSD"
    // Crypto:  tickers=X:BTCUSD      locale=global market=crypto  → key "X:BTCUSD"
    let prefixed: string[];
    let locale: string;
    let market: string;

    if (assetClass === 'forex') {
      prefixed = tokens.map((t) => `C:${t}`);
      locale = 'global';
      market = 'fx';
    } else if (assetClass === 'crypto') {
      prefixed = tokens.map((t) => `X:${t}`);
      locale = 'global';
      market = 'crypto';
    } else {
      prefixed = tokens;
      locale = 'us';
      market = 'stocks';
    }

    const snaps = await this.rest.getSnapshots(prefixed, locale, market);
    const ticks: MassiveCanonicalTick[] = [];

    for (const [sym, snap] of Object.entries(snaps)) {
      let token: string;
      let price: number;

      if (assetClass === 'forex') {
        // Strip "C:" prefix → "EURUSD" (matches provider_token in UIR)
        token = sym.replace(/^C:/i, '');
        const bid = snap.lastQuote?.p ?? 0;
        const ask = snap.lastQuote?.P ?? 0;
        price = bid && ask ? (bid + ask) / 2 : (snap.day?.c ?? 0);
      } else if (assetClass === 'crypto') {
        // Strip "X:" prefix → "BTCUSD"
        token = sym.replace(/^X:/i, '');
        price = snap.lastTrade?.p ?? snap.day?.c ?? 0;
      } else {
        token = sym;
        price = snap.lastTrade?.p ?? snap.day?.c ?? 0;
      }

      if (price > 0) {
        ticks.push({
          instrument_token: token,
          last_price: price,
          exchange: assetClass,
          volume: snap.day?.v,
          last_trade_time: snap.lastTrade?.t ?? snap.updated,
        });
      }
    }

    return ticks;
  }
}
