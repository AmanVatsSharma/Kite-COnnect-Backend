/**
 * File:        apps/admin-dashboard/src/pages/ChartWatchPage.tsx
 * Module:      admin-dashboard · Charts
 * Purpose:     Multi-panel candlestick chart watch — up to 6 instruments simultaneously.
 *              Fetches the last N candles (e.g. "last 100 candles on 5min") so the chart
 *              always shows live data up to the present moment.
 *
 * Exports:
 *   - ChartWatchPage — full-page chart grid component
 *
 * Depends on:
 *   - ../lib/falcon-api   — postFalconHistoricalBatch, searchFalconInstruments (exchange-filtered)
 *   - ../lib/api-client   — getAdminToken
 *   - ../lib/toast        — notify
 *   - ../lib/types        — FalconCandle, FalconInstrument
 *   - lightweight-charts  — createChart, candlestick + volume histogram series
 *
 * Side-effects:
 *   - localStorage 'chart-watch-slots-v2': reads on mount, writes on every slot change (config only)
 *   - setInterval 60s: auto-refresh intraday slots during NSE market hours 09:15–15:30 IST Mon–Fri
 *
 * Key invariants:
 *   - `to` is always today (IST) — charts always end at the present
 *   - `from` is back-calculated from candle count + interval using trading-day arithmetic
 *   - API may return more candles than requested (over-estimated range); .slice(-count) trims to exact N
 *   - Max 6 slots — all fit in one batch call (batch cap = 10)
 *   - lightweight-charts owns the canvas DOM; React never mutates it after mount
 *   - Changing interval resets count to that interval's sensible default
 *   - Kite SDK returns `{ data: [{date, open, high, low, close, volume, oi?}, ...] }` — objects in a `data` envelope.
 *     normalizeCandles() handles all observed shapes (objects, tuples, .data wrapper, .candles wrapper).
 *   - Intraday candles use UNIX-seconds time; daily uses 'YYYY-MM-DD' string. Mixing collapses the chart.
 *
 * Read order:
 *   1. SlotConfig / ChartSlot    — state shape
 *   2. CANDLES_PER_DAY / helpers — candle-count → date-range arithmetic
 *   3. CandlePanel               — lightweight-charts rendering
 *   4. InstrumentSearch          — debounced search dropdown
 *   5. SlotCard                  — single chart panel with all controls
 *   6. ChartWatchPage            — page orchestration, batch load, auto-refresh
 *
 * Author:      BharatERP
 * Last-updated: 2026-05-09
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createChart, ColorType } from 'lightweight-charts';
import * as falcon from '../lib/falcon-api';
import { notify } from '../lib/toast';
import { getAdminToken } from '../lib/api-client';
import type { FalconCandle, FalconInstrument } from '../lib/types';

const MAX_SLOTS = 6;
const LS_KEY = 'chart-watch-slots-v2';

const INTERVALS = ['minute', '5minute', '15minute', '30minute', '60minute', 'day'] as const;
type Interval = (typeof INTERVALS)[number];

/** Approximate NSE candles produced per full trading day per interval. */
const CANDLES_PER_DAY: Record<Interval, number> = {
  minute: 375,
  '5minute': 75,
  '15minute': 25,
  '30minute': 13,
  '60minute': 6,
  day: 1,
};

/** Sensible default candle count when an interval is first selected. */
const DEFAULT_COUNT: Record<Interval, number> = {
  minute: 375,    // 1 trading day
  '5minute': 100,
  '15minute': 100,
  '30minute': 100,
  '60minute': 100,
  day: 200,
};

/** Quick-pick candle counts per interval shown as preset buttons. */
const COUNT_PRESETS: Record<Interval, number[]> = {
  minute: [100, 200, 375],
  '5minute': [50, 100, 200, 375],
  '15minute': [25, 50, 100, 200],
  '30minute': [25, 50, 100],
  '60minute': [25, 50, 100],
  day: [100, 200, 500, 1000],
};

// ─── State shapes ────────────────────────────────────────────────────────────

interface SlotConfig {
  id: string;
  token: number | null;
  name: string;
  interval: Interval;
  count: number;
}

interface ChartSlot extends SlotConfig {
  candles: FalconCandle[];
  loading: boolean;
  error: string | null;
  lastFetched: number | null;
}

// ─── Date arithmetic ─────────────────────────────────────────────────────────

function istToday(): string {
  return new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Back-calculate a `from` date that covers at least `count` candles of `interval`.
 * Over-estimates by 50% + 5 days so weekends and holidays never leave the chart short.
 * The caller slices the response to exactly `count` candles.
 */
function computeFrom(interval: Interval, count: number): string {
  const tradingDays = Math.ceil(count / CANDLES_PER_DAY[interval]);
  const calendarDays = Math.ceil(tradingDays * 1.5) + 5;
  const ms = new Date(istToday()).getTime() - calendarDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function isMarketOpen(): boolean {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 555 && mins < 930; // 09:15 → 15:30
}

/**
 * Normalize whatever the historical batch endpoint returns into FalconCandle tuples.
 * Kite SDK actually returns: { data: [{date: Date, open, high, low, close, volume, oi?}, ...] }.
 * We also tolerate { candles: [...] }, raw arrays, and tuple form for safety.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeCandles(raw: any): FalconCandle[] {
  if (!raw) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let arr: any[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'object') arr = raw.data ?? raw.candles ?? [];
  if (!Array.isArray(arr)) return [];
  return arr
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((c: any): FalconCandle | null => {
      if (Array.isArray(c)) {
        return [String(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[5]), c[6] != null ? Number(c[6]) : undefined];
      }
      if (c && typeof c === 'object' && c.date != null) {
        return [
          String(c.date),
          Number(c.open),
          Number(c.high),
          Number(c.low),
          Number(c.close),
          Number(c.volume),
          c.oi != null ? Number(c.oi) : undefined,
        ];
      }
      return null;
    })
    .filter((c): c is FalconCandle => c != null && Number.isFinite(c[1]));
}

/** Pull the per-token error message out of a batch entry, if any. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractError(raw: any): string | null {
  if (!raw || Array.isArray(raw)) return null;
  if (typeof raw === 'object' && typeof raw.error === 'string') return raw.error;
  return null;
}

function makeSlot(overrides?: Partial<SlotConfig>): ChartSlot {
  return {
    id: Math.random().toString(36).slice(2, 9),
    token: null,
    name: '',
    interval: 'day',
    count: DEFAULT_COUNT['day'],
    candles: [],
    loading: false,
    error: null,
    lastFetched: null,
    ...overrides,
  };
}

// ─── CandlePanel ─────────────────────────────────────────────────────────────

/**
 * lightweight-charts time format:
 *   - daily candles: "YYYY-MM-DD" string is fine
 *   - intraday candles: MUST be UNIX timestamp in seconds (number), otherwise multiple candles
 *     per day collapse into one slot and the chart looks empty/wrong.
 */
function toChartTime(dateStr: string, isIntraday: boolean): number | string {
  if (isIntraday) {
    const ms = new Date(dateStr).getTime();
    return Math.floor(ms / 1000);
  }
  // Daily — extract YYYY-MM-DD
  return dateStr.length >= 10 ? dateStr.slice(0, 10) : dateStr;
}

function CandlePanel({ candles, isIntraday }: { candles: FalconCandle[]; isIntraday: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || !candles.length) return;
    const chart = createChart(ref.current, {
      width: ref.current.clientWidth || 480,
      height: 280,
      layout: { background: { type: ColorType.Solid, color: '#0c1522' }, textColor: '#8899aa' },
      grid: { vertLines: { color: '#1a2232' }, horzLines: { color: '#1a2232' } },
      timeScale: { borderColor: '#1a2232', timeVisible: isIntraday, secondsVisible: false },
      rightPriceScale: { borderColor: '#1a2232' },
    });

    const cs = chart.addCandlestickSeries({
      upColor: '#2bd39b', downColor: '#ff5252',
      borderVisible: false,
      wickUpColor: '#2bd39b', wickDownColor: '#ff5252',
    });

    const vs = chart.addHistogramSeries({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      priceFormat: { type: 'volume' } as any,
      priceScaleId: 'vol',
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    // Sort + dedupe by time — lightweight-charts requires strictly ascending unique times
    const seen = new Set<string | number>();
    const ohlc = candles
      .map((c) => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        time: toChartTime(c[0], isIntraday) as any,
        open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
      }))
      .filter((c) => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
      .sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));

    cs.setData(ohlc.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    vs.setData(ohlc.map((c) => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? '#2bd39b66' : '#ff525266',
    })));
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(ref.current);
    return () => { ro.disconnect(); chart.remove(); };
  }, [candles, isIntraday]);

  return <div ref={ref} style={{ width: '100%', height: 280 }} />;
}

// ─── InstrumentSearch ────────────────────────────────────────────────────────

const EXCHANGE_FILTERS = ['NSE', 'BSE', 'MCX', 'NFO', 'BFO'] as const;
const EXCHANGE_COLOR: Record<string, string> = {
  NSE: '#4a90e2', BSE: '#f5a623', MCX: '#9b59b6', NFO: '#2bd39b', BFO: '#e67e22',
};

function InstrumentSearch({ onSelect }: { onSelect: (inst: FalconInstrument) => void }) {
  const [q, setQ] = useState('');
  const [exchange, setExchange] = useState<string | undefined>(undefined);
  const [results, setResults] = useState<FalconInstrument[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function runSearch(query: string, ex: string | undefined) {
    if (timer.current) clearTimeout(timer.current);
    if (!query.trim()) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      try {
        const res = await falcon.searchFalconInstruments(query, 25, ex);
        setResults(Array.isArray(res) ? res : []);
        setOpen(true);
      } catch { /* silent */ }
    }, 250);
  }

  function onQueryChange(v: string) {
    setQ(v);
    runSearch(v, exchange);
  }

  function toggleExchange(ex: string) {
    const next = exchange === ex ? undefined : ex;
    setExchange(next);
    runSearch(q, next);
  }

  function pick(inst: FalconInstrument) {
    setQ(''); setResults([]); setOpen(false);
    onSelect(inst);
  }

  return (
    <div>
      {/* Exchange filter strip */}
      <div style={{ display: 'flex', gap: 3, marginBottom: 4 }}>
        <button
          type="button"
          className={`btn-xs${!exchange ? ' btn-xs--ok' : ''}`}
          style={{ fontSize: 9 }}
          onMouseDown={(e) => { e.preventDefault(); toggleExchange(''); }}
        >ALL</button>
        {EXCHANGE_FILTERS.map((ex) => (
          <button
            key={ex}
            type="button"
            className={`btn-xs${exchange === ex ? ' btn-xs--ok' : ''}`}
            style={{ fontSize: 9, color: exchange === ex ? undefined : EXCHANGE_COLOR[ex] }}
            onMouseDown={(e) => { e.preventDefault(); toggleExchange(ex); }}
          >{ex}</button>
        ))}
      </div>

      {/* Search input + dropdown */}
      <div style={{ position: 'relative' }}>
        <input
          placeholder={exchange ? `Search ${exchange} instruments…` : 'Search NSE / BSE / MCX / NFO…'}
          value={q}
          onChange={(e) => onQueryChange(e.target.value)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          style={{ width: '100%', fontSize: 11, padding: '3px 7px', boxSizing: 'border-box' }}
        />
        {open && results.length > 0 && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
            background: '#0c1522', border: '1px solid #1a2232', borderRadius: 4,
            maxHeight: 220, overflowY: 'auto',
          }}>
            {results.map((r) => (
              <div
                key={r.instrument_token}
                onMouseDown={() => pick(r)}
                style={{
                  padding: '5px 8px', cursor: 'pointer',
                  borderBottom: '1px solid #1a2232',
                  display: 'flex', gap: 5, alignItems: 'baseline',
                }}
              >
                <span style={{ color: '#fff', fontWeight: 600, fontSize: 11 }}>{r.tradingsymbol}</span>
                <span style={{
                  fontSize: 9, fontWeight: 700, flexShrink: 0,
                  color: EXCHANGE_COLOR[r.exchange] ?? '#8899aa',
                }}>{r.exchange}</span>
                <span style={{
                  fontSize: 9, flexShrink: 0,
                  color: r.instrument_type === 'EQ' ? '#2bd39b' : '#f5a623',
                }}>{r.instrument_type}</span>
                {r.expiry && (
                  <span style={{ fontSize: 9, color: '#8899aa', flexShrink: 0 }}>{r.expiry}</span>
                )}
                <span style={{
                  color: '#8899aa', fontSize: 10,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{r.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SlotCard ────────────────────────────────────────────────────────────────

interface SlotCardProps {
  slot: ChartSlot;
  onSelect: (id: string, inst: FalconInstrument) => void;
  onInterval: (id: string, iv: Interval) => void;
  onCount: (id: string, n: number) => void;
  onRefresh: (id: string) => void;
  onRemove: (id: string) => void;
}

function SlotCard({ slot, onSelect, onInterval, onCount, onRefresh, onRemove }: SlotCardProps) {
  const presets = COUNT_PRESETS[slot.interval];

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 220 }}>
      {/* header */}
      <div className="panel__head">
        <span className="panel__title" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {slot.name || 'EMPTY SLOT'}
        </span>
        {slot.token && (
          <span style={{ fontSize: 9, color: 'var(--muted)', flexShrink: 0 }}>
            last {slot.candles.length || slot.count} · {slot.interval}
          </span>
        )}
        {slot.lastFetched && (
          <span style={{ fontSize: 9, color: 'var(--muted)', flexShrink: 0, marginLeft: 4 }}>
            {new Date(slot.lastFetched).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}
          </span>
        )}
        <button
          type="button" className="btn-xs" title="Refresh"
          disabled={!slot.token || slot.loading}
          onClick={() => onRefresh(slot.id)}
        >↻</button>
        <button
          type="button" className="btn-xs btn-xs--danger" title="Remove"
          onClick={() => onRemove(slot.id)}
        >×</button>
      </div>

      {/* instrument search — outside panel__body to prevent overflow clip on dropdown */}
      <div style={{ padding: '6px 12px', borderBottom: '1px solid #1a2232' }}>
        <InstrumentSearch onSelect={(inst) => onSelect(slot.id, inst)} />
      </div>

      {/* controls + chart */}
      <div className="panel__body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {slot.token && (
          <>
            {/* interval */}
            <div>
              <div style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 3 }}>INTERVAL</div>
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                {INTERVALS.map((iv) => (
                  <button key={iv} type="button"
                    className={`btn-xs${slot.interval === iv ? ' btn-xs--ok' : ''}`}
                    style={{ fontSize: 9 }}
                    onClick={() => onInterval(slot.id, iv)}
                  >{iv}</button>
                ))}
              </div>
            </div>

            {/* candle count */}
            <div>
              <div style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 3 }}>CANDLES</div>
              <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                {presets.map((n) => (
                  <button key={n} type="button"
                    className={`btn-xs${slot.count === n ? ' btn-xs--ok' : ''}`}
                    style={{ fontSize: 9 }}
                    onClick={() => onCount(slot.id, n)}
                  >{n}</button>
                ))}
                <input
                  type="number"
                  min={1}
                  value={slot.count}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (n > 0) onCount(slot.id, n);
                  }}
                  style={{ width: 54, fontSize: 10, padding: '2px 4px', textAlign: 'center' }}
                  title="Custom candle count"
                />
              </div>
            </div>
          </>
        )}

        {/* chart state */}
        {slot.loading && (
          <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 11, padding: '60px 0' }}>Loading…</div>
        )}
        {!slot.loading && slot.error && (
          <div style={{ color: 'var(--bad)', fontSize: 11 }}>{slot.error}</div>
        )}
        {!slot.loading && !slot.error && slot.candles.length > 0 && (
          <CandlePanel candles={slot.candles} isIntraday={slot.interval !== 'day'} />
        )}
        {!slot.loading && !slot.token && (
          <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 11, padding: '60px 0' }}>
            Search an instrument above
          </div>
        )}
        {!slot.loading && slot.token && !slot.error && slot.candles.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 11, padding: '60px 0' }}>
            No candles returned
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ChartWatchPage ──────────────────────────────────────────────────────────

export function ChartWatchPage() {
  const adminToken = getAdminToken();

  const [slots, setSlots] = useState<ChartSlot[]>(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const configs: SlotConfig[] = JSON.parse(raw);
        return configs.map((c) => ({ ...c, candles: [], loading: false, error: null, lastFetched: null }));
      }
    } catch { /* corrupted — start fresh */ }
    return [];
  });

  const slotsRef = useRef(slots);
  useEffect(() => { slotsRef.current = slots; }, [slots]);

  // Persist config only (no candle data) to localStorage
  useEffect(() => {
    const configs = slots.map(({ id, token, name, interval, count }) => ({ id, token, name, interval, count }));
    localStorage.setItem(LS_KEY, JSON.stringify(configs));
  }, [slots]);

  /**
   * Core fetch: loads the last `slot.count` candles for a subset (by id) or all loaded slots.
   * Uses postFalconHistoricalBatch so all slots resolve in a single HTTP call.
   */
  const fetchSlots = useCallback(async (targetIds?: string[]) => {
    const current = slotsRef.current;
    const toFetch = targetIds
      ? current.filter((s) => targetIds.includes(s.id) && s.token)
      : current.filter((s) => s.token);
    if (!toFetch.length) return;

    setSlots((prev) =>
      prev.map((s) => (toFetch.find((t) => t.id === s.id) ? { ...s, loading: true, error: null } : s))
    );

    const today = istToday();
    const requests = toFetch.map((s) => ({
      token: s.token!,
      from: computeFrom(s.interval, s.count),
      to: today,
      interval: s.interval,
    }));

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await falcon.postFalconHistoricalBatch(requests) as any;
      setSlots((prev) =>
        prev.map((s) => {
          if (!toFetch.find((t) => t.id === s.id) || !s.token) return s;
          const entry = raw?.[s.token];
          const err = extractError(entry);
          const all = normalizeCandles(entry);
          const candles = all.slice(-s.count); // trim to exactly the last N requested
          return { ...s, loading: false, candles, error: err, lastFetched: err ? s.lastFetched : Date.now() };
        })
      );
    } catch (e) {
      const msg = (e as Error).message;
      notify.error(`Fetch failed: ${msg}`);
      setSlots((prev) =>
        prev.map((s) => (toFetch.find((t) => t.id === s.id) ? { ...s, loading: false, error: msg } : s))
      );
    }
  }, []); // stable — reads fresh state via slotsRef

  // Initial load for any persisted slots
  useEffect(() => { void fetchSlots(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh intraday slots every 60s during market hours
  useEffect(() => {
    const id = setInterval(() => {
      if (!isMarketOpen()) return;
      const ids = slotsRef.current.filter((s) => s.token && s.interval !== 'day').map((s) => s.id);
      if (ids.length) void fetchSlots(ids);
    }, 60_000);
    return () => clearInterval(id);
  }, [fetchSlots]);

  /** Fetch a single slot by its current config values — avoids stale closures by taking params directly. */
  async function fetchOne(slotId: string, token: number, interval: Interval, count: number) {
    setSlots((prev) => prev.map((s) => (s.id === slotId ? { ...s, loading: true, error: null } : s)));
    try {
      const today = istToday();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await falcon.postFalconHistoricalBatch([{ token, from: computeFrom(interval, count), to: today, interval }]) as any;
      const entry = raw?.[token];
      const err = extractError(entry);
      const all = normalizeCandles(entry);
      const candles = all.slice(-count);
      setSlots((prev) =>
        prev.map((s) =>
          s.id === slotId ? { ...s, loading: false, candles, error: err, lastFetched: err ? s.lastFetched : Date.now() } : s
        )
      );
    } catch (e) {
      const msg = (e as Error).message;
      setSlots((prev) => prev.map((s) => (s.id === slotId ? { ...s, loading: false, error: msg } : s)));
    }
  }

  function handleSelect(id: string, inst: FalconInstrument) {
    const slot = slots.find((s) => s.id === id);
    if (!slot) return;
    setSlots((prev) =>
      prev.map((s) =>
        s.id === id
          ? { ...s, token: inst.instrument_token, name: `${inst.exchange}:${inst.tradingsymbol}`, candles: [], loading: true, error: null }
          : s
      )
    );
    void fetchOne(id, inst.instrument_token, slot.interval, slot.count);
  }

  function handleInterval(id: string, iv: Interval) {
    const slot = slots.find((s) => s.id === id);
    if (!slot) return;
    const newCount = DEFAULT_COUNT[iv]; // reset count to a sensible default for the new interval
    setSlots((prev) =>
      prev.map((s) => (s.id === id ? { ...s, interval: iv, count: newCount, candles: [], loading: !!slot.token, error: null } : s))
    );
    if (slot.token) void fetchOne(id, slot.token, iv, newCount);
  }

  function handleCount(id: string, n: number) {
    const slot = slots.find((s) => s.id === id);
    if (!slot) return;
    setSlots((prev) =>
      prev.map((s) => (s.id === id ? { ...s, count: n, candles: [], loading: !!slot.token, error: null } : s))
    );
    if (slot.token) void fetchOne(id, slot.token, slot.interval, n);
  }

  function addSlot() {
    if (slots.length >= MAX_SLOTS) { notify.error(`Max ${MAX_SLOTS} charts`); return; }
    setSlots((prev) => [...prev, makeSlot()]);
  }

  if (!adminToken) {
    return (
      <div className="panel">
        <div className="panel__body" style={{ color: 'var(--muted)', fontSize: 12, padding: 24 }}>
          Set an admin token in <strong>Settings</strong> to use Chart Watch.
        </div>
      </div>
    );
  }

  const loadedCount = slots.filter((s) => s.token).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', letterSpacing: 1 }}>CHART WATCH</span>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>{loadedCount}/{MAX_SLOTS} charts</span>
        <button type="button" className="btn-xs btn-xs--ok" onClick={() => void fetchSlots()} disabled={!loadedCount}>
          Refresh All
        </button>
        <button type="button" className="btn-xs" onClick={addSlot} disabled={slots.length >= MAX_SLOTS}>
          + Add Chart
        </button>
      </div>

      {/* empty state */}
      {slots.length === 0 && (
        <div
          className="panel"
          style={{
            border: '1px dashed #1a2232', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            minHeight: 200, color: 'var(--muted)', fontSize: 12,
          }}
          onClick={addSlot}
        >
          + Click to add your first chart
        </div>
      )}

      {/* 2-column grid */}
      {slots.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          {slots.map((slot) => (
            <SlotCard
              key={slot.id}
              slot={slot}
              onSelect={handleSelect}
              onInterval={handleInterval}
              onCount={handleCount}
              onRefresh={(id) => void fetchSlots([id])}
              onRemove={(id) => setSlots((prev) => prev.filter((s) => s.id !== id))}
            />
          ))}
          {slots.length < MAX_SLOTS && (
            <div
              className="panel"
              style={{
                border: '1px dashed #1a2232', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                minHeight: 200, color: 'var(--muted)', fontSize: 12,
              }}
              onClick={addSlot}
            >
              + Add Chart
            </div>
          )}
        </div>
      )}
    </div>
  );
}
