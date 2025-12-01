import { Injectable, Logger } from '@nestjs/common';

/**
 * Parsed representation of a free-text F&O style query.
 *
 * Examples of supported queries:
 * - "nifty 26000 ce"
 * - "banknifty 28mar 45000 pe"
 * - "gold 62000 pe"
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
}

@Injectable()
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
    let expiryFrom: string | undefined;
    let expiryTo: string | undefined;

    const optionTokens = new Set(['CE', 'PE', 'CALL', 'PUT', 'C', 'P']);
    const usedAsExpiry = new Set<string>();

    // 1) Detect option type and expiry tokens first
    for (const token of tokens) {
      const t = token.toUpperCase();

      // Option type detection (only first match is used)
      if (!optionType && optionTokens.has(t)) {
        if (t === 'CE' || t === 'C' || t === 'CALL') {
          optionType = 'CE';
          continue;
        }
        if (t === 'PE' || t === 'P' || t === 'PUT') {
          optionType = 'PE';
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
      }
    }

    // 2) Detect strike as the first reasonably sized numeric token
    for (const token of tokens) {
      const n = Number(token.replace(/[^\d.]/g, ''));
      if (!Number.isFinite(n)) continue;
      // Ignore obviously tiny or unrealistic values (defensive guard)
      if (n <= 1) continue;
      // Only take the first candidate; callers can always override via query params
      strike = n;
      break;
    }

    // 3) Detect underlying symbol as the first non-numeric, non-option, non-expiry token
    //    e.g., "NIFTY" in "nifty 26000 ce"
    for (const token of tokens) {
      const t = token.toUpperCase();
      if (optionTokens.has(t)) continue;
      if (usedAsExpiry.has(t)) continue;
      if (/^\d+(\.\d+)?$/.test(t)) continue;

      // Skip pure month names when not accompanied by a year – too ambiguous
      if (this.isMonthToken(t) && !/\d/.test(t)) continue;

      // Clean underlying to alphabetic prefix (e.g., BANKNIFTY-I -> BANKNIFTY)
      const alpha = t.replace(/[^A-Z]/g, '');
      if (!alpha) continue;

      underlying = alpha;
      break;
    }

    const parsed: ParsedFoQuery = {
      ...base,
      underlying,
      strike,
      optionType,
      expiryFrom,
      expiryTo,
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
    const token = rawToken.replace(/[^A-Z0-9]/g, '').toUpperCase();
    if (!token) return null;

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
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
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
}


