/**
 * @file binance-websocket.client.spec.ts
 * @module binance
 * @description Unit tests for BinanceWebSocketClient — frame parsing, normalization, subscribe/unsubscribe wire format.
 * @author BharatERP
 * @created 2026-04-26
 * @updated 2026-04-26
 *
 * Strategy: stub out `ws` so we never open a real socket. We construct the client,
 * then exercise its public API + simulate inbound messages by directly invoking
 * its message handler via the captured `socket.on('message', ...)` callback.
 */
import { BinanceWebSocketClient } from './binance-websocket.client';
import {
  BINANCE_CANONICAL_EXCHANGE,
  BINANCE_MAX_STREAMS_PER_CONNECTION,
} from '../binance.constants';

// Capture the most recent fake socket so each test can drive its events.
let lastFakeSocket: FakeWebSocket;

class FakeWebSocket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private handlers = new Map<string, (...args: any[]) => void>();
  constructor(public url: string) {
    lastFakeSocket = this;
  }
  on(ev: string, cb: (...args: any[]) => void) {
    this.handlers.set(ev, cb);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.handlers.get('close')?.(1000, Buffer.from('test_close'));
  }
  /** Fire one of the captured handlers (used by tests to simulate inbound events). */
  fire(ev: string, ...args: any[]) {
    this.handlers.get(ev)?.(...args);
  }
}

jest.mock('ws', () => {
  // The ws module exports the constructor as both default and named, plus the OPEN constant.
  // Using a single FakeWebSocket constructor satisfies `new WebSocket(url)` and `WebSocket.OPEN`.
  const Ctor: any = function (this: any, url: string) {
    return new FakeWebSocket(url);
  };
  Ctor.OPEN = 1;
  // Some bundlers see `import * as WebSocket from 'ws'` and expect a Module-like object.
  // Provide both shapes so either form works.
  return Object.assign(Ctor, { default: Ctor, WebSocket: Ctor, OPEN: 1 });
});

describe('BinanceWebSocketClient', () => {
  let client: BinanceWebSocketClient;

  beforeEach(() => {
    client = new BinanceWebSocketClient();
  });

  // ── Subscribe / unsubscribe wire format ────────────────────────────────

  it('sends a SUBSCRIBE JSON-RPC frame with lowercase @trade params after open', () => {
    const ticks: any[] = [];
    const connects: any[] = [];
    client.on('ticks', (t) => ticks.push(t));
    client.on('connect', () => connects.push(true));

    client.connect();
    client.subscribe(['BTCUSDT', 'ETHUSDT']);
    lastFakeSocket.fire('open');

    expect(connects).toHaveLength(1);
    // After 'open' the client re-subscribes everything in subscribedSymbols
    expect(lastFakeSocket.sent).toHaveLength(1);
    const frame = JSON.parse(lastFakeSocket.sent[0]);
    expect(frame.method).toBe('SUBSCRIBE');
    expect(frame.params).toEqual(['btcusdt@trade', 'ethusdt@trade']);
    expect(typeof frame.id).toBe('number');
  });

  it('uppercases incoming tokens, deduplicates, and skips numeric ids', () => {
    client.connect();
    lastFakeSocket.fire('open');
    lastFakeSocket.sent.length = 0; // reset (re-subscribe on open sent 0 — empty set)

    client.subscribe(['btcusdt', 'BTCUSDT', '12345', '   ', 'ETHUSDT']);
    expect(client.getSubscribedCount()).toBe(2);
    expect(client.getSubscribedSymbols().sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    const frame = JSON.parse(lastFakeSocket.sent[0]);
    expect(frame.params).toEqual(['btcusdt@trade', 'ethusdt@trade']);
  });

  it('caps subscriptions at BINANCE_MAX_STREAMS_PER_CONNECTION', () => {
    client.connect();
    lastFakeSocket.fire('open');
    const tooMany = Array.from(
      { length: BINANCE_MAX_STREAMS_PER_CONNECTION + 50 },
      (_, i) => `SYM${i}USDT`,
    );
    client.subscribe(tooMany);
    expect(client.getSubscribedCount()).toBe(BINANCE_MAX_STREAMS_PER_CONNECTION);
  });

  it('UNSUBSCRIBE frame removes from tracked set and sends correct params', () => {
    client.connect();
    lastFakeSocket.fire('open');
    client.subscribe(['BTCUSDT', 'ETHUSDT']);
    lastFakeSocket.sent.length = 0;

    client.unsubscribe(['btcusdt', 'NEVERSUBBED']);
    expect(client.getSubscribedCount()).toBe(1);
    expect(client.getSubscribedSymbols()).toEqual(['ETHUSDT']);
    const frame = JSON.parse(lastFakeSocket.sent[0]);
    expect(frame.method).toBe('UNSUBSCRIBE');
    expect(frame.params).toEqual(['btcusdt@trade']);
  });

  // ── Inbound frame handling ─────────────────────────────────────────────

  it('emits normalized canonical tick on a wrapped trade frame', () => {
    const ticks: any[] = [];
    client.on('ticks', (t) => ticks.push(t));

    client.connect();
    lastFakeSocket.fire('open');
    lastFakeSocket.fire(
      'message',
      JSON.stringify({
        stream: 'btcusdt@trade',
        data: {
          e: 'trade',
          E: 1714128000000,
          s: 'BTCUSDT',
          t: 12345,
          p: '50000.55',
          q: '0.123',
          T: 1714128000123,
          m: false,
          M: true,
        },
      }),
    );

    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toHaveLength(1);
    expect(ticks[0][0]).toMatchObject({
      instrument_token: 'BTCUSDT',
      last_price: 50000.55,
      exchange: BINANCE_CANONICAL_EXCHANGE,
      volume: 0.123,
      last_trade_time: 1714128000123,
    });
  });

  it('also accepts an unwrapped trade event (single-stream case)', () => {
    const ticks: any[] = [];
    client.on('ticks', (t) => ticks.push(t));

    client.connect();
    lastFakeSocket.fire('open');
    lastFakeSocket.fire(
      'message',
      JSON.stringify({
        e: 'trade',
        E: 1714128000000,
        s: 'ETHUSDT',
        t: 1,
        p: '3000.10',
        q: '0.5',
        T: 1714128000500,
        m: true,
        M: true,
      }),
    );

    expect(ticks).toHaveLength(1);
    expect(ticks[0][0].instrument_token).toBe('ETHUSDT');
    expect(ticks[0][0].last_price).toBe(3000.1);
  });

  it('silently ignores ack and error JSON-RPC frames (no tick emit)', () => {
    const ticks: any[] = [];
    client.on('ticks', (t) => ticks.push(t));

    client.connect();
    lastFakeSocket.fire('open');
    lastFakeSocket.fire('message', JSON.stringify({ result: null, id: 7 }));
    lastFakeSocket.fire(
      'message',
      JSON.stringify({ error: { code: -1121, msg: 'Invalid symbol.' }, id: 8 }),
    );

    expect(ticks).toHaveLength(0);
  });

  it('drops frames with non-finite price', () => {
    const ticks: any[] = [];
    client.on('ticks', (t) => ticks.push(t));

    client.connect();
    lastFakeSocket.fire('open');
    lastFakeSocket.fire(
      'message',
      JSON.stringify({
        stream: 'foo@trade',
        data: { e: 'trade', s: 'FOO', p: 'not-a-number', q: '1', T: 1 },
      }),
    );

    expect(ticks).toHaveLength(0);
  });

  it('does not throw on malformed JSON', () => {
    client.connect();
    lastFakeSocket.fire('open');
    expect(() => lastFakeSocket.fire('message', '{ this is not json')).not.toThrow();
  });

  // ── Reconnect re-subscribe ─────────────────────────────────────────────

  it('re-sends SUBSCRIBE for all tracked symbols when the socket reopens', () => {
    client.connect();
    lastFakeSocket.fire('open');
    client.subscribe(['BTCUSDT']);
    lastFakeSocket.sent.length = 0;

    // Simulate a clean re-open (no actual reconnect timer; just fire open again)
    lastFakeSocket.fire('open');
    const frame = JSON.parse(lastFakeSocket.sent[0]);
    expect(frame.method).toBe('SUBSCRIBE');
    expect(frame.params).toEqual(['btcusdt@trade']);
  });

  // ── Disconnect ─────────────────────────────────────────────────────────

  it('disconnect clears reconnect intent and closes the socket', () => {
    const disconnects: any[] = [];
    client.on('disconnect', () => disconnects.push(true));

    client.connect();
    lastFakeSocket.fire('open');
    client.disconnect();

    expect(client.isWsConnected()).toBe(false);
  });
});
