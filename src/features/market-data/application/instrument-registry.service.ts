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
  | {
      status: 'resolved';
      uirId: number;
      canonical: string;
      providerToken: string;
    }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'not_found' };

/** Result of a derivative symbol resolution attempt (FUT/CE/PE). */
export type DerivativeResolveResult =
  | {
      status: 'resolved';
      uirId: number;
      canonical: string;
      providerToken?: string;
      expiry: Date | null;
      instrument_type: string;
    }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'not_found'; reason?: string };

/** One entry in the underlying → entries warm map. */
interface UnderlyingEntry {
  uirId: number;
  exchange: string;
  instrument_type: string;
  canonical: string;
  expiry: Date | null; // Contract expiry date for derivatives
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
  private uirIdToIsin = new Map<number, string>(); // 42 -> "INE002A01018"
  // Underlying name (uppercase) -> all UIR entries with that underlying, for flex symbol resolution
  private underlyingToEntries = new Map<string, UnderlyingEntry[]>();
  // Parsed "base" of the Kite-style underlying (e.g. GOLD, NIFTYIT) -> all entries whose
  // underlying matches <base><YY><MON><FUT|CE|PE>. Used to resolve shorthand like
  // "MCX:GOLD:FUT" against the production data which stores underlyings as
  // "GOLD26JUNFUT" / "GOLDM26JUNFUT" / "GOLDGUINEA26JUNFUT" / "NIFTYIT26JUNFUT".
  private baseUnderlyingToEntries = new Map<string, UnderlyingEntry[]>();

  /**
   * In-flight warm-up promise. Resolves when warmMaps() completes (success or failure).
   * Subscribers await `ready()` to ensure the in-memory maps are populated before resolving
   * symbols. Once resolved, future `ready()` calls short-circuit (one microtask each).
   */
  private warmPromise: Promise<void> | null = null;
  /** Set to true after the warm-up promise has settled (used for sync isReady() probe). */
  private warmSettled = false;

  constructor(
    @InjectRepository(UniversalInstrument)
    private readonly uirRepo: Repository<UniversalInstrument>,
    @InjectRepository(InstrumentMapping)
    private readonly mappingRepo: Repository<InstrumentMapping>,
  ) {
    this.logger.log('InstrumentRegistryService instantiated');
  }

  async onModuleInit(): Promise<void> {
    // Run warm-up in background so it doesn't block app bootstrap (resolves 502 Bad Gateway).
    // Track the in-flight promise so callers can `await ready()` before any resolve* call
    // — this prevents early subscribe requests from hitting empty maps and silently failing.
    this.warmPromise = this.warmMaps()
      .catch((err) => {
        this.logger.error('Background instrument registry warm-up failed', err);
      })
      .finally(() => {
        this.warmSettled = true;
      });
  }

  /**
   * Awaitable readiness gate. Resolves once the background warm-up has completed (success
   * or failure). After the first call post-warm-up, this is a no-op (single microtask) —
   * safe to await on every subscribe without measurable latency cost.
   */
  ready(): Promise<void> {
    return this.warmPromise ?? Promise.resolve();
  }

  /**
   * Synchronous readiness probe. True once the warm-up promise has settled.
   * Use this only when the caller cannot afford even a microtask wait (e.g. hot-path
   * diagnostics). The subscribe path should `await ready()` instead.
   */
  isReady(): boolean {
    return this.warmSettled;
  }

  /**
   * Load all active UIR entries and their mappings into in-memory maps.
   */
  async warmMaps(): Promise<void> {
    this.logger.log('Starting instrument registry warm-up...');
    const startTime = Date.now();

    // Helper to yield control back to Event Loop
    const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

    // Load all active universal instruments using raw query for performance
    const uirRows = await this.uirRepo.query(`
      SELECT id, canonical_symbol, exchange, isin, underlying, instrument_type, expiry 
      FROM universal_instruments 
      WHERE is_active = true
    `);

    this.logger.log(`Fetched ${uirRows.length} active universal instruments in ${Date.now() - startTime}ms. Processing...`);

    let count = 0;
    for (const row of uirRows) {
      const id = Number(row.id); // bigint comes as string from TypeORM raw query
      this.uirIdToCanonical.set(id, row.canonical_symbol);
      this.canonicalToUirId.set(row.canonical_symbol, id);
      this.uirIdToExchange.set(id, row.exchange);
      if (row.isin) {
        this.uirIdToIsin.set(id, row.isin);
      }

      // Build underlying → entries map for flex symbol resolution ("RELIANCE" → [...])
      if (row.underlying) {
        const underlyingKey = row.underlying.toUpperCase();
        let existing = this.underlyingToEntries.get(underlyingKey);
        if (!existing) {
          existing = [];
          this.underlyingToEntries.set(underlyingKey, existing);
        }
        existing.push({
          uirId: id,
          exchange: row.exchange,
          instrument_type: row.instrument_type,
          canonical: row.canonical_symbol,
          expiry: row.expiry ?? null,
        });

        // 2026-06-05: also index by the parsed Kite "base" symbol so callers can
        // resolve shorthand like "MCX:GOLD:FUT" against production data where
        // underlyings are stored as "GOLD26JUNFUT" / "GOLDM26JUNFUT" /
        // "GOLDGUINEA26JUNFUT" / "NIFTYIT26JUNFUT" etc.
        const baseMatch = underlyingKey.match(/^([A-Z]+)\d{2}[A-Z]{3}(FUT|CE|PE)$/);
        if (baseMatch) {
          const baseKey = baseMatch[1];
          let baseExisting = this.baseUnderlyingToEntries.get(baseKey);
          if (!baseExisting) {
            baseExisting = [];
            this.baseUnderlyingToEntries.set(baseKey, baseExisting);
          }
          baseExisting.push({
            uirId: id,
            exchange: row.exchange,
            instrument_type: row.instrument_type,
            canonical: row.canonical_symbol,
            expiry: row.expiry ?? null,
          });
        }
      }

      // Yield every 5000 records to prevent freezing the Event Loop
      if (++count % 5000 === 0) {
        await yieldToEventLoop();
      }
    }

    const mappingStartTime = Date.now();
    // Load all mappings that have a UIR ID assigned using raw query
    const mappings = await this.mappingRepo.query(`
      SELECT uir_id, provider, provider_token, instrument_token 
      FROM instrument_mappings 
      WHERE uir_id IS NOT NULL
    `);

    this.logger.log(`Fetched ${mappings.length} instrument mappings in ${Date.now() - mappingStartTime}ms. Processing...`);

    count = 0;
    for (const mapping of mappings) {
      const uirId = Number(mapping.uir_id); // bigint may come as string
      const key = `${mapping.provider}:${mapping.provider_token}`;

      this.providerTokenToUirId.set(key, uirId);

      // Vortex secondary index
      if (mapping.provider === 'vortex' && mapping.instrument_token != null) {
        const numericKey = `vortex:${mapping.instrument_token}`;
        const existing = this.providerTokenToUirId.get(numericKey);
        if (existing === undefined) {
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

      // Yield every 5000 records
      if (++count % 5000 === 0) {
        await yieldToEventLoop();
      }
    }

    this.logger.log(
      `Instrument registry warmed: ${uirRows.length} instruments, ${mappings.length} mappings in ${Date.now() - startTime}ms`,
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
    const providers: InternalProviderName[] = [
      'kite',
      'vortex',
      'massive',
      'binance',
    ];
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
    if (exactId != null)
      return { status: 'resolved', uirId: exactId, canonical: symbol };

    // Underlying fallback: case-insensitive lookup (e.g. "RELIANCE", "reliance")
    const key = symbol.trim().toUpperCase();
    const entries = this.underlyingToEntries.get(key);
    if (!entries || entries.length === 0) return { status: 'not_found' };

    // Prefer EQ, then IDX. Never auto-resolve FUT/CE/PE (expiry makes them ambiguous).
    const eq = entries.filter((e) => e.instrument_type === 'EQ');
    const pool =
      eq.length > 0 ? eq : entries.filter((e) => e.instrument_type === 'IDX');

    if (pool.length === 0) {
      return {
        status: 'ambiguous',
        candidates: entries.map((e) => e.canonical),
      };
    }

    if (pool.length === 1) {
      return {
        status: 'resolved',
        uirId: pool[0].uirId,
        canonical: pool[0].canonical,
      };
    }

    // Multiple EQ entries (e.g. NSE + BSE): prefer NSE as primary Indian exchange.
    const nse = pool.find((e) => e.exchange === 'NSE');
    if (nse)
      return { status: 'resolved', uirId: nse.uirId, canonical: nse.canonical };

    return { status: 'ambiguous', candidates: pool.map((e) => e.canonical) };
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
      const providerToken = this.uirIdToProviderTokens
        .get(direct)
        ?.get(provider);
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
        const providerToken = this.uirIdToProviderTokens
          .get(upperHit)
          ?.get(provider);
        if (canonical && providerToken) {
          return {
            status: 'resolved',
            uirId: upperHit,
            canonical,
            providerToken,
          };
        }
      }
    }

    // 2. Exact canonical match — must have a token in the requested provider.
    const exactCanon =
      this.canonicalToUirId.get(identifier) ??
      this.canonicalToUirId.get(upperId);
    if (exactCanon != null) {
      const providerToken = this.uirIdToProviderTokens
        .get(exactCanon)
        ?.get(provider);
      if (providerToken) {
        const canonical = this.uirIdToCanonical.get(exactCanon)!;
        return {
          status: 'resolved',
          uirId: exactCanon,
          canonical,
          providerToken,
        };
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
    const pool =
      eq.length > 0
        ? eq
        : inProvider.filter((e) => e.instrument_type === 'IDX');

    if (pool.length === 0) {
      return {
        status: 'ambiguous',
        candidates: inProvider.map((e) => e.canonical),
      };
    }
    if (pool.length === 1) {
      const providerToken = this.uirIdToProviderTokens
        .get(pool[0].uirId)!
        .get(provider)!;
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
      const providerToken = this.uirIdToProviderTokens
        .get(nse.uirId)!
        .get(provider)!;
      return {
        status: 'resolved',
        uirId: nse.uirId,
        canonical: nse.canonical,
        providerToken,
      };
    }

    return { status: 'ambiguous', candidates: pool.map((e) => e.canonical) };
  }

  /**
   * Resolve a derivative symbol like "MCX:GOLD:FUT", "NFO:NIFTY:CE", or "GOLD:FUT" (no exchange).
   *
   * Resolution order:
   *   1. EXCHANGE:UNDERLYING:TYPE with explicit exchange — resolve in that exchange only.
   *   2. UNDERLYING:TYPE without exchange — apply provider preference order (MCX → NFO → BFO).
   *   3. For CE/PE: resolve underlying EQ to get LTP, pick nearest ATM strike.
   *
   * Hot-path: O(1) map lookups + filter + sort on small set — no async, no DB.
   */
  resolveDerivativeSymbol(symbol: string): DerivativeResolveResult {
    const parts = symbol.split(':');
    if (parts.length < 2) {
      return { status: 'not_found', reason: 'Invalid derivative symbol format' };
    }

    const type = parts[parts.length - 1].toUpperCase();
    if (!['FUT', 'CE', 'PE'].includes(type)) {
      return { status: 'not_found', reason: `Not a derivative type: ${type}` };
    }

    const underlyingRaw = parts.length === 3 ? parts[1] : parts[0];
    const underlyingKey = underlyingRaw.toUpperCase();
    const explicitExchange = parts.length === 3 ? parts[0].toUpperCase() : null;

    // 2026-06-05: merge the exact-key and parsed-Kite-base maps. The base map
    // catches production data where the underlying is stored as "GOLD26JUNFUT"
    // (with the Kite date+type code baked in) but the user types the shorthand
    // "GOLD". Both sets are returned so the downstream type/exchange/sort
    // pipeline can pick the right contract.
    //
    // 2026-06-10: base entries are concatenated FIRST so that the
    // kite-mapped "GOLD26AUGFUT" (UIR 26305) wins the expiry-tie break over
    // the plain "GOLD" (UIR 546557) which has only a vortex mapping. Without
    // this, the nearest-expiry sort returns 546557 first and the upstream
    // kite subscription fails because the kite provider token for that UIR
    // is absent.
    const baseEntries = this.baseUnderlyingToEntries.get(underlyingKey) ?? [];
    const exactEntries = this.underlyingToEntries.get(underlyingKey) ?? [];
    const allEntries = [...baseEntries, ...exactEntries];
    if (allEntries.length === 0) {
      return { status: 'not_found', reason: `Underlying not found: ${underlyingRaw}` };
    }

    // Filter by type (FUT, CE, PE)
    const typeEntries = allEntries.filter(e => e.instrument_type === type);
    if (typeEntries.length === 0) {
      return { status: 'not_found', reason: `No ${type} contracts for ${underlyingRaw}` };
    }

    // Filter by exchange if specified, otherwise use preference order
    let candidates = typeEntries;
    if (explicitExchange) {
      candidates = typeEntries.filter(e => e.exchange === explicitExchange);
      if (candidates.length === 0) {
        return { status: 'not_found', reason: `${type} not found in ${explicitExchange}` };
      }
    } else {
      // Apply exchange preference: MCX > NFO > BFO > others
      const exchangeOrder = ['MCX', 'NFO', 'BFO'];
      const sorted: typeof typeEntries = [];
      for (const ex of exchangeOrder) {
        const match = candidates.filter(e => e.exchange === ex);
        if (match.length > 0) sorted.push(...match);
      }
      // Add any remaining exchanges not in preference list
      const matchedExchanges = new Set([...exchangeOrder, ...sorted.map(e => e.exchange)]);
      for (const e of candidates) {
        if (!matchedExchanges.has(e.exchange)) sorted.push(e);
      }
      candidates = sorted;
    }

    // Filter non-expired (expiry > now or null expiry for equity-like)
    const now = new Date();
    const activeCandidates = candidates.filter(e => !e.expiry || e.expiry > now);

    if (activeCandidates.length === 0) {
      return { status: 'not_found', reason: `All ${type} contracts for ${underlyingRaw} have expired` };
    }

    // Sort by expiry ASC, pick nearest
    const sorted = activeCandidates.sort((a, b) => {
      if (!a.expiry && !b.expiry) return 0;
      if (!a.expiry) return 1;
      if (!b.expiry) return -1;
      return a.expiry.getTime() - b.expiry.getTime();
    });

    if (sorted.length === 1) {
      return {
        status: 'resolved',
        uirId: sorted[0].uirId,
        canonical: sorted[0].canonical,
        expiry: sorted[0].expiry,
        instrument_type: sorted[0].instrument_type,
      };
    }

    // Multiple candidates — for derivatives, pick nearest expiry (first in sorted).
    // Only return ambiguous if expiry dates are equal (truly duplicate contracts).
    const nearestExpiry = sorted[0].expiry?.getTime() ?? 0;
    const hasSameExpiry = sorted.every(e => e.expiry?.getTime() === nearestExpiry);
    if (!hasSameExpiry) {
      return {
        status: 'resolved',
        uirId: sorted[0].uirId,
        canonical: sorted[0].canonical,
        expiry: sorted[0].expiry,
        instrument_type: sorted[0].instrument_type,
      };
    }

    // 2026-06-10: All candidates have the same expiry — pick the one with
    // an active provider mapping for the target exchange. This prevents
    // returning a UIR ID that has no streaming support (e.g., MCX:GOLD:FUT
    // returning 546557 which only has vortex when kite is the preferred
    // provider for MCX via EXCHANGE_TO_PROVIDER).
    if (explicitExchange) {
      const targetProvider = getProviderForExchange(explicitExchange);
      if (targetProvider) {
        const withProvider = sorted.find(e => {
          const providerMap = this.uirIdToProviderTokens.get(e.uirId);
          return providerMap?.has(targetProvider);
        });
        if (withProvider) {
          this.logger.debug(
            `[resolveDerivativeSymbol] ${underlyingRaw}:${type} resolved to ${withProvider.canonical} (UIR ${withProvider.uirId}) via provider-preference`,
          );
          return {
            status: 'resolved',
            uirId: withProvider.uirId,
            canonical: withProvider.canonical,
            expiry: withProvider.expiry,
            instrument_type: withProvider.instrument_type,
          };
        }
      }
    }

    return {
      status: 'ambiguous',
      candidates: sorted.map(e => e.canonical),
    };
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
      if (exchange && indian.has(exchange) && providerMap.has('vortex'))
        return 'vortex';
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
    this.baseUnderlyingToEntries.clear();
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

  /** ISIN for one UIR ID (in-memory, O(1)). Used for free logo URL generation. */
  getIsin(uirId: number): string | undefined {
    return this.uirIdToIsin.get(uirId);
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
