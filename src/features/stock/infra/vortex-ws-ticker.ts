/**
 * @file vortex-ws-ticker.ts
 * @module stock
 * @description Rupeezy Vortex WebSocket sharded ticker: up to 3 sockets × 1000 instruments, mode upgrades, unified tick stream.
 * @author BharatERP
 * @created 2025-03-23
 *
 * Notes:
 * - Per Vortex docs: max 1000 instruments per WebSocket, max 3 concurrent WS per access_token.
 */
import { Logger } from '@nestjs/common';
import * as WebSocket from 'ws';

export type VortexMode = 'ltp' | 'ohlcv' | 'full';

export const VORTEX_MODE_PRIORITY: Record<VortexMode, number> = {
  ltp: 1,
  ohlcv: 2,
  full: 3,
};

function modeBeats(next: VortexMode, current: VortexMode): boolean {
  return VORTEX_MODE_PRIORITY[next] > VORTEX_MODE_PRIORITY[current];
}

export interface VortexWsShardDeps {
  streamUrl: string;
  shardIndex: number;
  maxSubscriptionsPerSocket: number;
  logger: Logger;
  parseBinaryTicks: (buf: Buffer) => any[];
  getExchangesForTokens: (
    tokens: string[],
  ) => Promise<Map<string, 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'>>;
  getAccessToken: () => string | null;
  getConfigAccessToken: () => string | undefined;
  maxReconnectAttempts: number;
  onReconnectAttempt?: () => void;
  /** Invoked after a shard open/close; parent recomputes aggregate connectivity. */
  onShardConnectedChange?: () => void;
  metrics?: {
    incSubscribeDropped: (reason: string) => void;
  };
}

/**
 * One Vortex WebSocket connection (≤ maxSubscriptionsPerSocket instruments).
 */
export class VortexWebSocketShard {
  private ws: WebSocket | null = null;
  private handlers: Record<string, Function[]> = {};
  private subscribed: Set<number> = new Set();
  private modeByToken: Map<number, VortexMode> = new Map();
  private exchangeByToken: Map<
    number,
    'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'
  > = new Map();
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private reconnectAttempts = 0;
  private pendingSubscribe: Array<{ tokens: number[]; mode: VortexMode }> = [];

  constructor(private readonly deps: VortexWsShardDeps) {}

  get index(): number {
    return this.deps.shardIndex;
  }

  getSubscribedCount(): number {
    return this.subscribed.size;
  }

  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  on(event: string, fn: Function) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(fn);
  }

  emit(event: string, ...args: any[]) {
    (this.handlers[event] || []).forEach((h) => {
      try {
        h(...args);
      } catch {
        /* ignore */
      }
    });
  }

  primeExchangeMapping(
    pairs: Array<{
      token: number;
      exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO';
    }>,
  ) {
    try {
      for (const p of pairs || []) {
        if (Number.isFinite(p?.token as any) && p?.exchange) {
          this.exchangeByToken.set(Number(p.token), p.exchange);
        }
      }
      this.deps.logger.debug(
        `[Vortex] shard=${this.deps.shardIndex} primed exchange mapping count=${pairs?.length || 0}`,
      );
    } catch (e) {
      this.deps.logger.warn(
        `[Vortex] shard=${this.deps.shardIndex} primeExchangeMapping failed`,
        e as any,
      );
    }
  }

  connect() {
    const token =
      this.deps.getAccessToken() || this.deps.getConfigAccessToken();
    if (!token) {
      this.deps.logger.warn(
        `[Vortex] shard=${this.deps.shardIndex} No access_token for WS; did you login?`,
      );
      return;
    }
    const url = `${this.deps.streamUrl}?auth_token=${encodeURIComponent(token)}`;
    this.deps.logger.log(
      `[Vortex] shard=${this.deps.shardIndex} WS connecting to ${url.replace(token, '***')}`,
    );
    this.ws = new WebSocket(url);
    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.deps.logger.log(
        `[Vortex] shard=${this.deps.shardIndex} WS connected successfully`,
      );
      this.deps.onShardConnectedChange?.();
      this.startHeartbeat();
      if (this.subscribed.size > 0) {
        this.deps.logger.log(
          `[Vortex] shard=${this.deps.shardIndex} Resubscribing ${this.subscribed.size} tokens`,
        );
        this.resubscribeAll();
      }
      this.flushPendingSubscribe();
    });
    this.ws.on('close', (code, reason) => {
      this.deps.logger.warn(
        `[Vortex] shard=${this.deps.shardIndex} WS disconnected code=${code} reason=${reason}`,
      );
      this.stopHeartbeat();
      this.deps.onShardConnectedChange?.();
      this.emit('disconnect');
      this.scheduleReconnect();
    });
    this.ws.on('error', (e) => {
      this.deps.logger.error(
        `[Vortex] shard=${this.deps.shardIndex} WS error`,
        e as any,
      );
      this.emit('error', e);
    });
    this.ws.on('ping', () => {
      try {
        this.ws?.pong();
      } catch {
        /* ignore */
      }
    });
    this.ws.on('pong', () => {
      this.lastPongAt = Date.now();
    });
    this.ws.on('message', (data: any) => {
      if (typeof data === 'string') {
        this.handleTextMessage(data.toString());
      } else if (Buffer.isBuffer(data)) {
        try {
          const ticks = this.deps.parseBinaryTicks(data);
          if (ticks.length) {
            this.deps.logger.debug(
              `[Vortex] shard=${this.deps.shardIndex} parsed ${ticks.length} binary ticks`,
            );
            this.emit('ticks', ticks);
          }
        } catch (e) {
          this.deps.logger.error(
            `[Vortex] shard=${this.deps.shardIndex} parse binary failed`,
            e as any,
          );
        }
      }
    });
  }

  disconnect() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  subscribe(tokens: number[], mode: VortexMode = 'ltp') {
    if (!tokens.length) return;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingSubscribe.push({ tokens: [...tokens], mode });
      this.deps.logger.debug(
        `[Vortex] shard=${this.deps.shardIndex} queue subscribe pending=${this.pendingSubscribe.length} tokens=${tokens.length} mode=${mode}`,
      );
      return;
    }

    const toUpgrade: number[] = [];
    const fresh: number[] = [];
    for (const t of tokens) {
      if (this.subscribed.has(t)) {
        const cur = this.modeByToken.get(t) || 'ltp';
        if (modeBeats(mode, cur)) {
          toUpgrade.push(t);
          this.modeByToken.set(t, mode);
        }
      } else {
        fresh.push(t);
      }
    }

    if (toUpgrade.length > 0) {
      this.runUpgradeSubscribe(toUpgrade, mode);
    }

    const cap = this.deps.maxSubscriptionsPerSocket;
    const available = Math.max(0, cap - this.subscribed.size);
    const toAdd = fresh.slice(0, available);
    const dropped = fresh.slice(available);

    if (toAdd.length === 0 && fresh.length > 0) {
      this.deps.logger.warn(
        `[Vortex] shard=${this.deps.shardIndex} limit (${cap}) reached; dropping ${fresh.length} new tokens`,
      );
      try {
        this.deps.metrics?.incSubscribeDropped('shard_full');
      } catch {
        /* ignore */
      }
    }

    if (dropped.length) {
      try {
        this.deps.metrics?.incSubscribeDropped('shard_full');
      } catch {
        /* ignore */
      }
    }

    toAdd.forEach((token) => this.modeByToken.set(token, mode));

    if (toAdd.length === 0) return;

    this.deps.logger.log(
      `[Vortex] shard=${this.deps.shardIndex} subscribing ${toAdd.length} new tokens mode=${mode}`,
    );

    void this.runNewSubscribes(toAdd, mode);
  }

  private flushPendingSubscribe() {
    const q = this.pendingSubscribe.splice(0);
    for (const batch of q) {
      this.subscribe(batch.tokens, batch.mode);
    }
  }

  private runUpgradeSubscribe(tokens: number[], mode: VortexMode) {
    void (async () => {
      try {
        const missing = tokens.filter((t) => !this.exchangeByToken.has(t));
        if (missing.length) {
          const exMapRaw = await this.deps.getExchangesForTokens(
            missing.map((t) => String(t)),
          );
          missing.forEach((t) => {
            const ex = exMapRaw.get(String(t));
            if (ex) this.exchangeByToken.set(t, ex);
          });
        }
      } catch (e) {
        this.deps.logger.warn(
          `[Vortex] shard=${this.deps.shardIndex} upgrade exchange resolution failed`,
          e as any,
        );
      }
      for (const t of tokens) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;
        const ex = this.exchangeByToken.get(t);
        if (!ex) {
          this.deps.logger.warn(
            `[Vortex] shard=${this.deps.shardIndex} skip mode upgrade token=${t} (no exchange)`,
          );
          continue;
        }
        this.sendFrame({
          exchange: ex,
          token: t,
          mode,
          message_type: 'subscribe',
        });
      }
      if (tokens.length) {
        this.deps.logger.log(
          `[Vortex] shard=${this.deps.shardIndex} mode upgraded to ${mode} for ${tokens.length} tokens`,
        );
      }
    })();
  }

  private async runNewSubscribes(toAdd: number[], mode: VortexMode) {
    try {
      const exMapRaw = await this.deps.getExchangesForTokens(
        toAdd.map((t) => String(t)),
      );
      const ok: number[] = [];
      for (const t of toAdd) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          this.deps.logger.warn(
            `[Vortex] shard=${this.deps.shardIndex} WS closed while subscribing token=${t}`,
          );
          break;
        }
        const tokenMode = this.modeByToken.get(t) || mode;
        const ex =
          this.exchangeByToken.get(t) ||
          (exMapRaw.get(String(t)) as
            | 'NSE_EQ'
            | 'NSE_FO'
            | 'NSE_CUR'
            | 'MCX_FO'
            | undefined);
        if (!ex) {
          this.deps.logger.warn(
            `[Vortex] shard=${this.deps.shardIndex} skip token=${t} (exchange unresolved)`,
          );
          continue;
        }
        this.exchangeByToken.set(t, ex);
        this.sendFrame({
          exchange: ex,
          token: t,
          mode: tokenMode,
          message_type: 'subscribe',
        });
        this.subscribed.add(t);
        ok.push(t);
      }
      if (ok.length) {
        this.deps.logger.log(
          `[Vortex] shard=${this.deps.shardIndex} subscribed ${ok.length}/${toAdd.length} mode=${mode}`,
        );
      }
    } catch (e) {
      this.deps.logger.error(
        `[Vortex] shard=${this.deps.shardIndex} subscribe batch failed`,
        e as any,
      );
    }
  }

  unsubscribe(tokens: number[]) {
    void (async () => {
      try {
        const missing = tokens.filter((t) => !this.exchangeByToken.has(t));
        if (missing.length) {
          const exMapRaw = await this.deps.getExchangesForTokens(
            missing.map((t) => String(t)),
          );
          missing.forEach((t) => {
            const ex = exMapRaw.get(String(t)) as
              | 'NSE_EQ'
              | 'NSE_FO'
              | 'NSE_CUR'
              | 'MCX_FO'
              | undefined;
            if (ex) this.exchangeByToken.set(t, ex);
          });
        }
      } catch (e) {
        this.deps.logger.warn(
          `[Vortex] shard=${this.deps.shardIndex} unsubscribe exchange resolution failed`,
          e as any,
        );
      }
      for (const t of tokens) {
        const ex = this.exchangeByToken.get(t);
        if (!ex) {
          this.deps.logger.warn(
            `[Vortex] shard=${this.deps.shardIndex} skip unsubscribe token=${t}`,
          );
          continue;
        }
        const m = this.modeByToken.get(t) || 'ltp';
        this.sendFrame({
          exchange: ex,
          token: t,
          mode: m,
          message_type: 'unsubscribe',
        });
        this.subscribed.delete(t);
        this.modeByToken.delete(t);
        this.exchangeByToken.delete(t);
      }
      if (tokens.length) {
        this.deps.logger.log(
          `[Vortex] shard=${this.deps.shardIndex} unsubscribed ${tokens.length} tokens`,
        );
      }
    })();
  }

  setMode(mode: string, tokens: number[]) {
    const m = mode as VortexMode;
    const target = tokens.filter((t) => this.subscribed.has(t));
    target.forEach((t) => this.modeByToken.set(t, m));
    if (target.length) {
      this.runUpgradeSubscribe(target, m);
    }
  }

  private sendFrame(obj: any) {
    try {
      const message = JSON.stringify(obj);
      this.ws?.send(message);
      this.deps.logger.debug(
        `[Vortex] shard=${this.deps.shardIndex} sent ${message}`,
      );
    } catch (e) {
      this.deps.logger.error(
        `[Vortex] shard=${this.deps.shardIndex} send failed`,
        e as any,
      );
    }
  }

  private handleTextMessage(raw: string) {
    try {
      const j = JSON.parse(raw);
      if (
        j?.message_type === 'subscribed' ||
        j?.status === 'subscribed' ||
        (j?.type === 'subscription' && j?.status === 'success')
      ) {
        const token = j?.token;
        const exchange = j?.exchange;
        if (token && !this.subscribed.has(token)) {
          this.subscribed.add(token);
          this.deps.logger.log(
            `[Vortex] shard=${this.deps.shardIndex} server confirmed token=${token} ex=${exchange || '?'}`,
          );
        }
      } else if (
        j?.message_type === 'unsubscribed' ||
        j?.status === 'unsubscribed'
      ) {
        const token = j?.token;
        if (token) {
          this.subscribed.delete(token);
          this.modeByToken.delete(token);
          this.exchangeByToken.delete(token);
        }
      } else if (
        j?.error ||
        j?.status === 'error' ||
        j?.message_type === 'error'
      ) {
        const token = j?.token;
        const errorMsg = j?.error || j?.message || 'Unknown error';
        if (token) {
          this.subscribed.delete(token);
          this.modeByToken.delete(token);
          this.exchangeByToken.delete(token);
          this.deps.logger.error(
            `[Vortex] shard=${this.deps.shardIndex} subscription error token=${token}: ${errorMsg}`,
          );
        } else {
          this.deps.logger.error(
            `[Vortex] shard=${this.deps.shardIndex} error: ${errorMsg}`,
          );
        }
      } else if (j?.type === 'postback') {
        this.deps.logger.debug(
          `[Vortex] shard=${this.deps.shardIndex} postback`,
        );
      } else {
        this.deps.logger.debug(
          `[Vortex] shard=${this.deps.shardIndex} text: ${raw}`,
        );
      }
    } catch (e) {
      this.deps.logger.warn(
        `[Vortex] shard=${this.deps.shardIndex} parse text failed`,
        e as any,
      );
    }
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.deps.maxReconnectAttempts) return;
    this.deps.onReconnectAttempt?.();
    const base = 1000 * Math.pow(1.5, this.reconnectAttempts++);
    const jitter = Math.floor(Math.random() * 300);
    const delay = base + jitter;
    setTimeout(() => this.connect(), delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.pingTimer = setInterval(() => {
      try {
        this.ws?.ping?.();
        this.sendFrame({ type: 'ping', t: Date.now() });
      } catch {
        /* ignore */
      }
      if (Date.now() - this.lastPongAt > 60000) {
        try {
          this.ws?.terminate?.();
        } catch {
          /* ignore */
        }
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
    void (async () => {
      try {
        const missing = tokens.filter((t) => !this.exchangeByToken.has(t));
        if (missing.length) {
          const exMapRaw = await this.deps.getExchangesForTokens(
            missing.map((t) => String(t)),
          );
          missing.forEach((t) => {
            const ex = exMapRaw.get(String(t)) as
              | 'NSE_EQ'
              | 'NSE_FO'
              | 'NSE_CUR'
              | 'MCX_FO'
              | undefined;
            if (ex) this.exchangeByToken.set(t, ex);
          });
        }
      } catch (e) {
        this.deps.logger.warn(
          `[Vortex] shard=${this.deps.shardIndex} resubscribeAll map failed`,
          e as any,
        );
      }
      const toResub = tokens.filter((t) => this.exchangeByToken.has(t));
      for (const t of toResub) {
        const mode = this.modeByToken.get(t) || 'ltp';
        const ex = this.exchangeByToken.get(t)!;
        this.sendFrame({
          exchange: ex,
          token: t,
          mode,
          message_type: 'subscribe',
        });
      }
      this.deps.logger.log(
        `[Vortex] shard=${this.deps.shardIndex} resent subscribe for ${toResub.length}/${tokens.length} tokens`,
      );
    })();
  }
}

export interface VortexShardedTickerDeps {
  streamUrl: string;
  maxShards: number;
  maxSubscriptionsPerSocket: number;
  logger: Logger;
  parseBinaryTicks: (buf: Buffer) => any[];
  getExchangesForTokens: (
    tokens: string[],
  ) => Promise<Map<string, 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'>>;
  getAccessToken: () => string | null;
  getConfigAccessToken: () => string | undefined;
  maxReconnectAttempts: number;
  onParentWsConnected?: (anyConnected: boolean) => void;
  metrics?: {
    incSubscribeDropped: (reason: string) => void;
    setShardsConnected: (n: number) => void;
  };
}

/**
 * Facade: routes instruments across up to `maxShards` WebSocket connections.
 */
export class VortexShardedTicker {
  private readonly shards: VortexWebSocketShard[] = [];
  private readonly tokenToShard: Map<number, number> = new Map();
  private handlers: Record<string, Function[]> = {};
  private aggregateConnectEmitted = false;

  constructor(private readonly deps: VortexShardedTickerDeps) {
    const tickerSelf = this;
    for (let i = 0; i < deps.maxShards; i++) {
      const shard = new VortexWebSocketShard({
        streamUrl: deps.streamUrl,
        shardIndex: i,
        maxSubscriptionsPerSocket: deps.maxSubscriptionsPerSocket,
        logger: deps.logger,
        parseBinaryTicks: deps.parseBinaryTicks,
        getExchangesForTokens: deps.getExchangesForTokens,
        getAccessToken: deps.getAccessToken,
        getConfigAccessToken: deps.getConfigAccessToken,
        maxReconnectAttempts: deps.maxReconnectAttempts,
        onReconnectAttempt: () => {
          /* optional hook */
        },
        onShardConnectedChange: () => {
          const n = tickerSelf.shards.filter((s) => s.isConnected()).length;
          try {
            deps.metrics?.setShardsConnected(n);
          } catch {
            /* ignore */
          }
          const anyConn = n > 0;
          deps.onParentWsConnected?.(anyConn);
          if (anyConn && !tickerSelf.aggregateConnectEmitted) {
            tickerSelf.aggregateConnectEmitted = true;
            tickerSelf.emit('connect');
          }
          if (!anyConn && tickerSelf.aggregateConnectEmitted) {
            tickerSelf.aggregateConnectEmitted = false;
            tickerSelf.emit('disconnect');
          }
        },
        metrics: deps.metrics,
      });
      shard.on('ticks', (ticks: any[]) => tickerSelf.emit('ticks', ticks));
      shard.on('error', (err: any) => tickerSelf.emit('error', err));
      this.shards.push(shard);
    }
  }

  on(event: string, fn: Function) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(fn);
  }

  emit(event: string, ...args: any[]) {
    (this.handlers[event] || []).forEach((h) => {
      try {
        h(...args);
      } catch {
        /* ignore */
      }
    });
  }

  primeExchangeMapping(
    pairs: Array<{
      token: number;
      exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO';
    }>,
  ) {
    for (const s of this.shards) {
      s.primeExchangeMapping(pairs);
    }
  }

  connect() {
    this.shards[0]?.connect();
  }

  disconnect() {
    for (const s of this.shards) {
      s.disconnect();
    }
  }

  subscribe(tokens: number[], mode: VortexMode = 'ltp') {
    if (!tokens.length) return;

    const byShard = new Map<number, number[]>();
    const fresh: number[] = [];

    for (const t of tokens) {
      const idx = this.tokenToShard.get(t);
      if (idx !== undefined) {
        if (!byShard.has(idx)) byShard.set(idx, []);
        byShard.get(idx)!.push(t);
      } else {
        fresh.push(t);
      }
    }

    for (const [idx, toks] of byShard) {
      this.shards[idx]?.subscribe(toks, mode);
    }

    const freshByShard = new Map<number, number[]>();
    for (const t of fresh) {
      const shard = this.pickShardForNewToken();
      if (!shard) {
        this.deps.logger.warn(
          `[Vortex] No shard capacity for token=${t} (max ${this.deps.maxShards}×${this.deps.maxSubscriptionsPerSocket})`,
        );
        try {
          this.deps.metrics?.incSubscribeDropped('all_shards_full');
        } catch {
          /* ignore */
        }
        continue;
      }
      this.tokenToShard.set(t, shard.index);
      if (!freshByShard.has(shard.index)) {
        freshByShard.set(shard.index, []);
      }
      freshByShard.get(shard.index)!.push(t);
    }

    for (const [idx, toks] of freshByShard) {
      if (!this.shards[idx]?.isConnected()) {
        this.shards[idx].connect();
      }
      this.shards[idx].subscribe(toks, mode);
    }
  }

  private pickShardForNewToken(): VortexWebSocketShard | null {
    for (const s of this.shards) {
      if (s.getSubscribedCount() < this.deps.maxSubscriptionsPerSocket) {
        return s;
      }
    }
    return null;
  }

  unsubscribe(tokens: number[]) {
    const byShard = new Map<number, number[]>();
    for (const t of tokens) {
      const idx = this.tokenToShard.get(t);
      if (idx !== undefined) {
        this.tokenToShard.delete(t);
        if (!byShard.has(idx)) byShard.set(idx, []);
        byShard.get(idx)!.push(t);
      }
    }
    for (const [idx, toks] of byShard) {
      this.shards[idx]?.unsubscribe(toks);
    }
  }

  setMode(mode: string, tokens: number[]) {
    const byShard = new Map<number, number[]>();
    for (const t of tokens) {
      const idx = this.tokenToShard.get(t);
      if (idx !== undefined) {
        if (!byShard.has(idx)) byShard.set(idx, []);
        byShard.get(idx)!.push(t);
      }
    }
    for (const [idx, toks] of byShard) {
      this.shards[idx]?.setMode(mode, toks);
    }
  }

  getTotalCapacity(): number {
    return this.deps.maxShards * this.deps.maxSubscriptionsPerSocket;
  }

  getShardCount(): number {
    return this.deps.maxShards;
  }

  getMaxPerSocket(): number {
    return this.deps.maxSubscriptionsPerSocket;
  }
}
