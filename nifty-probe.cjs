/**
 * @file nifty-probe.cjs
 * @description READ-ONLY probe: subscribe to NIFTY 50 via Socket.IO /market-data.
 *              Tests UIR-id and Kite-token forms of the `instruments` field.
 *              Use TAG + INSTR env vars to switch the test variant.
 */
const { io } = require('socket.io-client');
const KEY = 'tradebazaar-live-01';
const URL = 'http://localhost:3000/market-data';
const TAG = process.env.TAG || 'uir';
const INSTR = process.env.INSTR ? JSON.parse(process.env.INSTR) : [];

const s = io(URL, {
  transports: ['websocket'],
  reconnection: false,
  query: { api_key: KEY },
  extraHeaders: { 'x-api-key': KEY }
});

const log = (k, v) => console.log(JSON.stringify({ tag: TAG, ts: new Date().toISOString(), event: k, payload: v }));

s.on('connect', () => log('connect', s.id));
s.on('disconnect', (r) => log('disconnect', r));
s.on('connect_error', (e) => log('connect_error', e.message));
s.onAny((event, ...args) => log('onAny', { event, args }));
s.on('market_data', (msg) => log('market_data', msg));
s.on('subscription_confirmed', (msg) => log('subscription_confirmed', msg));
s.on('error', (msg) => log('error', msg));

setTimeout(() => {
  log('subscribe_emit', { instruments: INSTR, mode: 'ltp' });
  s.emit('subscribe', { instruments: INSTR, mode: 'ltp' });
}, 2000);

setTimeout(() => process.exit(0), 20000);
