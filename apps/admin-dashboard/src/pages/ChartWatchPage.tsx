/**
 * File:        apps/admin-dashboard/src/pages/ChartWatchPage.tsx
 * Module:      admin-dashboard · Charts
 * Purpose:     Multi-panel candlestick chart watch — up to 6 instruments simultaneously with batch fetching,
 *              auto-refresh during market hours, and localStorage slot persistence.
 *
 * Exports:
 *   - ChartWatchPage — full-page chart grid component
 *
 * Depends on:
 *   - ../lib/falcon-api   — postFalconHistoricalBatch, searchFalconInstruments
 *   - ../lib/api-client   — getAdminToken
 *   - ../lib/toast        — notify
 *   - ../lib/types        — FalconCandle, FalconInstrument
 *   - lightweight-charts  — createChart, candlestick + volume histogram series
 *
 * Side-effects:
 *   - localStorage 'chart-watch-slots': reads on mount, writes on every slot change (config only, not candles)
 *   - setInterval 60s: auto-refresh intraday slots during NSE market hours 09:15–15:30 IST Mon–Fri
 *
 * Key invariants:
 *   - Max 6 slots — all fit in one batch call (batch cap = 10, well within limit)
 *   - lightweight-charts owns the canvas DOM; React never mutates the ref container after mount
 *   - Batch adapter returns FalconCandle[] on success or { error: string } on per-token failure — both handled
 *   - InstrumentSearch sits between panel__head and panel__body to avoid overflow clip on dropdown
 *
 * Read order:
 *   1. ChartSlot / SlotConfig  — state shape
 *   2. helpers                 — computeDates, isMarketOpen, makeSlot
 *   3. CandlePanel             — lightweight-charts rendering
 *   4. InstrumentSearch        — debounced search dropdown
 *   5. SlotCard                — single chart panel
 *   6. ChartWatchPage          — page orchestration, batch load, auto-refresh
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
const LS_KEY = 'chart-watch-slots';
const INTERVALS = ['minute', '5minute', '15minute', '30minute', '60minute', 'day'] as const;
const PRESETS = ['1D', '5D', '1M', '3M', '6M', '1Y'] as const;

type Interval = (typeof INTERVALS)[number];
type Preset = (typeof PRESETS)[number];

interface SlotConfig {
  id: string;
  token: number | null;
  name: string;
  interval: Interval;
  preset: Preset;
}

interface ChartSlot extends SlotConfig {
  candles: FalconCandle[];
  loading: boolean;
  error: string | null;
  lastFetched: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function istToday(): string {
  return new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

function subtractMonths(date: string, months: number): string {
  const d = new Date(date);
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function subtractDays(date: string, days: number): string {
  return new Date(new Date(date).getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function computeDates(preset: Preset): { from: string; to: string } {
  const today = istToday();
  switch (preset) {
    case '1D': return { from: subtractDays(today, 1), to: today };
    case '5D': return { from: subtractDays(today, 5), to: today };
    case '1M': return { from: subtractMonths(today, 1), to: today };
    case '3M': return { from: subtractMonths(today, 3), to: today };
    case '6M': return { from: subtractMonths(today, 6), to: today };
    case '1Y': return { from: subtractMonths(today, 12), to: today };
  }
}

function isMarketOpen(): boolean {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 555 && mins < 930; // 09:15 → 15:30
}

function makeSlot(overrides?: Partial<SlotConfig>): ChartSlot {
  return {
    id: Math.random().toString(36).slice(2, 9),
    token: null,
    name: '',
    interval: 'day',
    preset: '1M',
    candles: [],
    loading: false,
    error: null,
    lastFetched: null,
    ...overrides,
  };
}

// ─── CandlePanel ─────────────────────────────────────────────────────────────

function CandlePanel({ candles }: { candles: FalconCandle[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || !candles.length) return;
    const chart = createChart(ref.current, {
      width: ref.current.clientWidth || 480,
      height: 280,
      layout: { background: { type: ColorType.Solid, color: '#0c1522' }, textColor: '#8899aa' },
      grid: { vertLines: { color: '#1a2232' }, horzLines: { color: '#1a2232' } },
      timeScale: { borderColor: '#1a2232', timeVisible: true },
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ohlc = candles.map((c) => ({ time: c[0].slice(0, 10) as any, open: c[1], high: c[2], low: c[3], close: c[4] }));
    cs.setData(ohlc);
    vs.setData(candles.map((c, i) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      time: c[0].slice(0, 10) as any,
      value: c[5],
      color: (ohlc[i]?.close ?? 0) >= (ohlc[i]?.open ?? 0) ? '#2bd39b33' : '#ff525233',
    })));
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(ref.current);
    return () => { ro.disconnect(); chart.remove(); };
  }, [candles]);

  return <div ref={ref} style={{ width: '100%', height: 280 }} />;
}

// ─── InstrumentSearch ────────────────────────────────────────────────────────

function InstrumentSearch({ onSelect }: { onSelect: (inst: FalconInstrument) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<FalconInstrument[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onChange(v: string) {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    if (!v.trim()) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      try {
        const res = await falcon.searchFalconInstruments(v, 8);
        setResults(Array.isArray(res) ? res : []);
        setOpen(true);
      } catch { /* silent — no admin token or network error */ }
    }, 300);
  }

  function pick(inst: FalconInstrument) {
    setQ(''); setResults([]); setOpen(false);
    onSelect(inst);
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        placeholder="Search instrument…"
        value={q}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        style={{ width: '100%', fontSize: 11, padding: '3px 7px', boxSizing: 'border-box' }}
      />
      {open && results.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          background: '#0c1522', border: '1px solid #1a2232', borderRadius: 4,
          maxHeight: 180, overflowY: 'auto',
        }}>
          {results.map((r) => (
            <div
              key={r.instrument_token}
              onMouseDown={() => pick(r)}
              style={{
                padding: '5px 8px', cursor: 'pointer', fontSize: 11,
                borderBottom: '1px solid #1a2232',
                display: 'flex', gap: 6, alignItems: 'baseline',
              }}
            >
              <span style={{ color: '#fff', fontWeight: 600 }}>{r.tradingsymbol}</span>
              <span style={{ color: '#4a90e2', fontSize: 10 }}>{r.exchange}</span>
              <span style={{ color: '#8899aa', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SlotCard ────────────────────────────────────────────────────────────────

interface SlotCardProps {
  slot: ChartSlot;
  onSelect: (id: string, inst: FalconInstrument) => void;
  onInterval: (id: string, iv: Interval) => void;
  onPreset: (id: string, p: Preset) => void;
  onRefresh: (id: string) => void;
  onRemove: (id: string) => void;
}

function SlotCard({ slot, onSelect, onInterval, onPreset, onRefresh, onRemove }: SlotCardProps) {
  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', minHeight: 220 }}>
      {/* header */}
      <div className="panel__head">
        <span className="panel__title" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {slot.name || 'EMPTY SLOT'}
        </span>
        {slot.lastFetched && (
          <span style={{ fontSize: 9, color: 'var(--muted)', flexShrink: 0 }}>
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

      {/* instrument search — lives outside panel__body to avoid overflow clip on the dropdown */}
      <div style={{ padding: '6px 12px', borderBottom: '1px solid #1a2232' }}>
        <InstrumentSearch onSelect={(inst) => onSelect(slot.id, inst)} />
      </div>

      {/* body: controls + chart */}
      <div className="panel__body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {slot.token && (
          <>
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              {INTERVALS.map((iv) => (
                <button key={iv} type="button"
                  className={`btn-xs${slot.interval === iv ? ' btn-xs--ok' : ''}`}
                  style={{ fontSize: 9 }}
                  onClick={() => onInterval(slot.id, iv)}
                >{iv}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 3 }}>
              {PRESETS.map((p) => (
                <button key={p} type="button"
                  className={`btn-xs${slot.preset === p ? ' btn-xs--ok' : ''}`}
                  style={{ fontSize: 9 }}
                  onClick={() => onPreset(slot.id, p)}
                >{p}</button>
              ))}
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
          <>
            <div style={{ fontSize: 9, color: 'var(--muted)', textAlign: 'right' }}>{slot.candles.length} candles</div>
            <CandlePanel candles={slot.candles} />
          </>
        )}
        {!slot.loading && !slot.token && (
          <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 11, padding: '60px 0' }}>
            Search an instrument above
          </div>
        )}
        {!slot.loading && slot.token && !slot.error && slot.candles.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 11, padding: '60px 0' }}>
            No candles — try a wider date range
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
    } catch { /* corrupted storage — start fresh */ }
    return [];
  });

  // Keep a ref so stable callbacks always see the latest slots
  const slotsRef = useRef(slots);
  useEffect(() => { slotsRef.current = slots; }, [slots]);

  // Persist only the config (no candles) to localStorage
  useEffect(() => {
    const configs = slots.map(({ id, token, name, interval, preset }) => ({ id, token, name, interval, preset }));
    localStorage.setItem(LS_KEY, JSON.stringify(configs));
  }, [slots]);

  // Core fetch: loads candles for a subset (by id) or all loaded slots
  const fetchSlots = useCallback(async (targetIds?: string[]) => {
    const current = slotsRef.current;
    const toFetch = targetIds
      ? current.filter((s) => targetIds.includes(s.id) && s.token)
      : current.filter((s) => s.token);
    if (!toFetch.length) return;

    setSlots((prev) =>
      prev.map((s) => (toFetch.find((t) => t.id === s.id) ? { ...s, loading: true, error: null } : s))
    );

    const requests = toFetch.map((s) => ({ token: s.token!, ...computeDates(s.preset), interval: s.interval }));
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await falcon.postFalconHistoricalBatch(requests) as any;
      setSlots((prev) =>
        prev.map((s) => {
          if (!toFetch.find((t) => t.id === s.id) || !s.token) return s;
          const entry = raw[s.token];
          // Adapter returns FalconCandle[] on success, { error: string } on per-token failure
          const candles: FalconCandle[] = Array.isArray(entry) ? entry : (entry?.candles ?? []);
          const err: string | null = !Array.isArray(entry) ? (entry?.error ?? null) : null;
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

  // Fetch a single slot using its current config values (avoids stale closures)
  async function fetchOne(slotId: string, token: number, preset: Preset, interval: Interval) {
    setSlots((prev) => prev.map((s) => (s.id === slotId ? { ...s, loading: true, error: null } : s)));
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await falcon.postFalconHistoricalBatch([{ token, ...computeDates(preset), interval }]) as any;
      const entry = raw[token];
      const candles: FalconCandle[] = Array.isArray(entry) ? entry : (entry?.candles ?? []);
      const err: string | null = !Array.isArray(entry) ? (entry?.error ?? null) : null;
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
    void fetchOne(id, inst.instrument_token, slot.preset, slot.interval);
  }

  function handleInterval(id: string, iv: Interval) {
    const slot = slots.find((s) => s.id === id);
    if (!slot) return;
    setSlots((prev) =>
      prev.map((s) => (s.id === id ? { ...s, interval: iv, candles: [], loading: !!slot.token, error: null } : s))
    );
    if (slot.token) void fetchOne(id, slot.token, slot.preset, iv);
  }

  function handlePreset(id: string, p: Preset) {
    const slot = slots.find((s) => s.id === id);
    if (!slot) return;
    setSlots((prev) =>
      prev.map((s) => (s.id === id ? { ...s, preset: p, candles: [], loading: !!slot.token, error: null } : s))
    );
    if (slot.token) void fetchOne(id, slot.token, p, slot.interval);
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
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>{loadedCount}/{MAX_SLOTS}</span>
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
              onPreset={handlePreset}
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
