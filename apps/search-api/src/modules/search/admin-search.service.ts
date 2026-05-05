/**
 * @file apps/search-api/src/modules/search/admin-search.service.ts
 * @module search-api
 * @description Admin-facing service for the Search Admin panel. Reads MeiliSearch
 *              index stats + settings + the Redis-stored synonym telemetry that the
 *              indexer would convert to dynamic synonyms on its next `synonyms-apply`
 *              run. View-only — no destructive actions in V1.
 *
 * Exports:
 *   - AdminSearchService                  — NestJS injectable service
 *   - SearchAdminOverview                 — combined response shape for the panel
 *
 * Depends on:
 *   - MEILI_HOST_PRIMARY                  — primary Meili server (re-uses search.service env)
 *   - MEILI_MASTER_KEY                    — auth for Meili admin routes
 *   - REDIS_HOST / REDIS_PORT             — for scanning syn:q:*:sym:* counters
 *
 * Side-effects:
 *   - HTTP GET to MeiliSearch (/indexes/{idx}/stats and /settings)
 *   - Redis SCAN over the syn:q:* keyspace (bounded by SCAN COUNT cap)
 *
 * Key invariants:
 *   - Never throws on Meili/Redis failure — partial responses with `errors: [...]` instead.
 *     The admin panel must remain navigable even when one backend is down.
 *   - Synonym scan is read-only; mutations go through the indexer's `synonyms-apply` mode.
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-01
 */

import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import Redis from 'ioredis';

/** Combined response shape the admin panel renders. */
export type SearchAdminOverview = {
  meili: {
    indexName: string;
    numberOfDocuments: number | null;
    isIndexing: boolean | null;
    fieldDistribution: Record<string, number> | null;
    settings: {
      searchableAttributes: string[] | null;
      filterableAttributes: string[] | null;
      sortableAttributes: string[] | null;
      synonymCount: number | null;
    };
  };
  /**
   * Top-N (q, symbol) selection signals from Redis. These are what the indexer would
   * promote to dynamic synonyms on its next `synonyms-apply` run — admins can preview
   * the candidate list before applying.
   */
  selectionSignals: {
    scanned: number;
    top: { q: string; symbol: string; count: number }[];
  };
  /**
   * Top-N most-searched queries (aggregated across symbols). Useful to sanity-check
   * that the indexer's tokenization + synonyms cover the real query distribution.
   */
  popularQueries: {
    q: string;
    totalSelections: number;
    uniqueSymbols: number;
  }[];
  errors: string[];
  generatedAt: string;
};

@Injectable()
export class AdminSearchService {
  private readonly logger = new Logger('AdminSearchService');
  private readonly meili: AxiosInstance;
  private readonly redis?: Redis;

  constructor() {
    const host =
      process.env.MEILI_HOST_PRIMARY ||
      process.env.MEILI_HOST ||
      'http://meilisearch:7700';
    const apiKey = process.env.MEILI_MASTER_KEY || '';
    this.meili = axios.create({
      baseURL: host,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      timeout: Number(process.env.MEILI_TIMEOUT_MS || 1500),
    });

    try {
      this.redis = new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: Number(process.env.REDIS_PORT || 6379),
        lazyConnect: true,
      });
    } catch {
      this.logger.warn(
        'Redis init failed — admin panel will skip synonym signals',
      );
    }
  }

  async getOverview(topN = 30): Promise<SearchAdminOverview> {
    const indexName = process.env.MEILI_INDEX || 'instruments_v1';
    const errors: string[] = [];

    const [meili, signals] = await Promise.all([
      this.fetchMeiliBlock(indexName).catch((e) => {
        errors.push(`meili: ${e?.message ?? 'unknown'}`);
        return this.emptyMeiliBlock(indexName);
      }),
      this.fetchSelectionSignals(topN).catch((e) => {
        errors.push(`redis: ${e?.message ?? 'unknown'}`);
        return {
          scanned: 0,
          top: [] as { q: string; symbol: string; count: number }[],
        };
      }),
    ]);

    // Aggregate per-query totals from selection signals (one Redis scan, two views).
    const queryAgg = new Map<
      string,
      { totalSelections: number; symbols: Set<string> }
    >();
    for (const sig of signals.top) {
      const cur = queryAgg.get(sig.q) ?? {
        totalSelections: 0,
        symbols: new Set<string>(),
      };
      cur.totalSelections += sig.count;
      cur.symbols.add(sig.symbol);
      queryAgg.set(sig.q, cur);
    }
    const popularQueries = Array.from(queryAgg.entries())
      .map(([q, v]) => ({
        q,
        totalSelections: v.totalSelections,
        uniqueSymbols: v.symbols.size,
      }))
      .sort((a, b) => b.totalSelections - a.totalSelections)
      .slice(0, topN);

    return {
      meili,
      selectionSignals: signals,
      popularQueries,
      errors,
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Meili stats + settings ────────────────────────────────────────────────

  private async fetchMeiliBlock(
    indexName: string,
  ): Promise<SearchAdminOverview['meili']> {
    const [statsResp, settingsResp] = await Promise.all([
      this.meili.get(`/indexes/${indexName}/stats`),
      this.meili.get(`/indexes/${indexName}/settings`),
    ]);

    const stats = statsResp.data || {};
    const settings = settingsResp.data || {};
    return {
      indexName,
      numberOfDocuments:
        typeof stats.numberOfDocuments === 'number'
          ? stats.numberOfDocuments
          : null,
      isIndexing:
        typeof stats.isIndexing === 'boolean' ? stats.isIndexing : null,
      fieldDistribution: stats.fieldDistribution ?? null,
      settings: {
        searchableAttributes: Array.isArray(settings.searchableAttributes)
          ? settings.searchableAttributes
          : null,
        filterableAttributes: Array.isArray(settings.filterableAttributes)
          ? settings.filterableAttributes
          : null,
        sortableAttributes: Array.isArray(settings.sortableAttributes)
          ? settings.sortableAttributes
          : null,
        synonymCount:
          settings.synonyms && typeof settings.synonyms === 'object'
            ? Object.keys(settings.synonyms).length
            : null,
      },
    };
  }

  private emptyMeiliBlock(indexName: string): SearchAdminOverview['meili'] {
    return {
      indexName,
      numberOfDocuments: null,
      isIndexing: null,
      fieldDistribution: null,
      settings: {
        searchableAttributes: null,
        filterableAttributes: null,
        sortableAttributes: null,
        synonymCount: null,
      },
    };
  }

  // ── Selection signals (Redis SCAN over syn:q:*:sym:*) ─────────────────────

  /**
   * Scan keyspace for `syn:q:{query}:sym:{symbol}` counters and return the top-N
   * by count. Bounded by `SCAN_LIMIT` so a runaway keyspace doesn't stall the panel.
   *
   * Scan is non-blocking (cursor-based) and the cap is enforced across iterations,
   * not per-iteration — so large keyspaces are sampled rather than fully read.
   */
  private async fetchSelectionSignals(
    topN: number,
  ): Promise<SearchAdminOverview['selectionSignals']> {
    if (!this.redis) return { scanned: 0, top: [] };

    const SCAN_LIMIT = Number(process.env.ADMIN_SYNONYM_SCAN_LIMIT || 5000);
    const all: { q: string; symbol: string; count: number }[] = [];
    let cursor = '0';
    let scanned = 0;

    do {
      const [next, keys]: [string, string[]] = await this.redis.scan(
        cursor,
        'MATCH',
        'syn:q:*:sym:*',
        'COUNT',
        500,
      );
      cursor = next;

      if (keys.length) {
        const counts = await this.redis.mget(...keys);
        for (let i = 0; i < keys.length; i++) {
          const m = keys[i].match(/^syn:q:(.+):sym:(.+)$/);
          if (!m) continue;
          const c = Number(counts[i] ?? 0);
          if (!Number.isFinite(c) || c <= 0) continue;
          all.push({ q: m[1], symbol: m[2], count: c });
          scanned++;
          if (scanned >= SCAN_LIMIT) {
            cursor = '0';
            break;
          }
        }
      }
    } while (cursor !== '0');

    all.sort((a, b) => b.count - a.count);
    return { scanned, top: all.slice(0, topN) };
  }
}
