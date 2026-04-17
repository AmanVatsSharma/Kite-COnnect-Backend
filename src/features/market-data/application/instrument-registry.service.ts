/**
 * @file instrument-registry.service.ts
 * @module market-data
 * @description Warm in-memory registry mapping provider tokens <-> UIR IDs <-> canonical symbols.
 * @author BharatERP
 * @created 2026-04-17
 * @updated 2026-04-17
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { UniversalInstrument } from '../domain/universal-instrument.entity';
import { InstrumentMapping } from '../domain/instrument-mapping.entity';

@Injectable()
export class InstrumentRegistryService implements OnModuleInit {
  private readonly logger = new Logger(InstrumentRegistryService.name);

  // Hot-path maps (O(1) lookup)
  private providerTokenToUirId = new Map<string, number>(); // "kite:256265" -> 42
  private uirIdToCanonical = new Map<number, string>(); // 42 -> "NSE:RELIANCE"
  private canonicalToUirId = new Map<string, number>(); // "NSE:RELIANCE" -> 42
  private uirIdToProviderTokens = new Map<number, Map<string, string>>(); // 42 -> { kite: "256265", vortex: "NSE_EQ-22" }

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
    }

    // Load all mappings that have a UIR ID assigned
    const mappings = await this.mappingRepo.find({
      where: { uir_id: Not(IsNull()) },
    });

    for (const mapping of mappings) {
      const uirId = Number(mapping.uir_id); // bigint may come as string
      const key = `${mapping.provider}:${mapping.provider_token}`;

      this.providerTokenToUirId.set(key, uirId);

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
   * Get the provider-specific token for upstream subscribe calls.
   */
  getProviderToken(uirId: number, provider: string): string | undefined {
    const providerMap = this.uirIdToProviderTokens.get(uirId);
    if (!providerMap) return undefined;
    return providerMap.get(provider);
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
    await this.warmMaps();
  }

  /**
   * Return counts for monitoring/logging.
   */
  getStats(): { instruments: number; mappings: number } {
    return {
      instruments: this.uirIdToCanonical.size,
      mappings: this.providerTokenToUirId.size,
    };
  }
}
