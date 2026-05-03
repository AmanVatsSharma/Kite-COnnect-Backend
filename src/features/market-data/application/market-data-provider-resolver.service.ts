/**
 * @file market-data-provider-resolver.service.ts
 * @module market-data
 * @description Resolves MarketDataProvider for HTTP and WebSocket (kite/vortex/massive/binance; falcon/vayu/polygon aliases).
 * @author BharatERP
 * @created 2025-01-01
 * @updated 2026-04-26
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KiteProviderService } from '@features/kite-connect/infra/kite-provider.service';
import { VortexProviderService } from '@features/stock/infra/vortex-provider.service';
import { MassiveProviderService } from '@features/massive/infra/massive-provider.service';
import { BinanceProviderService } from '@features/binance/infra/binance-provider.service';
import { MarketDataProvider } from '@features/market-data/infra/market-data.provider';
import { RedisService } from '@infra/redis/redis.service';
import { ApiKey } from '@features/auth/domain/api-key.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  normalizeProviderAlias,
  InternalProviderName,
} from '@shared/utils/provider-label.util';

type ProviderName = InternalProviderName;

@Injectable()
export class MarketDataProviderResolverService {
  private readonly logger = new Logger(MarketDataProviderResolverService.name);
  private providerCache: Map<ProviderName, MarketDataProvider> = new Map();
  private GLOBAL_PROVIDER_KEY = 'provider:global';
  private inMemoryGlobalProvider: ProviderName | null = null;

  constructor(
    private config: ConfigService,
    private redis: RedisService,
    private kite: KiteProviderService,
    private vortex: VortexProviderService,
    private massive: MassiveProviderService,
    private binance: BinanceProviderService,
    @InjectRepository(ApiKey) private apiKeyRepo: Repository<ApiKey>,
  ) {}

  // HTTP resolution priority: header x-provider -> API key provider -> global override -> env DATA_PROVIDER
  async resolveForHttp(
    headers: Record<string, any>,
    apiKey?: string,
  ): Promise<MarketDataProvider> {
    const headerRaw = (
      headers?.['x-provider'] ||
      headers?.['X-Provider'] ||
      ''
    ).toString();
    const fromHeader = normalizeProviderAlias(headerRaw);
    if (fromHeader) {
      this.logger.log(`[Resolver][HTTP] Using header provider=${fromHeader}`);
      return this.getProvider(fromHeader);
    }

    if (apiKey) {
      try {
        const rec = await this.apiKeyRepo.findOne({
          where: { key: apiKey, is_active: true },
        });
        const normalized = normalizeProviderAlias(rec?.provider ?? null);
        if (normalized) {
          this.logger.log(
            `[Resolver][HTTP] Using API key provider=${normalized}`,
          );
          return this.getProvider(normalized);
        }
      } catch (e) {
        this.logger.warn(
          '[Resolver][HTTP] API key lookup failed; continuing',
          e as any,
        );
      }
    }

    const global = await this.getGlobalProviderName();
    if (global) {
      this.logger.log(`[Resolver][HTTP] Using global provider=${global}`);
      return this.getProvider(global);
    }

    const envRaw = this.config.get('DATA_PROVIDER', 'kite') || 'kite';
    const envName: ProviderName =
      normalizeProviderAlias(String(envRaw)) ?? 'kite';
    this.logger.log(`[Resolver][HTTP] Using env provider=${envName}`);
    return this.getProvider(envName);
  }

  // WS uses a single global provider for all connections
  async resolveForWebsocket(): Promise<MarketDataProvider> {
    const name = await this.getResolvedInternalProviderNameForWebsocket();
    this.logger.log(`[Resolver][WS] Using global provider=${name}`);
    const provider = this.getProvider(name);
    // Ensure provider is initialized for WS path
    try {
      await provider.initialize();
    } catch (e) {
      this.logger.warn(
        '[Resolver][WS] provider.initialize() failed (non-fatal)',
        e as any,
      );
    }
    return provider;
  }

  async setGlobalProviderName(name: ProviderName): Promise<void> {
    this.logger.warn(`[Resolver] Setting global provider to ${name}`);
    try {
      if (this.redis.isRedisAvailable()) {
        await this.redis.set(this.GLOBAL_PROVIDER_KEY, name);
      } else {
        this.inMemoryGlobalProvider = name;
      }
    } catch (e) {
      this.inMemoryGlobalProvider = name;
      this.logger.warn(
        '[Resolver] Redis not available; using in-memory global provider',
      );
    }
  }

  async getGlobalProviderName(): Promise<ProviderName | null> {
    try {
      if (this.redis.isRedisAvailable()) {
        const v = await this.redis.get<string>(this.GLOBAL_PROVIDER_KEY);
        const n = normalizeProviderAlias(v ?? null);
        if (n) return n;
      }
    } catch {}
    if (this.inMemoryGlobalProvider) return this.inMemoryGlobalProvider;
    return null;
  }

  /** Effective internal provider for WS/metrics (global Redis key or normalized DATA_PROVIDER). */
  async getResolvedInternalProviderNameForWebsocket(): Promise<ProviderName> {
    const envFallback =
      normalizeProviderAlias(
        String(this.config.get('DATA_PROVIDER', 'kite') || 'kite'),
      ) ?? 'kite';
    return (await this.getGlobalProviderName()) || envFallback;
  }

  private async ensureInitialized(
    instance: MarketDataProvider,
    name: ProviderName,
  ) {
    try {
      await instance.initialize();
    } catch (e) {
      this.logger.error(`[Resolver] initialize() failed for ${name}`, e as any);
    }
  }

  getProvider(name: ProviderName): MarketDataProvider {
    if (this.providerCache.has(name)) return this.providerCache.get(name)!;
    let instance: MarketDataProvider;
    if (name === 'kite') instance = this.kite;
    else if (name === 'massive') instance = this.massive;
    else if (name === 'binance') instance = this.binance;
    else instance = this.vortex;
    // fire-and-forget initialize; providers are resilient if not configured
    this.ensureInitialized(instance, name);
    this.providerCache.set(name, instance);
    return instance;
  }

  /**
   * Returns providers that have valid credentials and are ready to stream.
   * Kite: isClientInitialized() — access token loaded from Redis/DB.
   * Massive: !isDegraded() — MASSIVE_API_KEY is set.
   * Vortex: getDebugStatus()?.httpClientReady — VORTEX_API_KEY set.
   * Binance: !isDegraded() — public market data needs no creds, so this is true after onModuleInit.
   */
  getEnabledProviders(): InternalProviderName[] {
    const enabled: InternalProviderName[] = [];
    if (this.kite.isClientInitialized()) enabled.push('kite');
    if (!this.massive.isDegraded()) enabled.push('massive');
    const vortexStatus = this.vortex.getDebugStatus?.();
    if (vortexStatus?.httpClientReady) enabled.push('vortex');
    if (!this.binance.isDegraded()) enabled.push('binance');
    return enabled;
  }
}
