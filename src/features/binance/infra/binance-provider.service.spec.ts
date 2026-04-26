/**
 * @file binance-provider.service.spec.ts
 * @module binance
 * @description Unit tests for BinanceProviderService — REST translations and provider contract surface.
 * @author BharatERP
 * @created 2026-04-26
 * @updated 2026-04-26
 */

// Stub the WS client so constructing the provider doesn't open sockets.
jest.mock('./binance-websocket.client', () => {
  return {
    BinanceWebSocketClient: class {
      isWsConnected = () => false;
      getSubscribedCount = () => 0;
      getReconnectAttempts = () => 0;
      on = () => undefined;
      connect = () => undefined;
      disconnect = () => undefined;
      subscribe = () => undefined;
      unsubscribe = () => undefined;
    },
  };
});

import { BinanceProviderService } from './binance-provider.service';
import { BinanceRestClient } from './binance-rest.client';
import { BINANCE_MAX_STREAMS_PER_CONNECTION } from '../binance.constants';

function makeRestStub(overrides: Partial<BinanceRestClient> = {}): BinanceRestClient {
  return {
    isReady: () => true,
    getExchangeInfo: jest.fn(),
    getTickerPrices: jest.fn(),
    get24hrTicker: jest.fn(),
    getKlines: jest.fn(),
    ...overrides,
  } as unknown as BinanceRestClient;
}

describe('BinanceProviderService', () => {
  it('exposes the canonical provider name and limit', () => {
    const svc = new BinanceProviderService(makeRestStub());
    expect(svc.providerName).toBe('binance');
    expect(svc.getSubscriptionLimit()).toBe(BINANCE_MAX_STREAMS_PER_CONNECTION);
  });

  it('initialize() flips degraded → false (no credentials needed)', async () => {
    const svc = new BinanceProviderService(makeRestStub());
    expect(svc.isDegraded()).toBe(true);
    await svc.initialize();
    expect(svc.isDegraded()).toBe(false);
  });

  it('getInstruments filters TRADING + isSpotTradingAllowed and shapes rows', async () => {
    const rest = makeRestStub({
      getExchangeInfo: jest.fn().mockResolvedValue({
        symbols: [
          {
            symbol: 'BTCUSDT',
            status: 'TRADING',
            isSpotTradingAllowed: true,
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            filters: [],
          },
          {
            symbol: 'XYZBUSD',
            status: 'BREAK',
            isSpotTradingAllowed: true,
            baseAsset: 'XYZ',
            quoteAsset: 'BUSD',
            filters: [],
          },
          {
            symbol: 'NOSPOT',
            status: 'TRADING',
            isSpotTradingAllowed: false,
            baseAsset: 'NS',
            quoteAsset: 'USDT',
            filters: [],
          },
        ],
      }),
    } as any);
    const svc = new BinanceProviderService(rest);
    const out = await svc.getInstruments();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      instrument_token: 'BTCUSDT',
      tradingsymbol: 'BTCUSDT',
      exchange: 'BINANCE',
      segment: 'spot',
      instrument_type: 'EQ',
      name: 'BTC/USDT',
    });
  });

  it('getLTP returns map keyed by symbol with parsed numeric prices', async () => {
    const rest = makeRestStub({
      getTickerPrices: jest.fn().mockResolvedValue([
        { symbol: 'BTCUSDT', price: '50000.55' },
        { symbol: 'ETHUSDT', price: '3000.10' },
      ]),
    } as any);
    const svc = new BinanceProviderService(rest);
    const out = await svc.getLTP(['BTCUSDT', 'ETHUSDT']);
    expect(out['BTCUSDT'].last_price).toBe(50000.55);
    expect(out['ETHUSDT'].last_price).toBe(3000.1);
  });

  it('getLTPByPairs keys results as EXCHANGE-TOKEN with null when price is non-positive', async () => {
    const rest = makeRestStub({
      getTickerPrices: jest.fn().mockResolvedValue([
        { symbol: 'BTCUSDT', price: '50000' },
        { symbol: 'BADCOIN', price: '0' },
      ]),
    } as any);
    const svc = new BinanceProviderService(rest);
    const out = await svc.getLTPByPairs([
      { exchange: 'BINANCE', token: 'BTCUSDT' },
      { exchange: 'BINANCE', token: 'BADCOIN' },
      { exchange: 'BINANCE', token: 'MISSING' },
    ]);
    expect(out['BINANCE-BTCUSDT'].last_price).toBe(50000);
    expect(out['BINANCE-BADCOIN'].last_price).toBeNull();
    expect(out['BINANCE-MISSING'].last_price).toBeNull();
  });

  it('getQuote includes ohlc + buy/sell from /ticker/24hr', async () => {
    const rest = makeRestStub({
      get24hrTicker: jest.fn().mockResolvedValue([
        {
          symbol: 'BTCUSDT',
          lastPrice: '50000',
          bidPrice: '49999.5',
          askPrice: '50000.5',
          openPrice: '49000',
          highPrice: '51000',
          lowPrice: '48500',
          prevClosePrice: '48800',
          volume: '1234.5',
          priceChange: '1200',
        },
      ]),
    } as any);
    const svc = new BinanceProviderService(rest);
    const out = await svc.getQuote(['BTCUSDT']);
    expect(out['BTCUSDT']).toMatchObject({
      instrument_token: 'BTCUSDT',
      last_price: 50000,
      buy_price: 49999.5,
      sell_price: 50000.5,
      volume: 1234.5,
      ohlc: { open: 49000, high: 51000, low: 48500, close: 48800 },
      net_change: 1200,
    });
  });

  it('getHistoricalData maps klines to date/open/high/low/close/volume', async () => {
    const rest = makeRestStub({
      getKlines: jest
        .fn()
        .mockResolvedValue([
          [1714128000000, '50000', '50100', '49900', '50050', '1.5', 1714128059999, '75000', 100, '0.5', '25000', '0'],
        ]),
    } as any);
    const svc = new BinanceProviderService(rest);
    const out = await svc.getHistoricalData('BTCUSDT', '2026-04-26', '2026-04-27', '1minute');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      open: 50000,
      high: 50100,
      low: 49900,
      close: 50050,
      volume: 1.5,
    });
    // 1714128000000 ms = 2024-04-26T10:40:00.000Z — confirms epoch→ISO conversion works
    expect(out[0].date).toBe(new Date(1714128000000).toISOString());
  });
});
