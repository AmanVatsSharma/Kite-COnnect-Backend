/**
 * File:        src/features/stock/application/universal-ltp.service.ts
 * Module:      Stock · Universal LTP
 * Purpose:     Resolve live prices for a list of universal instrument IDs without
 *              the caller needing to know which broker holds each instrument.
 *              Prefers vortex; falls back to kite for instruments without a vortex token.
 *
 * Exports:
 *   - UniversalLtpService.getUniversalLtp(ids) → { success, data }
 *     data is keyed by universal instrument id (string): { last_price: number|null }
 *
 * Depends on:
 *   - InstrumentRegistryService — in-memory O(1) map of uirId → provider tokens
 *   - VortexProviderService     — getLTPByPairs() for vortex-mapped instruments
 *   - KiteProviderService       — getLTPByPairs() for kite-only instruments
 *
 * Side-effects:
 *   - HTTP calls to vortex and/or kite REST endpoints (non-fatal; returns null last_price on failure)
 *
 * Key invariants:
 *   - Vortex provider_token format in instrument_mappings: "EXCHANGE-token" e.g. "NSE_EQ-22"
 *   - Split on last '-' to recover exchange and token
 *   - Result is always { success: true, data: {...} } — never throws (errors degrade to empty data)
 *
 * Author:      BharatERP
 * Last-updated: 2026-04-25
 */

import { Injectable, Logger } from '@nestjs/common';
import { InstrumentRegistryService } from '@features/market-data/application/instrument-registry.service';
import { VortexProviderService } from '../infra/vortex-provider.service';
import { KiteProviderService } from '@features/kite-connect/infra/kite-provider.service';

@Injectable()
export class UniversalLtpService {
  private readonly logger = new Logger(UniversalLtpService.name);

  constructor(
    private readonly registry: InstrumentRegistryService,
    private readonly vortexProvider: VortexProviderService,
    private readonly kiteProvider: KiteProviderService,
  ) {}

  async getUniversalLtp(ids: number[]): Promise<{
    success: true;
    data: Record<string, { last_price: number | null }>;
  }> {
    const result: Record<string, { last_price: number | null }> = {};

    if (!ids?.length) return { success: true, data: result };

    type VortexPair = { exchange: 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO'; token: string };
    const vortexPairs: VortexPair[] = [];
    const vortexTokenToUirId = new Map<string, number>(); // "NSE_EQ-22" → uirId

    const kitePairs: Array<{ exchange: string; token: string }> = [];
    const kiteTokenToUirId = new Map<string, number>(); // "256265" → uirId

    for (const id of ids) {
      const providerMap = this.registry.getProviderTokens(id);
      if (!providerMap) continue;

      const vortexToken = providerMap.get('vortex'); // "NSE_EQ-22"
      const kiteToken = providerMap.get('kite');     // "256265"

      if (vortexToken) {
        // Split on last '-' to separate "NSE_EQ" from "22"
        const lastDash = vortexToken.lastIndexOf('-');
        if (lastDash > 0) {
          const exchange = vortexToken.substring(0, lastDash) as VortexPair['exchange'];
          const token = vortexToken.substring(lastDash + 1);
          vortexPairs.push({ exchange, token });
          vortexTokenToUirId.set(vortexToken, id);
        }
      } else if (kiteToken) {
        const exchange = this.registry.getExchange(id) ?? 'NSE';
        kitePairs.push({ exchange, token: kiteToken });
        kiteTokenToUirId.set(kiteToken, id);
      }
    }

    // Vortex batch
    if (vortexPairs.length) {
      try {
        const ltpMap = await this.vortexProvider.getLTPByPairs(vortexPairs);
        // ltpMap keyed by "NSE_EQ-22"
        for (const [exTok, val] of Object.entries(ltpMap)) {
          const uirId = vortexTokenToUirId.get(exTok);
          if (uirId != null) result[String(uirId)] = val;
        }
      } catch (err: any) {
        this.logger.warn(`[UniversalLtp] vortex batch failed: ${err?.message}`);
      }
    }

    // Kite batch (fallback for instruments without vortex mapping)
    if (kitePairs.length) {
      try {
        const ltpMap = await this.kiteProvider.getLTPByPairs(kitePairs);
        // kiteProvider.getLTPByPairs returns map keyed by "EXCHANGE-token" or token string
        for (const [key, val] of Object.entries(ltpMap)) {
          // Try token alone (last segment after '-') as a lookup key
          const tok = key.includes('-') ? key.split('-').pop()! : key;
          const uirId = kiteTokenToUirId.get(tok) ?? kiteTokenToUirId.get(key);
          if (uirId != null) result[String(uirId)] = val as { last_price: number | null };
        }
      } catch (err: any) {
        this.logger.warn(`[UniversalLtp] kite batch failed: ${err?.message}`);
      }
    }

    return { success: true, data: result };
  }
}
