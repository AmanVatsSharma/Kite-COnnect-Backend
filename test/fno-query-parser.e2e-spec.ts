import { FnoQueryParserService } from '../src/services/fno-query-parser.service';

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
});


