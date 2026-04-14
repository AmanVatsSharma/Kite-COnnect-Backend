/**
 * @file FalconPage.tsx
 * @module admin-dashboard
 * @description Falcon (Kite) operator page — dense terminal layout: account status, stream control,
 *   instrument browser, market data explorer, historical candlestick charts, shard status, options chain.
 * @author BharatERP
 * @updated 2026-04-14 — Phase 3: session banner + quick actions strip
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createChart, ColorType } from 'lightweight-charts';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import * as falcon from '../lib/falcon-api';
import { notify } from '../lib/toast';
import { ErrorInline } from '../components/ErrorInline';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
import type { FalconInstrument, FalconCandle } from '../lib/types';

const INTERVALS = ['minute', '3minute', '5minute', '10minute', '15minute', '30minute', '60minute', 'day'] as const;
const EXCHANGES = ['', 'NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'BCD'];
const PAGE_SIZE = 25;

function fmt(n: number | undefined | null, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', { maximumFractionDigits: decimals });
}

function fmtRs(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `₹${fmt(n)}`;
}

function parseTokens(raw: string): string[] {
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function StatRow({ label, value, variant }: { label: string; value: React.ReactNode; variant?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="stat-row">
      <span className="stat-row__label">{label}</span>
      <span className={`stat-row__value${variant ? ` stat-row__value--${variant}` : ''}`}>{value}</span>
    </div>
  );
}

function CandleChart({ candles }: { candles: FalconCandle[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !candles.length) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth || 700,
      height: 280,
      layout: { background: { type: ColorType.Solid, color: '#0c1522' }, textColor: '#cccccc' },
      grid: { vertLines: { color: '#1a2232' }, horzLines: { color: '#1a2232' } },
      timeScale: { borderColor: '#1a2232' },
    });
    const series = chart.addCandlestickSeries({
      upColor: '#2bd39b',
      downColor: '#ff5252',
      borderVisible: false,
      wickUpColor: '#2bd39b',
      wickDownColor: '#ff5252',
    });
    series.setData(
      candles.map((c) => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        time: String(c[0]).substring(0, 10) as any,
        open: c[1], high: c[2], low: c[3], close: c[4],
      }))
    );
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); chart.remove(); };
  }, [candles]);

  return <div ref={containerRef} style={{ width: '100%', height: 280 }} />;
}

// ─── main page ──────────────────────────────────────────────────────────────

export function FalconPage() {
  const token = getAdminToken();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { refetchInterval } = useRefreshInterval();

  const debug = useQuery({ queryKey: ['admin-debug-falcon'], queryFn: admin.getKiteDebug, enabled: !!token, refetchInterval });
  const profile = useQuery({ queryKey: ['falcon-profile'], queryFn: falcon.getFalconProfile, enabled: !!token });
  const margins = useQuery({ queryKey: ['falcon-margins'], queryFn: () => falcon.getFalconMargins(), enabled: !!token });
  const globalProv = useQuery({ queryKey: ['admin-global-provider'], queryFn: admin.getGlobalProvider, enabled: !!token, refetchInterval });
  const streamStatus = useQuery({ queryKey: ['admin-stream-status'], queryFn: admin.getStreamStatus, enabled: !!token, refetchInterval });
  const stats = useQuery({ queryKey: ['falcon-stats'], queryFn: falcon.getFalconStats, enabled: !!token });
  const falconConfig = useQuery({ queryKey: ['falcon-config'], queryFn: falcon.getFalconConfig, enabled: !!token });
  const shardStatus = useQuery({ queryKey: ['falcon-shard-status'], queryFn: falcon.getFalconShardStatus, enabled: !!token, refetchInterval });
  const sessionQ = useQuery({ queryKey: ['falcon-session'], queryFn: falcon.getFalconSession, refetchInterval: 30_000, enabled: !!token });

  // Quick action mutations
  const restartTickerMut = useMutation({
    mutationFn: falcon.postFalconTickerRestart,
    onSuccess: () => {
      notify.ok('Ticker restarted');
      void qc.invalidateQueries({ queryKey: ['falcon-shard-status'] });
      void qc.invalidateQueries({ queryKey: ['admin-debug-falcon'] });
    },
    onError: (e: Error) => notify.error(`Restart failed: ${e.message}`),
  });

  const [validatingSession, setValidatingSession] = useState(false);
  async function handleValidateSession() {
    setValidatingSession(true);
    try {
      await falcon.getFalconProfile();
      notify.ok('Kite session valid');
    } catch (e) {
      notify.error(`Session invalid: ${(e as Error).message}`);
    } finally {
      setValidatingSession(false);
    }
  }

  const [flushAllLoading, setFlushAllLoading] = useState(false);
  async function handleFlushAllCaches() {
    setFlushAllLoading(true);
    try {
      await Promise.all([
        falcon.flushFalconCache({ type: 'options' }),
        falcon.flushFalconCache({ type: 'ltp' }),
        falcon.flushFalconCache({ type: 'historical' }),
      ]);
      notify.ok('All caches flushed');
    } catch (e) {
      notify.error(`Flush failed: ${(e as Error).message}`);
    } finally {
      setFlushAllLoading(false);
    }
  }

  const setProvMut = useMutation({
    mutationFn: () => admin.setGlobalProvider('kite'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-global-provider'] });
      void qc.invalidateQueries({ queryKey: ['admin-stream-status'] });
    },
  });
  const startMut = useMutation({
    mutationFn: admin.startStream,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-stream-status'] }),
  });
  const stopMut = useMutation({
    mutationFn: admin.stopStream,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-stream-status'] }),
  });

  // Sync
  const [syncExchange, setSyncExchange] = useState('');
  const [syncResult, setSyncResult] = useState<Record<string, unknown> | null>(null);
  const syncMut = useMutation({
    mutationFn: () => falcon.syncFalconInstruments(syncExchange || undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSuccess: (data: any) => {
      setSyncResult(data);
      void qc.invalidateQueries({ queryKey: ['falcon-stats'] });
    },
  });

  // Instrument browser
  const [instrPage, setInstrPage] = useState(0);
  const [instrExchange, setInstrExchange] = useState('');
  const [instrType, setInstrType] = useState('');
  const [instrSearch, setInstrSearch] = useState('');
  const [instrSearchInput, setInstrSearchInput] = useState('');
  const instruments = useQuery({
    queryKey: ['falcon-instruments', instrPage, instrExchange, instrType, instrSearch],
    queryFn: () =>
      instrSearch
        ? falcon.searchFalconInstruments(instrSearch, 50).then((data) => ({
            instruments: Array.isArray(data) ? data : [],
            total: Array.isArray(data) ? data.length : 0,
          }))
        : falcon.getFalconInstruments({
            exchange: instrExchange || undefined,
            instrument_type: instrType || undefined,
            limit: PAGE_SIZE,
            offset: instrPage * PAGE_SIZE,
          }),
    enabled: !!token,
  });

  // Market data explorer
  const [mdTokens, setMdTokens] = useState('');
  const [mdMode, setMdMode] = useState<'ltp' | 'quote' | 'ohlc'>('ltp');
  const [mdResult, setMdResult] = useState<object | null>(null);
  const [mdError, setMdError] = useState<string | null>(null);
  const [mdLoading, setMdLoading] = useState(false);

  const fetchMd = async () => {
    const tokens = parseTokens(mdTokens);
    if (!tokens.length) return;
    setMdError(null); setMdLoading(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;
      if (mdMode === 'ltp') result = await falcon.getFalconLTP(tokens);
      else if (mdMode === 'quote') result = await falcon.getFalconQuote(tokens);
      else result = await falcon.getFalconOHLC(tokens);
      setMdResult(result as object);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { setMdError(e?.message || 'Request failed'); }
    finally { setMdLoading(false); }
  };

  // Historical data
  const [histToken, setHistToken] = useState('');
  const [histFrom, setHistFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10);
  });
  const [histTo, setHistTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [histInterval, setHistInterval] = useState<string>('day');
  const [histContinuous, setHistContinuous] = useState(false);
  const [histOi, setHistOi] = useState(false);
  const [histCandles, setHistCandles] = useState<FalconCandle[] | null>(null);
  const [histError, setHistError] = useState<string | null>(null);
  const [histLoading, setHistLoading] = useState(false);

  const fetchHistorical = async () => {
    if (!histToken.trim()) return;
    setHistError(null); setHistLoading(true); setHistCandles(null);
    try {
      const result = await falcon.getFalconHistorical(histToken.trim(), histFrom, histTo, histInterval, histContinuous, histOi);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const candles = (result as any)?.candles ?? result;
      setHistCandles(Array.isArray(candles) ? candles : []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { setHistError(e?.message || 'Request failed'); }
    finally { setHistLoading(false); }
  };

  // Credentials
  const [cfgApiKey, setCfgApiKey] = useState('');
  const [cfgApiSecret, setCfgApiSecret] = useState('');
  const [cfgMsg, setCfgMsg] = useState<string | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const cfgMut = useMutation({
    mutationFn: () => falcon.updateFalconConfig({ apiKey: cfgApiKey, apiSecret: cfgApiSecret || undefined }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSuccess: (data: any) => {
      setCfgMsg(data?.message ?? 'Updated'); setCfgErr(null);
      setCfgApiKey(''); setCfgApiSecret('');
      void qc.invalidateQueries({ queryKey: ['falcon-config'] });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onError: (e: any) => { setCfgErr(e?.message || 'Update failed'); setCfgMsg(null); },
  });

  // Options chain explorer
  const [optSymbol, setOptSymbol] = useState('');
  const [optLtpOnly, setOptLtpOnly] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [optData, setOptData] = useState<any>(null);
  const [optError, setOptError] = useState<string | null>(null);
  const [optLoading, setOptLoading] = useState(false);
  const [optExpiry, setOptExpiry] = useState('');
  const [flushMsg, setFlushMsg] = useState<string | null>(null);

  const fetchOptionsChain = async () => {
    if (!optSymbol.trim()) return;
    setOptError(null); setOptLoading(true); setOptData(null); setOptExpiry('');
    try {
      const result = await falcon.getFalconOptionsChainAdmin(optSymbol.trim().toUpperCase(), optLtpOnly);
      setOptData(result);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { setOptError(e?.message || 'Request failed'); }
    finally { setOptLoading(false); }
  };

  const handleFlushOptions = async () => {
    setFlushMsg(null);
    try {
      await falcon.flushFalconCache({ type: 'options', symbol: optSymbol.trim().toUpperCase() || undefined });
      setFlushMsg('Options cache flushed');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { setFlushMsg(`Flush failed: ${e?.message ?? ''}`); }
  };

  if (!token) {
    return <section className="card"><p className="err">Add an admin token in Settings.</p></section>;
  }

  // ── derived values ──────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const debugData = debug.data as any;
  const isConnected = debugData?.connected === true;
  const isDegraded = debugData?.degraded === true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const profileData = profile.data as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const marginsData = margins.data as any;
  const equityNet = marginsData?.equity?.net ?? marginsData?.net;
  const commodityNet = marginsData?.commodity?.net;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const currentProvider = (globalProv.data as any)?.provider;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isStreaming = (streamStatus.data as any)?.isStreaming === true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statsData = stats.data as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfgData = falconConfig.data as any;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', overflow: 'hidden' }}>
      {/* ── Page header ────────────────────────────────────────── */}
      <div className="page-head">
        <h1>FALCON (KITE)</h1>
        <div style={{ display: 'flex', gap: 12 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
            <span className={`dot ${isConnected && !isDegraded ? 'dot--live' : isDegraded ? 'dot--warn' : 'dot--off'}`} />
            <span style={{ color: isConnected ? 'var(--ok)' : 'var(--muted)' }}>
              {isDegraded ? 'DEGRADED' : isConnected ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
            <span className={`dot ${isStreaming ? 'dot--live' : 'dot--off'}`} />
            <span style={{ color: isStreaming ? 'var(--ok)' : 'var(--muted)' }}>
              {isStreaming ? 'STREAMING' : 'STREAM OFF'}
            </span>
          </span>
          {currentProvider && (
            <span className={`cc-chip ${currentProvider === 'kite' ? 'cc-chip--ok' : 'cc-chip--neutral'}`} style={{ fontSize: 9 }}>
              PROVIDER: {String(currentProvider).toUpperCase()}
            </span>
          )}
        </div>
      </div>

      {/* ── Session Banner ─────────────────────────────────────── */}
      {sessionQ.data && (() => {
        const ttl = sessionQ.data.ttlSeconds;
        const hasToken = sessionQ.data.hasToken;
        let bg = 'rgba(43,211,155,0.06)';
        let border = 'rgba(43,211,155,0.2)';
        let color = 'var(--ok)';
        let msg = `Session valid · Expires in ${Math.floor(ttl / 3600)}h ${Math.floor((ttl % 3600) / 60)}m`;
        let showReauth = false;
        if (!hasToken || ttl < 0) {
          bg = 'rgba(255,107,107,0.06)'; border = 'rgba(255,107,107,0.2)'; color = 'var(--bad)';
          msg = 'Session expired / missing — Login required'; showReauth = true;
        } else if (ttl < 7200) {
          bg = 'rgba(245,166,35,0.06)'; border = 'rgba(245,166,35,0.2)'; color = 'var(--warn, #f5a623)';
          const h = Math.floor(ttl / 3600); const m = Math.floor((ttl % 3600) / 60);
          msg = `Token expires in ${h}h ${m}m — re-auth soon`; showReauth = true;
        }
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: bg, border: `1px solid ${border}`, borderRadius: 4, fontSize: 10, color, flexShrink: 0 }}>
            <span style={{ flex: 1 }}>{msg}</span>
            {showReauth && (
              <button type="button" className="btn-xs btn-xs--bad" style={{ fontSize: 9 }} onClick={() => navigate('/auth')}>
                Re-auth Now
              </button>
            )}
          </div>
        );
      })()}

      {/* ── Quick Actions strip ─────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn-xs"
          onClick={() => restartTickerMut.mutate()}
          disabled={restartTickerMut.isPending}
          title="Restart Kite ticker (all shards)"
        >
          {restartTickerMut.isPending ? '…' : '⟳ Restart Ticker'}
        </button>
        <button
          type="button"
          className="btn-xs"
          onClick={() => syncMut.mutate()}
          disabled={syncMut.isPending}
          title="Sync Falcon instruments from Kite"
        >
          {syncMut.isPending ? 'Syncing…' : '↓ Sync Instruments'}
        </button>
        <button
          type="button"
          className="btn-xs btn-xs--bad"
          onClick={() => void handleFlushAllCaches()}
          disabled={flushAllLoading}
          title="Flush options + LTP + historical caches"
        >
          {flushAllLoading ? 'Flushing…' : '✕ Flush All Caches'}
        </button>
        <button
          type="button"
          className="btn-xs"
          onClick={() => void handleValidateSession()}
          disabled={validatingSession}
          title="Validate Kite session via profile endpoint"
        >
          {validatingSession ? 'Validating…' : '↺ Validate Session'}
        </button>
      </div>

      {/* ── Scrollable content ─────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>

        {/* ── Row 1: Account + Provider + Stats ──────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, flexShrink: 0 }}>

          {/* Account & connection */}
          <div className="panel">
            <div className="panel__head">
              <span className="panel__title">ACCOUNT &amp; CONNECTION</span>
              <span className="panel__title-val" style={{ color: isConnected ? 'var(--ok)' : 'var(--bad)' }}>
                {isDegraded ? 'DEGRADED' : isConnected ? 'OK' : 'DOWN'}
              </span>
            </div>
            <div className="panel__body">
              <ErrorInline message={debug.isError ? (debug.error as Error).message : null} />
              <StatRow label="Connection" value={isDegraded ? 'Degraded' : isConnected ? 'Connected' : 'Disconnected'}
                variant={isDegraded ? 'warn' : isConnected ? 'ok' : 'bad'} />
              <StatRow label="HTTP Client" value={debugData?.httpClientReady ? 'Ready' : 'Not ready'}
                variant={debugData?.httpClientReady ? 'ok' : 'bad'} />
              <StatRow label="API Key" value={debugData?.maskedApiKey ?? '—'} />
              <StatRow label="Access Token" value={debugData?.maskedAccessToken ?? '—'} />
              <StatRow label="Reconnect attempts" value={String(debugData?.reconnectAttempts ?? '—')} />
              {profileData && (
                <>
                  <div className="panel-section-title" style={{ marginTop: 6 }}>PROFILE</div>
                  <StatRow label="User" value={`${profileData.user_name ?? '—'} (${profileData.user_id ?? '—'})`} />
                  <StatRow label="Email" value={profileData.email ?? '—'} />
                  <StatRow label="Broker" value={profileData.broker ?? '—'} />
                  <StatRow label="Exchanges" value={(profileData.exchanges ?? []).join(', ') || '—'} />
                </>
              )}
              {(profile.isError || margins.isError) && (
                <>
                  <ErrorInline message={profile.isError ? (profile.error as Error).message : null} />
                  <ErrorInline message={margins.isError ? (margins.error as Error).message : null} />
                </>
              )}
              <StatRow label="Equity margin" value={fmtRs(equityNet)} />
              <StatRow label="Commodity margin" value={fmtRs(commodityNet)} />
            </div>
          </div>

          {/* Provider + stream */}
          <div className="panel">
            <div className="panel__head">
              <span className="panel__title">PROVIDER &amp; STREAM</span>
              <span className={`dot ${isStreaming ? 'dot--live' : 'dot--off'}`} />
            </div>
            <div className="panel__body">
              <StatRow label="Active provider" value={currentProvider ?? '—'}
                variant={currentProvider === 'kite' ? 'ok' : undefined} />
              <StatRow label="Stream" value={isStreaming ? 'Live' : 'Stopped'}
                variant={isStreaming ? 'ok' : 'warn'} />
              <div className="panel-section-title" style={{ marginTop: 8 }}>ACTIVATE FALCON</div>
              <div style={{ marginTop: 4 }}>
                <button
                  type="button"
                  className={`provider-btn ${currentProvider === 'kite' ? 'provider-btn--active' : ''}`}
                  style={{ width: '100%' }}
                  onClick={() => setProvMut.mutate()}
                  disabled={setProvMut.isPending}
                >
                  {setProvMut.isPending ? 'Activating…' : 'ACTIVATE FALCON (KITE)'}
                </button>
              </div>
              <div className="panel-section-title" style={{ marginTop: 8 }}>STREAM CONTROLS</div>
              <div className="stream-btns" style={{ marginTop: 4 }}>
                <button type="button" className="stream-btn-start" onClick={() => startMut.mutate()} disabled={startMut.isPending || isStreaming}>
                  ▶ START
                </button>
                <button type="button" className="stream-btn-stop" onClick={() => stopMut.mutate()} disabled={stopMut.isPending || !isStreaming}>
                  ■ STOP
                </button>
              </div>
              {(setProvMut.isError || startMut.isError || stopMut.isError) && (
                <p className="err" style={{ fontSize: 10, marginTop: 4 }}>
                  {((setProvMut.error || startMut.error || stopMut.error) as Error).message}
                </p>
              )}
            </div>
          </div>

          {/* Instrument stats + sync */}
          <div className="panel">
            <div className="panel__head">
              <span className="panel__title">INSTRUMENT STATS &amp; SYNC</span>
            </div>
            <div className="panel__body">
              <ErrorInline message={stats.isError ? (stats.error as Error).message : null} />
              {statsData && (
                <>
                  <StatRow label="Total" value={(statsData.total ?? 0).toLocaleString()} />
                  <StatRow label="Active" value={(statsData.active ?? 0).toLocaleString()} variant="ok" />
                  <StatRow label="Inactive" value={(statsData.inactive ?? 0).toLocaleString()} />
                  {statsData.by_exchange && (
                    Object.entries(statsData.by_exchange as Record<string, number>).map(([ex, count]) => (
                      <StatRow key={ex} label={ex} value={(count as number).toLocaleString()} />
                    ))
                  )}
                </>
              )}
              <div className="panel-section-title" style={{ marginTop: 8 }}>SYNC NOW</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                <select
                  value={syncExchange}
                  onChange={(e) => setSyncExchange(e.target.value)}
                  style={{ fontSize: 11, padding: '4px 6px', flex: 1 }}
                >
                  {EXCHANGES.map((ex) => <option key={ex} value={ex}>{ex || 'ALL'}</option>)}
                </select>
                <button type="button" className="btn-xs btn-xs--ok" onClick={() => syncMut.mutate()} disabled={syncMut.isPending}>
                  {syncMut.isPending ? 'Syncing…' : 'Sync'}
                </button>
              </div>
              {syncMut.isError && <p className="err" style={{ fontSize: 10, marginTop: 4 }}>{(syncMut.error as Error).message}</p>}
              {syncResult && (
                <div style={{ marginTop: 6, fontSize: 10, color: 'var(--ok)' }}>
                  Synced: {String(syncResult.synced ?? '—')} · Updated: {String(syncResult.updated ?? '—')}
                  {syncResult.reconciled != null ? ` · Reconciled: ${String(syncResult.reconciled)}` : ''}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Shard Status + Capacity ─────────────────────────── */}
        {(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sd = shardStatus.data as any;
          if (!sd) return null;
          const { shards = [], totalCapacity = 3000, used = 0, remaining = 0, utilizationPct = 0 } = sd;
          const barColor = utilizationPct >= 90 ? 'var(--bad)' : utilizationPct >= 70 ? 'var(--warn)' : 'var(--ok)';
          return (
            <div className="panel" style={{ flexShrink: 0 }}>
              <div className="panel__head">
                <span className="panel__title">WS SHARD STATUS</span>
                <span className="panel__title-val">{shards.length} shard{shards.length !== 1 ? 's' : ''} · {used.toLocaleString()}/{totalCapacity.toLocaleString()} tokens</span>
              </div>
              <div className="panel__body">
                {/* Capacity bar */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginBottom: 3 }}>
                    <span style={{ color: 'var(--muted)' }}>CAPACITY UTILIZATION</span>
                    <span style={{ color: barColor, fontWeight: 600 }}>{utilizationPct.toFixed(1)}% · {remaining.toLocaleString()} remaining</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(utilizationPct, 100)}%`, background: barColor, transition: 'width 0.4s ease', borderRadius: 3 }} />
                  </div>
                </div>
                {/* Per-shard cards */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {shards.map((shard: any) => (
                    <div key={shard.index} style={{ flex: '1 1 160px', minWidth: 140, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, padding: '6px 10px', background: 'rgba(0,0,0,0.18)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>SHARD {shard.index}</span>
                        <span className={`cc-chip ${shard.isConnected ? 'cc-chip--ok' : 'cc-chip--bad'}`} style={{ fontSize: 8, padding: '1px 6px' }}>
                          {shard.isConnected ? 'LIVE' : shard.disableReconnect ? 'HALTED' : 'DOWN'}
                        </span>
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 2 }}>
                        <span style={{ color: 'var(--text)' }}>{(shard.subscribedCount ?? 0).toLocaleString()}</span> / 3,000 tokens
                      </div>
                      {/* mini bar */}
                      <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginBottom: 4 }}>
                        <div style={{ height: '100%', width: `${Math.min(((shard.subscribedCount ?? 0) / 3000) * 100, 100)}%`, background: shard.isConnected ? 'var(--ok)' : 'var(--bad)', borderRadius: 2 }} />
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--muted)' }}>reconnects: {shard.reconnectCount ?? 0} · attempts: {shard.reconnectAttempts ?? 0}</div>
                    </div>
                  ))}
                  {shards.length === 0 && (
                    <div style={{ fontSize: 10, color: 'var(--muted)', padding: '4px 0' }}>No shard data — Kite ticker not initialized.</div>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Credentials panel ──────────────────────────────── */}
        <div className="panel" style={{ flexShrink: 0 }}>
          <div className="panel__head">
            <span className="panel__title">FALCON API CREDENTIALS</span>
            {cfgData?.accessToken?.masked && (
              <span className="cc-chip cc-chip--ok" style={{ fontSize: 9 }}>TOKEN SET</span>
            )}
          </div>
          <div className="panel__body">
            <p style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
              Update Kite API Key / Secret without SSH. After updating, re-authenticate at{' '}
              <code style={{ fontSize: 10 }}>/api/auth/falcon/login</code>.
            </p>
            {cfgData && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginBottom: 10 }}>
                {[
                  { label: 'API Key', val: `${cfgData.apiKey?.masked ?? '—'} · ${cfgData.apiKey?.source ?? '?'}` },
                  { label: 'API Secret', val: `${cfgData.apiSecret?.hasValue ? 'Set' : 'Not set'} · ${cfgData.apiSecret?.source ?? '?'}` },
                  { label: 'Access Token', val: cfgData.accessToken?.masked ?? 'Not set' },
                  { label: 'Client Init', val: cfgData.initialized ? 'Ready' : 'Not ready' },
                ].map((r) => (
                  <div key={r.label} className="stat-chip" style={{ minWidth: 0 }}>
                    <div className="stat-chip__label">{r.label.toUpperCase()}</div>
                    <div style={{ fontSize: 10, color: 'var(--text)', fontFamily: 'ui-monospace,monospace', wordBreak: 'break-all' }}>{r.val}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <label style={{ fontSize: 10, marginBottom: 2, display: 'block' }}>API KEY *</label>
                <input
                  value={cfgApiKey}
                  onChange={(e) => setCfgApiKey(e.target.value)}
                  placeholder="e.g. abcdef1234567890"
                  autoComplete="off"
                  style={{ fontSize: 11, padding: '4px 6px', width: '100%' }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={{ fontSize: 10, marginBottom: 2, display: 'block' }}>API SECRET (optional)</label>
                <input
                  type="password"
                  value={cfgApiSecret}
                  onChange={(e) => setCfgApiSecret(e.target.value)}
                  placeholder="leave blank to keep existing"
                  autoComplete="new-password"
                  style={{ fontSize: 11, padding: '4px 6px', width: '100%' }}
                />
              </div>
              <button
                type="button"
                className="btn-xs btn-xs--ok"
                onClick={() => cfgMut.mutate()}
                disabled={cfgMut.isPending || !cfgApiKey.trim()}
              >
                {cfgMut.isPending ? 'Saving…' : 'Save Credentials'}
              </button>
            </div>
            {cfgMsg && <p style={{ color: 'var(--ok)', fontSize: 10, marginTop: 5 }}>{cfgMsg}</p>}
            {cfgErr && <p style={{ color: 'var(--bad)', fontSize: 10, marginTop: 5 }}>{cfgErr}</p>}
          </div>
        </div>

        {/* ── Instrument browser ──────────────────────────────── */}
        <div className="panel" style={{ flexShrink: 0 }}>
          <div className="panel__head">
            <span className="panel__title">INSTRUMENT BROWSER</span>
            {instruments.data && (
              <span className="panel__title-val">{(instruments.data.total ?? 0).toLocaleString()} results</span>
            )}
          </div>
          <div className="panel__body" style={{ padding: '6px 0 0' }}>
            {/* Search controls */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 8px 6px' }}>
              <input
                placeholder="Search symbol (e.g. SBIN, NIFTY)"
                value={instrSearchInput}
                onChange={(e) => setInstrSearchInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { setInstrSearch(instrSearchInput); setInstrPage(0); } }}
                style={{ fontSize: 11, padding: '3px 7px', minWidth: 180 }}
              />
              <button type="button" className="btn-xs" onClick={() => { setInstrSearch(instrSearchInput); setInstrPage(0); }}>Search</button>
              <button type="button" className="btn-xs" onClick={() => { setInstrSearch(''); setInstrSearchInput(''); setInstrPage(0); }}>Clear</button>
              <select
                value={instrExchange}
                onChange={(e) => { setInstrExchange(e.target.value); setInstrPage(0); }}
                style={{ fontSize: 11, padding: '3px 6px' }}
              >
                {EXCHANGES.map((ex) => <option key={ex} value={ex}>{ex || 'All Exchanges'}</option>)}
              </select>
              <select
                value={instrType}
                onChange={(e) => { setInstrType(e.target.value); setInstrPage(0); }}
                style={{ fontSize: 11, padding: '3px 6px' }}
              >
                {['', 'EQ', 'FUT', 'CE', 'PE'].map((t) => <option key={t} value={t}>{t || 'All Types'}</option>)}
              </select>
              {!instrSearch && instruments.data && (
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button type="button" className="btn-xs" disabled={instrPage === 0} onClick={() => setInstrPage((p) => p - 1)}>← Prev</button>
                  <span style={{ fontSize: 10, color: 'var(--muted)' }}>
                    {instrPage * PAGE_SIZE + 1}–{Math.min((instrPage + 1) * PAGE_SIZE, instruments.data.total ?? 0)}{' '}
                    of {(instruments.data.total ?? 0).toLocaleString()}
                  </span>
                  <button type="button" className="btn-xs" disabled={(instrPage + 1) * PAGE_SIZE >= (instruments.data.total ?? 0)} onClick={() => setInstrPage((p) => p + 1)}>Next →</button>
                </span>
              )}
            </div>
            <ErrorInline message={instruments.isError ? (instruments.error as Error).message : null} />
            <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>TOKEN</th>
                    <th>SYMBOL</th>
                    <th>EXCHANGE</th>
                    <th>TYPE</th>
                    <th>EXPIRY</th>
                    <th className="cell-num">STRIKE</th>
                    <th className="cell-num">LOT</th>
                    <th className="cell-num">TICK</th>
                    <th style={{ width: 36 }}>ACT</th>
                  </tr>
                </thead>
                <tbody>
                  {(instruments.data?.instruments ?? []).map((i: FalconInstrument) => (
                    <tr key={i.instrument_token}>
                      <td><span className="cell-key" style={{ maxWidth: 80 }}>{i.instrument_token}</span></td>
                      <td style={{ fontWeight: 600 }}>{i.tradingsymbol}</td>
                      <td className="cell-muted">{i.exchange}</td>
                      <td>
                        <span className="reason-pill" style={{ background: 'rgba(124,158,255,0.1)', color: 'var(--accent)', borderColor: 'rgba(124,158,255,0.2)' }}>
                          {i.instrument_type}
                        </span>
                      </td>
                      <td className="cell-muted">{i.expiry || '—'}</td>
                      <td className="cell-num">{i.strike ? fmt(i.strike) : '—'}</td>
                      <td className="cell-num">{i.lot_size}</td>
                      <td className="cell-num">{i.tick_size}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span className={`dot ${i.is_active ? 'dot--live' : 'dot--off'}`} />
                      </td>
                    </tr>
                  ))}
                  {instruments.isLoading && (
                    <tr><td colSpan={9} className="cell-muted" style={{ textAlign: 'center', padding: '12px 8px' }}>Loading…</td></tr>
                  )}
                  {!instruments.isLoading && (instruments.data?.instruments ?? []).length === 0 && (
                    <tr><td colSpan={9} className="cell-muted" style={{ textAlign: 'center', padding: '12px 8px' }}>No instruments found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ── Market data explorer ─────────────────────────────── */}
        <div className="panel" style={{ flexShrink: 0 }}>
          <div className="panel__head">
            <span className="panel__title">MARKET DATA EXPLORER</span>
          </div>
          <div className="panel__body">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
              <input
                placeholder="Tokens: 256265, 738561"
                value={mdTokens}
                onChange={(e) => setMdTokens(e.target.value)}
                style={{ fontSize: 11, padding: '3px 7px', minWidth: 200, fontFamily: 'ui-monospace,monospace' }}
              />
              {(['ltp', 'quote', 'ohlc'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`btn-xs ${mdMode === m ? 'btn-xs--ok' : ''}`}
                  onClick={() => { setMdMode(m); setMdResult(null); }}
                >
                  {m.toUpperCase()}
                </button>
              ))}
              <button type="button" className="btn-xs btn-xs--ok" onClick={() => void fetchMd()} disabled={mdLoading || !mdTokens.trim()}>
                {mdLoading ? 'Fetching…' : '▶ Fetch'}
              </button>
            </div>
            <ErrorInline message={mdError} />
            {mdResult && (
              <pre style={{
                fontSize: 10,
                background: 'rgba(0,0,0,0.2)',
                borderRadius: 4,
                padding: '8px 10px',
                maxHeight: 200,
                overflow: 'auto',
                color: 'var(--text)',
                fontFamily: 'ui-monospace,monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}>
                {JSON.stringify(mdResult, null, 2)}
              </pre>
            )}
          </div>
        </div>

        {/* ── Historical candles ───────────────────────────────── */}
        <div className="panel" style={{ flexShrink: 0 }}>
          <div className="panel__head">
            <span className="panel__title">HISTORICAL CANDLES</span>
            {histCandles && <span className="panel__title-val">{histCandles.length} candles</span>}
          </div>
          <div className="panel__body">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
              <input
                placeholder="Token (e.g. 256265)"
                value={histToken}
                onChange={(e) => setHistToken(e.target.value)}
                style={{ fontSize: 11, padding: '3px 7px', width: 130, fontFamily: 'ui-monospace,monospace' }}
              />
              <input type="date" value={histFrom} onChange={(e) => setHistFrom(e.target.value)} style={{ fontSize: 11, padding: '3px 6px' }} />
              <span style={{ fontSize: 10, color: 'var(--muted)' }}>→</span>
              <input type="date" value={histTo} onChange={(e) => setHistTo(e.target.value)} style={{ fontSize: 11, padding: '3px 6px' }} />
              <select value={histInterval} onChange={(e) => setHistInterval(e.target.value)} style={{ fontSize: 11, padding: '3px 6px' }}>
                {INTERVALS.map((iv) => <option key={iv} value={iv}>{iv}</option>)}
              </select>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={histContinuous} onChange={(e) => setHistContinuous(e.target.checked)} />
                cont.
              </label>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={histOi} onChange={(e) => setHistOi(e.target.checked)} />
                OI
              </label>
              <button type="button" className="btn-xs btn-xs--ok" onClick={() => void fetchHistorical()} disabled={histLoading || !histToken.trim()}>
                {histLoading ? 'Fetching…' : '▶ Fetch'}
              </button>
            </div>
            <ErrorInline message={histError} />
            {histCandles && histCandles.length > 0 && (
              <>
                <CandleChart candles={histCandles} />
                <details style={{ marginTop: 8 }}>
                  <summary style={{ fontSize: 10, color: 'var(--muted)', cursor: 'pointer' }}>
                    Raw candles ({histCandles.length})
                  </summary>
                  <div style={{ overflowX: 'auto', maxHeight: 200, overflowY: 'auto', marginTop: 6 }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>DATE</th>
                          <th className="cell-num">OPEN</th>
                          <th className="cell-num" style={{ color: 'var(--price-up)' }}>HIGH</th>
                          <th className="cell-num" style={{ color: 'var(--price-down)' }}>LOW</th>
                          <th className="cell-num">CLOSE</th>
                          <th className="cell-num">VOLUME</th>
                          {histOi && <th className="cell-num">OI</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {histCandles.slice(0, 500).map((c, idx) => (
                          <tr key={idx}>
                            <td style={{ fontFamily: 'ui-monospace,monospace' }}>{String(c[0]).substring(0, 19)}</td>
                            <td className="cell-num">{fmt(c[1])}</td>
                            <td className="cell-num" style={{ color: 'var(--price-up)' }}>{fmt(c[2])}</td>
                            <td className="cell-num" style={{ color: 'var(--price-down)' }}>{fmt(c[3])}</td>
                            <td className="cell-num">{fmt(c[4])}</td>
                            <td className="cell-num">{c[5]?.toLocaleString() ?? '—'}</td>
                            {histOi && <td className="cell-num">{c[6]?.toLocaleString() ?? '—'}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
            {histCandles && histCandles.length === 0 && (
              <p style={{ fontSize: 10, color: 'var(--muted)' }}>No candle data returned.</p>
            )}
          </div>
        </div>

        {/* ── Options Chain Explorer ───────────────────────────── */}
        <div className="panel" style={{ flexShrink: 0 }}>
          <div className="panel__head">
            <span className="panel__title">OPTIONS CHAIN EXPLORER</span>
            {optData && (
              <span className="panel__title-val">
                {optData.symbol} · {(optData.strikes ?? []).length} strikes
                {optData.fromCache ? ' · CACHED' : ' · FRESH'}
              </span>
            )}
          </div>
          <div className="panel__body">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
              <input
                placeholder="Symbol (e.g. NIFTY)"
                value={optSymbol}
                onChange={(e) => setOptSymbol(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === 'Enter') void fetchOptionsChain(); }}
                style={{ fontSize: 11, padding: '3px 7px', width: 130, fontFamily: 'ui-monospace,monospace' }}
              />
              <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={optLtpOnly} onChange={(e) => setOptLtpOnly(e.target.checked)} />
                LTP only
              </label>
              <button type="button" className="btn-xs btn-xs--ok" onClick={() => void fetchOptionsChain()} disabled={optLoading || !optSymbol.trim()}>
                {optLoading ? 'Loading…' : '▶ Load Chain'}
              </button>
              {optData && (
                <button type="button" className="btn-xs btn-xs--bad" onClick={() => void handleFlushOptions()} title="Flush Redis cache for this symbol">
                  ✕ Flush Cache
                </button>
              )}
              {optData?.expiries?.length > 0 && (
                <select
                  value={optExpiry}
                  onChange={(e) => setOptExpiry(e.target.value)}
                  style={{ fontSize: 11, padding: '3px 6px', marginLeft: 'auto' }}
                >
                  <option value="">All expiries</option>
                  {(optData.expiries as string[]).map((exp: string) => (
                    <option key={exp} value={exp}>{exp}</option>
                  ))}
                </select>
              )}
            </div>
            {flushMsg && (
              <p style={{ fontSize: 10, color: flushMsg.startsWith('Flush failed') ? 'var(--bad)' : 'var(--ok)', marginBottom: 6 }}>{flushMsg}</p>
            )}
            <ErrorInline message={optError} />
            {optData && (
              <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="cell-num">STRIKE</th>
                      <th>CE TOKEN</th>
                      <th className="cell-num">CE LTP</th>
                      <th>PE TOKEN</th>
                      <th className="cell-num">PE LTP</th>
                      {!optLtpOnly && <th>EXPIRY</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(optData.strikes ?? [])
                      .filter((s: any) => !optExpiry || s.expiry === optExpiry)
                      .slice(0, 200)
                      .map((s: any, idx: number) => (
                        <tr key={idx}>
                          <td className="cell-num" style={{ fontWeight: 600 }}>{fmt(s.strike)}</td>
                          <td><span className="cell-key" style={{ maxWidth: 90 }}>{s.ceToken ?? '—'}</span></td>
                          <td className="cell-num" style={{ color: 'var(--price-up)' }}>{s.ceLtp != null ? fmtRs(s.ceLtp) : '—'}</td>
                          <td><span className="cell-key" style={{ maxWidth: 90 }}>{s.peToken ?? '—'}</span></td>
                          <td className="cell-num" style={{ color: 'var(--price-down)' }}>{s.peLtp != null ? fmtRs(s.peLtp) : '—'}</td>
                          {!optLtpOnly && <td className="cell-muted">{s.expiry ?? '—'}</td>}
                        </tr>
                      ))}
                    {(optData.strikes ?? []).length === 0 && (
                      <tr><td colSpan={5} className="cell-muted" style={{ textAlign: 'center', padding: '12px 8px' }}>No strikes found</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

      </div>{/* end scrollable */}
    </div>
  );
}
