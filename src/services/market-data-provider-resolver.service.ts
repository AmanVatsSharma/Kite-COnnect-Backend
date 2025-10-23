import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KiteProviderService } from '../providers/kite-provider.service';
import { VortexProviderService } from '../providers/vortex-provider.service';
import { MarketDataProvider } from '../providers/market-data.provider';
import { RedisService } from './redis.service';
import { ApiKey } from '../entities/api-key.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

type ProviderName = 'kite' | 'vortex';

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
    @InjectRepository(ApiKey) private apiKeyRepo: Repository<ApiKey>,
  ) {}

  // HTTP resolution priority: header x-provider -> API key provider -> global override -> env DATA_PROVIDER
  async resolveForHttp(headers: Record<string, any>, apiKey?: string): Promise<MarketDataProvider> {
    const headerValue = (headers?.['x-provider'] || headers?.['X-Provider'] || '').toString().toLowerCase();
    if (headerValue === 'kite' || headerValue === 'vortex') {
      this.logger.log(`[Resolver][HTTP] Using header provider=${headerValue}`);
      return this.getProvider(headerValue as ProviderName);
    }

    if (apiKey) {
      try {
        const rec = await this.apiKeyRepo.findOne({ where: { key: apiKey, is_active: true } });
        if (rec?.provider === 'kite' || rec?.provider === 'vortex') {
          this.logger.log(`[Resolver][HTTP] Using API key provider=${rec.provider}`);
          return this.getProvider(rec.provider as ProviderName);
        }
      } catch (e) {
        this.logger.warn('[Resolver][HTTP] API key lookup failed; continuing', e as any);
      }
    }

    const global = await this.getGlobalProviderName();
    if (global) {
      this.logger.log(`[Resolver][HTTP] Using global provider=${global}`);
      return this.getProvider(global);
    }

    const envName = (this.config.get('DATA_PROVIDER', 'kite') || 'kite').toLowerCase() as ProviderName;
    this.logger.log(`[Resolver][HTTP] Using env provider=${envName}`);
    return this.getProvider(envName);
  }

  // WS uses a single global provider for all connections
  async resolveForWebsocket(): Promise<MarketDataProvider> {
    const name = (await this.getGlobalProviderName()) || (this.config.get('DATA_PROVIDER', 'kite') as ProviderName);
    this.logger.log(`[Resolver][WS] Using global provider=${name}`);
    const provider = this.getProvider(name);
    // Ensure provider is initialized for WS path
    try { await provider.initialize(); } catch (e) { this.logger.warn('[Resolver][WS] provider.initialize() failed (non-fatal)', e as any); }
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
      this.logger.warn('[Resolver] Redis not available; using in-memory global provider');
    }
  }

  async getGlobalProviderName(): Promise<ProviderName | null> {
    try {
      if (this.redis.isRedisAvailable()) {
        const v = await this.redis.get<string>(this.GLOBAL_PROVIDER_KEY);
        if (v === 'kite' || v === 'vortex') return v;
      }
    } catch {}
    if (this.inMemoryGlobalProvider) return this.inMemoryGlobalProvider;
    return null;
  }

  private async ensureInitialized(instance: MarketDataProvider, name: ProviderName) {
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
    else instance = this.vortex;
    // fire-and-forget initialize; providers are resilient if not configured
    this.ensureInitialized(instance, name);
    this.providerCache.set(name, instance);
    return instance;
  }
}


