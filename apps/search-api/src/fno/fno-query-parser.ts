/**
 * @file apps/search-api/src/fno/fno-query-parser.ts
 * @module search-api
 * @description Standalone copy of the F&O query parser for use by the search-api
 *              microservice. The search-api is a separate Docker container (port 3002)
 *              and cannot import from `src/`, so we duplicate the parser here.
 *              **Keep this file in sync with
 *              `src/features/market-data/application/fno-query-parser.service.ts`
 *              when adding new NL phrases, alias tables, or expiry rules.**
 *
 *              Precedent: `apps/search-indexer/src/index.ts` duplicates
 *              `EXCHANGE_TO_PROVIDER` (see comment there: "duplicated here because
 *              the search-indexer is a separate Docker container with no `src/`
 *              import path").
 *
 *              Used by: the search controller to derive structured filters
 *              (strike, optionType, expiry window, isMonthly, isWeekly) from
 *              the raw `?q=` string before calling MeiliSearch. This is a plain
 *              class (no `@Injectable()` decorator) — the controller instantiates
 *              it directly with `new FnoQueryParserService()`.
 *
 * @author BharatERP
 * @created 2026-06-23
 */
import { Logger } from '@nestjs/common';

/**
 * Parsed representation of a free-text F&O style query.
 *
 * Examples of supported queries:
 * - "nifty 26000 ce"
 * - "banknifty 28mar 45000 pe"
 * - "gold 62000 pe"
 * - "monthly nifty"
 * - "this thursday"
 *
 * The parser is intentionally best-effort:
 * - When it cannot confidently infer a field, that field is left undefined.
 * - Callers must always handle partial parses gracefully.
 */
export interface ParsedFoQuery {
  /** Original raw query string from the client */
  raw: string;
  /** Uppercased, trimmed query used for tokenization */
  normalized: string;
  /** Tokenized representation (uppercased, split on whitespace / dashes / underscores) */
  tokens: string[];
  /** Detected underlying symbol (e.g. NIFTY, BANKNIFTY, GOLD) */
  underlying?: string;
  /** Detected strike price, if any (e.g. 26000) */
  strike?: number;
  /** Detected option type (CE / PE) when present */
  optionType?: 'CE' | 'PE';
  /**
   * Detected expiry window in Vortex DB format (YYYYMMDD).
   * - When we can infer an exact expiry: from === to.
   * - When only a month is known: from = first day, to = last day of month.
   */
  expiryFrom?: string;
  expiryTo?: string;
  /**
   * True when the parser detected "monthly" / "monthly expiry" / "month end"
   * phrasing. Caller should filter MeiliSearch docs on `isMonthly = true`.
   */
  isMonthly?: boolean;
  /**
   * True when the parser detected "weekly" / "weekly expiry" phrasing.
   * Caller should filter MeiliSearch docs on `isWeekly = true`.
   */
  isWeekly?: boolean;
  /**
   * Tokens that should be sent to MeiliSearch's text search (`q`).
   *
   * Excludes:
   * - NL keywords: `monthly`, `weekly`, `expiry`, `month end`, `next week`
   * - Weekday names: `monday`, `tuesday`, …
   * - Strike numbers (consumed into `strike`)
   * - Option type tokens (`CE`, `PE`, `CALL`, `PUT`)
   * - Expiry date tokens (e.g., `28MAR2025`)
   * - The first alphabetic token (consumed into `underlying`)
   *
   * Why this exists: MeiliSearch's text search requires all `q` words to match
   * (with `matchingStrategy: "all"`). NL keywords like "monthly" and "expiry"
   * don't appear in document fields — only as `isMonthly=true` filter — so
   * passing them to Meili would yield 0 hits. The controller should use
   * `textTerms.join(' ')` (or fall back to `q`) as the Meili `q` parameter.
   *
   * Example:
   *   `q="nifty 24000 monthly expiry"`
   *     → underlying="NIFTY", strike=24000, isMonthly=true,
   *       textTerms=["nifty"]  ← underlying is still in terms so Meili ranks by name match
   *
   *   `q="reliance"`
   *     → underlying="RELIANCE", textTerms=["reliance"]
   *
   * Tokens are returned in their original (upper-cased) form, preserving order.
   */
  textTerms?: string[];
}

export class FnoQueryParserService {
  private readonly logger = new Logger(FnoQueryParserService.name);

  /**
   * Parse a free-text F&O style query into structured hints for downstream filters.
   *
   * This does NOT hit the database and never throws – callers should treat the
   * result as hints layered on top of explicit query params.
   */
  parse(raw: string | undefined | null): ParsedFoQuery {
    const safeRaw = (raw ?? '').trim();
    const normalized = safeRaw.toUpperCase();
    const tokens =
      normalized.length > 0
        ? normalized.split(/[\s\-_]+/).filter((t) => t.length > 0)
        : [];

    const base: ParsedFoQuery = {
      raw: safeRaw,
      normalized,
      tokens,
    };

    if (!tokens.length) {
      return base;
    }

    // Internal working state
    let underlying: string | undefined;
    let strike: number | undefined;
    let optionType: 'CE' | 'PE' | undefined;
    let isMonthly = false;
    let isWeekly = false;
    let expiryFrom: string | undefined;
    let expiryTo: string | undefined;

    const optionTokens = new Set(['CE', 'PE', 'CALL', 'PUT', 'C', 'P']);
    const usedAsExpiry = new Set<string>();
    // Track which tokens were consumed by the NL parser so we can return a
    // clean textTerms[] for MeiliSearch text matching. We never strip the
    // underlying itself — Meili's name/symbol fields are what we want to hit.
    const consumed = new Set<number>();

    // 1) Detect option type and expiry tokens first
    for (const token of tokens) {
      const t = token.toUpperCase();

      // Option type detection (only first match is used)
      if (!optionType && optionTokens.has(t)) {
        if (t === 'CE' || t === 'C' || t === 'CALL') {
          optionType = 'CE';
          consumed.add(tokens.indexOf(token));
          continue;
        }
        if (t === 'PE' || t === 'P' || t === 'PUT') {
          optionType = 'PE';
          consumed.add(tokens.indexOf(token));
          continue;
        }
      }

      // Expiry detection
      const exp = this.parseExpiryToken(t);
      if (exp) {
        // Prefer the first detected expiry window; callers can still override
        if (!expiryFrom) expiryFrom = exp.from;
        if (!expiryTo) expiryTo = exp.to;
        usedAsExpiry.add(t);
        consumed.add(tokens.indexOf(token));
      }
    }

    // NL expiry detection: monthly / weekly / weekday tokens
    const NL_MONTHLY = new Set(['MONTHLY', 'MONTHEND', 'MONTH']);
    const NL_WEEKLY = new Set(['WEEKLY']);
    const NL_WEEKDAYS: Record<string, number> = {
      MONDAY: 1,
      TUESDAY: 2,
      WEDNESDAY: 3,
      THURSDAY: 4,
      FRIDAY: 5,
      SATURDAY: 6,
      SUNDAY: 0,
    };
    for (const token of tokens) {
      const t = token.toUpperCase();
      if (NL_MONTHLY.has(t)) {
        isMonthly = true;
        consumed.add(tokens.indexOf(token));
        continue;
      }
      if (NL_WEEKLY.has(t)) {
        isWeekly = true;
        consumed.add(tokens.indexOf(token));
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(NL_WEEKDAYS, t)) {
        const target = NL_WEEKDAYS[t];
        const today = new Date();
        const cur = today.getDay();
        let delta = (target - cur + 7) % 7;
        if (delta === 0) delta = 7;
        const next = new Date(today.getTime() + delta * 86400000);
        const ymd = this.toYmd(
          next.getFullYear(),
          next.getMonth() + 1,
          next.getDate(),
        );
        if (!expiryFrom) expiryFrom = ymd;
        if (!expiryTo) expiryTo = ymd;
        consumed.add(tokens.indexOf(token));
      }
    }

    const lowerTokens = tokens.map((t) => t.toLowerCase());
    if (
      lowerTokens.includes('next') &&
      lowerTokens.some((t) => t === 'week' || t === 'weekly')
    ) {
      const today = new Date();
      const tomorrow = new Date(today.getTime() + 86400000);
      const weekOut = new Date(today.getTime() + 7 * 86400000);
      const from = this.toYmd(
        tomorrow.getFullYear(),
        tomorrow.getMonth() + 1,
        tomorrow.getDate(),
      );
      const to = this.toYmd(
        weekOut.getFullYear(),
        weekOut.getMonth() + 1,
        weekOut.getDate(),
      );
      if (!expiryFrom || expiryFrom < from) expiryFrom = from;
      if (!expiryTo || expiryTo > to) expiryTo = to;
      // Mark "next" + "week"/"weekly" tokens as consumed so they don't pollute
      // the textTerms[] that the controller sends to Meili.
      const nextIdx = lowerTokens.indexOf('next');
      if (nextIdx >= 0) consumed.add(nextIdx);
      const weekIdx = lowerTokens.findIndex(
        (t) => t === 'week' || t === 'weekly',
      );
      if (weekIdx >= 0) consumed.add(weekIdx);
    }

    // 2) Detect strike as the first reasonably sized numeric token.
    //    Supports relaxed formats like "26k" (→ 26000) in addition to plain numbers.
    for (const token of tokens) {
      if (usedAsExpiry.has(token)) continue;
      const parsedStrike = this.parseStrikeToken(token);
      if (parsedStrike === null) continue;
      // Only take the first candidate; callers can always override via query params
      strike = parsedStrike;
      consumed.add(tokens.indexOf(token));
      break;
    }

    // 3) Detect underlying symbol as the first non-numeric, non-option, non-expiry token
    //    e.g., "NIFTY" in "nifty 26000 ce"
    for (const token of tokens) {
      const t = token.toUpperCase();
      if (optionTokens.has(t)) continue;
      if (usedAsExpiry.has(t)) continue;
      if (NL_MONTHLY.has(t)) continue;
      if (NL_WEEKLY.has(t)) continue;
      if (Object.prototype.hasOwnProperty.call(NL_WEEKDAYS, t)) continue;
      if (/^\d+(\.\d+)?$/.test(t)) continue;

      // Skip pure month names when not accompanied by a year – too ambiguous
      if (this.isMonthToken(t) && !/\d/.test(t)) continue;

      // Clean underlying to alphabetic prefix (e.g., BANKNIFTY-I -> BANKNIFTY)
      const alpha = t.replace(/[^A-Z]/g, '');
      if (!alpha) continue;

      // Normalize common aliases to their canonical underlying (e.g., NIFTY50 -> NIFTY).
      underlying = this.normalizeUnderlying(alpha);
      // NOTE: we deliberately do NOT add this token to `consumed` — the
      // underlying (e.g. "NIFTY") is exactly what we want Meili to text-match
      // against the `name` / `symbol` fields of the index documents. Stripping
      // it would leave Meili with no text signal and rely entirely on
      // filterable attrs (which `underlyingSymbol` is not, in our index).
      break;
    }

    const parsed: ParsedFoQuery = {
      ...base,
      underlying,
      strike,
      optionType,
      expiryFrom,
      expiryTo,
      isMonthly: isMonthly || undefined,
      isWeekly: isWeekly || undefined,
      textTerms:
        consumed.size > 0
          ? tokens.filter((_, i) => !consumed.has(i))
          : tokens.slice(),
    };

    // Debug-level only to avoid noisy logs in production, but extremely useful during tuning
    this.logger.debug?.(
      `[FnoQueryParser] Parsed query="${safeRaw}" -> ` +
        JSON.stringify({
          underlying: parsed.underlying,
          strike: parsed.strike,
          optionType: parsed.optionType,
          expiryFrom: parsed.expiryFrom,
          expiryTo: parsed.expiryTo,
        }),
    );

    return parsed;
  }

  /**
   * Try to interpret a token as an expiry hint and convert it into a
   * [from, to] window in YYYYMMDD format.
   *
   * Supported patterns (case-insensitive, separators ignored):
   * - YYYYMMDD          → exact date
   * - DDMMMYYYY / DDMMMYY (e.g., 28MAR2025, 28MAR25)
   * - MMMYYYY / MMMYY   → whole month window (e.g., MAR2025)
   */
  private parseExpiryToken(
    rawToken: string,
  ): { from: string; to: string } | null {
    // Normalize token and strip separator noise
    let token = rawToken.replace(/[^A-Z0-9]/g, '').toUpperCase();
    if (!token) return null;

    // Weekly expiries sometimes carry a trailing W and digit (e.g., 28MAR24W4).
    // Strip the W-suffix before pattern matching; expiry window is still based on date only.
    token = token.replace(/W\d+$/i, '');

    // YYYYMMDD
    if (/^\d{8}$/.test(token)) {
      const yyyy = Number(token.slice(0, 4));
      const mm = Number(token.slice(4, 6));
      const dd = Number(token.slice(6, 8));
      if (!this.isValidYmd(yyyy, mm, dd)) return null;
      const ymd = this.toYmd(yyyy, mm, dd);
      return { from: ymd, to: ymd };
    }

    // DDMMMYYYY or DDMMMYY (e.g., 28MAR2025, 28MAR25)
    if (/^\d{1,2}[A-Z]{3}\d{2,4}$/.test(token)) {
      const dayPart = token.match(/^\d{1,2}/)![0];
      const day = Number(dayPart);
      const monthStr = token.substr(dayPart.length, 3);
      const yearPart = token.substr(dayPart.length + 3);
      const month = this.monthFromToken(monthStr);
      if (!month) return null;
      const year = this.normalizeYear(Number(yearPart));
      if (!this.isValidYmd(year, month, day)) return null;
      const ymd = this.toYmd(year, month, day);
      return { from: ymd, to: ymd };
    }

    // MMMYYYY or MMMYY (month window)
    if (/^[A-Z]{3}\d{2,4}$/.test(token)) {
      const monthStr = token.substr(0, 3);
      const yearPart = token.substr(3);
      const month = this.monthFromToken(monthStr);
      if (!month) return null;
      const year = this.normalizeYear(Number(yearPart));
      const from = this.toYmd(year, month, 1);
      const lastDay = this.lastDayOfMonth(year, month);
      const to = this.toYmd(year, month, lastDay);
      return { from, to };
    }

    return null;
  }

  /** Convert YYYY, MM, DD into compact YYYYMMDD */
  private toYmd(year: number, month: number, day: number): string {
    const mm = month.toString().padStart(2, '0');
    const dd = day.toString().padStart(2, '0');
    return `${year}${mm}${dd}`;
  }

  /** Check if a Y/M/D triple is a valid calendar date. */
  private isValidYmd(year: number, month: number, day: number): boolean {
    if (
      !Number.isFinite(year) ||
      !Number.isFinite(month) ||
      !Number.isFinite(day)
    ) {
      return false;
    }
    if (month < 1 || month > 12) return false;
    if (day < 1) return false;
    const last = this.lastDayOfMonth(year, month);
    return day <= last;
  }

  /** Last day of a given month/year. */
  private lastDayOfMonth(year: number, month: number): number {
    // JS Date: day=0 gives last day of previous month
    return new Date(year, month, 0).getDate();
  }

  /** Map a month token like JAN/MAR/APR to a month number. */
  private monthFromToken(mon: string): number | null {
    const map: Record<string, number> = {
      JAN: 1,
      FEB: 2,
      MAR: 3,
      APR: 4,
      MAY: 5,
      JUN: 6,
      JUL: 7,
      AUG: 8,
      SEP: 9,
      OCT: 10,
      NOV: 11,
      DEC: 12,
    };
    return map[mon.toUpperCase()] ?? null;
  }

  /** Detect whether a token looks like a month name (JAN, FEB, ...) */
  private isMonthToken(token: string): boolean {
    return this.monthFromToken(token) !== null;
  }

  /**
   * Normalize a 2-digit or 4-digit year into a 4-digit year.
   * - 0–79  → 2000–2079
   * - 80–99 → 1980–1999
   * - 4-digit values are passed through as-is.
   */
  private normalizeYear(year: number): number {
    if (!Number.isFinite(year)) return new Date().getFullYear();
    if (year >= 1000) return year;
    if (year >= 0 && year <= 79) return 2000 + year;
    if (year >= 80 && year <= 99) return 1900 + year;
    return year;
  }

  /**
   * Parse a potential strike token into a numeric strike, handling relaxed formats.
   *
   * Supported examples:
   * - "26000"      → 26000
   * - "26K" / "26k"   → 26000
   * - "26.5K"      → 26500
   *
   * Returns null when the token does not look like a reasonable strike.
   */
  private parseStrikeToken(token: string): number | null {
    const raw = String(token || '').toUpperCase();
    if (!raw) return null;

    // 26K / 26.5K style shorthand
    if (/^\d+(\.\d+)?[K]$/.test(raw)) {
      const kMatch = raw.match(/^(\d+(?:\.\d+)?)[K]$/)!;
      const base = Number(kMatch[1]);
      if (!Number.isFinite(base)) return null;
      const value = base * 1000;
      return value > 1 ? value : null;
    }

    // Plain numeric strike (e.g. 26000)
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      if (n <= 1) return null;
      return n;
    }

    return null;
  }

  /**
   * Normalize underlying aliases to canonical symbols.
   * This is intentionally conservative to avoid surprising remaps.
   */
  private normalizeUnderlying(symbol: string): string {
    const s = (symbol || '').toUpperCase();
    const aliases: Record<string, string> = {
      NIFTY50: 'NIFTY',
      MM: 'MM',
      MANDM: 'MM',
      BAJAJAUTO: 'BAJAJ_AUTO',
      BAJAJFINANCE: 'BAJFINANCE',
      HUL: 'HINDUNILVR',
    };
    return aliases[s] || s;
  }
}
