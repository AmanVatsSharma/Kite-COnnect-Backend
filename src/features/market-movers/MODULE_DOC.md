# Market Movers feature

Returns NSE/BSE top gainers, losers, and most active stocks. Powered by Alpha Vantage (free tier) with Yahoo Finance RSS fallback.

## Changelog

- **2026-05-24** — Initial release:
  - `MarketMoversService`: Alpha Vantage `TOP_GAINERS`/`TOP_LOSERS`/`TOP_AGGRESSIVE_CAPITAL_GAINERS` with Redis cache (1-hour TTL), exponential-backoff retry (3 attempts), Yahoo Finance index-context fallback.
  - `MarketMoversCronService`: Hourly cron (`@Cron('5 * * * *')`) pre-warms Redis cache for NSE+BSE × gainers/losers/active on startup and every hour.
  - `MarketMoversController`: `GET /api/market/movers?type=gainers&exchange=NSE` with `Cache-Control: public, max-age=3600` and `X-Cache-Generated-At` header.
  - `MarketMoversModule`: Wired into `AppModule`.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `ALPHA_VANTAGE_API_KEY` | — | Free key from [alphavantage.co](https://www.alphavantage.co/support/#api-key). If absent, falls back to Yahoo Finance (limited data). |
| `MARKET_MOVERS_CRON` | `5 * * * *` | Cron expression for hourly cache warm |
| `MARKET_MOVERS_PREWARM` | `true` | Set `false` to skip on-module-init cache warm |

## Response shape

```json
{
  "success": true,
  "data": {
    "type": "gainers",
    "exchange": "NSE",
    "generatedAt": "2026-05-24T10:05:00.000Z",
    "items": [
      {
        "symbol": "RELIANCE",
        "name": "Reliance Industries",
        "lastPrice": 2800.50,
        "changePercent": 5.2,
        "volume": 15000000,
        "reason": null
      }
    ]
  }
}
```

## Entry points

- HTTP: `src/features/market-movers/interface/market-movers.controller.ts` under `@Controller('market/movers')`
- Service: `src/features/market-movers/application/market-movers.service.ts`

## Limitations

- **Alpha Vantage free tier**: 25 requests/day, 5 requests/minute. For production use, consider upgrading to a premium plan or using a dedicated Indian market data provider (NSE API, Trendlyne, MoneyControl).
- **Yahoo Finance fallback**: Provides index-level data only; detailed per-stock movers are not available without authentication.
- **Production recommendation**: Replace the Alpha Vantage / Yahoo Finance fallbacks with a paid Indian market data provider (e.g., NSE API, Trendlyne API, Bloomberg, Refinitiv) for reliable and comprehensive movers data.