/**
 * File:        src/features/stock/application/universal-ltp.service.ts
 * Module:      Stock · Universal LTP
 * Purpose:     Resolve live prices for a list of universal instrument IDs without
 *              the caller needing to know which broker holds each instrument.
 *              Dispatches vortex, kite, massive, and binance batches in parallel.
 *
 * Exports:
 *   - UniversalLtpService.getUniversalLtp(ids) → { success, data }
 *     data is keyed by universal instrument id (string): { last_price: number|null }
 *
 * Depends on:
 *   - InstrumentRegistryService — in-memory O(1) map of uirId → provider tokens
 *   - VortexProviderService     — getLTPByPairs() for vortex-mapped instruments (Indian exchanges)
 *   - KiteProviderService       — getLTPByPairs() for kite-only instruments
 *   - MassiveProviderService    — getLTPByPairs() for US/FX/CRYPTO/IDX instruments
 *   - BinanceProviderService    — getLTPByPairs() for BINANCE crypto pairs
 *
 * Side-effects:
 *   - HTTP calls to vortex, kite, massive, and/or binance REST endpoints
 *     (non-fatal; returns null last_price on failure)
 *
 * Key invariants:
 *   - Vortex provider_token format in instrument_mappings: "EXCHANGE-token" e.g. "NSE_EQ-22"
 *   - Split on last '-' to recover exchange and token
 *   - Massive provider_token is the ticker symbol string e.g. "AAPL"
 *   - Binance provider_token is the uppercase symbol string e.g. "BTCUSDT"
 *   - Routing: vortex wins if token present AND vortex isConfigured; else kite; else massive; else binance
 *   - If Vortex has no credentials (only Kite set up), instruments with both tokens fall through to Kite
 *   - Result is always { success: true, data: {...} } — never throws (errors degrade to empty data)
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-03
 */

import { Injectable, Logger } from '@nestjs/common';
import { InstrumentRegistryService } from '@features/market-data/application/instrument-registry.service';
import { VortexProviderService } from '../infra/vortex-provider.service';
import { KiteProviderService } from '@features/kite-connect/infra/kite-provider.service';
import { MassiveProviderService } from '@features/massive/infra/massive-provider.service';
import { BinanceProviderService } from '@features/binance/infra/binance-provider.service';

@Injectable()
export class UniversalLtpService {
  private readonly logger = new Logger(UniversalLtpService.name);

  constructor(
    private readonly registry: InstrumentRegistryService,
    private readonly vortexProvider: VortexProviderService,
    private readonly kiteProvider: KiteProviderService,
    private readonly massiveProvider: MassiveProviderService,
    private readonly binanceProvider: BinanceProviderService,
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

    const massivePairs: Array<{ exchange: string; token: string }> = [];
    const massiveTokenToUirId = new Map<string, number>(); // "AAPL" → uirId

    const binancePairs: Array<{ exchange: string; token: string }> = [];
    const binanceTokenToUirId = new Map<string, number>(); // "BTCUSDT" → uirId

    for (const id of ids) {
      const providerMap = this.registry.getProviderTokens(id);
      if (!providerMap) continue;

      const vortexToken = providerMap.get('vortex'); // "NSE_EQ-22"
      const kiteToken = providerMap.get('kite');     // "256265"
      const massiveToken = providerMap.get('massive'); // "AAPL"
      const binanceToken = providerMap.get('binance'); // "BTCUSDT"

      // Route to Vortex only when it is configured; otherwise fall through to Kite.
      // Instruments often have both tokens — Vortex returning empty (no credentials)
      // used to silently drop NSE prices even though Kite was valid.
      if (vortexToken && this.vortexProvider.isConfigured) {
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
      } else if (massiveToken) {
        const exchange = this.registry.getExchange(id) ?? 'US';
        massivePairs.push({ exchange, token: massiveToken });
        massiveTokenToUirId.set(massiveToken, id);
      } else if (binanceToken) {
        const exchange = this.registry.getExchange(id) ?? 'BINANCE';
        binancePairs.push({ exchange, token: binanceToken });
        binanceTokenToUirId.set(binanceToken, id);
      }
    }

    // All three provider batches run in parallel
    await Promise.all([
      // Vortex batch
      vortexPairs.length
        ? this.vortexProvider.getLTPByPairs(vortexPairs)
            .then((ltpMap) => {
              for (const [exTok, val] of Object.entries(ltpMap)) {
                const uirId = vortexTokenToUirId.get(exTok);
                if (uirId != null) result[String(uirId)] = val;
              }
            })
            .catch((err: any) => this.logger.warn(`[UniversalLtp] vortex batch failed: ${err?.message}`))
        : Promise.resolve(),

      // Kite batch (fallback for instruments without vortex mapping)
      kitePairs.length
        ? this.kiteProvider.getLTPByPairs(kitePairs)
            .then((ltpMap) => {
              for (const [key, val] of Object.entries(ltpMap)) {
                // Try token alone (last segment after '-') as a lookup key
                const tok = key.includes('-') ? key.split('-').pop()! : key;
                const uirId = kiteTokenToUirId.get(tok) ?? kiteTokenToUirId.get(key);
                if (uirId != null) result[String(uirId)] = val as { last_price: number | null };
              }
            })
            .catch((err: any) => this.logger.warn(`[UniversalLtp] kite batch failed: ${err?.message}`))
        : Promise.resolve(),

      // Massive batch (US/FX/CRYPTO/IDX instruments)
      massivePairs.length
        ? this.massiveProvider.getLTPByPairs(massivePairs)
            .then((ltpMap) => {
              // MassiveProvider keys result as "EXCHANGE-TOKEN" (e.g. "US-AAPL")
              for (const [key, val] of Object.entries(ltpMap)) {
                const tok = key.includes('-') ? key.split('-').pop()! : key;
                const uirId = massiveTokenToUirId.get(tok) ?? massiveTokenToUirId.get(key);
                if (uirId != null) result[String(uirId)] = val;
              }
            })
            .catch((err: any) => this.logger.warn(`[UniversalLtp] massive batch failed: ${err?.message}`))
        : Promise.resolve(),

      // Binance batch (BINANCE crypto pairs)
      binancePairs.length
        ? this.binanceProvider.getLTPByPairs(binancePairs)
            .then((ltpMap) => {
              // BinanceProvider keys result as "EXCHANGE-TOKEN" (e.g. "BINANCE-BTCUSDT")
              for (const [key, val] of Object.entries(ltpMap)) {
                const tok = key.includes('-') ? key.split('-').pop()! : key;
                const uirId = binanceTokenToUirId.get(tok) ?? binanceTokenToUirId.get(key);
                if (uirId != null) result[String(uirId)] = val;
              }
            })
            .catch((err: any) => this.logger.warn(`[UniversalLtp] binance batch failed: ${err?.message}`))
        : Promise.resolve(),
    ]);

    return { success: true, data: result };
  }
}
