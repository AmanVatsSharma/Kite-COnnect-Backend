/**
 * @file FalconPage.tsx
 * @module admin-dashboard
 * @description Falcon (Kite) operator page — account status, WebSocket provider control,
 *   instrument sync & browser, live market data explorer, and historical candlestick charts.
 * @author BharatERP
 * @created 2026-04-14
 * @updated 2026-04-14
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createChart, ColorType } from 'lightweight-charts';
import { getAdminToken } from '../lib/api-client';
import * as admin from '../lib/admin-api';
import * as falcon from '../lib/falcon-api';
import { ErrorInline } from '../components/ErrorInline';
import { KeyValueGrid } from '../components/KeyValueGrid';
import { MetricCard } from '../components/MetricCard';
import { RawJsonDetails } from '../components/RawJsonDetails';
import { SectionCard } from '../components/section-card';
import { StatusBadge } from '../components/StatusBadge';
import { useRefreshInterval } from '../hooks/useRefreshInterval';
import type { FalconInstrument, FalconCandle } from '../lib/types';

const INTERVALS = ['minute', '3minute', '5minute', '10minute', '15minute', '30minute', '60minute', 'day'] as const;
const EXCHANGES = ['', 'NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'BCD'];
const PAGE_SIZE = 20;

// ─── helpers ────────────────────────────────────────────────────────────────

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

// ─── sub-components ─────────────────────────────────────────────────────────

function CandleChart({ candles }: { candles: FalconCandle[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !candles.length) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth || 700,
      height: 320,
      layout: {
        background: { type: ColorType.Solid, color: '#0d0d0d' },
        textColor: '#cccccc',
      },
      grid: {
        vertLines: { color: '#1e1e1e' },
        horzLines: { color: '#1e1e1e' },
      },
      timeScale: { borderColor: '#333333' },
    });

    const series = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    const chartData = candles.map((c) => ({
      time: String(c[0]).substring(0, 10) as any,
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
    }));

    series.setData(chartData);
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [candles]);

  return <div ref={containerRef} style={{ width: '100%', height: 320 }} />;
}

// ─── main page ──────────────────────────────────────────────────────────────

export function FalconPage() {
  const token = getAdminToken();
  const qc = useQueryClient();
  const { refetchInterval } = useRefreshInterval();

  // ── Section 1: account & connection ──
  const debug = useQuery({
    queryKey: ['admin-debug-falcon'],
    queryFn: admin.getKiteDebug,
    enabled: !!token,
    refetchInterval,
  });
  const profile = useQuery({
    queryKey: ['falcon-profile'],
    queryFn: falcon.getFalconProfile,
    enabled: !!token,
  });
  const margins = useQuery({
    queryKey: ['falcon-margins'],
    queryFn: () => falcon.getFalconMargins(),
    enabled: !!token,
  });

  // ── Section 2: provider & WS stream ──
  const globalProv = useQuery({
    queryKey: ['admin-global-provider'],
    queryFn: admin.getGlobalProvider,
    enabled: !!token,
    refetchInterval,
  });
  const streamStatus = useQuery({
    queryKey: ['admin-stream-status'],
    queryFn: admin.getStreamStatus,
    enabled: !!token,
    refetchInterval,
  });
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

  // ── Section 3: stats & sync ──
  const stats = useQuery({
    queryKey: ['falcon-stats'],
    queryFn: falcon.getFalconStats,
    enabled: !!token,
  });
  const [syncExchange, setSyncExchange] = useState('');
  const [syncResult, setSyncResult] = useState<any>(null);

  const syncMut = useMutation({
    mutationFn: () => falcon.syncFalconInstruments(syncExchange || undefined),
    onSuccess: (data: any) => {
      setSyncResult(data);
      void qc.invalidateQueries({ queryKey: ['falcon-stats'] });
    },
  });

  // ── Section 4: instrument browser ──
  const [instrPage, setInstrPage] = useState(0);
  const [instrExchange, setInstrExchange] = useState('');
  const [instrType, setInstrType] = useState('');
  const [instrSearch, setInstrSearch] = useState('');
  const [instrSearchInput, setInstrSearchInput] = useState('');

  const instruments = useQuery({
    queryKey: ['falcon-instruments', instrPage, instrExchange, instrType, instrSearch],
    queryFn: () =>
      instrSearch
        ? falcon.searchFalconInstruments(instrSearch, 50).then((data) => ({ instruments: Array.isArray(data) ? data : [], total: Array.isArray(data) ? data.length : 0 }))
        : falcon.getFalconInstruments({
            exchange: instrExchange || undefined,
            instrument_type: instrType || undefined,
            limit: PAGE_SIZE,
            offset: instrPage * PAGE_SIZE,
          }),
    enabled: !!token,
  });

  // ── Section 5: market data explorer ──
  const [mdTokens, setMdTokens] = useState('');
  const [mdMode, setMdMode] = useState<'ltp' | 'quote' | 'ohlc'>('ltp');
  const [mdResult, setMdResult] = useState<any>(null);
  const [mdError, setMdError] = useState<string | null>(null);
  const [mdLoading, setMdLoading] = useState(false);

  const fetchMd = async () => {
    const tokens = parseTokens(mdTokens);
    if (!tokens.length) return;
    setMdError(null);
    setMdLoading(true);
    try {
      let result: any;
      if (mdMode === 'ltp') result = await falcon.getFalconLTP(tokens);
      else if (mdMode === 'quote') result = await falcon.getFalconQuote(tokens);
      else result = await falcon.getFalconOHLC(tokens);
      setMdResult(result);
    } catch (e: any) {
      setMdError(e?.message || 'Request failed');
    } finally {
      setMdLoading(false);
    }
  };

  // ── Section 6: historical data ──
  const [histToken, setHistToken] = useState('');
  const [histFrom, setHistFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
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
    setHistError(null);
    setHistLoading(true);
    setHistCandles(null);
    try {
      const result = await falcon.getFalconHistorical(histToken.trim(), histFrom, histTo, histInterval, histContinuous, histOi);
      const candles = (result as any)?.candles ?? result;
      setHistCandles(Array.isArray(candles) ? candles : []);
    } catch (e: any) {
      setHistError(e?.message || 'Request failed');
    } finally {
      setHistLoading(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────

  if (!token) {
    return (
      <section className="card">
        <p className="err">Add an admin token in Settings.</p>
      </section>
    );
  }

  const debugData = debug.data as any;
  const isConnected = debugData?.connected === true;
  const isDegraded = debugData?.degraded === true;
  const connVariant = isDegraded ? 'bad' : isConnected ? 'ok' : 'warn';
  const connLabel = isDegraded ? 'Degraded' : isConnected ? 'Connected' : 'Disconnected';

  const profileData = profile.data as any;
  const marginsData = margins.data as any;
  const equityNet = marginsData?.equity?.net ?? marginsData?.net;
  const commodityNet = marginsData?.commodity?.net;

  const currentProvider = (globalProv.data as any)?.provider;
  const isStreaming = (streamStatus.data as any)?.isStreaming;

  const statsData = stats.data as any;

  return (
    <>
      {/* ── 1. Account & Connection ── */}
      <SectionCard title="Account & Connection">
        <ErrorInline message={debug.isError ? (debug.error as Error).message : null} />
        <div className="metric-grid">
          <MetricCard label="Kite Status" value={<StatusBadge variant={connVariant}>{connLabel}</StatusBadge>} />
          <MetricCard label="HTTP Client" value={<StatusBadge variant={debugData?.httpClientReady ? 'ok' : 'bad'}>{debugData?.httpClientReady ? 'Ready' : 'Not Ready'}</StatusBadge>} />
          <MetricCard label="Equity Margin" value={fmtRs(equityNet)} hint="net available" />
          <MetricCard label="Commodity Margin" value={fmtRs(commodityNet)} hint="net available" />
        </div>
        {profileData && (
          <KeyValueGrid rows={[
            { label: 'User', value: `${profileData.user_name} (${profileData.user_id})` },
            { label: 'Email', value: profileData.email },
            { label: 'Broker', value: profileData.broker },
            { label: 'Exchanges', value: (profileData.exchanges || []).join(', ') || '—' },
            { label: 'Products', value: (profileData.products || []).join(', ') || '—' },
          ]} />
        )}
        {debugData && (
          <KeyValueGrid rows={[
            { label: 'API Key', value: debugData.maskedApiKey || '—' },
            { label: 'Access Token', value: debugData.maskedAccessToken || '—' },
            { label: 'Reconnect Attempts', value: String(debugData.reconnectAttempts ?? '—') },
          ]} />
        )}
        <ErrorInline message={profile.isError ? (profile.error as Error).message : null} />
        <ErrorInline message={margins.isError ? (margins.error as Error).message : null} />
      </SectionCard>

      {/* ── 2. Provider & WebSocket Stream ── */}
      <SectionCard title="Provider & WebSocket Stream">
        <div className="metric-grid">
          <MetricCard
            label="Active Provider"
            value={<StatusBadge variant={currentProvider === 'kite' ? 'ok' : 'neutral'}>{currentProvider || 'not set'}</StatusBadge>}
          />
          <MetricCard
            label="Stream"
            value={<StatusBadge variant={isStreaming ? 'ok' : 'neutral'}>{isStreaming ? 'Streaming' : 'Stopped'}</StatusBadge>}
          />
        </div>
        <p className="muted" style={{ marginBottom: 8 }}>
          Kite WS: single connection per access token · modes: ltp / quote / full
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setProvMut.mutate()} disabled={setProvMut.isPending}>
            {setProvMut.isPending ? 'Activating…' : 'Activate Falcon (Kite)'}
          </button>
          <button onClick={() => startMut.mutate()} disabled={startMut.isPending}>
            {startMut.isPending ? 'Starting…' : 'Start Stream'}
          </button>
          <button onClick={() => stopMut.mutate()} disabled={stopMut.isPending}>
            {stopMut.isPending ? 'Stopping…' : 'Stop Stream'}
          </button>
        </div>
        <ErrorInline message={setProvMut.isError ? (setProvMut.error as Error).message : null} />
        <ErrorInline message={startMut.isError ? (startMut.error as Error).message : null} />
        <ErrorInline message={stopMut.isError ? (stopMut.error as Error).message : null} />
      </SectionCard>

      {/* ── 3. Instrument Stats & Sync ── */}
      <SectionCard title="Instrument Stats & Sync">
        {statsData && (
          <div className="metric-grid">
            <MetricCard label="Total" value={statsData.total?.toLocaleString() ?? '—'} />
            <MetricCard label="Active" value={statsData.active?.toLocaleString() ?? '—'} />
            <MetricCard label="Inactive" value={statsData.inactive?.toLocaleString() ?? '—'} />
            {statsData.by_exchange && Object.entries(statsData.by_exchange as Record<string, number>).map(([ex, count]) => (
              <MetricCard key={ex} label={ex} value={count.toLocaleString()} />
            ))}
          </div>
        )}
        <ErrorInline message={stats.isError ? (stats.error as Error).message : null} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          <select value={syncExchange} onChange={(e) => setSyncExchange(e.target.value)} style={{ minWidth: 100 }}>
            {EXCHANGES.map((ex) => <option key={ex} value={ex}>{ex || 'ALL'}</option>)}
          </select>
          <button onClick={() => syncMut.mutate()} disabled={syncMut.isPending}>
            {syncMut.isPending ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>
        <ErrorInline message={syncMut.isError ? (syncMut.error as Error).message : null} />
        {syncResult && (
          <p style={{ marginTop: 8 }}>
            Synced: {syncResult.synced ?? '—'} · Updated: {syncResult.updated ?? '—'}
            {syncResult.reconciled != null ? ` · Reconciled: ${syncResult.reconciled}` : ''}
          </p>
        )}
      </SectionCard>

      {/* ── 4. Instrument Browser ── */}
      <SectionCard title="Instrument Browser">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <input
            placeholder="Search (e.g. SBIN, NIFTY)"
            value={instrSearchInput}
            onChange={(e) => setInstrSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setInstrSearch(instrSearchInput); setInstrPage(0); } }}
            style={{ minWidth: 180 }}
          />
          <button onClick={() => { setInstrSearch(instrSearchInput); setInstrPage(0); }}>Search</button>
          <button onClick={() => { setInstrSearch(''); setInstrSearchInput(''); setInstrPage(0); }}>Clear</button>
          <select value={instrExchange} onChange={(e) => { setInstrExchange(e.target.value); setInstrPage(0); }}>
            {EXCHANGES.map((ex) => <option key={ex} value={ex}>{ex || 'All Exchanges'}</option>)}
          </select>
          <select value={instrType} onChange={(e) => { setInstrType(e.target.value); setInstrPage(0); }}>
            {['', 'EQ', 'FUT', 'CE', 'PE'].map((t) => <option key={t} value={t}>{t || 'All Types'}</option>)}
          </select>
        </div>
        <ErrorInline message={instruments.isError ? (instruments.error as Error).message : null} />
        {instruments.data && (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    {['Token', 'Symbol', 'Exchange', 'Type', 'Expiry', 'Strike', 'Lot', 'Tick', 'Active'].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #333' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(instruments.data.instruments || []).map((i: FalconInstrument) => (
                    <tr key={i.instrument_token}>
                      <td style={{ padding: '3px 8px', fontFamily: 'monospace' }}>{i.instrument_token}</td>
                      <td style={{ padding: '3px 8px' }}>{i.tradingsymbol}</td>
                      <td style={{ padding: '3px 8px' }}>{i.exchange}</td>
                      <td style={{ padding: '3px 8px' }}>{i.instrument_type}</td>
                      <td style={{ padding: '3px 8px' }}>{i.expiry || '—'}</td>
                      <td style={{ padding: '3px 8px' }}>{i.strike ? fmt(i.strike) : '—'}</td>
                      <td style={{ padding: '3px 8px' }}>{i.lot_size}</td>
                      <td style={{ padding: '3px 8px' }}>{i.tick_size}</td>
                      <td style={{ padding: '3px 8px' }}>
                        <StatusBadge variant={i.is_active ? 'ok' : 'neutral'}>{i.is_active ? 'Y' : 'N'}</StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!instrSearch && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <button disabled={instrPage === 0} onClick={() => setInstrPage((p) => p - 1)}>← Prev</button>
                <span style={{ fontSize: 12 }}>
                  {instrPage * PAGE_SIZE + 1}–{Math.min((instrPage + 1) * PAGE_SIZE, instruments.data.total ?? 0)} of {instruments.data.total?.toLocaleString()}
                </span>
                <button
                  disabled={(instrPage + 1) * PAGE_SIZE >= (instruments.data.total ?? 0)}
                  onClick={() => setInstrPage((p) => p + 1)}
                >Next →</button>
              </div>
            )}
          </>
        )}
      </SectionCard>

      {/* ── 5. Market Data Explorer ── */}
      <SectionCard title="Market Data Explorer">
        <p className="muted" style={{ marginBottom: 8 }}>Enter instrument tokens (comma-separated). e.g. 256265, 738561</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <input
            placeholder="256265, 738561"
            value={mdTokens}
            onChange={(e) => setMdTokens(e.target.value)}
            style={{ minWidth: 240 }}
          />
          {(['ltp', 'quote', 'ohlc'] as const).map((m) => (
            <button
              key={m}
              style={{ fontWeight: mdMode === m ? 'bold' : undefined }}
              onClick={() => { setMdMode(m); setMdResult(null); }}
            >
              {m.toUpperCase()}
            </button>
          ))}
          <button onClick={fetchMd} disabled={mdLoading}>
            {mdLoading ? 'Fetching…' : 'Fetch'}
          </button>
        </div>
        <ErrorInline message={mdError} />
        {mdResult && <RawJsonDetails value={mdResult} summary={`${mdMode.toUpperCase()} result (raw JSON)`} />}
      </SectionCard>

      {/* ── 6. Historical Data ── */}
      <SectionCard title="Historical Candles">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <input
            placeholder="Token (e.g. 256265)"
            value={histToken}
            onChange={(e) => setHistToken(e.target.value)}
            style={{ minWidth: 140 }}
          />
          <input type="date" value={histFrom} onChange={(e) => setHistFrom(e.target.value)} />
          <input type="date" value={histTo} onChange={(e) => setHistTo(e.target.value)} />
          <select value={histInterval} onChange={(e) => setHistInterval(e.target.value)}>
            {INTERVALS.map((iv) => <option key={iv} value={iv}>{iv}</option>)}
          </select>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={histContinuous} onChange={(e) => setHistContinuous(e.target.checked)} />
            continuous
          </label>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={histOi} onChange={(e) => setHistOi(e.target.checked)} />
            OI
          </label>
          <button onClick={fetchHistorical} disabled={histLoading}>
            {histLoading ? 'Fetching…' : 'Fetch'}
          </button>
        </div>
        <ErrorInline message={histError} />
        {histCandles && histCandles.length > 0 && (
          <>
            <CandleChart candles={histCandles} />
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12 }}>Raw candles ({histCandles.length})</summary>
              <div style={{ overflowX: 'auto', marginTop: 6 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr>
                      {['Date', 'Open', 'High', 'Low', 'Close', 'Volume', histOi ? 'OI' : null].filter(Boolean).map((h) => (
                        <th key={h!} style={{ textAlign: 'right', padding: '3px 6px', borderBottom: '1px solid #333' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {histCandles.slice(0, 500).map((c, idx) => (
                      <tr key={idx}>
                        <td style={{ padding: '2px 6px', fontFamily: 'monospace' }}>{String(c[0]).substring(0, 19)}</td>
                        <td style={{ padding: '2px 6px', textAlign: 'right' }}>{fmt(c[1])}</td>
                        <td style={{ padding: '2px 6px', textAlign: 'right', color: '#26a69a' }}>{fmt(c[2])}</td>
                        <td style={{ padding: '2px 6px', textAlign: 'right', color: '#ef5350' }}>{fmt(c[3])}</td>
                        <td style={{ padding: '2px 6px', textAlign: 'right' }}>{fmt(c[4])}</td>
                        <td style={{ padding: '2px 6px', textAlign: 'right' }}>{c[5]?.toLocaleString()}</td>
                        {histOi && <td style={{ padding: '2px 6px', textAlign: 'right' }}>{c[6]?.toLocaleString() ?? '—'}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
        {histCandles && histCandles.length === 0 && <p className="muted">No candle data returned.</p>}
      </SectionCard>

      {/* ── 7. Debug / Raw Status ── */}
      <SectionCard title="Debug" collapsible defaultOpen={false}>
        <ErrorInline message={debug.isError ? (debug.error as Error).message : null} />
        {debug.data && (
          <RawJsonDetails value={debug.data} summary="Kite provider debug (raw JSON)" />
        )}
      </SectionCard>
    </>
  );
}
