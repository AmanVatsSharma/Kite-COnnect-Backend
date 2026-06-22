/**
 * @file apps/search-api/src/modules/search/search.service.spec.ts
 * @module search-api
 * @description Unit tests for SearchService.buildFilter(). Golden-file assertions
 *              for the additive parser wiring: the MeiliSearch filter string emitted
 *              by buildFilter() must include explicit user ranges, parser-derived
 *              isMonthly/isWeekly flags, and parsed expiry windows, in the documented
 *              precedence (explicit user params win; parsed values fill in only when
 *              no explicit param is present).
 *
 *              The tests construct `new SearchService()` directly without DI — the
 *              constructor reads `process.env` for MeiliSearch / Redis config and
 *              creates an axios client + a (lazyConnect) Redis client. None of these
 *              are exercised by the `buildFilter` tests below, so no further mocking
 *              is required. If `buildFilter` ever starts touching the network, this
 *              assumption needs revisiting.
 * @author BharatERP
 * @created 2026-06-23
 */
import { SearchService } from './search.service';

describe('SearchService.buildFilter (additive parser wiring)', () => {
  const svc = new SearchService();

  it('emits no filter when no parsed data and no explicit params', () => {
    expect(svc.buildFilter({})).toBeUndefined();
  });

  it('preserves explicit user range when no parser data is present', () => {
    const f = svc.buildFilter({
      expiry_from: '2026-06-01',
      expiry_to: '2026-06-30',
    });
    expect(f).toContain(`expiry >= "2026-06-01"`);
    expect(f).toContain(`expiry <= "2026-06-30"`);
  });

  it('emits isMonthly=true when parser flags it', () => {
    const f = svc.buildFilter({ isMonthly: true });
    expect(f).toContain('isMonthly = true');
  });

  it('emits isWeekly=true when parser flags it', () => {
    const f = svc.buildFilter({ isWeekly: true });
    expect(f).toContain('isWeekly = true');
  });

  it('emits parsed-derived expiry range using parsedExpiryFrom/To', () => {
    const f = svc.buildFilter({
      parsedExpiryFrom: '2026-06-26',
      parsedExpiryTo: '2026-06-26',
    });
    expect(f).toContain(`expiry >= "2026-06-26"`);
    expect(f).toContain(`expiry <= "2026-06-26"`);
  });

  it('explicit user range takes precedence when both are set', () => {
    const f = svc.buildFilter({
      expiry_from: '2026-06-01',
      expiry_to: '2026-06-30',
      parsedExpiryFrom: '2026-06-23',
      parsedExpiryTo: '2026-06-29',
    });
    expect(f).toContain(`expiry >= "2026-06-01"`);
    expect(f).toContain(`expiry <= "2026-06-30"`);
    expect(f).not.toContain(`expiry >= "2026-06-23"`);
    expect(f).not.toContain(`expiry <= "2026-06-29"`);
  });

  it('combines isMonthly with strike range in AND', () => {
    const f = svc.buildFilter({ isMonthly: true, strike_min: 24000, strike_max: 26000 });
    expect(f).toContain('isMonthly = true');
    expect(f).toContain('strike >= 24000');
    expect(f).toContain('strike <= 26000');
    expect(f).toContain(' AND ');
  });
});
