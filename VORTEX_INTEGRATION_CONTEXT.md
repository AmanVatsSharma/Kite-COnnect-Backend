# Vortex Integration Context and Design

Purpose: Enable pluggable market data providers so the app can fetch from either Kite Connect or Vortex, with minimal code churn and clean boundaries.

## Current Architecture Summary
- Provider today: Kite Connect.
- Layers:
  - REST: `StockController` → `StockService` → `RequestBatchingService`/`KiteConnectService`
  - WS: `MarketDataGateway` ↔ `MarketDataStreamService` ↔ `KiteTicker`
  - Persistence: Postgres entities (instruments, market_data, subscriptions), Redis cache
- Data types used: instruments list, quotes, LTP, OHLC, historical, and live ticks.

## Target Design: Pluggable Provider Interface
Create a provider abstraction that both Kite and Vortex implement.

```ts
export interface MarketDataProvider {
  initialize(): Promise<void>;
  getInstruments(exchange?: string): Promise<any[]>;
  getQuote(tokens: string[]): Promise<Record<string, any>>;
  getLTP(tokens: string[]): Promise<Record<string, any>>;
  getOHLC(tokens: string[]): Promise<Record<string, any>>;
  getHistoricalData(token: number, from: string, to: string, interval: string): Promise<any>;

  // Streaming
  initializeTicker(): any; // returns ticker-like instance
  getTicker(): any;
}
```

- `KiteProvider` refactors `KiteConnectService` to implement the interface.
- `VortexProvider` implements the same using Vortex SDK/HTTP/websocket.
- `MarketDataProviderResolver` selects provider based on:
  - Env `DATA_PROVIDER=kite|vortex` (simple global), or
  - Per-API-key setting (column `provider` in `api_keys`), or
  - Header `x-provider` override (optional for testing).

## Changes Needed by Area
- Request Batching: inject `MarketDataProvider` instead of directly using Kite.
- StockService: keep unchanged; it calls batching/historical through provider.
- MarketDataStreamService: call `provider.initializeTicker()` and subscribe/unsubscribe using provider ticker (normalized API: `subscribe`, `unsubscribe`, `setMode`, `on('ticks')`).
- MarketDataGateway: unchanged (already routes to service), except (optional) allow `x-provider` to route per-connection.

## Token Mapping and Normalization
- If Vortex uses different instrument identifiers:
  - Add `instrument_mappings` table: `{ provider: 'kite'|'vortex', provider_token: string, instrument_token: number }`.
  - During instrument sync, populate mapping for Vortex.
  - Normalization helpers map incoming provider tokens to internal `instrument_token`.
- Live ticks normalization shape:
  - Normalize to `{ instrument_token, last_price, ohlc: { open, high, low, close }, volume, timestamp }`.

## Configuration & Secrets
- Add Vortex envs: `VORTEX_API_KEY`, `VORTEX_SECRET`, and stream URL.
- Add `DATA_PROVIDER` (global) default `kite`.
- Optional per-API-key `provider` default null (inherit global).

## Swagger & Dashboard
- Swagger: document optional `x-provider` header for testing; default uses key-config/global.
- Dashboard: add a provider dropdown (optional) that sets `x-provider` header for REST and uses WS query `provider`.

## Incremental Rollout Plan
1. Extract `MarketDataProvider` interface and refactor `KiteConnectService` → `KiteProvider` implementing it.
2. Create resolver service that returns active provider per request/connection.
3. Update `RequestBatchingService` and `MarketDataStreamService` to use the provider abstraction.
4. Implement `VortexProvider` skeleton with stubs; wire configs.
5. Add token mapping table if necessary.
6. E2E test with feature flag `DATA_PROVIDER=vortex` in staging.

## Effort Estimate
- Provider abstraction + refactor Kite: ~6–8 hours.
- Vortex provider implementation (REST + WS) once SDK/docs are provided: ~1–2 days.
- Token mapping + normalization if needed: +0.5–1.5 days.
- Per-API-key provider selection: +0.5 day.

## Risks/Notes
- Rate limits and throttling differ: tune batching window and chunk sizes per provider.
- WS semantics may differ: reconnection/backoff and subscription model must be aligned.
- Data field alignment (OHLC arrays vs objects) needs careful normalization.

## Auto-Setup Flow (Implemented)

After successful Vortex login callback, the system automatically:

1. **Sets Global Provider**: `providerResolver.setGlobalProviderName('vortex')`
2. **Starts Streaming**: `streamService.startStreaming()` 
3. **Connects WebSocket**: Initializes VortexTicker and connects to `wss://wire.rupeezy.in/ws`
4. **Updates Token**: Provider uses the new access token for all API calls

### Complete Flow Diagram

```
User Login → OAuth Callback → Auto-Setup → WebSocket Ready
     ↓              ↓              ↓              ↓
GET /auth/vortex/login → User Auth → POST /auth/vortex/callback → Auto Provider Setup
     ↓              ↓              ↓              ↓
Returns URL → Rupeezy Login → Token Exchange → Global Provider = 'vortex'
     ↓              ↓              ↓              ↓
User visits → User authorizes → Session saved → Streaming started
     ↓              ↓              ↓              ↓
Redirect to → Auth param → DB + Redis → WebSocket connected
callback URL → extracted → cache → Ready for subscriptions
```

### Manual Control (Admin APIs)

```bash
# Set global provider manually
POST /api/admin/provider/global { "provider": "vortex" }

# Start/stop streaming manually  
POST /api/admin/provider/stream/start
POST /api/admin/provider/stream/stop

# Check status
GET /api/admin/stream/status
GET /api/admin/debug/vortex
```

---

## Implementation Status (Updated)

### ✅ Completed Features
- **Provider Interface**: Created at `src/providers/market-data.provider.ts`
- **Kite Provider**: Implements interface; existing behavior preserved
- **Vortex Provider**: Complete implementation with WebSocket streaming
- **Auto-Setup**: Callback automatically sets provider and starts streaming
- **Exchange Fallback**: NSE_EQ fallback when instruments not synced
- **WebSocket URL Fallback**: Hardcoded fallback to `wss://wire.rupeezy.in/ws`
- **Comprehensive Logging**: Detailed logs throughout the flow
- **Resolver Service**: Selects provider for HTTP/WS with priority order
- **Request Batching**: Batches multiple requests to single API calls
- **Subscription Batching**: Batches WebSocket subscriptions every 500ms
- **Binary Parser**: Parses Vortex binary tick format (22/62/266 bytes)
- **Admin Endpoints**: Provider control and debug information
- **Documentation**: Complete setup guide and troubleshooting

### 🔧 Key Implementation Details

1. **VortexTicker Class**: 
   - WebSocket connection with auto-reconnect
   - Binary tick parsing per Vortex spec
   - Subscription management with exchange mapping
   - Heartbeat and error handling

2. **Exchange Mapping**:
   - Database lookup for instrument → exchange mapping
   - NSE_EQ fallback for unmapped tokens
   - Support for NSE_EQ, NSE_FO, NSE_CUR, MCX_FO

3. **Auto-Setup Logic**:
   - Callback sets global provider to 'vortex'
   - Automatically starts streaming if not active
   - Reconnects existing stream with new token

4. **Error Handling**:
   - Graceful degradation when credentials missing
   - Comprehensive logging for debugging
   - Fallback mechanisms throughout

### 📋 Testing Checklist

1. **Login Flow**: `/auth/vortex/login` → OAuth → callback success
2. **Auto-Setup**: Verify provider set and streaming started
3. **WebSocket**: Connect to `/market-data` namespace
4. **Subscription**: Subscribe to token 26000 (Nifty 50)
5. **Ticks**: Verify binary ticks received and parsed
6. **Broadcast**: Verify ticks broadcasted to clients

### 📚 Documentation

- **Setup Guide**: `src/providers/VORTEX_SETUP_GUIDE.md`
- **API Usage**: `Vortex_api_usage.md` 
- **WebSocket Spec**: `vortex_live.md`
- **Integration Context**: This file (updated)
