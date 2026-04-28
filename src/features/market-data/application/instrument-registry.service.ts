/**
 * @file instrument-registry.service.ts
 * @module market-data
 * @description Warm in-memory registry mapping provider tokens <-> UIR IDs <-> canonical symbols.
 * @author BharatERP
 * @created 2026-04-17
 * @updated 2026-04-28
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { UniversalInstrument } from '../domain/universal-instrument.entity';
import { InstrumentMapping } from '../domain/instrument-mapping.entity';
import { getProviderForExchange } from '@shared/utils/exchange-to-provider.util';
import { InternalProviderName } from '@shared/utils/provider-label.util';

/** Result of a flexible symbol resolution attempt. */
export type FlexResolveResult =
  | { status: 'resolved'; uirId: number; canonical: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'not_found' };

/** Result of a provider-scoped symbol resolution attempt. */
export type ProviderScopedResolveResult =
  | { status: 'resolved'; uirId: number; canonical: string; providerToken: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'not_found' };

/** One entry in the underlying → entries warm map. */
interface UnderlyingEntry {
  uirId: number;
  exchange: string;
  instrument_type: string;
  canonical: string;
}

@Injectable()
export class InstrumentRegistryService implements OnModuleInit {
  private readonly logger = new Logger(InstrumentRegistryService.name);

  // Hot-path maps (O(1) lookup)
  private providerTokenToUirId = new Map<string, number>(); // "kite:256265" -> 42
  private uirIdToCanonical = new Map<number, string>(); // 42 -> "NSE:RELIANCE"
  private canonicalToUirId = new Map<string, number>(); // "NSE:RELIANCE" -> 42
  private uirIdToProviderTokens = new Map<number, Map<string, string>>(); // 42 -> { kite: "256265", vortex: "NSE_EQ-22" }
  private uirIdToExchange = new Map<number, string>(); // 42 -> "NSE"
  // Underlying name (uppercase) -> all UIR entries with that underlying, for flex symbol resolution
  private underlyingToEntries = new Map<string, UnderlyingEntry[]>();

  constructor(
    @InjectRepository(UniversalInstrument)
    private readonly uirRepo: Repository<UniversalInstrument>,
    @InjectRepository(InstrumentMapping)
    private readonly mappingRepo: Repository<InstrumentMapping>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.warmMaps();
  }

  /**
   * Load all active UIR entries and their mappings into in-memory maps.
   */
  async warmMaps(): Promise<void> {
    // Load all active universal instruments
    const uirRows = await this.uirRepo.find({
      where: { is_active: true },
    });

    for (const row of uirRows) {
      const id = Number(row.id); // bigint comes as string from TypeORM
      this.uirIdToCanonical.set(id, row.canonical_symbol);
      this.canonicalToUirId.set(row.canonical_symbol, id);
      this.uirIdToExchange.set(id, row.exchange);

      // Build underlying → entries map for flex symbol resolution ("RELIANCE" → [...])
      if (row.underlying) {
        const underlyingKey = row.underlying.toUpperCase();
        const existing = this.underlyingToEntries.get(underlyingKey) ?? [];
        existing.push({ uirId: id, exchange: row.exchange, instrument_type: row.instrument_type, canonical: row.canonical_symbol });
        this.underlyingToEntries.set(underlyingKey, existing);
      }
    }

    // Load all mappings that have a UIR ID assigned
    const mappings = await this.mappingRepo.find({
      where: { uir_id: Not(IsNull()) },
    });

    for (const mapping of mappings) {
      const uirId = Number(mapping.uir_id); // bigint may come as string
      const key = `${mapping.provider}:${mapping.provider_token}`;

      this.providerTokenToUirId.set(key, uirId);

      // Vortex secondary index: also register by numeric token so callers can resolve with just
      // the number (e.g. "vortex:213123" in addition to "vortex:NSE_EQ-213123").
      // Vortex tokens are globally unique (PrimaryColumn on vortex_instruments.token).
      if (mapping.provider === 'vortex' && mapping.instrument_token != null) {
        const numericKey = `vortex:${mapping.instrument_token}`;
        const existing = this.providerTokenToUirId.get(numericKey);
        if (existing !== undefined && existing !== uirId) {
          this.logger.warn(
            `Vortex numeric token ${mapping.instrument_token} collision: existing uirId=${existing} vs ${uirId}; keeping existing`,
          );
        } else {
          this.providerTokenToUirId.set(numericKey, uirId);
        }
      }

      // Populate nested provider token map
      let providerMap = this.uirIdToProviderTokens.get(uirId);
      if (!providerMap) {
        providerMap = new Map<string, string>();
        this.uirIdToProviderTokens.set(uirId, providerMap);
      }
      providerMap.set(mapping.provider, mapping.provider_token);
    }

    this.logger.log(
      `Instrument registry warmed: ${uirRows.length} instruments, ${mappings.length} mappings`,
    );
  }

  /**
   * Resolve a provider-specific token to its UIR ID.
   * Hot-path: synchronous Map.get() — no async, no DB.
   */
  resolveProviderToken(
    provider: string,
    providerToken: string | number,
  ): number | undefined {
    const key = `${provider}:${providerToken}`;
    return this.providerTokenToUirId.get(key);
  }

  /**
   * Provider-agnostic token resolution — tries every provider and returns the first match.
   * Use when the caller has a token but doesn't know which provider issued it (multi-provider
   * WS clients that pass raw numeric tokens). Returns undefined if no provider has a mapping.
   *
   * Hot-path: at most 4 sync Map.get() calls — no async, no DB.
   */
  resolveTokenAcrossProviders(
    providerToken: string | number,
  ): number | undefined {
    const providers: InternalProviderName[] = ['kite', 'vortex', 'massive', 'binance'];
    for (const p of providers) {
      const id = this.providerTokenToUirId.get(`${p}:${providerToken}`);
      if (id !== undefined) return id;
    }
    return undefined;
  }

  /**
   * Get the canonical symbol for a UIR ID.
   */
  getCanonicalSymbol(uirId: number): string | undefined {
    return this.uirIdToCanonical.get(uirId);
  }

  /**
   * Resolve a canonical symbol to its UIR ID.
   */
  resolveCanonicalSymbol(symbol: string): number | undefined {
    return this.canonicalToUirId.get(symbol);
  }

  /**
   * Flexible symbol resolution — accepts both canonical format ("NSE:RELIANCE") and
   * plain underlying names ("RELIANCE", "NIFTY 50").
   *
   * Resolution order for plain names:
   *   1. EQ entries — prefer NSE over other exchanges.
   *   2. IDX entries — when no EQ match exists.
   *   3. FUT/CE/PE — never auto-resolved (ambiguous without expiry).
   *
   * Hot-path: O(1) map lookups only, no async, no DB.
   */
  resolveFlexSymbol(symbol: string): FlexResolveResult {
    // Fast path: exact canonical match (e.g. "NSE:RELIANCE")
    const exactId = this.canonicalToUirId.get(symbol);
    if (exactId != null) return { status: 'resolved', uirId: exactId, canonical: symbol };

    // Underlying fallback: case-insensitive lookup (e.g. "RELIANCE", "reliance")
    const key = symbol.trim().toUpperCase();
    const entries = this.underlyingToEntries.get(key);
    if (!entries || entries.length === 0) return { status: 'not_found' };

    // Prefer EQ, then IDX. Never auto-resolve FUT/CE/PE (expiry makes them ambiguous).
    const eq = entries.filter(e => e.instrument_type === 'EQ');
    const pool = eq.length > 0 ? eq : entries.filter(e => e.instrument_type === 'IDX');

    if (pool.length === 0) {
      return { status: 'ambiguous', candidates: entries.map(e => e.canonical) };
    }

    if (pool.length === 1) {
      return { status: 'resolved', uirId: pool[0].uirId, canonical: pool[0].canonical };
    }

    // Multiple EQ entries (e.g. NSE + BSE): prefer NSE as primary Indian exchange.
    const nse = pool.find(e => e.exchange === 'NSE');
    if (nse) return { status: 'resolved', uirId: nse.uirId, canonical: nse.canonical };

    return { status: 'ambiguous', candidates: pool.map(e => e.canonical) };
  }

  /**
   * Provider-scoped symbol resolution — used by the WS `Provider:identifier` prefix syntax
   * (e.g. `Falcon:reliance`, `Vayu:26000`, `Vayu:NSE_EQ-26000`, `Binance:BTCUSDT`).
   *
   * Resolves the identifier ONLY within the requested provider's mappings — never falls
   * back to another provider. This is the explicit-pin counterpart to `resolveFlexSymbol`.
   *
   * Resolution order (all O(1)):
   *   1. Pure-numeric or pair-form `EXCHANGE-TOKEN` → `resolveProviderToken(provider, raw)`.
   *      For Vortex this covers both `26000` (numeric secondary index) and `NSE_EQ-26000`
   *      (primary key). For kite/massive/binance only numeric/string-token applies.
   *   2. Exact canonical (`NSE:RELIANCE`) → `canonicalToUirId`, gated by the provider
   *      having a token for that UIR (otherwise `not_found`).
   *   3. Underlying fallback (`RELIANCE`, case-insensitive) → walk `underlyingToEntries`
   *      filtered to entries whose UIR has a token for the requested provider; same
   *      EQ-then-IDX preference as `resolveFlexSymbol`. Never auto-resolves FUT/CE/PE.
   */
  resolveProviderScopedSymbol(
    provider: InternalProviderName,
    identifier: string,
  ): ProviderScopedResolveResult {
    if (typeof identifier !== 'string' || identifier.length === 0) {
      return { status: 'not_found' };
    }

    // 1a. Direct provider-token lookup (handles numeric inputs and Vortex pair-form).
    const direct = this.providerTokenToUirId.get(`${provider}:${identifier}`);
    if (direct != null) {
      const canonical = this.uirIdToCanonical.get(direct);
      const providerToken = this.uirIdToProviderTokens.get(direct)?.get(provider);
      if (canonical && providerToken) {
        return { status: 'resolved', uirId: direct, canonical, providerToken };
      }
    }

    // 1b. Uppercased pair-form for case-insensitive Vortex pair input ("nse_eq-26000").
    const upperId = identifier.toUpperCase();
    if (upperId !== identifier) {
      const upperHit = this.providerTokenToUirId.get(`${provider}:${upperId}`);
      if (upperHit != null) {
        const canonical = this.uirIdToCanonical.get(upperHit);
        const providerToken = this.uirIdToProviderTokens.get(upperHit)?.get(provider);
        if (canonical && providerToken) {
          return { status: 'resolved', uirId: upperHit, canonical, providerToken };
        }
      }
    }

    // 2. Exact canonical match — must have a token in the requested provider.
    const exactCanon = this.canonicalToUirId.get(identifier) ?? this.canonicalToUirId.get(upperId);
    if (exactCanon != null) {
      const providerToken = this.uirIdToProviderTokens.get(exactCanon)?.get(provider);
      if (providerToken) {
        const canonical = this.uirIdToCanonical.get(exactCanon)!;
        return { status: 'resolved', uirId: exactCanon, canonical, providerToken };
      }
      // Canonical exists but the requested provider has no mapping for it — not_found in this provider's catalog.
      return { status: 'not_found' };
    }

    // 3. Underlying fallback — same EQ-then-IDX preference as resolveFlexSymbol, but
    //    filtered to entries whose UIR has a token for the requested provider.
    const allEntries = this.underlyingToEntries.get(upperId);
    if (!allEntries || allEntries.length === 0) return { status: 'not_found' };

    const inProvider = allEntries.filter((e) =>
      this.uirIdToProviderTokens.get(e.uirId)?.has(provider),
    );
    if (inProvider.length === 0) return { status: 'not_found' };

    const eq = inProvider.filter((e) => e.instrument_type === 'EQ');
    const pool = eq.length > 0 ? eq : inProvider.filter((e) => e.instrument_type === 'IDX');

    if (pool.length === 0) {
      return { status: 'ambiguous', candidates: inProvider.map((e) => e.canonical) };
    }
    if (pool.length === 1) {
      const providerToken = this.uirIdToProviderTokens.get(pool[0].uirId)!.get(provider)!;
      return {
        status: 'resolved',
        uirId: pool[0].uirId,
        canonical: pool[0].canonical,
        providerToken,
      };
    }

    // Multiple EQ entries (e.g. NSE + BSE within same provider): prefer NSE.
    const nse = pool.find((e) => e.exchange === 'NSE');
    if (nse) {
      const providerToken = this.uirIdToProviderTokens.get(nse.uirId)!.get(provider)!;
      return { status: 'resolved', uirId: nse.uirId, canonical: nse.canonical, providerToken };
    }

    return { status: 'ambiguous', candidates: pool.map((e) => e.canonical) };
  }

  /**
   * Get the provider-specific token for upstream subscribe calls.
   */
  getProviderToken(uirId: number, provider: string): string | undefined {
    const providerMap = this.uirIdToProviderTokens.get(uirId);
    if (!providerMap) return undefined;
    return providerMap.get(provider);
  }

  /**
   * Determine the best streaming provider for a UIR ID (O(1), no async, no DB).
   * Tier 1: canonical exchange → EXCHANGE_TO_PROVIDER (primary routing).
   * Tier 2: fallback to whichever provider has a token (prefer vortex for Indian exchanges).
   * Tier 3: no tokens → undefined.
   */
  getBestProviderForUirId(uirId: number): InternalProviderName | undefined {
    const exchange = this.uirIdToExchange.get(uirId);
    const primary = exchange ? getProviderForExchange(exchange) : undefined;
    const providerMap = this.uirIdToProviderTokens.get(uirId);

    if (primary && providerMap?.has(primary)) return primary;

    if (providerMap?.size) {
      const indian = new Set(['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'BCD']);
      if (exchange && indian.has(exchange) && providerMap.has('vortex')) return 'vortex';
      if (providerMap.has('kite')) return 'kite';
      if (providerMap.has('massive')) return 'massive';
      if (providerMap.has('binance')) return 'binance';
      return providerMap.keys().next().value as InternalProviderName;
    }

    return undefined;
  }

  /**
   * Clear and rebuild all maps from the database.
   */
  async refresh(): Promise<void> {
    this.logger.log('Instrument registry refresh triggered');
    this.providerTokenToUirId.clear();
    this.uirIdToCanonical.clear();
    this.canonicalToUirId.clear();
    this.uirIdToProviderTokens.clear();
    this.uirIdToExchange.clear();
    this.underlyingToEntries.clear();
    await this.warmMaps();
  }

  /**
   * Return provider tokens for all known providers for a canonical symbol (in-memory, no DB).
   */
  resolveCrossProvider(canonical: string): {
    uirId: number | undefined;
    kiteToken: string | undefined;
    vortexToken: string | undefined;
    massiveToken: string | undefined;
    binanceToken: string | undefined;
  } {
    const uirId = this.canonicalToUirId.get(canonical);
    if (uirId == null) {
      return {
        uirId: undefined,
        kiteToken: undefined,
        vortexToken: undefined,
        massiveToken: undefined,
        binanceToken: undefined,
      };
    }
    const providerMap = this.uirIdToProviderTokens.get(uirId);
    return {
      uirId,
      kiteToken: providerMap?.get('kite'),
      vortexToken: providerMap?.get('vortex'),
      massiveToken: providerMap?.get('massive'),
      binanceToken: providerMap?.get('binance'),
    };
  }

  /** Provider tokens for one UIR ID (in-memory, O(1)). Used by UniversalLtpService. */
  getProviderTokens(uirId: number): Map<string, string> | undefined {
    return this.uirIdToProviderTokens.get(uirId);
  }

  /** Exchange for one UIR ID (in-memory, O(1)). Used by UniversalLtpService for kite pair-building. */
  getExchange(uirId: number): string | undefined {
    return this.uirIdToExchange.get(uirId);
  }

  /**
   * Coverage breakdown computed from warm in-memory maps (no DB).
   */
  getCoverage(): {
    totalInRegistry: number;
    withBothProviders: number;
    withKiteOnly: number;
    withVortexOnly: number;
    withNoMapping: number;
  } {
    let both = 0;
    let kiteOnly = 0;
    let vortexOnly = 0;
    for (const [, providerMap] of this.uirIdToProviderTokens) {
      const hasKite = providerMap.has('kite');
      const hasVortex = providerMap.has('vortex');
      if (hasKite && hasVortex) both++;
      else if (hasKite) kiteOnly++;
      else if (hasVortex) vortexOnly++;
    }
    const total = this.uirIdToCanonical.size;
    return {
      totalInRegistry: total,
      withBothProviders: both,
      withKiteOnly: kiteOnly,
      withVortexOnly: vortexOnly,
      withNoMapping: total - this.uirIdToProviderTokens.size,
    };
  }

  /**
   * Return counts for monitoring/logging, including coverage summary.
   */
  getStats(): {
    instruments: number;
    mappings: number;
    coverage: ReturnType<InstrumentRegistryService['getCoverage']>;
  } {
    return {
      instruments: this.uirIdToCanonical.size,
      mappings: this.providerTokenToUirId.size,
      coverage: this.getCoverage(),
    };
  }
}
