# Design: Natural-language MeiliSearch upgrades for `/api/search`

**Date:** 2026-06-23
**Author:** BharatERP (with Claude)
**Status:** Approved (pending user sign-off on written spec)
**Approach:** B — indexer enrichment + parser extension + search-api wiring + ranking tune

## 1. Context and problem statement

The client reports three search failures on `/api/search`:

1. Cannot find options like `nifty 24000` with their expiry dates.
2. Cannot reliably find stocks (e.g. `reliance`, `m&m`).
3. Cannot search using natural-language expiry phrases (`monthly expiry`, `next week expiry`, `this thursday`).

### Root cause

`apps/search-api` is a thin pass-through to MeiliSearch. It does not call the existing `FnoQueryParserService` (which already understands `nifty 26000 ce` and `banknifty 28mar25 45000 pe`), and the MeiliSearch index has no derived fields for `isMonthly`/`isWeekly`/`expiryWeek`/etc. so the server cannot filter on those concepts even if it tried.

### Latent bug surfaced during exploration

`search.controller.ts:397, 522` calls `this.searchService.fetchPrimaryUir(q)` but the method is not defined in `search.service.ts`. Any `ltp_only` query that misses live ticks throws `TypeError: this.searchService.fetchPrimaryUir is not a function`. The fix is included in this design as a bonus (additive, never called by clients that do not use `ltp_only`).

## 2. Goals

1. `/api/search?q=nifty 24000` returns NIFTY options near strike 24000 across all expiries, grouped by expiry.
2. `/api/search?q=monthly nifty` / `?q=next week expiry nifty` / `?q=this thursday nifty` return only matching expiries, grouped by expiry.
3. `/api/search?q=reliance` returns `NSE:RELIANCE` (and `BSE:RELIANCE`) with high rank. `/api/search?q=RELIANCE INDUSTRIES` returns the same row via name search. `M&M` and `M AND M` both find the same row.
4. Existing query params (`?exchange=`, `?instrumentType=CE`, `?strike_min=`, `?expiry_from=`, etc.) **continue to work unchanged** — additive only.
5. The `/api/search/suggest` (typeahead) endpoint gets the same upgrades.
6. The `/api/search/filters` facets endpoint surfaces the new derived fields.

## 3. Non-goals

- No new public endpoint paths (no `/v2`).
- No breaking changes to existing response shape.
- No migration of legacy `instruments` table.
- No change to LTP hydration logic.
- No removal of any existing field, parameter, parser output, or response key.

## 4. Constraints

- All indexer changes are additive fields. Existing `searchableAttributes`/`filterableAttributes` arrays are **extended**, not replaced.
- All parser changes extend existing outputs. `parse()` returns the same shape plus new optional fields.
- Reindex uses the existing `INDEXER_MODE=backfill-and-watch` (already the default in `docker-compose.yml`).
- `madge` cycle check must still pass.

## 5. Architecture

```
Client → /api/search?q=...
   │
   ▼
apps/search-api
   SearchController.search(q, ...)
     │  • SearchQueryDto (class-validator)  ← new
     ▼
   FnoQueryParserService.parse(q)  ← extended
     outputs ParsedQuery {
       underlying?, strike?, optionType?,
       expiryFrom?, expiryTo?,
       isMonthly?, isWeekly?,
       rawTokens[]
     }
     │
     ▼
   SearchService.searchInstruments(parsed)  ← extended
     merges parsed filters INTO existing buildFilter() (additive)
     calls MeiliSearch
     │
     ▼
   buildResponseRow()  ← unchanged shape, plus optional:
     { hits, parsed, expiryGroups, facets }
     │
     ▼
apps/search-indexer (separate Docker container)
   toDoc()  ← extended:
     +isMonthly, +isWeekly, +expiryWeek, +expiryMonth,
     +expiryYear, +monthlyExpiryDate, +tokenKeywords
   applySettings()  ← extended (additive to arrays only)
   backfill()  ← unchanged; runs on next deploy
```

## 6. Component changes

| Component | Type | Action | Why |
|---|---|---|---|
| `SearchQueryDto` | new class | Add | Replaces bare `@Query()` with `class-validator`. |
| `FnoQueryParserService` | edit | Extend | Add NL expiry tokenization + `26k`/`26.5k` strike variants. Reuse, don't replace. |
| `ParsedQuery` interface | new | Add | Output shape; consumed by `SearchService`. Optional fields preserve backward compat. |
| `SearchService` | edit | Extend | Accept `ParsedQuery`; merge into `buildFilter()`. |
| `indexer toDoc()` | edit | Extend | Add 6 new fields per doc. Pure additive. |
| `indexer applySettings()` | edit | Extend | Add new fields to filterable + searchable arrays only. |
| `fetchPrimaryUir` | new method | Add | Closes the latent `TypeError` surfaced during exploration. |
| `fno-query-parser.spec.ts` | edit | Extend | New test cases for NL expiry + `26k` + `m&m`. |
| `search-api.service.spec.ts` | new | Add | First-ever test coverage for search-api. |
| `indexer-to-doc.spec.ts` | new | Add | Verify `isMonthly`/`isWeekly`/`monthlyExpiryDate`. |
| `MODULE_DOC.md` (×2) | edit | Update | Document new fields, new params, the parser wiring. |

## 7. Parser rules

### Input → output examples

| Query | `underlying` | `strike` | `optionType` | `expiryFrom` | `expiryTo` | `isMonthly` | `isWeekly` |
|---|---|---|---|---|---|---|---|
| `nifty` | `NIFTY` | – | – | – | – | – | – |
| `nifty 24000 ce` | `NIFTY` | `24000` | `CE` | – | – | – | – |
| `nifty 26k ce` | `NIFTY` | `26000` | `CE` | – | – | – | – |
| `nifty 24000 ce 28mar2025` | `NIFTY` | `24000` | `CE` | `2025-03-28` | `2025-03-28` | – | – |
| `nifty monthly` | `NIFTY` | – | – | – | – | `true` | – |
| `nifty monthly expiry` | `NIFTY` | – | – | – | – | `true` | – |
| `nifty weekly` | `NIFTY` | – | – | – | – | – | `true` |
| `nifty next week expiry` | `NIFTY` | – | – | `today+1` | `today+7` | – | – |
| `nifty this thursday` | `NIFTY` | – | – | (next Thu) | (next Thu) | – | – |
| `nifty 24000 ce monthly` | `NIFTY` | `24000` | `CE` | – | – | `true` | – |
| `reliance industries` | `RELIANCE` | – | – | – | – | – | – |
| `m&m` | `MM` (alias) | – | – | – | – | – | – |

### NL expiry rules (priority order)

1. `monthly`, `monthly expiry`, `month end` → `isMonthly=true`.
2. `weekly`, `weekly expiry` → `isWeekly=true`.
3. `this thursday`, `next thursday`, `<weekday>` → `expiryFrom = expiryTo = <date>`. Past → next week.
4. `next week`, `next week expiry` → `expiryFrom = tomorrow`, `expiryTo = +7 days`.
5. `this month`, `next month`, `this month expiry`, `next month expiry` → calendar-month range.
6. `nearest expiry`, `current expiry` → `expiryFrom = today`, sort by `expiryTs:asc`.

### Underlying extraction rules

- Strip F&O suffix: `NIFTY24JAN22000CE` → `NIFTY`.
- `M&M`, `M AND M`, `M & M` → `MM`.
- `BAJAJ-AUTO` → `BAJAJAUTO` and `BAJAJ AUTO`.
- BSE-vs-NSE disambiguation: by default emit `M&M` once with no exchange filter.

### Strike extraction rules

- `26k` → `26000`. `26.5k` → `26500`. `26.5 K` → `26500`. `26,000` → `26000`. `26000.50` → `26000.50`.

### Failure semantics

- If parser cannot extract anything (e.g. `q=hello world`), it returns `{ rawTokens: ['hello', 'world'] }`. Search proceeds with current free-text path.
- If parser extracts `underlying=NIFTY` but no strike/optionType/expiry, it adds the underlying as a high-priority token for Meili and adds an `instrumentType ∈ {FUT, CE, PE}` filter only when the user is clearly asking for an option (presence of `ce`/`pe`/`fut`/`future`/`call`/`put` token).

## 8. Indexer enrichment

### 8a. New indexer fields (added to every doc; null/empty when N/A)

```ts
isMonthly?: boolean;          // last Thursday of calendar month, derivative only
isWeekly?: boolean;           // any Thursday, derivative only
expiryWeek?: number;          // 1-5, week-of-month
expiryMonth?: number;         // 1-12
expiryYear?: number;          // 2025
monthlyExpiryDate?: number;   // Unix seconds at 09:15 UTC; for sort/grouping
tokenKeywords?: string[];     // ['RELIANCE', 'M&M', 'MM', 'M AND M', ...]
exactName?: string;           // already exists; extended with 'M&M' alias forms
searchKeywords?: string[];    // already exists; append tokenKeywords
```

### 8b. Indexer settings (additive only)

```ts
// Each list is extended; no entry is removed.
searchableAttributes: [...existing, 'tokenKeywords'],
filterableAttributes: [...existing, 'isMonthly', 'isWeekly',
                        'expiryWeek', 'expiryMonth', 'expiryYear',
                        'monthlyExpiryDate'],
sortableAttributes: [...existing, 'monthlyExpiryDate'],
```

## 9. Search-service filter merging (additive)

```ts
// buildFilter() is extended — never replaced.
if (parsed.isMonthly === true)   filterParts.push('isMonthly = true');
if (parsed.isWeekly === true)    filterParts.push('isWeekly = true');
if (parsed.expiryFrom)           filterParts.push(`expiry >= '${parsed.expiryFrom}'`);
if (parsed.expiryTo)             filterParts.push(`expiry <= '${parsed.expiryTo}'`);
```

If the user also passed `?expiry_from=...` directly, the parsed-from and the explicit-from are **unioned (looser wins)** so a query that was already working can never become empty.

## 10. Response shape (additive, opt-in)

```jsonc
{
  "hits": [...],                  // unchanged
  "parsed": {                      // NEW: structured parser output (omitted if parser was a no-op)
    "underlying": "NIFTY",
    "strike": 24000,
    "optionType": "CE",
    "isMonthly": false,
    "rawTokens": ["nifty", "24000", "ce"]
  },
  "expiryGroups": [                // NEW: when isMonthly/isWeekly/expiryFrom was set
    { "expiry": "2025-06-26", "isMonthly": true,  "isWeekly": true,  "count": 86 },
    { "expiry": "2025-07-03", "isMonthly": false, "isWeekly": true,  "count": 86 }
  ],
  "facets": {...}                  // unchanged
}
```

## 11. Error handling

| Scenario | Behavior |
|---|---|
| `q` is empty / whitespace | Empty hits; no parser call |
| Parser throws on garbage input | Catch, log warn, fall through with `rawTokens: [q]` |
| Meili rejects new field | Existing circuit breaker; secondary host fallback |
| Indexer write fails for a new field | Existing chunked-write loop continues; reindex is idempotent |
| `?expiry_from=` conflicts with parsed range | Union (looser wins) |

## 12. Tests

| File | Type | Cases |
|---|---|---|
| `fno-query-parser.spec.ts` (existing, extended) | Unit | All 12 parser examples + 5 NL expiry edge cases |
| `search-api.service.spec.ts` (new) | Unit | Golden file: parser example → expected Meili filter string |
| `fno-query-parser.e2e-spec.ts` (existing) | E2E | NL expiry end-to-end |
| `indexer-to-doc.spec.ts` (new) | Unit | `isMonthly=true` for last-Thursday, `isWeekly=true` for any Thursday, sort field |
| `scripts/debug-search.sh` (extended) | Smoke | `monthly`, `weekly`, `26k`, `m&m` |

## 13. Observability

| Signal | Where |
|---|---|
| `search.api.parse.matched` (counter) | search.service.ts |
| `search.api.parse.miss` (counter) | search.service.ts |
| `search.api.parse.duration_ms` (histogram) | search.service.ts |
| `search.api.meili.circuit_open` (already exists) | unchanged |
| New indexer fields in `/api/search/filters` facets | existing endpoint |

All counters use existing `src/infra/observability/` Prometheus registration — no new deps.

## 14. Rollout (phased — additive throughout)

1. **Phase 1 — parser tests + DTO + wiring (parser disabled in production).** Unit tests prove the wiring. No user-visible change.
2. **Phase 2 — enable parser in search-api** via `FNO_PARSER_ENABLED=true` (default `true`). Existing queries unchanged because parser adds optional filters only.
3. **Phase 3 — indexer enrichment.** `docker-compose.yml` already has `INDEXER_MODE=backfill-and-watch` so reindex happens automatically. Verify via `scripts/check-meili-sync.sh`.
4. **Phase 4 — cleanup.** Drop the `FNO_PARSER_ENABLED` flag once stable.

Each phase is independently revertable. Every phase is **enhance-only** — nothing is removed, renamed, or narrowed.

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `m&m` tokenization breaks existing search | `tokenKeywords` additive; `searchKeywords` unchanged for same row |
| Parser mis-tags `isMonthly=true` for non-F&O rows | Indexer only sets `isMonthly` when `instrumentType ∈ {FUT, CE, PE}` AND underlying ∈ NSE F&O class |
| Reindex slows search briefly | Indexer is a separate Docker container; search continues against the old schema until new docs land |
| `fetchPrimaryUir` latent bug surfaces during testing | Fix included in Phase 1 (additive; never called by clients that don't use `ltp_only`) |
| New dependencies in search-api | Reuse existing `moment` already imported in `fno-query-parser.service.ts`; no new deps |

## 16. Files to be modified or created

### Edit
- `apps/search-api/src/modules/search/search.controller.ts`
- `apps/search-api/src/modules/search/search.service.ts`
- `apps/search-indexer/src/index.ts`
- `src/features/market-data/application/fno-query-parser.service.ts`
- `test/fno-query-parser.e2e-spec.ts`
- `apps/search-api/MODULE_DOC.md`
- `apps/search-indexer/MODULE_DOC.md`

### Create
- `apps/search-api/src/modules/search/dto/search-query.dto.ts`
- `apps/search-api/src/modules/search/fno-query-parser.service.ts` (or extract to `src/shared/fno-query-parser/` per Section 2 note)
- `apps/search-api/src/modules/search/search.service.spec.ts`
- `apps/search-indexer/src/index.spec.ts`

## 17. Acceptance criteria

- `GET /api/search?q=nifty+24000` returns ≥ 1 NIFTY option row with strike within ±200 of 24000.
- `GET /api/search?q=monthly+nifty` returns only NIFTY rows where `isMonthly=true`.
- `GET /api/search?q=next+week+expiry+nifty` returns only NIFTY rows with `expiry` in `[today+1, today+7]`.
- `GET /api/search?q=reliance` returns `NSE:RELIANCE` in the first 3 hits.
- `GET /api/search?q=m%26m` returns `M&M` row(s) in the first 5 hits.
- All existing queries with `?exchange=` / `?instrumentType=` / `?strike_min=` / `?expiry_from=` produce **at least** the same hit set as before (union, never narrow).
- `npm run verify:pr` passes (build + test + check:cycles:warn).
- `scripts/check-meili-sync.sh` reports 100% sync with new fields populated for derivative rows.
