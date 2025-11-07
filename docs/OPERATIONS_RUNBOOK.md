# Operations Runbook

## Startup
- Ensure DB env set; prod: DB_MIGRATIONS_RUN=true, DB_SYNCHRONIZE=false
- Optional: SENTRY_DSN, OTEL_ENABLED=true
- Start app, verify `/api/health` and `/api/docs`

## Vayu provider
- Check `/api/stock/vayu/health` for HTTP reachability and status
- If auth expired, refresh token per Vortex guide; restart streaming via admin endpoint

## Streaming health
- Listen `stream_status` Socket.IO event (connected/disconnected/error)
- Check `/api/health/metrics` for `provider_queue_depth` and request latencies

## Instrument maintenance
- Dry run: `POST /api/stock/vayu/validate-instruments` (filters as needed)
- Deactivate: rerun with `{ auto_cleanup: true, dry_run: false }`
- Export CSV: `POST /api/stock/vayu/validate-instruments/export`
- Delete inactive: `DELETE /api/stock/vayu/instruments/inactive`

## Rate limits
- REST: global interceptor using Redis — RATE_LIMIT_* envs
- WS: per-event limits via ApiKeyService helpers

## Troubleshooting
- Quotes missing LTP → check exchange mapping, `debug/resolve` and `debug/build-q`
- High latency → inspect metrics, Redis, DB load; reduce batch sizes
- WS stuck → observe `stream_status`; restart stream via admin endpoint

## Load test
- REST LTP k6: `k6 run load/rest-ltp.k6.js`
- WS Artillery: `artillery run load/ws-subscribe.artillery.yml`

