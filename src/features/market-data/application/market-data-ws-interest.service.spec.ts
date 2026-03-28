/**
 * @file market-data-ws-interest.service.spec.ts
 * @module market-data
 * @description Ref-count behavior for WS subscriber interest index.
 * @author BharatERP
 * @created 2026-03-24
 */
import { MarketDataWsInterestService } from './market-data-ws-interest.service';

describe('MarketDataWsInterestService', () => {
  it('tracks refcount and drops token at zero', () => {
    const s = new MarketDataWsInterestService();
    s.addInterest(1);
    s.addInterest(1);
    expect(s.getInterestCount(1)).toBe(2);
    s.removeInterest(1);
    expect(s.getInterestCount(1)).toBe(1);
    s.removeInterest(1);
    expect(s.getInterestedTokens()).toEqual([]);
  });
});
