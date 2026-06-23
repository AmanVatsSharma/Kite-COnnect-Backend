"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FnoQueryParserService = void 0;
const common_1 = require("@nestjs/common");
class FnoQueryParserService {
    constructor() {
        this.logger = new common_1.Logger(FnoQueryParserService.name);
    }
    parse(raw) {
        var _a, _b;
        const safeRaw = (raw !== null && raw !== void 0 ? raw : '').trim();
        const normalized = safeRaw.toUpperCase();
        const tokens = normalized.length > 0
            ? normalized.split(/[\s\-_]+/).filter((t) => t.length > 0)
            : [];
        const base = {
            raw: safeRaw,
            normalized,
            tokens,
        };
        if (!tokens.length) {
            return base;
        }
        let underlying;
        let strike;
        let optionType;
        let isMonthly = false;
        let isWeekly = false;
        let expiryFrom;
        let expiryTo;
        const optionTokens = new Set(['CE', 'PE', 'CALL', 'PUT', 'C', 'P']);
        const usedAsExpiry = new Set();
        const consumed = new Set();
        for (const token of tokens) {
            const t = token.toUpperCase();
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
            const exp = this.parseExpiryToken(t);
            if (exp) {
                if (!expiryFrom)
                    expiryFrom = exp.from;
                if (!expiryTo)
                    expiryTo = exp.to;
                usedAsExpiry.add(t);
                consumed.add(tokens.indexOf(token));
            }
        }
        const NL_MONTHLY = new Set(['MONTHLY', 'MONTHEND', 'MONTH']);
        const NL_WEEKLY = new Set(['WEEKLY']);
        const NL_FILLER = new Set([
            'EXPIRY',
            'EXPIRING',
            'OPTIONS',
            'OPTION',
            'FUTURES',
            'FUTURE',
            'CONTRACTS',
            'CONTRACT',
            'INSTRUMENT',
            'INSTRUMENTS',
            'STOCKS',
            'STOCK',
            'SHARE',
            'SHARES',
            'SYMBOL',
            'TODAY',
            'TOMORROW',
        ]);
        const NL_WEEKDAYS = {
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
            if (NL_FILLER.has(t)) {
                consumed.add(tokens.indexOf(token));
                continue;
            }
            if (!expiryFrom && /^\d{1,2}$/.test(t)) {
                const day = parseInt(t, 10);
                const idx = tokens.indexOf(token);
                const nextTok = tokens[idx + 1];
                if (day >= 1 &&
                    day <= 31 &&
                    nextTok &&
                    this.isMonthToken(nextTok.toUpperCase())) {
                    const monthNum = this.monthFromToken(nextTok.toUpperCase());
                    if (monthNum) {
                        const today = new Date();
                        let yr = today.getFullYear();
                        const candidate = new Date(yr, monthNum - 1, day);
                        if (candidate.getTime() < today.getTime() - 86400000) {
                            yr += 1;
                        }
                        const ymd = this.toYmd(yr, monthNum, day);
                        if (!expiryFrom)
                            expiryFrom = ymd;
                        if (!expiryTo)
                            expiryTo = ymd;
                        usedAsExpiry.add(token);
                        usedAsExpiry.add(nextTok);
                        consumed.add(idx);
                        consumed.add(idx + 1);
                        continue;
                    }
                }
            }
            if (!expiryFrom && this.isMonthToken(t)) {
                const idx = tokens.indexOf(token);
                const nextTok = tokens[idx + 1];
                if (nextTok && /^\d{1,2}$/.test(nextTok)) {
                    const day = parseInt(nextTok, 10);
                    const monthNum = this.monthFromToken(t);
                    if (monthNum && day >= 1 && day <= 31) {
                        const today = new Date();
                        let yr = today.getFullYear();
                        const candidate = new Date(yr, monthNum - 1, day);
                        if (candidate.getTime() < today.getTime() - 86400000) {
                            yr += 1;
                        }
                        const ymd = this.toYmd(yr, monthNum, day);
                        if (!expiryFrom)
                            expiryFrom = ymd;
                        if (!expiryTo)
                            expiryTo = ymd;
                        usedAsExpiry.add(token);
                        usedAsExpiry.add(nextTok);
                        consumed.add(idx);
                        consumed.add(idx + 1);
                        continue;
                    }
                }
            }
            if (Object.prototype.hasOwnProperty.call(NL_WEEKDAYS, t)) {
                const target = NL_WEEKDAYS[t];
                const today = new Date();
                const cur = today.getDay();
                let delta = (target - cur + 7) % 7;
                if (delta === 0)
                    delta = 7;
                const next = new Date(today.getTime() + delta * 86400000);
                const ymd = this.toYmd(next.getFullYear(), next.getMonth() + 1, next.getDate());
                if (!expiryFrom)
                    expiryFrom = ymd;
                if (!expiryTo)
                    expiryTo = ymd;
                consumed.add(tokens.indexOf(token));
            }
        }
        const lowerTokens = tokens.map((t) => t.toLowerCase());
        if (lowerTokens.includes('next') &&
            lowerTokens.some((t) => t === 'week' || t === 'weekly')) {
            const today = new Date();
            const tomorrow = new Date(today.getTime() + 86400000);
            const weekOut = new Date(today.getTime() + 7 * 86400000);
            const from = this.toYmd(tomorrow.getFullYear(), tomorrow.getMonth() + 1, tomorrow.getDate());
            const to = this.toYmd(weekOut.getFullYear(), weekOut.getMonth() + 1, weekOut.getDate());
            if (!expiryFrom || expiryFrom < from)
                expiryFrom = from;
            if (!expiryTo || expiryTo > to)
                expiryTo = to;
            const nextIdx = lowerTokens.indexOf('next');
            if (nextIdx >= 0)
                consumed.add(nextIdx);
            const weekIdx = lowerTokens.findIndex((t) => t === 'week' || t === 'weekly');
            if (weekIdx >= 0)
                consumed.add(weekIdx);
        }
        for (const token of tokens) {
            if (usedAsExpiry.has(token))
                continue;
            const parsedStrike = this.parseStrikeToken(token);
            if (parsedStrike === null)
                continue;
            strike = parsedStrike;
            consumed.add(tokens.indexOf(token));
            break;
        }
        for (const token of tokens) {
            const t = token.toUpperCase();
            if (optionTokens.has(t))
                continue;
            if (usedAsExpiry.has(t))
                continue;
            if (NL_MONTHLY.has(t))
                continue;
            if (NL_WEEKLY.has(t))
                continue;
            if (NL_FILLER.has(t))
                continue;
            if (Object.prototype.hasOwnProperty.call(NL_WEEKDAYS, t))
                continue;
            if (/^\d+(\.\d+)?$/.test(t))
                continue;
            if (this.isMonthToken(t) && !/\d/.test(t))
                continue;
            const alpha = t.replace(/[^A-Z]/g, '');
            if (!alpha)
                continue;
            underlying = this.normalizeUnderlying(alpha);
            break;
        }
        const parsed = {
            ...base,
            underlying,
            strike,
            optionType,
            expiryFrom,
            expiryTo,
            isMonthly: isMonthly || undefined,
            isWeekly: isWeekly || undefined,
            textTerms: consumed.size > 0
                ? tokens.filter((_, i) => !consumed.has(i))
                : tokens.slice(),
        };
        (_b = (_a = this.logger).debug) === null || _b === void 0 ? void 0 : _b.call(_a, `[FnoQueryParser] Parsed query="${safeRaw}" -> ` +
            JSON.stringify({
                underlying: parsed.underlying,
                strike: parsed.strike,
                optionType: parsed.optionType,
                expiryFrom: parsed.expiryFrom,
                expiryTo: parsed.expiryTo,
            }));
        return parsed;
    }
    parseExpiryToken(rawToken) {
        let token = rawToken.replace(/[^A-Z0-9]/g, '').toUpperCase();
        if (!token)
            return null;
        token = token.replace(/W\d+$/i, '');
        if (/^\d{8}$/.test(token)) {
            const yyyy = Number(token.slice(0, 4));
            const mm = Number(token.slice(4, 6));
            const dd = Number(token.slice(6, 8));
            if (!this.isValidYmd(yyyy, mm, dd))
                return null;
            const ymd = this.toYmd(yyyy, mm, dd);
            return { from: ymd, to: ymd };
        }
        if (/^\d{1,2}[A-Z]{3}\d{2,4}$/.test(token)) {
            const dayPart = token.match(/^\d{1,2}/)[0];
            const day = Number(dayPart);
            const monthStr = token.substr(dayPart.length, 3);
            const yearPart = token.substr(dayPart.length + 3);
            const month = this.monthFromToken(monthStr);
            if (!month)
                return null;
            const year = this.normalizeYear(Number(yearPart));
            if (!this.isValidYmd(year, month, day))
                return null;
            const ymd = this.toYmd(year, month, day);
            return { from: ymd, to: ymd };
        }
        if (/^[A-Z]{3}\d{2,4}$/.test(token)) {
            const monthStr = token.substr(0, 3);
            const yearPart = token.substr(3);
            const month = this.monthFromToken(monthStr);
            if (!month)
                return null;
            const year = this.normalizeYear(Number(yearPart));
            const from = this.toYmd(year, month, 1);
            const lastDay = this.lastDayOfMonth(year, month);
            const to = this.toYmd(year, month, lastDay);
            return { from, to };
        }
        return null;
    }
    toYmd(year, month, day) {
        const mm = month.toString().padStart(2, '0');
        const dd = day.toString().padStart(2, '0');
        return `${year}-${mm}-${dd}`;
    }
    isValidYmd(year, month, day) {
        if (!Number.isFinite(year) ||
            !Number.isFinite(month) ||
            !Number.isFinite(day)) {
            return false;
        }
        if (month < 1 || month > 12)
            return false;
        if (day < 1)
            return false;
        const last = this.lastDayOfMonth(year, month);
        return day <= last;
    }
    lastDayOfMonth(year, month) {
        return new Date(year, month, 0).getDate();
    }
    monthFromToken(mon) {
        var _a;
        const map = {
            JAN: 1, JANUARY: 1,
            FEB: 2, FEBRUARY: 2,
            MAR: 3, MARCH: 3,
            APR: 4, APRIL: 4,
            MAY: 5,
            JUN: 6, JUNE: 6,
            JUL: 7, JULY: 7,
            AUG: 8, AUGUST: 8,
            SEP: 9, SEPT: 9, SEPTEMBER: 9,
            OCT: 10, OCTOBER: 10,
            NOV: 11, NOVEMBER: 11,
            DEC: 12, DECEMBER: 12,
        };
        return (_a = map[mon.toUpperCase()]) !== null && _a !== void 0 ? _a : null;
    }
    isMonthToken(token) {
        return this.monthFromToken(token) !== null;
    }
    normalizeYear(year) {
        if (!Number.isFinite(year))
            return new Date().getFullYear();
        if (year >= 1000)
            return year;
        if (year >= 0 && year <= 79)
            return 2000 + year;
        if (year >= 80 && year <= 99)
            return 1900 + year;
        return year;
    }
    parseStrikeToken(token) {
        const raw = String(token || '').toUpperCase();
        if (!raw)
            return null;
        if (/^\d+(\.\d+)?[K]$/.test(raw)) {
            const kMatch = raw.match(/^(\d+(?:\.\d+)?)[K]$/);
            const base = Number(kMatch[1]);
            if (!Number.isFinite(base))
                return null;
            const value = base * 1000;
            return value > 1 ? value : null;
        }
        if (/^\d+$/.test(raw)) {
            const n = Number(raw);
            if (!Number.isFinite(n))
                return null;
            if (n <= 1)
                return null;
            return n;
        }
        return null;
    }
    normalizeUnderlying(symbol) {
        const s = (symbol || '').toUpperCase();
        const aliases = {
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
exports.FnoQueryParserService = FnoQueryParserService;
