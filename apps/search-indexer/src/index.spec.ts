/**
 * @file apps/search-indexer/src/index.spec.ts
 * @module search-indexer
 * @description Unit tests for the indexer enrichment helpers. Pure-function tests;
 *              no Postgres / MeiliSearch round-trip required.
 * @author BharatERP
 * @created 2026-06-23
 */
import { lastThursdayOfMonth, weekOfMonth } from './index-helpers';

describe('indexer enrichment helpers', () => {
  it('lastThursdayOfMonth returns 25 for Jan 2024 (last Thursday = 25th)', () => {
    expect(lastThursdayOfMonth(2024, 1)).toBe(25);
  });
  it('lastThursdayOfMonth returns 30 for May 2024 (last Thursday = 30th)', () => {
    expect(lastThursdayOfMonth(2024, 5)).toBe(30);
  });
  it('lastThursdayOfMonth returns 28 for March 2024 (last Thursday = 28th)', () => {
    expect(lastThursdayOfMonth(2024, 3)).toBe(28);
  });

  it('weekOfMonth returns 1 for the 1st-7th, 2 for 8th-14th, etc.', () => {
    expect(weekOfMonth(2024, 6, 1)).toBe(1);
    expect(weekOfMonth(2024, 6, 7)).toBe(1);
    expect(weekOfMonth(2024, 6, 8)).toBe(2);
    expect(weekOfMonth(2024, 6, 14)).toBe(2);
    expect(weekOfMonth(2024, 6, 15)).toBe(3);
    expect(weekOfMonth(2024, 6, 30)).toBe(5);
  });
});