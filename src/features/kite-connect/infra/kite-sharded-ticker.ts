/**
 * @file kite-sharded-ticker.ts
 * @module kite-connect
 * @description Multi-shard Kite WebSocket ticker that manages N independent KiteTicker
 *   connections (each up to 3000 instruments). Exposes the same subscribe/unsubscribe/setMode
 *   interface as a single ticker so KiteProviderService needs no upstream changes beyond
 *   construction. Aggregates ticks and events from all shards transparently.
 *
 *   Routing: tokenToShard Map assigns each token to the first shard with available capacity.
 *   Per-shard reconnect uses exponential backoff independently from other shards.
 *   Auth errors disable reconnect on ALL shards (they share the same access token).
 * @author BharatERP
 * @created 2026-04-14
 */
import { Logger } from '@nestjs/common';
import { mapStreamModeToKiteMode } from './kite-ticker.facade';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { KiteTicker } = require('kiteconnect');

export interface KiteShardStatus {
  index: number;
  isConnected: boolean;
  subscribedCount: number;
  reconnectAttempts: number;
  reconnectCount: number;
  disableReconnect: boolean;
}

interface KiteShardState {
  index: number;
  inner: any; // raw KiteTicker SDK instance
  isConnected: boolean;
  reconnectAttempts: number;
  reconnectCount: number;
  disableReconnect: boolean;
  subscribedTokens: Set<number>;
  tokenModes: Map<number, string>; // token → kite upstream mode string
}

export interface KiteShardedTickerOptions {
  apiKey: string;
  accessToken: string;
  maxShards: number;
  perShardLimit?: number; // default 3000
  maxReconnectAttempts?: number; // default 10
  logger?: Logger;
  /** Called when any shard receives ticks. */
  onTick?: (ticks: any[]) => void;
  /** Called on aggregate connect (first shard or any shard re-connecting). */
  onConnect?: (shardIndex: number) => void;
  /** Called when any shard disconnects. */
  onDisconnect?: (shardIndex: number, args: any[]) => void;
  /** Called on auth error (disables all shards). */
  onAuthError?: (shardIndex: number, error: any) => void;
  /** Called when a shard hits max reconnect attempts. */
  onMaxReconnect?: (shardIndex: number) => void;
  /** Called on any other ticker error. */
  onError?: (shardIndex: number, error: any) => void;
}

export class KiteShardedTicker {
  private readonly shards: KiteShardState[] = [];
  private readonly tokenToShard: Map<number, number> = new Map();
  private readonly eventHandlers: Map<string, Array<(...args: any[]) => void>> =
    new Map();

  private readonly apiKey: string;
  private readonly accessToken: string;
  private readonly maxShards: number;
  private readonly perShardLimit: number;
  private readonly maxReconnectAttempts: number;
  private readonly logger: Logger;
  private readonly opts: KiteShardedTickerOptions;

  constructor(opts: KiteShardedTickerOptions) {
    this.apiKey = opts.apiKey;
    this.accessToken = opts.accessToken;
    this.maxShards = Math.max(1, opts.maxShards);
    this.perShardLimit = opts.perShardLimit ?? 3000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 10;
    this.logger = opts.logger ?? new Logger('KiteShardedTicker');
    this.opts = opts;
    this.build();
  }

  // ─── Build ────────────────────────────────────────────────────────────────

  private build(): void {
    for (let i = 0; i < this.maxShards; i++) {
      const inner = new KiteTicker({
        api_key: this.apiKey,
        access_token: this.accessToken,
      });
      const shard: KiteShardState = {
        index: i,
        inner,
        isConnected: false,
        reconnectAttempts: 0,
        reconnectCount: 0,
        disableReconnect: false,
        subscribedTokens: new Set(),
        tokenModes: new Map(),
      };
      this.attachShardHandlers(shard);
      this.shards.push(shard);
    }
    this.logger.log(
      `[KiteShardedTicker] Built ${this.maxShards} shard(s), capacity ${this.getSubscriptionLimit()} tokens`,
    );
  }

  private attachShardHandlers(shard: KiteShardState): void {
    const { inner } = shard;

    inner.on('connect', () => {
      shard.isConnected = true;
      shard.reconnectAttempts = 0;
      shard.disableReconnect = false;
      this.logger.log(`[KiteShardedTicker] Shard ${shard.index} connected`);
      // Resubscribe tokens if reconnecting with existing state
      if (shard.subscribedTokens.size > 0) {
        this.resubscribeShard(shard);
      }
      this.opts.onConnect?.(shard.index);
      this.emit('connect', shard.index);
    });

    inner.on('ticks', (ticks: any[]) => {
      this.opts.onTick?.(ticks);
      this.emit('ticks', ticks);
    });

    inner.on('disconnect', (...args: any[]) => {
      shard.isConnected = false;
      this.logger.warn(`[KiteShardedTicker] Shard ${shard.index} disconnected`);
      this.opts.onDisconnect?.(shard.index, args);
      this.emit('disconnect', shard.index, args);
      this.handleShardDisconnect(shard);
    });

    inner.on('error', (error: any) => {
      this.logger.error(
        `[KiteShardedTicker] Shard ${shard.index} error: ${error?.message ?? error}`,
      );
      if (this.isAuthError(error)) {
        // Disable ALL shards — shared access token
        for (const s of this.shards) {
          s.disableReconnect = true;
        }
        this.opts.onAuthError?.(shard.index, error);
        this.emit('error', error);
        try {
          inner.disconnect?.();
        } catch {}
      } else {
        this.opts.onError?.(shard.index, error);
        this.emit('error', error);
      }
    });

    inner.on('reconnect', (...args: any[]) => {
      this.logger.warn(
        `[KiteShardedTicker] Shard ${shard.index} reconnect event`,
      );
      this.emit('reconnect', shard.index, args);
    });

    inner.on('noreconnect', (...args: any[]) => {
      this.logger.warn(
        `[KiteShardedTicker] Shard ${shard.index} noreconnect event`,
      );
      this.emit('noreconnect', shard.index, args);
    });

    inner.on('close', (...args: any[]) => {
      this.logger.warn(`[KiteShardedTicker] Shard ${shard.index} close event`);
      this.emit('close', shard.index, args);
    });
  }

  // ─── Reconnect ────────────────────────────────────────────────────────────

  private handleShardDisconnect(shard: KiteShardState): void {
    if (shard.disableReconnect) {
      this.logger.warn(
        `[KiteShardedTicker] Shard ${shard.index} reconnect disabled (auth error)`,
      );
      return;
    }
    if (shard.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.warn(
        `[KiteShardedTicker] Shard ${shard.index} max reconnect attempts (${this.maxReconnectAttempts}) reached`,
      );
      this.opts.onMaxReconnect?.(shard.index);
      return;
    }
    shard.reconnectAttempts++;
    shard.reconnectCount++;
    const base = Math.min(30_000, 1000 * Math.pow(2, shard.reconnectAttempts));
    const jitter = Math.floor(Math.random() * 1000);
    const delayMs = base + jitter;
    this.logger.log(
      `[KiteShardedTicker] Shard ${shard.index} reconnecting in ${delayMs}ms (attempt ${shard.reconnectAttempts}/${this.maxReconnectAttempts})`,
    );
    setTimeout(() => {
      try {
        shard.inner.connect();
      } catch (e) {
        this.logger.error(
          `[KiteShardedTicker] Shard ${shard.index} reconnect call failed`,
          e as any,
        );
      }
    }, delayMs);
  }

  private resubscribeShard(shard: KiteShardState): void {
    const tokens = [...shard.subscribedTokens];
    if (!tokens.length) return;
    try {
      shard.inner.subscribe(tokens);
      // Re-apply modes grouped
      const modeGroups = new Map<string, number[]>();
      for (const [token, mode] of shard.tokenModes) {
        if (shard.subscribedTokens.has(token)) {
          if (!modeGroups.has(mode)) modeGroups.set(mode, []);
          modeGroups.get(mode)!.push(token);
        }
      }
      for (const [mode, modeTokens] of modeGroups) {
        shard.inner.setMode(mode, modeTokens);
      }
      this.logger.log(
        `[KiteShardedTicker] Shard ${shard.index} resubscribed ${tokens.length} tokens`,
      );
    } catch (e) {
      this.logger.error(
        `[KiteShardedTicker] Shard ${shard.index} resubscribe failed`,
        e as any,
      );
    }
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  private pickShard(): number {
    for (let i = 0; i < this.shards.length; i++) {
      if (this.shards[i].subscribedTokens.size < this.perShardLimit) return i;
    }
    return -1; // no capacity
  }

  // ─── Public interface (mirrors single KiteTicker facade) ──────────────────

  connect(): void {
    for (const shard of this.shards) {
      try {
        shard.inner.connect();
      } catch (e) {
        this.logger.error(
          `[KiteShardedTicker] Shard ${shard.index} connect() failed`,
          e as any,
        );
      }
    }
  }

  disconnect(): void {
    for (const shard of this.shards) {
      shard.disableReconnect = true; // prevent auto-reconnect after intentional disconnect
      try {
        shard.inner.disconnect?.();
      } catch {}
    }
  }

  /** Re-enable all shards for reconnect (used by restartTicker). */
  enableReconnect(): void {
    for (const shard of this.shards) {
      shard.disableReconnect = false;
      shard.reconnectAttempts = 0;
    }
  }

  subscribe(tokens: number[], mode?: string): number[] {
    if (!tokens.length) return tokens;
    const kiteMode = mode ? mapStreamModeToKiteMode(mode, {}) : undefined;

    // Separate existing vs new tokens
    const byShardNew: Map<number, number[]> = new Map();
    const byShardExist: Map<number, number[]> = new Map();
    const noCapacity: number[] = [];

    for (const token of tokens) {
      const existingShard = this.tokenToShard.get(token);
      if (existingShard !== undefined) {
        if (!byShardExist.has(existingShard))
          byShardExist.set(existingShard, []);
        byShardExist.get(existingShard)!.push(token);
      } else {
        const shardIdx = this.pickShard();
        if (shardIdx === -1) {
          noCapacity.push(token);
          continue;
        }
        this.tokenToShard.set(token, shardIdx);
        this.shards[shardIdx].subscribedTokens.add(token);
        if (!byShardNew.has(shardIdx)) byShardNew.set(shardIdx, []);
        byShardNew.get(shardIdx)!.push(token);
      }
    }

    if (noCapacity.length) {
      this.logger.warn(
        `[KiteShardedTicker] No capacity for ${noCapacity.length} tokens (all ${this.maxShards} shards full)`,
      );
      this.emit('capacity_exceeded', noCapacity);
    }

    // Subscribe new tokens
    for (const [shardIdx, newTokens] of byShardNew) {
      const shard = this.shards[shardIdx];
      try {
        shard.inner.subscribe(newTokens);
        if (kiteMode) {
          shard.inner.setMode(kiteMode, newTokens);
          for (const t of newTokens) shard.tokenModes.set(t, kiteMode);
        }
      } catch (e) {
        this.logger.error(
          `[KiteShardedTicker] Shard ${shardIdx} subscribe failed`,
          e as any,
        );
      }
    }

    // Apply mode to existing tokens if mode specified
    if (kiteMode) {
      for (const [shardIdx, existTokens] of byShardExist) {
        const shard = this.shards[shardIdx];
        try {
          shard.inner.setMode(kiteMode, existTokens);
          for (const t of existTokens) shard.tokenModes.set(t, kiteMode);
        } catch (e) {
          this.logger.error(
            `[KiteShardedTicker] Shard ${shardIdx} setMode failed`,
            e as any,
          );
        }
      }
    }

    return tokens;
  }

  setMode(mode: string, tokens: number[]): void {
    if (!tokens.length) return;
    const kiteMode = mapStreamModeToKiteMode(mode, {});
    const byShardIdx: Map<number, number[]> = new Map();
    for (const token of tokens) {
      const shardIdx = this.tokenToShard.get(token);
      if (shardIdx !== undefined) {
        if (!byShardIdx.has(shardIdx)) byShardIdx.set(shardIdx, []);
        byShardIdx.get(shardIdx)!.push(token);
      }
    }
    for (const [shardIdx, shardTokens] of byShardIdx) {
      const shard = this.shards[shardIdx];
      try {
        shard.inner.setMode(kiteMode, shardTokens);
        for (const t of shardTokens) shard.tokenModes.set(t, kiteMode);
      } catch (e) {
        this.logger.error(
          `[KiteShardedTicker] Shard ${shardIdx} setMode failed`,
          e as any,
        );
      }
    }
  }

  unsubscribe(tokens: number[]): void {
    if (!tokens.length) return;
    const byShardIdx: Map<number, number[]> = new Map();
    for (const token of tokens) {
      const shardIdx = this.tokenToShard.get(token);
      if (shardIdx !== undefined) {
        if (!byShardIdx.has(shardIdx)) byShardIdx.set(shardIdx, []);
        byShardIdx.get(shardIdx)!.push(token);
      }
    }
    for (const [shardIdx, shardTokens] of byShardIdx) {
      const shard = this.shards[shardIdx];
      try {
        shard.inner.unsubscribe(shardTokens);
      } catch (e) {
        this.logger.error(
          `[KiteShardedTicker] Shard ${shardIdx} unsubscribe failed`,
          e as any,
        );
      }
      for (const t of shardTokens) {
        shard.subscribedTokens.delete(t);
        shard.tokenModes.delete(t);
        this.tokenToShard.delete(t);
      }
    }
  }

  on(event: string, cb: (...args: any[]) => void): this {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
    this.eventHandlers.get(event)!.push(cb);
    return this;
  }

  private emit(event: string, ...args: any[]): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    for (const h of handlers) {
      try {
        h(...args);
      } catch (e) {
        this.logger.error(
          `[KiteShardedTicker] Event handler error for '${event}'`,
          e as any,
        );
      }
    }
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  getShardStatus(): KiteShardStatus[] {
    return this.shards.map((s) => ({
      index: s.index,
      isConnected: s.isConnected,
      subscribedCount: s.subscribedTokens.size,
      reconnectAttempts: s.reconnectAttempts,
      reconnectCount: s.reconnectCount,
      disableReconnect: s.disableReconnect,
    }));
  }

  getSubscriptionLimit(): number {
    return this.maxShards * this.perShardLimit;
  }

  getTotalSubscribed(): number {
    return this.shards.reduce((sum, s) => sum + s.subscribedTokens.size, 0);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private isAuthError(error: any): boolean {
    const msg = String(error?.message ?? '').toLowerCase();
    const code = error?.code ?? error?.data?.code;
    const status =
      error?.status ?? error?.data?.status ?? error?.response?.status;
    if (status === 403) return true;
    if (code && String(code).startsWith('4')) {
      const c = Number(code);
      if (c === 403 || c === 401) return true;
    }
    if (/auth|token|unauthori|forbidden/i.test(msg)) return true;
    return false;
  }
}
