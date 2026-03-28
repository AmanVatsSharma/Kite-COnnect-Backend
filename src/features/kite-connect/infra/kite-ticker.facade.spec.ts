/**
 * @file kite-ticker.facade.spec.ts
 * @module kite-connect
 * @description Unit tests for Kite ticker stream mode mapping and subscribe/setMode facade.
 * @author BharatERP
 * @created 2026-03-28
 */

import {
  mapStreamModeToKiteMode,
  wrapKiteTickerForStreaming,
} from './kite-ticker.facade';

describe('mapStreamModeToKiteMode', () => {
  const t = {
    modeLTP: 'ltp',
    modeQuote: 'quote',
    modeFull: 'full',
  };

  it('maps ohlcv to quote', () => {
    expect(mapStreamModeToKiteMode('ohlcv', t)).toBe('quote');
  });

  it('maps ltp and full', () => {
    expect(mapStreamModeToKiteMode('ltp', t)).toBe('ltp');
    expect(mapStreamModeToKiteMode('full', t)).toBe('full');
  });

  it('defaults unknown to ltp', () => {
    expect(mapStreamModeToKiteMode(undefined, t)).toBe('ltp');
  });
});

describe('wrapKiteTickerForStreaming', () => {
  it('calls subscribe then setMode with quote for ohlcv', () => {
    const calls: string[] = [];
    const inner = {
      modeLTP: 'ltp',
      modeQuote: 'quote',
      modeFull: 'full',
      subscribe(tokens: number[]) {
        calls.push(`sub:${tokens.join(',')}`);
      },
      setMode(mode: string, tokens: number[]) {
        calls.push(`mode:${mode}:${tokens.join(',')}`);
      },
      unsubscribe() {
        /* noop */
      },
      connect() {
        /* noop */
      },
      disconnect() {
        /* noop */
      },
      on() {
        /* noop */
      },
    };
    const facade = wrapKiteTickerForStreaming(inner);
    facade.subscribe([1, 2], 'ohlcv');
    expect(calls).toEqual(['sub:1,2', 'mode:quote:1,2']);
  });
});
