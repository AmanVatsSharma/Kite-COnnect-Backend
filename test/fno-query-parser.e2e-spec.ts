import { FnoQueryParserService } from '../src/features/market-data/application/fno-query-parser.service';

describe('FnoQueryParserService (trading-style F&O queries)', () => {
  const parser = new FnoQueryParserService();

  it('parses basic index option query "nifty 26000 ce"', () => {
    const parsed = parser.parse('nifty 26000 ce');
    expect(parsed.underlying).toBe('NIFTY');
    expect(parsed.strike).toBe(26000);
    expect(parsed.optionType).toBe('CE');
  });

  it('parses banknifty style query with expiry hint', () => {
    const parsed = parser.parse('banknifty 28mar25 45000 pe');
    expect(parsed.underlying).toBe('BANKNIFTY');
    expect(parsed.strike).toBe(45000);
    expect(parsed.optionType).toBe('PE');
    expect(parsed.expiryFrom).toBeDefined();
    expect(parsed.expiryTo).toBeDefined();
  });

  it('parses MCX option style query "gold 62000 ce"', () => {
    const parsed = parser.parse('gold 62000 ce');
    expect(parsed.underlying).toBe('GOLD');
    expect(parsed.strike).toBe(62000);
    expect(parsed.optionType).toBe('CE');
  });

  it('supports relaxed strike formats like "26k ce"', () => {
    const parsed = parser.parse('nifty 26k ce');
    expect(parsed.underlying).toBe('NIFTY');
    expect(parsed.strike).toBe(26000);
    expect(parsed.optionType).toBe('CE');
  });

  it('handles weekly-style expiry tokens like "28mar24w4"', () => {
    const parsed = parser.parse('banknifty 28mar24w4 45000 pe');
    expect(parsed.underlying).toBe('BANKNIFTY');
    expect(parsed.strike).toBe(45000);
    expect(parsed.optionType).toBe('PE');
    expect(parsed.expiryFrom).toBeDefined();
    expect(parsed.expiryTo).toBeDefined();
  });

  it('normalizes simple underlying aliases like NIFTY50 -> NIFTY', () => {
    const parsed = parser.parse('nifty50 26000 ce');
    expect(parsed.underlying).toBe('NIFTY');
    expect(parsed.strike).toBe(26000);
    expect(parsed.optionType).toBe('CE');
  });

  it('is resilient to empty / whitespace-only queries', () => {
    const parsed = parser.parse('   ');
    expect(parsed.tokens.length).toBe(0);
    expect(parsed.underlying).toBeUndefined();
    expect(parsed.strike).toBeUndefined();
    expect(parsed.optionType).toBeUndefined();
  });

  it('parses "monthly nifty" → isMonthly=true with NIFTY underlying', () => {
    const parsed = parser.parse('monthly nifty');
    expect(parsed.underlying).toBe('NIFTY');
    expect(parsed.isMonthly).toBe(true);
  });

  it('parses "nifty weekly expiry" → isWeekly=true', () => {
    const parsed = parser.parse('nifty weekly expiry');
    expect(parsed.underlying).toBe('NIFTY');
    expect(parsed.isWeekly).toBe(true);
  });

  it('parses "this thursday" → expiryFrom=expiryTo=next Thursday YYYYMMDD', () => {
    const parsed = parser.parse('this thursday');
    expect(parsed.expiryFrom).toBeDefined();
    expect(parsed.expiryFrom).toBe(parsed.expiryTo);
    expect(parsed.expiryFrom!.length).toBe(8);
  });

  it('parses "m&m" → underlying=MM', () => {
    const parsed = parser.parse('m&m');
    expect(parsed.underlying).toBe('MM');
  });

  it('parses "reliance industries" → underlying=RELIANCE', () => {
    const parsed = parser.parse('reliance industries');
    expect(parsed.underlying).toBe('RELIANCE');
  });

  it('does NOT set isMonthly when neither "monthly" nor related NL tokens are present', () => {
    const parsed = parser.parse('nifty 26000 ce');
    expect(parsed.isMonthly).toBeUndefined();
    expect(parsed.isWeekly).toBeUndefined();
  });
});
