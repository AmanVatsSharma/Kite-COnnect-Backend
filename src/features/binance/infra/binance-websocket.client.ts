/**
 * @file binance-websocket.client.ts
 * @module binance
 * @description WebSocket facade for Binance.com (global) Spot combined-stream.
 *   Implements the duck-typed TickerLike interface expected by MarketDataStreamService
 *   (on / subscribe / unsubscribe / connect / disconnect). Translates Binance trade frames
 *   into the canonical tick shape keyed by symbol string.
 * @author BharatERP
 * @created 2026-04-26
 * @updated 2026-04-26
 *
 * Protocol details:
 *  - Single WS connection. Up to 1024 streams per connection.
 *  - No auth. Open socket, immediately fire 'connect' to the streaming layer.
 *  - Subscribe via JSON-RPC: {"method":"SUBSCRIBE","params":["btcusdt@trade",...],"id":N}
 *  - Acks come back as {"result":null,"id":N} (logged at debug level only).
 *  - Trade frames arrive wrapped: {"stream":"btcusdt@trade","data":{"e":"trade",...}}
 *  - Server sends ping every ~3 min — the `ws` library replies pong automatically.
 *  - Reconnect with exponential backoff (1s → 60s, jittered), capped at
 *    BINANCE_WS_RECONNECT_MAX_ATTEMPTS (env, default 10). Re-subscribes all tracked symbols.
 */
import { Logger } from '@nestjs/common';
import * as WebSocket from 'ws';
import {
  BINANCE_CANONICAL_EXCHANGE,
  BINANCE_MAX_STREAMS_PER_CONNECTION,
  BINANCE_STREAM_SUFFIX,
  BINANCE_WS_BASE,
} from '../binance.constants';
import {
  BinanceCanonicalTick,
  BinanceCombinedFrame,
  BinanceJsonRpcAck,
  BinanceJsonRpcError,
  BinanceTradeEvent,
} from '../dto/binance-ws-event.dto';

type TickerEvent = 'ticks' | 'connect' | 'disconnect' | 'error';
type TickerHandler = (...args: any[]) => void;

export class BinanceWebSocketClient {
  private readonly logger = new Logger(BinanceWebSocketClient.name);

  private ws: WebSocket | null = null;
  private isConnected = false;
  private shouldReconnect = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts: number;

  /** Active uppercase symbol subscriptions kept for re-subscribe after reconnect. */
  private readonly subscribedSymbols = new Set<string>();

  /** Monotonic id counter for JSON-RPC SUBSCRIBE/UNSUBSCRIBE frames. */
  private nextId = 1;

  private readonly handlers = new Map<TickerEvent, TickerHandler[]>();

  constructor() {
    const cap = Number(process.env.BINANCE_WS_RECONNECT_MAX_ATTEMPTS ?? '10');
    this.maxReconnectAttempts = Number.isFinite(cap) && cap > 0 ? cap : 10;
  }

  // ── TickerLike: event API ────────────────────────────────────────────────

  on(event: TickerEvent, handler: TickerHandler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
  }

  private emit(event: TickerEvent, ...args: any[]): void {
    for (const h of this.handlers.get(event) ?? []) {
      try {
        h(...args);
      } catch {
        /* ignore handler throws — never let one bad listener break others */
      }
    }
  }

  // ── TickerLike: lifecycle ────────────────────────────────────────────────

  connect(): void {
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
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.isConnected = false;
    this.logger.log('[Binance WS] Disconnected');
  }

  // ── TickerLike: subscribe / unsubscribe ──────────────────────────────────

  /**
   * Symbols are normalized to uppercase. Numeric-looking tokens (UIR ids passed by
   * mistake from upstream chunking) are filtered out — same defensive guard as Massive.
   */
  subscribe(tokens: (string | number)[], _mode?: string): void {
    void _mode;
    const symbols = this.normalizeTokens(tokens);
    if (symbols.length === 0) return;

    const overflow =
      this.subscribedSymbols.size +
      symbols.length -
      BINANCE_MAX_STREAMS_PER_CONNECTION;
    if (overflow > 0) {
      this.logger.warn(
        `[Binance WS] subscribe(${symbols.length}) would exceed ${BINANCE_MAX_STREAMS_PER_CONNECTION}-stream cap (current=${this.subscribedSymbols.size}); truncating ${overflow}`,
      );
      symbols.splice(symbols.length - overflow);
    }

    for (const s of symbols) this.subscribedSymbols.add(s);

    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(symbols);
    }
    // Otherwise the open-handler re-subscribes everything from subscribedSymbols.
  }

  unsubscribe(tokens: (string | number)[]): void {
    const symbols = this.normalizeTokens(tokens).filter((s) =>
      this.subscribedSymbols.has(s),
    );
    if (symbols.length === 0) return;

    for (const s of symbols) this.subscribedSymbols.delete(s);

    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          method: 'UNSUBSCRIBE',
          params: symbols.map(this.streamFor),
          id: this.nextId++,
        }),
      );
      this.logger.debug(
        `[Binance WS] UNSUBSCRIBE ${symbols.length} (${symbols.slice(0, 3).join(',')}…)`,
      );
    }
  }

  /** Mode is a no-op for the v1 @trade-only client. Kept for TickerLike compatibility. */
  setMode(_mode: string, _tokens: (string | number)[]): void {
    void _mode;
    void _tokens;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private normalizeTokens(tokens: (string | number)[]): string[] {
    const seen = new Set<string>();
    for (const t of tokens) {
      const s = String(t).toUpperCase().trim();
      if (!s) continue;
      if (/^\d+$/.test(s)) continue; // skip stray UIR ids
      seen.add(s);
    }
    return Array.from(seen);
  }

  /** Build the stream channel name. v1 always @trade. */
  private readonly streamFor = (symbol: string): string =>
    `${symbol.toLowerCase()}${BINANCE_STREAM_SUFFIX.TRADE}`;

  private openConnection(): void {
    this.logger.log(`[Binance WS] Connecting to ${BINANCE_WS_BASE}`);

    let socket: WebSocket;
    try {
      socket = new WebSocket(BINANCE_WS_BASE);
    } catch (err) {
      this.logger.error(
        '[Binance WS] Failed to construct WebSocket',
        err as any,
      );
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.on('open', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.logger.log(
        `[Binance WS] Connected. Re-subscribing ${this.subscribedSymbols.size} tracked symbols`,
      );
      this.emit('connect');
      if (this.subscribedSymbols.size > 0) {
        this.sendSubscribe(Array.from(this.subscribedSymbols));
      }
    });

    socket.on('message', (raw: Buffer | string) => {
      this.handleMessage(raw.toString());
    });

    socket.on('close', (_code: number, reason: Buffer) => {
      const wasConnected = this.isConnected;
      this.isConnected = false;
      this.logger.warn(
        `[Binance WS] Closed (reason=${reason?.toString() || 'none'})`,
      );
      if (wasConnected) this.emit('disconnect');
      this.scheduleReconnect();
    });

    socket.on('error', (err: Error) => {
      this.logger.error('[Binance WS] Error', err as any);
      this.emit('error', err);
    });
  }

  private sendSubscribe(symbols: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const params = symbols.map(this.streamFor);
    this.ws.send(
      JSON.stringify({ method: 'SUBSCRIBE', params, id: this.nextId++ }),
    );
    this.logger.log(
      `[Binance WS] SUBSCRIBE ${symbols.length} (${symbols.slice(0, 5).join(',')}${symbols.length > 5 ? `…+${symbols.length - 5}` : ''})`,
    );
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.debug('[Binance WS] Non-JSON frame discarded');
      return;
    }

    if (this.isAck(parsed)) {
      this.logger.debug(`[Binance WS] ack id=${parsed.id}`);
      return;
    }
    if (this.isError(parsed)) {
      this.logger.warn(
        `[Binance WS] error id=${parsed.id} code=${parsed.error.code} msg=${parsed.error.msg}`,
      );
      return;
    }
    if (this.isCombinedFrame(parsed)) {
      const payload = (parsed as BinanceCombinedFrame).data;
      if (this.isTradeEvent(payload)) {
        const tick = this.tradeToTick(payload);
        if (tick) this.emit('ticks', [tick]);
      }
      return;
    }
    // Some Binance frames arrive un-wrapped when only a single stream is requested.
    if (this.isTradeEvent(parsed)) {
      const tick = this.tradeToTick(parsed);
      if (tick) this.emit('ticks', [tick]);
    }
  }

  private tradeToTick(t: BinanceTradeEvent): BinanceCanonicalTick | null {
    const lp = Number(t.p);
    if (!Number.isFinite(lp)) return null;
    return {
      instrument_token: t.s,
      last_price: lp,
      exchange: BINANCE_CANONICAL_EXCHANGE,
      volume: Number(t.q),
      last_trade_time: t.T,
    };
  }

  // ── Type guards ──────────────────────────────────────────────────────────

  private isAck(v: unknown): v is BinanceJsonRpcAck {
    return (
      typeof v === 'object' &&
      v !== null &&
      'result' in v &&
      (v as any).result === null &&
      typeof (v as any).id === 'number'
    );
  }

  private isError(v: unknown): v is BinanceJsonRpcError {
    return (
      typeof v === 'object' &&
      v !== null &&
      'error' in v &&
      typeof (v as any).error === 'object' &&
      typeof (v as any).id === 'number'
    );
  }

  private isCombinedFrame(v: unknown): v is BinanceCombinedFrame {
    return (
      typeof v === 'object' &&
      v !== null &&
      typeof (v as any).stream === 'string' &&
      'data' in v
    );
  }

  private isTradeEvent(v: unknown): v is BinanceTradeEvent {
    return (
      typeof v === 'object' &&
      v !== null &&
      (v as any).e === 'trade' &&
      typeof (v as any).s === 'string' &&
      typeof (v as any).p === 'string'
    );
  }

  // ── Reconnect ────────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(
        `[Binance WS] Max reconnect attempts (${this.maxReconnectAttempts}) reached — giving up`,
      );
      return;
    }
    const base = Math.min(60_000, 1000 * Math.pow(2, this.reconnectAttempts));
    const delayMs = base + Math.random() * 1000;
    this.reconnectAttempts++;
    this.logger.log(
      `[Binance WS] Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${Math.round(delayMs)}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openConnection();
    }, delayMs);
  }

  // ── Health/status accessors used by BinanceProviderService.getShardStatus() ──

  isWsConnected(): boolean {
    return this.isConnected;
  }

  getSubscribedCount(): number {
    return this.subscribedSymbols.size;
  }

  getSubscribedSymbols(): string[] {
    return Array.from(this.subscribedSymbols);
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }
}
