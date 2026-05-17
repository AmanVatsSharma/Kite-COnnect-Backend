/**
 * @file options-greeks.service.ts
 * @module Falcon · Options Greeks Service
 * @description Enriches options chain data with Black-Scholes Greeks (delta, gamma, theta, vega, IV).
 *              Orchestrates the math library and provides batch enrichment for entire chains.
 *
 * Exports:
 *   - OptionsGreeksService — Injectable service for Greek calculations
 *
 * Depends on:
 *   - @/shared/utils/options-math — Pure math functions
 *
 * Author: BharatERP
 * Last-updated: 2026-05-17
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  RISK_FREE_RATE,
  blackScholesCall,
  blackScholesPut,
  delta,
  gamma,
  theta,
  vega,
  impliedVolatility,
  daysToExpiry,
  calculateMaxPain,
  probabilityITM,
} from '@shared/utils/options-math';

export interface OptionQuote {
  instrument_token: number;
  tradingsymbol: string;
  expiry: string;
  strike: number;
  instrument_type: 'CE' | 'PE';
  last_price?: number | null;
  oi?: number | null;
  volume?: number | null;
  ohlc?: { open: number; high: number; low: number; close: number } | null;
  depth?: {
    buy: Array<{ price: number; quantity: number }>;
    sell: Array<{ price: number; quantity: number }>;
  } | null;
}

export interface EnrichedOption extends OptionQuote {
  iv?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  theoretical_price?: number | null;
  probability_itm?: number | null;
}

export interface StrikeData {
  strike: number;
  itm?: 'CE' | 'PE' | 'ATM' | null;
  CE?: EnrichedOption;
  PE?: EnrichedOption;
}

export interface ExpiryData {
  expiry: string;
  pcr?: number | null;
  total_ce_oi?: number;
  total_pe_oi?: number;
  avg_iv?: number | null;
  max_pain?: number | null;
  strikes: StrikeData[];
}

export interface EnrichedDeepOptionsChain {
  symbol: string;
  underlying_ltp: number | null;
  atm_strike: number | null;
  fetched_at: string;
  expiries: string[];
  chain: Record<string, ExpiryData>;
}

@Injectable()
export class OptionsGreeksService {
  private readonly logger = new Logger(OptionsGreeksService.name);
  private readonly riskFreeRate = RISK_FREE_RATE;

  /**
   * Enrich a single option with Greeks
   */
  enrichOption(
    option: OptionQuote,
    spotPrice: number,
    riskFreeRate = this.riskFreeRate,
  ): EnrichedOption {
    try {
      const T = daysToExpiry(option.expiry);
      const marketPrice = option.last_price ?? 0;

      // Skip if no valid price or expired
      if (T <= 0 || marketPrice <= 0) {
        return { ...option };
      }

      // Calculate IV from market price
      const iv = impliedVolatility(
        marketPrice,
        spotPrice,
        option.strike,
        T,
        riskFreeRate,
        option.instrument_type === 'CE' ? 'call' : 'put',
      );

      if (iv === null) {
        this.logger.debug(
          `Could not calculate IV for ${option.tradingsymbol}: marketPrice=${marketPrice}`,
        );
        return { ...option };
      }

      // Calculate all Greeks
      const type = option.instrument_type === 'CE' ? 'call' : 'put';
      const d = delta(type, spotPrice, option.strike, T, riskFreeRate, iv);
      const g = gamma(spotPrice, option.strike, T, riskFreeRate, iv);
      const t = theta(type, spotPrice, option.strike, T, riskFreeRate, iv);
      const v = vega(spotPrice, option.strike, T, riskFreeRate, iv);

      // Theoretical price
      const theoreticalPrice =
        type === 'call'
          ? blackScholesCall(spotPrice, option.strike, T, riskFreeRate, iv)
          : blackScholesPut(spotPrice, option.strike, T, riskFreeRate, iv);

      // Probability of ITM
      const probItm = probabilityITM(type, spotPrice, option.strike, T, riskFreeRate, iv);

      return {
        ...option,
        iv: Math.round(iv * 10000) / 100, // IV as percentage (e.g., 15.5)
        delta: Math.round(d * 10000) / 10000, // 4 decimal places
        gamma: Math.round(g * 100000) / 100000, // 5 decimal places
        theta: Math.round(t * 100) / 100, // 2 decimal places (₹/day)
        vega: Math.round(v * 100) / 100, // 2 decimal places (₹ per 1% IV)
        theoretical_price:
          Math.round(theoreticalPrice * 100) / 100, // 2 decimal places
        probability_itm: Math.round(probItm * 1000) / 10, // Percentage (e.g., 45.5)
      };
    } catch (error) {
      this.logger.warn(
        `Failed to enrich option ${option.tradingsymbol}: ${(error as Error).message}`,
      );
      return { ...option };
    }
  }

  /**
   * Enrich entire options chain with Greeks
   * Processes strikes in parallel for performance
   */
  enrichChain(
    chain: EnrichedDeepOptionsChain,
    spotPrice: number,
    riskFreeRate = this.riskFreeRate,
  ): EnrichedDeepOptionsChain {
    const enrichedChain: EnrichedDeepOptionsChain = {
      ...chain,
      chain: {},
    };

    let totalIV = 0;
    let ivCount = 0;

    for (const [expiry, expiryData] of Object.entries(chain.chain)) {
      const enrichedStrikes: StrikeData[] = [];
      const strikesForPain: Array<{ strike: number; ce_oi?: number; pe_oi?: number }> = [];
      let expiryTotalIV = 0;
      let expiryIVCount = 0;

      for (const strikeData of expiryData.strikes) {
        const enrichedStrike: StrikeData = { ...strikeData };

        // Enrich CE
        if (strikeData.CE) {
          enrichedStrike.CE = this.enrichOption(strikeData.CE, spotPrice, riskFreeRate);
          if (enrichedStrike.CE.iv != null) {
            expiryTotalIV += enrichedStrike.CE.iv;
            expiryIVCount++;
            totalIV += enrichedStrike.CE.iv;
            ivCount++;
          }
        }

        // Enrich PE
        if (strikeData.PE) {
          enrichedStrike.PE = this.enrichOption(strikeData.PE, spotPrice, riskFreeRate);
          if (enrichedStrike.PE.iv != null) {
            expiryTotalIV += enrichedStrike.PE.iv;
            expiryIVCount++;
            totalIV += enrichedStrike.PE.iv;
            ivCount++;
          }
        }

        enrichedStrikes.push(enrichedStrike);

        // Collect for Max Pain
        strikesForPain.push({
          strike: strikeData.strike,
          ce_oi: enrichedStrike.CE?.oi ?? undefined,
          pe_oi: enrichedStrike.PE?.oi ?? undefined,
        });
      }

      // Calculate Max Pain for this expiry
      const maxPain = strikesForPain.length > 0
        ? calculateMaxPain(strikesForPain, spotPrice)
        : null;

      // Average IV for this expiry
      const avgIV = expiryIVCount > 0 ? expiryTotalIV / expiryIVCount : null;

      enrichedChain.chain[expiry] = {
        ...expiryData,
        strikes: enrichedStrikes,
        avg_iv: avgIV !== null ? Math.round(avgIV * 100) / 100 : null,
        max_pain: maxPain,
      };
    }

    return enrichedChain;
  }

  /**
   * Batch enrich options chain (async, for use with Promise.all)
   * Use this when you need parallel processing across multiple symbols
   */
  async enrichChainAsync(
    chain: EnrichedDeepOptionsChain,
    spotPrice: number,
    riskFreeRate = this.riskFreeRate,
  ): Promise<EnrichedDeepOptionsChain> {
    return this.enrichChain(chain, spotPrice, riskFreeRate);
  }
}