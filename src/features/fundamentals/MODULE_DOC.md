# Fundamentals Module

## Overview

Fetches and caches stock fundamental data from Yahoo Finance public endpoints. No API key required. Data is cached in Postgres (`fundamentals_cache` table) with a configurable TTL (default 24 hours). Redis is used for short-term in-memory caching (5 minutes).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stock/:symbol/fundamentals?exchange=NSE` | Get fundamentals for a symbol |
| GET | `/api/stock/fundamentals/batch?symbols=NIFTY,RELIANCE&exchange=NSE` | Batch get (max 5 symbols) |
| POST | `/api/stock/:symbol/fundamentals/refresh?exchange=NSE` | Force refresh cache |
| GET | `/api/stock/fundamentals/stats` | Cache statistics |
| DELETE | `/api/stock/fundamentals/cache?symbol=NIFTY&exchange=NSE` | Clear cache entry or all |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FUNDAMENTALS_CACHE_TTL_HOURS` | `24` | Cache TTL in hours |
| `YFINANCE_FALLBACK_ENABLED` | `true` | Enable Yahoo Finance fallback |

## Yahoo Finance Endpoints Used

- Chart: `GET https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}.NS?interval=1d&range=5d`
- Quote Summary: `GET https://query2.finance.yahoo.com/v10/finance/quoteSummary/{SYMBOL}.NS?modules=financialData,defaultKeyStatistics,assetProfile,summaryDetail,incomeStatementHistory,balanceSheetHistory`

## Database Schema

Table: `fundamentals_cache`

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PRIMARY KEY | Auto |
| symbol | VARCHAR(32) | Uppercase symbol |
| exchange | VARCHAR(16) | e.g. NSE, BSE |
| fetchedAt | TIMESTAMPTZ | When data was fetched |
| nextFetchAt | TIMESTAMPTZ | When cache expires |
| data | JSONB | Full mapped fundamentals |
| priceData | JSONB | Chart endpoint price data |
| stale | BOOLEAN | True if served stale |
| created_at | TIMESTAMP | TypeORM CreateDateColumn |
| updated_at | TIMESTAMP | TypeORM UpdateDateColumn |

Unique constraint: `(symbol, exchange)`

## Rate Limiting

- 500ms delay between Yahoo Finance requests to avoid 429 errors
- Max 5 symbols per batch request
- 15s HTTP timeout per request

## Changelog

- **2026-05-24**: Initial implementation — Yahoo Finance free endpoints, Postgres cache, Redis short-term cache, batch support (max 5 symbols)