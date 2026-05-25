# News feature

Provider-agnostic **Finnhub** news aggregator: fetches, persists, and broadcasts financial news in real-time via WebSocket.

## Changelog

- **2026-05-24** — Initial release:
  - `NewsItem` entity (`news_items` table) with indices on `finnhubId`, `source`, `category`, `publishedAt`; unique constraints on `(source,url)` and `finnhubId`.
  - `NewsService`: `fetchFromFinnhub(category)` with Redis cache (TTL 5 min), retry with exponential backoff; `persistNewsItems()` upserts via `ON CONFLICT (finnhubId)`; `pushToRingBuffer()` + `getLatestFromCache()` via Redis list; `list()` + `getById()` from DB with cache fallback.
  - `NewsSchedulerService`: polls Finnhub across `general`, `forex`, `crypto`, `commodity` every `NEWS_POLL_INTERVAL_MS` (default 5 min); distributed lock via Redis ensures single-instance poll; 1-hour dedup window per finnhubId; broadcasts new items over `NewsGateway`.
  - `NewsGateway` (`/news-ws` namespace): clients auto-join `news-room`; sends `news:initial` (up to 20 cached items) on connect; `broadcastNews()` pushes `news:item` events to all subscribers.
  - `NewsController`: `GET /api/news` (paginated, category + symbol filter), `GET /api/news/categories`, `GET /api/news/:id`.
  - Migration `1748000000000-create-news-items`.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `FINNHUB_API_KEY` | — | Finnhub.io API key (required for polling) |
| `NEWS_POLL_INTERVAL_MS` | `300000` | Poll interval in ms (5 min) |
| `NEWS_CACHE_TTL_SECONDS` | `300` | Redis cache TTL for Finnhub responses |
| `NEWS_POLLING_ENABLED` | `true` | Set `false` to disable scheduler |

## Entry points

- REST: `src/features/news/interface/news.controller.ts` under `@Controller('news')`
- WebSocket: `src/features/news/interface/news.gateway.ts` at namespace `/news-ws`
- Service: `src/features/news/application/news.service.ts`
- Scheduler: `src/features/news/application/news-scheduler.service.ts`