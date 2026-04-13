/**
 * @file vortex-instrument-helpers.ts
 * @module stock
 * @description Pure helpers for Vortex instrument descriptions and exchange normalization (shared by sync/cleanup).
 * @author BharatERP
 * @created 2026-03-28
 */

/**
 * Human-readable description for CSV/DB instrument rows (same logic as legacy VortexInstrumentService).
 */
export function generateVortexInstrumentDescription(instrument: {
  exchange?: string;
  symbol?: string;
  instrument_name?: string;
  expiry_date?: string;
  strike_price?: number;
  option_type?: string;
}): string {
  const parts: string[] = [instrument.exchange || '', instrument.symbol || ''];

  if (instrument.instrument_name) {
    parts.push(instrument.instrument_name);
  }

  if (instrument.expiry_date && instrument.expiry_date.length === 8) {
    try {
      const year = instrument.expiry_date.substring(0, 4);
      const month = instrument.expiry_date.substring(4, 6);
      const day = instrument.expiry_date.substring(6, 8);
      const monthNames = [
        'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT',
        'NOV', 'DEC',
      ];
      const monthName = monthNames[parseInt(month, 10) - 1] || month;
      parts.push(`${day}${monthName}${year}`);
    } catch {
      parts.push(instrument.expiry_date);
    }
  }

  if (
    instrument.strike_price &&
    Number.isFinite(instrument.strike_price) &&
    instrument.strike_price > 0
  ) {
    parts.push(String(instrument.strike_price));
  }

  if (instrument.option_type) {
    parts.push(instrument.option_type);
  }

  return parts.filter((p) => p).join(' ');
}

/**
 * Normalize exchange string (aligned with vortex-provider normalization).
 */
export function normalizeVortexExchange(
  ex: string,
): 'NSE_EQ' | 'NSE_FO' | 'NSE_CUR' | 'MCX_FO' | null {
  const s = (ex || '').toUpperCase().trim();
  if (!s) return null;

  if (s === 'NSE_EQ') return 'NSE_EQ';
  if (s === 'NSE_FO') return 'NSE_FO';
  if (s === 'NSE_CUR') return 'NSE_CUR';
  if (s === 'MCX_FO') return 'MCX_FO';

  if (
    s.includes('NSE_EQ') ||
    (s === 'NSE' && !s.includes('FO') && !s.includes('CUR')) ||
    s === 'EQ' ||
    s.includes('EQUITY')
  ) {
    return 'NSE_EQ';
  }
  if (
    s.includes('NSE_FO') ||
    s.includes('FO') ||
    s.includes('FUT') ||
    s.includes('FNO')
  ) {
    return 'NSE_FO';
  }
  if (s.includes('NSE_CUR') || s.includes('CDS') || s.includes('CUR')) {
    return 'NSE_CUR';
  }
  if (s.includes('MCX')) {
    return 'MCX_FO';
  }

  return null;
}
