# Search Canary Runbook

This runbook validates the new Meilisearch-backed `/api/search` in production behind Nginx. Use it for initial canary and future smoke checks.

## Preconditions
- Meilisearch `instruments_v1` has documents (`numberOfDocuments > 0`).
- `search-api` healthy on port 3002. Nginx route `/api/search` present in `trading.conf`.

## Quick Health
```bash
# Meili stats
docker compose exec -T search-api sh -lc \
  'curl -sS -H "Authorization: Bearer $MEILI_MASTER_KEY" \
   http://meilisearch:7700/indexes/instruments_v1/stats | jq .'

# Direct and via HTTPS
curl -sS "http://localhost:3002/api/search?q=SBIN&limit=5" | jq .
curl -ksS "https://marketdata.vedpragya.com/api/search?q=SBIN&limit=5" | jq .
```

## LTP Coverage Checks
```bash
# Pair-first hydration then instruments fallback (verify last_price present)
curl -sS "http://localhost:3002/api/search?q=SBIN&limit=10&ltp_only=true" | jq .

# Direct vayu LTP (pairs)
curl -sS -H "x-api-key: $HYDRATION_API_KEY" \
  -H "x-provider: vayu" \
  -X POST http://localhost:3000/api/stock/vayu/ltp \
  -d '{"pairs": [{"exchange":"NSE_EQ","token":"26000"}]}' | jq .

# Direct vayu LTP (instruments fallback)
curl -sS -H "x-api-key: $HYDRATION_API_KEY" \
  -H "x-provider: vayu" \
  -X POST http://localhost:3000/api/stock/vayu/ltp \
  -d '{"instruments": [26000, 738561]}' | jq .
```

## Latency and error spot-check (5 minutes)
```bash
# 100 sample queries locally to search-api (direct)
seq 1 100 | xargs -I{} -P 10 sh -c \
  'curl -s -o /dev/null -w "%{http_code} %{time_total}\n" "http://localhost:3002/api/search?q=SBIN&limit=5"' \
  | awk '{print $1,$2}' | tee /tmp/search_samples.txt

# Error rate
awk '$1 != "200" {err++} END {print "error_rate=" (err+0)/NR}' /tmp/search_samples.txt

# p95 latency (s) on direct path
awk '{print $2}' /tmp/search_samples.txt | sort -n | awk 'BEGIN{p=0.95} {a[NR]=$1} END{idx=int(NR*p); if(idx==0)idx=1; print a[idx]}'
```
Targets: error_rate <= 0.01, p95 <= 0.25s direct. Expect slightly higher via Nginx.

## Logs to watch (10 minutes)
```bash
# App-level errors or timeouts
docker compose logs -f search-api | egrep -i "ERR|HTTP 5|timed out|Meili search failed|circuit"

# Meilisearch index_not_found or auth issues
docker compose logs -f meilisearch | egrep -i "error|index_not_found|unauthorized"
```

## Rate-limit and protection
- Nginx `api_limit` and `ws_limit` zones are active. `/api/search` uses `limit_req zone=api_limit burst=30 nodelay`.
- If needed, lower the burst or rate in `/etc/nginx/sites-available/trading.conf` and `reload`.

## Rollback (disable route)
Comment or remove the `/api/search` location block in `trading.conf`, then reload:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

## Success criteria
- Health and sample queries return 200 with sensible results.
- Error rate ≤ 1%, p95 latency ≤ 250ms (direct) over 100 samples.
- No persistent errors in `search-api` or Meilisearch logs.

## Notes
- Live-quote hydration is best-effort and cached with a short TTL; search results still return quickly even if quotes are briefly delayed.
- For sustained load testing, prefer a dedicated tool (k6, wrk) and observe system metrics.
