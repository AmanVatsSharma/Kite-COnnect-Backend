# Validation & Cleanup Flow

- Entry: `POST /api/stock/vayu/validate-instruments`
- Filters: `exchange`, `instrument_name`, `symbol`, `option_type`
- Modes: dry-run (default), auto_cleanup (deactivate)

Flow:
1) Fetch instruments per filters (batch_size up to 1000)
2) Build pairs, call `getLTPByPairs` in chunks
3) Classify: valid LTP vs invalid (`last_price=null`)
4) If auto_cleanup & !dry_run: deactivate invalid tokens in batches of 10k
5) Export: `POST /api/stock/vayu/validate-instruments/export` → CSV
6) Delete: `DELETE /api/stock/vayu/instruments/inactive`

Notes
- Exchange normalization enforced; no NSE_EQ fallback
- Swagger defaults to statistics to avoid huge payloads (use include_invalid_list=true)

