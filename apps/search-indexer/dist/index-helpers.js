"use strict";
/**
 * @file apps/search-indexer/src/index-helpers.ts
 * @module search-indexer
 * @description Pure helper functions used by index.ts and its tests.
 *              Extracted so tests can import without bootstrapping the whole module.
 * @author BharatERP
 * @created 2026-06-23
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.weeklyDowForUnderlying = weeklyDowForUnderlying;
exports.lastDowOfMonth = lastDowOfMonth;
exports.lastThursdayOfMonth = lastThursdayOfMonth;
exports.weekOfMonth = weekOfMonth;
/**
 * Day-of-week (0=Sun..6=Sat) on which the underlying's weekly contract expires.
 * NSE NIFTY/BANKNIFTY/FINNIFTY mid-week contracts expire on TUESDAY.
 * BSE SENSEX/BANKEX weekly contracts expire on FRIDAY.
 * MCX commodity weeklies follow their own schedule (we default to Thursday
 * for unknowns; the indexer will still mark them weekly correctly because
 * `isWeekly` is determined by comparing the expiry's day-of-week to this map).
 *
 * Looking up by upper-cased underlying symbol. The first match wins.
 */
const WEEKLY_DOW_BY_UNDERLYING = [
    [/^NIFTY$/, 2], // NIFTY 50 — Tuesday
    [/^BANKNIFTY$/, 2], // BANK NIFTY — Tuesday
    [/^FINNIFTY$/, 2], // FIN NIFTY — Tuesday
    [/^MIDCPNIFTY$/, 2], // MIDCAP NIFTY — Tuesday
    [/^SENSEX$/, 5], // BSE SENSEX — Friday
    [/^BANKEX$/, 5], // BSE BANKEX — Friday
    [/^MCX.*/, 4], // MCX commodities (default Thursday — varies, but close enough)
];
/**
 * Return the day-of-week (0=Sun..6=Sat) on which `underlying`'s weekly
 * contract expires, or `undefined` if unknown. Used by `toDoc()` to decide
 * whether `isWeekly` should be set for a given expiry.
 */
function weeklyDowForUnderlying(underlying) {
    if (!underlying)
        return undefined;
    const up = String(underlying).toUpperCase();
    for (const [pattern, dow] of WEEKLY_DOW_BY_UNDERLYING) {
        if (pattern.test(up))
            return dow;
    }
    return undefined;
}
/**
 * Return the day-of-month (1-31) of the last `dow` (0-6) in the given
 * calendar month. Used to classify a derivative expiry as "monthly":
 * - NIFTY monthly is the last Tuesday of the month (since 2024-11-20)
 * - BANKNIFTY monthly is also the last Tuesday
 * - FINNIFTY, MIDCPNIFTY monthly: last Tuesday
 * - SENSEX monthly: last Friday
 * - BSE BANKEX monthly: last Friday
 * - Stock options (e.g. RELIANCE monthly): last Thursday of the month
 *
 * This replaces the previous `lastThursdayOfMonth` helper which assumed
 * the (incorrect) global rule that monthly = last Thursday. NIFTY monthly
 * has been on the last TUESDAY since the November 2024 expiry change.
 *
 * @param year  4-digit calendar year (e.g. 2026)
 * @param month 1-based calendar month (1 = Jan, 12 = Dec)
 * @param dow   0=Sun..6=Sat target day
 * @returns day-of-month (1-31) of the last occurrence of `dow`
 */
function lastDowOfMonth(year, month, dow) {
    const lastDay = new Date(year, month, 0).getDate();
    for (let d = lastDay; d >= 1; d--) {
        if (new Date(year, month - 1, d).getDay() === dow)
            return d;
    }
    return lastDay;
}
/**
 * Legacy helper kept for backwards compatibility. Returns the day-of-month
 * of the last Thursday of the given month. New code should prefer
 * `lastDowOfMonth(yy, mm, weeklyDowForUnderlying(...))`.
 *
 * @deprecated Use `lastDowOfMonth` + `weeklyDowForUnderlying` instead.
 */
function lastThursdayOfMonth(year, month) {
    return lastDowOfMonth(year, month, 4);
}
/**
 * Return the week-of-month (1-5) for a given date. Week 1 is days 1-7,
 * week 2 is days 8-14, etc. Used to classify derivative expiries as W1/W2/W3
 * weekly contracts (matches the broker convention for NIFTY weekly expiries).
 *
 * @param year  4-digit calendar year
 * @param month 1-based calendar month
 * @param day   day-of-month (1-31)
 * @returns week number (1-5)
 */
function weekOfMonth(year, month, day) {
    return Math.floor((day - 1) / 7) + 1;
}
