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
exports.lastThursdayOfMonth = lastThursdayOfMonth;
exports.weekOfMonth = weekOfMonth;
/**
 * Return the day-of-month (1-31) of the last Thursday in the given calendar
 * month. Used to classify a derivative expiry as "monthly" (NIFTY monthly
 * expiry is always the last Thursday of the month).
 *
 * @param year  4-digit calendar year (e.g. 2026)
 * @param month 1-based calendar month (1 = Jan, 12 = Dec)
 * @returns day-of-month (1-31) of the last Thursday
 */
function lastThursdayOfMonth(year, month) {
    const lastDay = new Date(year, month, 0).getDate();
    for (let d = lastDay; d >= 1; d--) {
        const dow = new Date(year, month - 1, d).getDay();
        if (dow === 4)
            return d;
    }
    return lastDay;
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
