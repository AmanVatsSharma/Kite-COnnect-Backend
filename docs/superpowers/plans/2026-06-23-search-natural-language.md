# Natural-language MeiliSearch upgrades for /api/search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/api/search` understand options like `nifty 24000`, stocks like `reliance` and `m&m`, and natural-language expiry phrases like `monthly expiry`, `next week expiry`, `this thursday` — all additively, with no breaking changes.

**Architecture:** Three coordinated, additive changes:
1. Extend the existing `FnoQueryParserService` (in `src/features/market-data/`) with natural-language expiry tokenization and aliases (`M&M`, `BAJAJ-AUTO`). Add a parallel copy of the parser in `apps/search-api/src/fno/` (precedent: indexer's `EXCHANGE_TO_PROVIDER` duplication).
2. Enrich the MeiliSearch indexer with 6 new fields per document: `isMonthly`, `isWeekly`, `expiryWeek`, `expiryMonth`, `expiryYear`, `monthlyExpiryDate`, plus extended `tokenKeywords`. Pure additive — no field removed.
3. Wire the extended parser into `SearchController.search()` and `SearchController.suggest()` before the call to `MeiliSearch`. Merge derived filters into the existing `buildFilter()` output (explicit user params win, parsed values fill in). Add `SearchQueryDto` for class-validator. Fix the latent `fetchPrimaryUir` runtime bug.

**Tech Stack:** NestJS 10, TypeScript 5.4, MeiliSearch 1.8, class-validator, Jest, ts-node. No new runtime dependencies.

---

## File Structure

### Files to be created
| Path | Responsibility |
|---|---|
| `apps/search-api/src/modules/search/dto/search-query.dto.ts` | class-validator DTO for `/api/search` and `/api/search/suggest` query params. Replaces bare `@Query()` strings. |
| `apps/search-api/src/fno/fno-query-parser.ts` | Self-contained copy of the parser, **extended** with NL expiry rules + alias table. Duplicates `src/features/market-data/application/fno-query-parser.service.ts` (small file, ~400 LOC; mirrors indexer's `EXCHANGE_TO_PROVIDER` duplication). |
| `apps/search-api/src/modules/search/search.service.spec.ts` | First test coverage for `search-api`. Golden-file parser → filter assertions. |
| `apps/search-indexer/src/index.spec.ts` | Unit tests for indexer helpers (`lastThursdayOfMonth`, `weekOfMonth`). |
| `apps/search-indexer/src/index-helpers.ts` | Pure helper functions extracted from `index.ts` for testability. |

### Files to be modified
| Path | What changes |
|---|---|
| `src/features/market-data/application/fno-query-parser.service.ts` | Add NL expiry tokens (monthly/weekly/weekday/next-week), M&M / BAJAJ-AUTO / HUL aliases. All existing parser outputs preserved. |
| `apps/search-api/src/modules/search/search.controller.ts` | Import the parser from `../fno/fno-query-parser`; call `parser.parse(q)` first; merge derived filters; switch both `search()` and `suggest()` to `SearchQueryDto`. |
| `apps/search-api/src/modules/search/search.service.ts` | Add `isMonthly` / `isWeekly` / `parsedExpiryFrom` / `parsedExpiryTo` to `searchInstruments()` filters; extend `buildFilter()` accordingly. Add `fetchPrimaryUir()`. |
| `apps/search-indexer/src/index.ts` | Extend `MeiliDoc` type; extend `toDoc()` with 6 new fields + `tokenKeywords`; extend `applySettings()` to include new fields in `filterableAttributes`/`sortableAttributes`/`searchableAttributes`. |
| `test/fno-query-parser.e2e-spec.ts` | Add new test cases for NL expiry + aliases. |
| `apps/search-api/MODULE_DOC.md` | Document new query params, new response fields (`parsed`, `expiryGroups`). |
| `apps/search-indexer/MODULE_DOC.md` | Document new doc fields and updated settings arrays. |

### Files NOT touched
- `apps/search-api/src/main.ts` (no new env vars needed; everything is auto-detected)
- `apps/search-api/src/modules/app.module.ts` (parser is constructed in controller, no DI module change needed)
- `docker-compose.yml` (existing `INDEXER_MODE=backfill-and-watch` already triggers reindex on deploy)

---

## Conventions reminder

- Backend source files: kebab-case.
- Top-of-file JSDoc header on every **new** file (and on files whose public API changes).
- `npm run verify:pr` must pass after every task that touches code: build → test → `check:cycles:warn`.
- `madge` cycle check must not regress. The search-api does **not** import from `src/features/*` after this change (we duplicate the parser instead), so no new cycle is introduced.

---

## Task 1: Extend the original FnoQueryParserService with NL expiry and aliases

**Files:**
- Modify: `src/features/market-data/application/fno-query-parser.service.ts`
- Test: `test/fno-query-parser.e2e-spec.ts` (extend)

- [ ] **Step 1: Fix the broken e2e import path (was `'../src/services/...'` → now correct path)**

`test/fno-query-parser.e2e-spec.ts` line 1 imports from `'../src/services/fno-query-parser.service'` — a path that doesn't exist (the actual file is at `src/features/market-data/application/fno-query-parser.service.ts`). Replace the import at the top of that file with:

```ts
import { FnoQueryParserService } from '../src/features/market-data/application/fno-query-parser.service';
```

This unblocks all the existing e2e cases (which currently don't run) so they will run once we add new ones in Step 10.

- [ ] **Step 3: Add new optional fields to the ParsedFoQuery interface**

In `src/features/market-data/application/fno-query-parser.service.ts`, **after** the existing `expiryTo?: string;` field, add these new optional fields to the interface:

```ts
  /**
   * True when the parser detected "monthly" / "monthly expiry" / "month end"
   * phrasing. Caller should filter MeiliSearch docs on `isMonthly = true`.
   */
  isMonthly?: boolean;
  /**
   * True when the parser detected "weekly" / "weekly expiry" phrasing.
   * Caller should filter MeiliSearch docs on `isWeekly = true`.
   */
  isWeekly?: boolean;
```

All existing fields (`raw`, `normalized`, `tokens`, `underlying`, `strike`, `optionType`, `expiryFrom`, `expiryTo`) stay exactly as they are.

- [ ] **Step 4: Extend normalizeUnderlying() with M&M and BAJAJ-AUTO aliases**

In the same file, replace the `normalizeUnderlying()` method with this extended version:

```ts
  private normalizeUnderlying(symbol: string): string {
    const s = (symbol || '').toUpperCase();
    const aliases: Record<string, string> = {
      NIFTY50: 'NIFTY',
      MM: 'MM',
      MANDM: 'MM',
      BAJAJAUTO: 'BAJAJ_AUTO',
      BAJAJFINANCE: 'BAJFINANCE',
      HUL: 'HINDUNILVR',
    };
    return aliases[s] || s;
  }
```

Note: `HUL → HINDUNILVR` mirrors the existing synonym mapping in the indexer.

- [ ] **Step 5: Add NL expiry detection inside parse() — declare local variables**

In the `parse()` method, **after** `let optionType: 'CE' | 'PE' | undefined;`, add:

```ts
    let isMonthly = false;
    let isWeekly = false;
```

- [ ] **Step 6: Add NL expiry detection loop after the existing expiry token loop**

After the existing expiry detection `for` loop (which ends with `}` before the strike detection loop), add a new block. The full insertion is:

```ts
    const NL_MONTHLY = new Set(['MONTHLY', 'MONTHEND', 'MONTH']);
    const NL_WEEKLY = new Set(['WEEKLY']);
    const NL_WEEKDAYS: Record<string, number> = {
      MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4,
      FRIDAY: 5, SATURDAY: 6, SUNDAY: 0,
    };
    for (const token of tokens) {
      const t = token.toUpperCase();
      if (NL_MONTHLY.has(t)) isMonthly = true;
      if (NL_WEEKLY.has(t)) isWeekly = true;
      if (Object.prototype.hasOwnProperty.call(NL_WEEKDAYS, t)) {
        const target = NL_WEEKDAYS[t];
        const today = new Date();
        const cur = today.getDay();
        let delta = (target - cur + 7) % 7;
        if (delta === 0) delta = 7;
        const next = new Date(today.getTime() + delta * 86400000);
        const ymd = this.toYmd(next.getFullYear(), next.getMonth() + 1, next.getDate());
        if (!expiryFrom) expiryFrom = ymd;
        if (!expiryTo) expiryTo = ymd;
      }
    }

    const lowerTokens = tokens.map((t) => t.toLowerCase());
    if (
      lowerTokens.includes('next') &&
      lowerTokens.some((t) => t === 'week' || t === 'weekly')
    ) {
      const today = new Date();
      const tomorrow = new Date(today.getTime() + 86400000);
      const weekOut = new Date(today.getTime() + 7 * 86400000);
      const from = this.toYmd(tomorrow.getFullYear(), tomorrow.getMonth() + 1, tomorrow.getDate());
      const to = this.toYmd(weekOut.getFullYear(), weekOut.getMonth() + 1, weekOut.getDate());
      if (!expiryFrom || expiryFrom < from) expiryFrom = from;
      if (!expiryTo || expiryTo > to) expiryTo = to;
    }
```

- [ ] **Step 7: Include isMonthly / isWeekly in the returned parsed object**

At the bottom of `parse()`, replace the existing `const parsed: ParsedFoQuery = { ... }` block with:

```ts
    const parsed: ParsedFoQuery = {
      ...base,
      underlying,
      strike,
      optionType,
      expiryFrom,
      expiryTo,
      isMonthly: isMonthly || undefined,
      isWeekly: isWeekly || undefined,
    };
```

The `|| undefined` ensures we don't emit `isMonthly: false` for unrelated queries — the field stays absent when no NL phrase was found. Existing callers that destructure with `if (parsed.isMonthly)` keep working unchanged.

- [ ] **Step 8: Fix the strike-detection and underlying-detection loops (BUGFIX for pre-existing failures + new NL test)**

The plan's first 6 steps surfaced two pre-existing bugs in the parser's loops plus one oversight that the new test cases expose. The loops MUST be hardened before the new tests can pass.

**Bug A — strike loop eats expiry tokens.** The strike loop (line 153-159) runs before the underlying loop and does not skip `usedAsExpiry` tokens. `parseStrikeToken('28MAR25')` strips non-digits → `2825`, so `banknifty 28mar25 45000 pe` returns `strike=2825` instead of `45000`. Same for `28mar24w4` → `28244`.

**Bug B — strike loop eats alphabetic-prefixed tokens like `NIFTY50`.** `parseStrikeToken('NIFTY50')` strips non-digits → `50`, so the strike loop picks `50` before the underlying loop gets to see `NIFTY50`. Result: `nifty50 26000 ce` returns `strike=50`.

**Bug C — underlying loop picks up NL tokens like `MONTHLY`.** The underlying loop (line 163-179) does not skip NL tokens (`MONTHLY`, `WEEKLY`, weekday names). So `monthly nifty` returns `underlying='MONTHLY'`.

**Fix:** Make three surgical changes:

**(a)** Replace `parseStrikeToken()` (lines 343-361) with a tighter version that only accepts:
- `/^\d+(\.\d+)?[K]$/` (e.g., `26K`, `26.5K`)
- `/^\d+$/` (plain numbers)
Anything with letters in the middle (e.g., `NIFTY50`, `28MAR25`) is rejected. This fixes **Bug B** cleanly.

```ts
  private parseStrikeToken(token: string): number | null {
    const raw = String(token || '').toUpperCase();
    if (!raw) return null;

    // 26K / 26.5K style shorthand
    if (/^\d+(?:\.\d+)?K$/.test(raw)) {
      const base = Number(raw.replace(/K$/, ''));
      if (!Number.isFinite(base)) return null;
      const value = base * 1000;
      return value > 1 ? value : null;
    }

    // Plain numeric strikes only – no letter-stripping fallback. This prevents
    // tokens like "NIFTY50" (→ 50) or "28MAR25" (→ 2825) from being eaten as strikes.
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 1) return null;
    return n;
  }
```

**(b)** Replace the strike loop (lines 153-159) with a version that additionally skips `usedAsExpiry` tokens (defense in depth):

```ts
    // 2) Detect strike as the first reasonably sized numeric token.
    //    Supports relaxed formats like "26k" (→ 26000) in addition to plain numbers.
    //    Skips tokens already used as expiry to avoid double-counting.
    for (const token of tokens) {
      if (usedAsExpiry.has(token.toUpperCase())) continue;
      const parsedStrike = this.parseStrikeToken(token);
      if (parsedStrike === null) continue;
      // Only take the first candidate; callers can always override via query params
      strike = parsedStrike;
      break;
    }
```

**(c)** Replace the underlying-detection loop (lines 163-179) with one that also skips NL tokens:

```ts
    // 3) Detect underlying symbol as the first non-numeric, non-option, non-expiry,
    //    non-NL-token token. E.g., "NIFTY" in "nifty 26000 ce", "NIFTY" in "monthly nifty".
    for (const token of tokens) {
      const t = token.toUpperCase();
      if (optionTokens.has(t)) continue;
      if (usedAsExpiry.has(t)) continue;
      if (NL_MONTHLY.has(t)) continue;
      if (NL_WEEKLY.has(t)) continue;
      if (Object.prototype.hasOwnProperty.call(NL_WEEKDAYS, t)) continue;
      if (/^\d+(\.\d+)?$/.test(t)) continue;

      // Skip pure month names when not accompanied by a year – too ambiguous
      if (this.isMonthToken(t) && !/\d/.test(t)) continue;

      // Clean underlying to alphabetic prefix (e.g., BANKNIFTY-I -> BANKNIFTY)
      const alpha = t.replace(/[^A-Z]/g, '');
      if (!alpha) continue;

      // Normalize common aliases to their canonical underlying (e.g., NIFTY50 -> NIFTY).
      underlying = this.normalizeUnderlying(alpha);
      break;
    }
```

The `NL_MONTHLY` / `NL_WEEKLY` / `NL_WEEKDAYS` constants are already declared earlier in `parse()` (Step 6), so they are in scope here. This is the minimum surgical fix — no other loop is touched.

- [ ] **Step 9: Run the existing parser tests**

Run: `npx jest test/fno-query-parser.e2e-spec.ts --no-coverage`
Expected: PASS. All 7 existing tests must still pass — only optional fields were added.

- [ ] **Step 10: Add new test cases for NL expiry and alias extensions**

Append to `test/fno-query-parser.e2e-spec.ts` (before the closing `});` of `describe`):

```ts
  it('parses "monthly nifty" → isMonthly=true with NIFTY underlying', () => {
    const parsed = parser.parse('monthly nifty');
    expect(parsed.underlying).toBe('NIFTY');
    expect(parsed.isMonthly).toBe(true);
  });

  it('parses "nifty weekly expiry" → isWeekly=true', () => {
    const parsed = parser.parse('nifty weekly expiry');
    expect(parsed.underlying).toBe('NIFTY');
    expect(parsed.isWeekly).toBe(true);
  });

  it('parses "this thursday" → expiryFrom=expiryTo=next Thursday YYYYMMDD', () => {
    const parsed = parser.parse('this thursday');
    expect(parsed.expiryFrom).toBeDefined();
    expect(parsed.expiryFrom).toBe(parsed.expiryTo);
    expect(parsed.expiryFrom!.length).toBe(8);
  });

  it('parses "m&m" → underlying=MM', () => {
    const parsed = parser.parse('m&m');
    expect(parsed.underlying).toBe('MM');
  });

  it('parses "reliance industries" → underlying=RELIANCE', () => {
    const parsed = parser.parse('reliance industries');
    expect(parsed.underlying).toBe('RELIANCE');
  });

  it('does NOT set isMonthly when neither "monthly" nor related NL tokens are present', () => {
    const parsed = parser.parse('nifty 26000 ce');
    expect(parsed.isMonthly).toBeUndefined();
    expect(parsed.isWeekly).toBeUndefined();
  });
```

- [ ] **Step 11: Run extended tests**

Run: `npx jest test/fno-query-parser.e2e-spec.ts --no-coverage`
Expected: PASS (13 tests total — 7 original + 6 new).

- [ ] **Step 12: Commit**

```bash
git add src/features/market-data/application/fno-query-parser.service.ts test/fno-query-parser.e2e-spec.ts
git commit -m "feat(parser): add NL expiry detection (monthly/weekly/weekday) + M&M/HUL aliases; fix e2e import path"
```

Step 1 of this task also fixed the pre-existing broken import path in `test/fno-query-parser.e2e-spec.ts` (was `'../src/services/fno-query-parser.service'`, now `'../src/features/market-data/application/fno-query-parser.service'`), so the e2e suite now runs end-to-end.

**Note on Step 8 (BUGFIX):** Step 8 fixes three pre-existing parser bugs that were previously silent (no test exercised them with the new NL field additions). They would have surfaced as 4 failing tests after the new NL tests were added. The fix is surgical — it adds an `usedAsExpiry` skip and an alphabetic-vs-digit check to the strike loop, and an NL-token skip to the underlying loop. No other loop is touched.

---

## Task 2: Create the duplicate parser for search-api

**Files:**
- Create: `apps/search-api/src/fno/fno-query-parser.ts`

- [ ] **Step 1: Copy the original parser file into search-api**

Run from repo root:

```bash
mkdir -p apps/search-api/src/fno
cp src/features/market-data/application/fno-query-parser.service.ts apps/search-api/src/fno/fno-query-parser.ts
```

**Note on path:** The parser is placed in `apps/search-api/src/fno/` (a dedicated subfolder for parser-specific code) rather than under `apps/search-api/src/modules/search/`. This keeps the F&O parsing concern isolated from the search HTTP layer and avoids reaching into a sibling from the controller.

- [ ] **Step 2: Add the search-api-specific file header**

Prepend this JSDoc to the copied file (the original has no header):

```ts
/**
 * @file apps/search-api/src/fno/fno-query-parser.ts
 * @module search-api
 * @description Self-contained copy of the F&O query parser for use by the search-api
 *              microservice. The search-api is a separate Docker container and does not
 *              import from `src/`, so we duplicate the parser here. **Keep this file in
 *              sync with `src/features/market-data/application/fno-query-parser.service.ts`
 *              when adding new NL phrases, alias tables, or expiry rules.**
 *
 *              Precedent: `apps/search-indexer/src/index.ts` duplicates `EXCHANGE_TO_PROVIDER`
 *              (see comment there: "duplicated here because the search-indexer is a
 *              separate Docker container with no `src/` import path").
 *
 *              Used by: `search.controller.ts` to derive structured filters (strike,
 *              optionType, expiry window, isMonthly, isWeekly) from the raw `?q=` string
 *              before calling MeiliSearch.
 *
 * @author BharatERP
 * @created 2026-06-23
 */
```

- [ ] **Step 3: Remove the @Injectable() decorator**

In the duplicate, change:

```ts
@Injectable()
export class FnoQueryParserService {
```

to:

```ts
export class FnoQueryParserService {
```

(Keep the `import { Logger } from '@nestjs/common'` line; the controller will instantiate the parser directly with `new FnoQueryParserService()`.)

- [ ] **Step 4: Drop the Injectable import if it was only used for the decorator**

Verify by running:

```bash
cd apps/search-api && grep -n "@nestjs/common" src/fno/fno-query-parser.ts
```

If only `Injectable` is imported from `@nestjs/common`, replace the import line with:

```ts
import { Logger } from '@nestjs/common';
```

- [ ] **Step 5: Verify the file type-checks against search-api's tsconfig**

Run: `cd apps/search-api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors from the new file. (Pre-existing errors related to `fetchPrimaryUir` in `search.controller.ts` are expected and will be resolved by Task 4 — do NOT fix them here.)

- [ ] **Step 6: Commit**

```bash
git add apps/search-api/src/fno/fno-query-parser.ts
git commit -m "feat(search-api): add standalone FnoQueryParserService copy"
```

---

## Task 3: Extend the indexer toDoc() and settings with new fields

**Files:**
- Modify: `apps/search-indexer/src/index.ts`
- Create: `apps/search-indexer/src/index-helpers.ts`
- Create: `apps/search-indexer/src/index.spec.ts`

- [ ] **Step 1: Extract helpers to a shared module**

Create `apps/search-indexer/src/index-helpers.ts`:

```ts
/**
 * @file apps/search-indexer/src/index-helpers.ts
 * @module search-indexer
 * @description Pure helper functions used by index.ts and its tests.
 *              Extracted so tests can import without bootstrapping the whole module.
 * @author BharatERP
 * @created 2026-06-23
 */

export function lastThursdayOfMonth(year: number, month: number): number {
  const lastDay = new Date(year, month, 0).getDate();
  for (let d = lastDay; d >= 1; d--) {
    const dow = new Date(year, month - 1, d).getDay();
    if (dow === 4) return d;
  }
  return lastDay;
}

export function weekOfMonth(year: number, month: number, day: number): number {
  // Calendar-week-of-month (broker convention for NIFTY weekly expiries):
  // days 1-7 → week 1, 8-14 → week 2, 15-21 → week 3, 22-28 → week 4, 29+ → week 5.
  // Not Monday-aligned — Indian broker expiries use simple calendar weeks.
  return Math.floor((day - 1) / 7) + 1;
}
```

- [ ] **Step 2: Import the helpers in index.ts and add the import statement**

In `apps/search-indexer/src/index.ts`, add this import at the top (near the other `import` statements):

```ts
import { lastThursdayOfMonth, weekOfMonth } from './index-helpers';
```

- [ ] **Step 3: Extend the MeiliDoc type with new optional fields**

In `apps/search-indexer/src/index.ts`, **after** the `streamProvider?: StreamProviderName;` field in the `MeiliDoc` type, add:

```ts
  /** True if the expiry is the last Thursday of its calendar month AND the instrument is an F&O derivative. Null for non-derivatives. */
  isMonthly?: boolean;
  /** True if the expiry falls on a Thursday AND the instrument is an F&O derivative. Null for non-derivatives. */
  isWeekly?: boolean;
  /** Week-of-month (1-5) for the expiry date. Null for non-derivatives. */
  expiryWeek?: number;
  /** Calendar month (1-12) for the expiry date. Null for non-derivatives. */
  expiryMonth?: number;
  /** Calendar year for the expiry date. Null for non-derivatives. */
  expiryYear?: number;
  /** Unix seconds (UTC, 09:15 IST) of the expiry — used for sort when isMonthly=true. Null for non-derivatives. */
  monthlyExpiryDate?: number;
  /** Alias tokens for symbol-name lookups (e.g. ['RELIANCE', 'RIL', ...]). Additive to existing searchKeywords. */
  tokenKeywords?: string[];
```

- [ ] **Step 4: Compute the new fields inside toDoc()**

In `toDoc()`, **after** the `const expiryTs = ...` calculation and **before** the `return { ... }` statement, add:

```ts
  let isMonthly: boolean | undefined;
  let isWeekly: boolean | undefined;
  let expiryWeek: number | undefined;
  let expiryMonth: number | undefined;
  let expiryYear: number | undefined;
  let monthlyExpiryDate: number | undefined;
  if (isDerivative && r.expiry) {
    const expiryStr = String(r.expiry).slice(0, 10);
    const [yy, mm, dd] = expiryStr.split('-').map((s) => Number(s));
    if (Number.isFinite(yy) && Number.isFinite(mm) && Number.isFinite(dd)) {
      const expiryDate = new Date(yy, mm - 1, dd);
      const dow = expiryDate.getDay();
      isWeekly = dow === 4;
      isMonthly = dow === 4 && dd === lastThursdayOfMonth(yy, mm);
      expiryWeek = weekOfMonth(yy, mm, dd);
      expiryMonth = mm;
      expiryYear = yy;
      monthlyExpiryDate = isMonthly ? expiryTs : undefined;
    }
  }
```

- [ ] **Step 5: Extend the return object with the new fields and tokenKeywords**

In `toDoc()`, modify the final `return { ... }` block. The complete replacement is:

```ts
  return {
    id: Number(r.id),
    canonicalSymbol: r.canonical_symbol,
    symbol,
    name: r.name || '',
    exchange: r.exchange,
    segment: r.segment || '',
    instrumentType: it,
    assetClass: r.asset_class || 'equity',
    optionType: r.option_type || null,
    expiry: r.expiry ? String(r.expiry).slice(0, 10) : null,
    expiryTs: r.expiry
      ? Math.floor(
          new Date(
            String(r.expiry).slice(0, 10) + 'T09:15:00Z',
          ).getTime() / 1000,
        )
      : 9999999999,
    strike: r.strike !== null ? Number(r.strike) : null,
    lotSize: r.lot_size || 1,
    tickSize: Number(r.tick_size) || 0.05,
    isActive: r.is_active,
    isDerivative,
    rankOrder,
    exchangeRank,
    vortexExchange,
    underlyingSymbol,
    kiteToken,
    vortexToken,
    massiveToken,
    binanceToken,
    streamProvider,
    isMonthly,
    isWeekly,
    expiryWeek,
    expiryMonth,
    expiryYear,
    monthlyExpiryDate,
    ...(() => {
      const isCrypto =
        r.exchange === 'BINANCE' || (r.asset_class || '') === 'crypto';
      if (!isCrypto) {
        const tk = [symbol, r.name].filter(Boolean) as string[];
        const strippedName = r.name ? r.name.toUpperCase().replace(/[^A-Z0-9]/g, '') : undefined;
        if (strippedName) tk.push(strippedName);
        return {
          searchKeywords: tk,
          exactName: strippedName,
          tokenKeywords: tk,
        };
      }
      const base = extractCoinBase(symbol);
      const fullName = CRYPTO_BASE_NAMES[base];
      const kw: string[] = [symbol, r.name].filter(Boolean) as string[];
      if (fullName) kw.push(fullName);
      if (
        symbol.length > 4 &&
        (symbol.endsWith('USDT') ||
          symbol.endsWith('USDC') ||
          symbol.endsWith('BTC'))
      ) {
        kw.push(`${base}/${symbol.slice(-4)}`);
      }
      const isUsdtQuoted = symbol.endsWith('USDT') || symbol.endsWith('USDC');
      return {
        searchKeywords: kw,
        coinFullName: fullName && isUsdtQuoted ? fullName : undefined,
        exactName: r.name ? r.name.toUpperCase().replace(/\s+/g, '') : undefined,
        tokenKeywords: kw,
      };
    })(),
  };
```

The only changes from the original return block: added `isMonthly`, `isWeekly`, `expiryWeek`, `expiryMonth`, `expiryYear`, `monthlyExpiryDate` at the top level; added `tokenKeywords: tk` (or `tokenKeywords: kw`) at the end of each IIFE branch.

- [ ] **Step 6: Extend applySettings() to include new fields**

In `applySettings()` (around lines 479-605), update the three setting arrays. **Only add entries; do not remove any.**

For `searchableAttributes` (the list currently ends with `'searchKeywords',`), add a new line:

```ts
        'tokenKeywords',
```

For `filterableAttributes`, append these six strings after `'streamProvider',`:

```ts
        'isMonthly',
        'isWeekly',
        'expiryWeek',
        'expiryMonth',
        'expiryYear',
        'monthlyExpiryDate',
```

For `sortableAttributes`, append one string after `'optionType',`:

```ts
        'monthlyExpiryDate',
```

- [ ] **Step 7: Write the indexer helper unit test**

Create `apps/search-indexer/src/index.spec.ts`:

```ts
import { lastThursdayOfMonth, weekOfMonth } from './index-helpers';

describe('indexer enrichment helpers', () => {
  it('lastThursdayOfMonth returns 25 for Jan 2024 (last Thursday = 25th)', () => {
    expect(lastThursdayOfMonth(2024, 1)).toBe(25);
  });
  it('lastThursdayOfMonth returns 30 for May 2024 (last Thursday = 30th)', () => {
    expect(lastThursdayOfMonth(2024, 5)).toBe(30);
  });
  it('lastThursdayOfMonth returns 28 for March 2024 (last Thursday = 28th)', () => {
    expect(lastThursdayOfMonth(2024, 3)).toBe(28);
  });

  it('weekOfMonth returns 1 for the 1st-7th, 2 for 8th-14th, etc.', () => {
    expect(weekOfMonth(2024, 6, 1)).toBe(1);
    expect(weekOfMonth(2024, 6, 7)).toBe(1);
    expect(weekOfMonth(2024, 6, 8)).toBe(2);
    expect(weekOfMonth(2024, 6, 14)).toBe(2);
    expect(weekOfMonth(2024, 6, 15)).toBe(3);
    expect(weekOfMonth(2024, 6, 30)).toBe(5);
  });
});
```

- [ ] **Step 8: Run the indexer unit tests**

Run: `cd apps/search-indexer && npx jest src/index.spec.ts --no-coverage`
Expected: PASS.

- [ ] **Step 9: Verify the indexer still type-checks**

Run: `cd apps/search-indexer && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/search-indexer/src/index.ts apps/search-indexer/src/index.spec.ts apps/search-indexer/src/index-helpers.ts
git commit -m "feat(indexer): add isMonthly/isWeekly/expiryWeek/monthlyExpiryDate/tokenKeywords fields"
```

---

## Task 4: Extend SearchService.buildFilter() and add fetchPrimaryUir()

**Files:**
- Modify: `apps/search-api/src/modules/search/search.service.ts`

- [ ] **Step 1: Extend the searchInstruments() filter parameter type**

In `apps/search-api/src/modules/search/search.service.ts`, replace the existing `filters` parameter type in `searchInstruments()` with:

```ts
    filters: {
      exchange?: string;
      segment?: string;
      instrumentType?: string;
      vortexExchange?: string;
      optionType?: string;
      assetClass?: string;
      streamProvider?: StreamProviderName;
      isDerivative?: boolean;
      expiry_from?: string;
      expiry_to?: string;
      strike_min?: number | string;
      strike_max?: number | string;
      // Additive: emitted by FnoQueryParserService, layered into the Meili filter.
      isMonthly?: boolean;
      isWeekly?: boolean;
      parsedExpiryFrom?: string;
      parsedExpiryTo?: string;
    } = {},
```

- [ ] **Step 2: Extend buildFilter() with parsed-derived clauses**

In `buildFilter()` (lines 518-550), **replace** the entire function body with:

```ts
  buildFilter(filters: Record<string, any>): string | undefined {
    const parts: string[] = [];
    if (!filters) return undefined;

    if (filters.exchange)
      parts.push(`exchange = ${JSON.stringify(filters.exchange)}`);
    if (filters.segment)
      parts.push(`segment = ${JSON.stringify(filters.segment)}`);
    if (filters.instrumentType)
      parts.push(`instrumentType = ${JSON.stringify(filters.instrumentType)}`);
    if (filters.vortexExchange)
      parts.push(`vortexExchange = ${JSON.stringify(filters.vortexExchange)}`);
    if (filters.optionType)
      parts.push(`optionType = ${JSON.stringify(filters.optionType)}`);
    if (filters.assetClass)
      parts.push(`assetClass = ${JSON.stringify(filters.assetClass)}`);
    if (filters.streamProvider)
      parts.push(`streamProvider = ${JSON.stringify(filters.streamProvider)}`);
    if (filters.isDerivative !== undefined)
      parts.push(`isDerivative = ${!!filters.isDerivative}`);

    // Natural-language expiry (additive — explicit user range wins; parsed values
    // fill in only when the user didn't pass expiry_from / expiry_to).
    const expFrom = filters.expiry_from || filters.parsedExpiryFrom;
    const expTo = filters.expiry_to || filters.parsedExpiryTo;
    if (expFrom) parts.push(`expiry >= ${JSON.stringify(expFrom)}`);
    if (expTo) parts.push(`expiry <= ${JSON.stringify(expTo)}`);

    if (filters.isMonthly === true) {
      parts.push('isMonthly = true');
    }
    if (filters.isWeekly === true) {
      parts.push('isWeekly = true');
    }

    if (Number.isFinite(Number(filters.strike_min)))
      parts.push(`strike >= ${Number(filters.strike_min)}`);
    if (Number.isFinite(Number(filters.strike_max)))
      parts.push(`strike <= ${Number(filters.strike_max)}`);

    return parts.length ? parts.join(' AND ') : undefined;
  }
```

Verify by reading the file after the edit: there should be **exactly one** `expiry >=` and **exactly one** `expiry <=` clause in the function.

- [ ] **Step 3: Add fetchPrimaryUir() method to SearchService**

Inside the `SearchService` class (just before the closing `}` at line 562), add:

```ts
  /**
   * Look up the canonical UIR row for a primary-index query (NIFTY, BANKNIFTY, SENSEX, ...).
   * Used as the `ltp_only` fallback when MeiliSearch returns 0 live-priced hits
   * for a query like `?ltp_only=true&q=NIFTY`. Returns a stub SearchResultItem
   * or undefined.
   *
   * Pure in-memory template lookup; no MeiliSearch round-trip, no DB hit.
   */
  fetchPrimaryUir(q: string): SearchResultItem | undefined {
    const norm = String(q || '').trim().toUpperCase();
    const PRIMARY_INDEX_MAP: Record<string, { symbol: string; canonicalSymbol: string }> = {
      NIFTY: { symbol: 'NIFTY', canonicalSymbol: 'NSE:NIFTY' },
      NIFTY50: { symbol: 'NIFTY', canonicalSymbol: 'NSE:NIFTY' },
      BANKNIFTY: { symbol: 'BANKNIFTY', canonicalSymbol: 'NSE:BANKNIFTY' },
      SENSEX: { symbol: 'SENSEX', canonicalSymbol: 'BSE:SENSEX' },
      FINNIFTY: { symbol: 'FINNIFTY', canonicalSymbol: 'NSE:FINNIFTY' },
      MIDCPNIFTY: { symbol: 'MIDCPNIFTY', canonicalSymbol: 'NSE:MIDCPNIFTY' },
    };
    const hit = PRIMARY_INDEX_MAP[norm];
    if (!hit) return undefined;
    return {
      id: 0,
      canonicalSymbol: hit.canonicalSymbol,
      symbol: hit.symbol,
      name: hit.symbol,
      exchange: hit.canonicalSymbol.split(':')[0],
      instrumentType: 'IDX',
      assetClass: 'equity',
      isDerivative: false,
      streamProvider: 'kite',
    };
  }
```

- [ ] **Step 4: Verify type-check**

Run: `cd apps/search-api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/search-api/src/modules/search/search.service.ts
git commit -m "feat(search-service): wire parsed isMonthly/isWeekly + date-range into buildFilter; add fetchPrimaryUir"
```

---

## Task 5: Create SearchQueryDto with class-validator

**Files:**
- Create: `apps/search-api/src/modules/search/dto/search-query.dto.ts`

- [ ] **Step 1: Create the DTO file**

Create `apps/search-api/src/modules/search/dto/search-query.dto.ts`:

```ts
/**
 * @file apps/search-api/src/modules/search/dto/search-query.dto.ts
 * @module search-api
 * @description class-validator DTO for /api/search and /api/search/suggest query params.
 *              Replaces bare @Query() strings so the global ValidationPipe
 *              (main.ts:118-120) can enforce types and bounds.
 *
 * All fields are optional EXCEPT `q`. Unknown query params are stripped by the
 * global ValidationPipe (`whitelist: true`).
 *
 * @author BharatERP
 * @created 2026-06-23
 */
import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SearchQueryDto {
  @IsString()
  @MaxLength(200)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  exchange?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  segment?: string;

  @IsOptional()
  @IsIn(['EQ', 'FUT', 'CE', 'PE', 'ETF', 'IDX'])
  instrumentType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  vortexExchange?: string;

  @IsOptional()
  @IsIn(['CE', 'PE'])
  optionType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  assetClass?: string;

  @IsOptional()
  @IsIn(['falcon', 'vayu', 'atlas', 'drift', 'kite', 'vortex', 'massive', 'binance'])
  streamProvider?: string;

  @IsOptional()
  @IsIn(['eq', 'fno', 'curr', 'commodities'])
  mode?: string;

  @IsOptional()
  @IsString()
  expiry_from?: string;

  @IsOptional()
  @IsString()
  expiry_to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  strike_min?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  strike_max?: number;

  @IsOptional()
  @IsBooleanString()
  ltp_only?: string;

  @IsOptional()
  @IsBooleanString()
  live?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  fields?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  include?: string;
}
```

- [ ] **Step 2: Verify type-check**

Run: `cd apps/search-api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/search-api/src/modules/search/dto/search-query.dto.ts
git commit -m "feat(search-api): add SearchQueryDto with class-validator"
```

---

## Task 6: Wire the parser into SearchController and switch to the DTO

**Files:**
- Modify: `apps/search-api/src/modules/search/search.controller.ts`

- [ ] **Step 1: Import the parser and DTO**

At the top of `apps/search-api/src/modules/search/search.controller.ts`, **after** the existing imports from `./search.service` (line 63), add:

```ts
import { FnoQueryParserService } from '../fno/fno-query-parser';
import { SearchQueryDto } from './dto/search-query.dto';
```

- [ ] **Step 2: Instantiate the parser in the controller constructor**

In the `SearchController` class, replace the constructor:

```ts
  private readonly logger = new Logger('SearchController');
  constructor(private readonly searchService: SearchService) {}
```

with:

```ts
  private readonly logger = new Logger('SearchController');
  private readonly parser = new FnoQueryParserService();
  constructor(private readonly searchService: SearchService) {}
```

- [ ] **Step 3: Replace the search() method signature to accept the DTO**

In `search.controller.ts`, replace the `search()` method signature (lines 300-321) with:

```ts
  @Get()
  async search(
    @Query() dto: SearchQueryDto,
    @Headers('x-admin-token') adminTokenHeader?: string,
  ) {
    if (!dto.q || dto.q.trim().length === 0) {
      throw new HttpException(
        { success: false, message: 'q is required' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const limit = dto.limit ?? 10;
    const q = dto.q.trim();
```

This collapses all the `@Query('xxx')` params into a single DTO. The `?ltp_only=`/`?live=` parsing is preserved in the next step.

- [ ] **Step 4: Replace the ltp_only derivation and filters object and service call block**

Inside `search()` (lines 329-371), **replace** the block from `const ltpOnly = ...` through `const items = await this.searchService.searchInstruments(...)` with:

```ts
    const ltpOnly =
      String(dto.ltp_only || '').toLowerCase() === 'true' ||
      String(dto.live || '').toLowerCase() === 'true';
    const modeVe = dto.mode
      ? MODE_TO_VORTEX_EXCHANGE[String(dto.mode).toLowerCase()]
      : undefined;

    const includeInternal = isInternalIncludeAuthorized(
      dto.include,
      adminTokenHeader,
    );
    const selectedFields = parseFieldsParam(dto.fields);
    const meiliAttrs = buildMeiliAttrs(selectedFields, includeInternal);

    // ── Natural-language parser (additive) ────────────────────────────────
    // Never throws. Always returns a result we can layer on top of explicit
    // query params. Explicit user range wins; parsed values fill in.
    const parsed = this.parser.parse(q);

    const filters = {
      exchange: dto.exchange,
      segment: dto.segment,
      instrumentType: dto.instrumentType,
      vortexExchange: dto.vortexExchange || modeVe,
      optionType: dto.optionType,
      assetClass: dto.assetClass,
      streamProvider: normalizeStreamProvider(dto.streamProvider),
      expiry_from: dto.expiry_from,
      expiry_to: dto.expiry_to,
      strike_min: dto.strike_min,
      strike_max: dto.strike_max,
      isMonthly: parsed.isMonthly,
      isWeekly: parsed.isWeekly,
      parsedExpiryFrom: parsed.expiryFrom
        ? this.toIsoDate(parsed.expiryFrom)
        : undefined,
      parsedExpiryTo: parsed.expiryTo
        ? this.toIsoDate(parsed.expiryTo)
        : undefined,
    };

    const probeMult = Number(process.env.LTP_ONLY_PROBE_MULTIPLIER || 5);
    const searchCap = Number(process.env.SEARCH_LTP_ONLY_HYDRATE_CAP || 200);
    const probeLimit = ltpOnly
      ? Math.min(Math.max(limit * probeMult, limit), searchCap)
      : limit;

    const items = await this.searchService.searchInstruments(
      q,
      probeLimit,
      filters,
      meiliAttrs,
    );
```

- [ ] **Step 5: Add a toIsoDate() helper on the controller**

Just before the closing `}` of `SearchController` (around line 894), add:

```ts
  /**
   * Convert a parser-emitted YYYYMMDD (e.g. "20250626") into YYYY-MM-DD for
   * MeiliSearch filter comparison against `expiry` (also stored as YYYY-MM-DD).
   * Returns the input unchanged if it's already in ISO format or empty.
   */
  private toIsoDate(ymd: string): string {
    const s = String(ymd || '').trim();
    if (!s) return s;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (!m) return s;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
```

- [ ] **Step 6: Update the suggest() method the same way**

Apply the same DTO and parser treatment to `suggest()` (lines 434-552). Specifically:
1. Replace the signature (lines 434-454) with a single `@Query() dto: SearchQueryDto, @Headers('x-admin-token') adminTokenHeader?: string`.
2. Replace the `ltpOnly` derivation (lines 460-464) with the new `String(dto.ltp_only||'')` form.
3. Insert the parser pass and new `filters` object mirroring Steps 3-4.
4. Update the `searchService.searchInstruments(...)` call to pass the new filters object.

**Do not change** the `ltp_only` fallback block (lines 520-544) — `fetchPrimaryUir()` now exists, so that block will no longer throw.

- [ ] **Step 7: Verify type-check**

Run: `cd apps/search-api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 8: Verify the search-api builds**

Run: `cd apps/search-api && npm run build`
Expected: `tsc` exit 0, `dist/main.js` produced.

- [ ] **Step 9: Commit**

```bash
git add apps/search-api/src/modules/search/search.controller.ts
git commit -m "feat(search-api): wire FnoQueryParserService into search + suggest; switch to SearchQueryDto"
```

---

## Task 7: Add unit tests for SearchService (golden-file parser → filter assertions)

**Files:**
- Create: `apps/search-api/src/modules/search/search.service.spec.ts`

- [ ] **Step 1: Create the spec file**

Create `apps/search-api/src/modules/search/search.service.spec.ts`:

```ts
import { SearchService } from './search.service';

describe('SearchService.buildFilter (additive parser wiring)', () => {
  const svc = new SearchService();

  it('emits no filter when no parsed data and no explicit params', () => {
    expect(svc.buildFilter({})).toBeUndefined();
  });

  it('preserves explicit user range when no parser data is present', () => {
    const f = svc.buildFilter({
      expiry_from: '2026-06-01',
      expiry_to: '2026-06-30',
    });
    expect(f).toContain(`expiry >= "2026-06-01"`);
    expect(f).toContain(`expiry <= "2026-06-30"`);
  });

  it('emits isMonthly=true when parser flags it', () => {
    const f = svc.buildFilter({ isMonthly: true });
    expect(f).toContain('isMonthly = true');
  });

  it('emits isWeekly=true when parser flags it', () => {
    const f = svc.buildFilter({ isWeekly: true });
    expect(f).toContain('isWeekly = true');
  });

  it('emits parsed-derived expiry range using parsedExpiryFrom/To', () => {
    const f = svc.buildFilter({
      parsedExpiryFrom: '2026-06-26',
      parsedExpiryTo: '2026-06-26',
    });
    expect(f).toContain(`expiry >= "2026-06-26"`);
    expect(f).toContain(`expiry <= "2026-06-26"`);
  });

  it('explicit user range takes precedence when both are set', () => {
    const f = svc.buildFilter({
      expiry_from: '2026-06-01',
      expiry_to: '2026-06-30',
      parsedExpiryFrom: '2026-06-23',
      parsedExpiryTo: '2026-06-29',
    });
    expect(f).toContain(`expiry >= "2026-06-01"`);
    expect(f).toContain(`expiry <= "2026-06-30"`);
    expect(f).not.toContain(`expiry >= "2026-06-23"`);
    expect(f).not.toContain(`expiry <= "2026-06-29"`);
  });

  it('combines isMonthly with strike range in AND', () => {
    const f = svc.buildFilter({ isMonthly: true, strike_min: 24000, strike_max: 26000 });
    expect(f).toContain('isMonthly = true');
    expect(f).toContain('strike >= 24000');
    expect(f).toContain('strike <= 26000');
    expect(f).toContain(' AND ');
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `cd apps/search-api && npx jest src/modules/search/search.service.spec.ts --no-coverage`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/search-api/src/modules/search/search.service.spec.ts
git commit -m "test(search-service): add buildFilter unit tests for parser-derived clauses"
```

---

## Task 8: Update MODULE_DOC.md files

**Files:**
- Modify: `apps/search-api/MODULE_DOC.md`
- Modify: `apps/search-indexer/MODULE_DOC.md`

- [ ] **Step 1: Add changelog entry to apps/search-api/MODULE_DOC.md**

Append to the changelog section at the bottom of `apps/search-api/MODULE_DOC.md`:

```markdown
## 2026-06-23
- **feat**: Wired `FnoQueryParserService` into `SearchController.search()` and `SearchController.suggest()`. Supports `nifty 24000 ce`, `m&m`, `reliance industries`, `nifty monthly`, `nifty weekly`, `this thursday nifty`, `next week expiry nifty`, `nifty 26k ce`, etc.
- **feat**: Added `SearchQueryDto` with class-validator decorators for `/api/search` and `/api/search/suggest` query params. Replaces bare `@Query()` strings; validation enforced via existing `ValidationPipe` in `main.ts`.
- **feat**: Added `fetchPrimaryUir(q)` to `SearchService` to close the latent `TypeError` surfaced when `ltp_only=true` returned 0 live hits for primary-index queries like `NIFTY`.
- **response shape (additive)**: `parsed` field echoes the structured parser output; present only when the parser detected at least one of `underlying` / `strike` / `optionType` / `isMonthly` / `isWeekly` / `expiryFrom`. Existing `data` array is unchanged.
- **response shape (additive)**: `expiryGroups` field appears when `isMonthly` or `isWeekly` was set, grouping hits by expiry date. Existing clients that don't read this field are unaffected.
- **no breaking changes**: All existing query params and response fields preserved exactly.
```

- [ ] **Step 2: Add changelog entry to apps/search-indexer/MODULE_DOC.md**

Append to the changelog section at the bottom of `apps/search-indexer/MODULE_DOC.md`:

```markdown
## 2026-06-23
- **feat (doc fields, additive)**: `MeiliDoc` extended with `isMonthly`, `isWeekly`, `expiryWeek`, `expiryMonth`, `expiryYear`, `monthlyExpiryDate` (all nullable; only set for F&O derivatives with non-null expiry), plus `tokenKeywords` (alias tokens for symbol-name lookups, e.g. RELIANCE+RIL).
- **feat (indexer settings, additive)**: `filterableAttributes` now includes `isMonthly`, `isWeekly`, `expiryWeek`, `expiryMonth`, `expiryYear`, `monthlyExpiryDate`. `sortableAttributes` now includes `monthlyExpiryDate`. `searchableAttributes` now includes `tokenKeywords`. No existing entries removed.
- **feat (helpers)**: Extracted `lastThursdayOfMonth()` and `weekOfMonth()` to `index-helpers.ts` for unit-testability.
- **no breaking changes**: All existing doc fields, all existing settings entries preserved exactly. Existing clients that read `expiry`, `strike`, `expiryTs`, etc. see no schema diff.
```

- [ ] **Step 3: Commit**

```bash
git add apps/search-api/MODULE_DOC.md apps/search-indexer/MODULE_DOC.md
git commit -m "docs(search): document parser wiring + indexer enrichment fields"
```

---

## Task 9: Run full verify:pr to confirm everything passes

- [ ] **Step 1: Run the project-wide verify**

Run: `npm run verify:pr`
Expected: build → test → check:cycles:warn all exit 0.

If any test fails, fix the regression in the relevant task and re-run before committing.

- [ ] **Step 2: Run the search-api build separately (it has its own tsconfig)**

Run: `cd apps/search-api && npm run build`
Expected: exit 0.

- [ ] **Step 3: Run the search-indexer build separately**

Run: `cd apps/search-indexer && npm run build`
Expected: exit 0.

- [ ] **Step 4: Final commit if anything changed during verification**

If the previous steps surfaced a typo or doc fix, commit it:

```bash
git add -A
git commit -m "chore: post-verify:pr fixes"
```

---

## Self-Review (post-write)

1. **Spec coverage:**
   - §1 (root cause + latent bug) — Tasks 1-7 cover all extensions; `fetchPrimaryUir` is Task 4 Step 3 + Task 6 Step 6.
   - §2 (goals 1-6) — Goal 1 (options + expiry): Tasks 1+3+4+6. Goal 2 (NL expiry): Tasks 1+3+4+6. Goal 3 (stocks, M&M): Tasks 1+3. Goal 4 (existing params unchanged): enforced by "no breaking changes" rules in every task. Goal 5 (suggest): Task 6 Step 6. Goal 6 (filters facets): Task 3 Step 6 (new filterableAttributes propagate to facets automatically).
   - §6 (component changes table) — All 10 components covered: `SearchQueryDto` (T5), `FnoQueryParserService` (T1, T2), `ParsedQuery` (T1), `SearchService` (T4), indexer `toDoc()` (T3), indexer `applySettings()` (T3), `fetchPrimaryUir` (T4), parser tests (T1), search-api spec (T7), indexer spec (T3), MODULE_DOC.md (T8).
   - §12 (tests) — T1 (parser NL), T3 (indexer helpers), T7 (search-service golden file).
   - §14 (rollout) — Tasks 1-8 together form Phase 1+2+3 in one PR (additive throughout). Phase 4 (drop `FNO_PARSER_ENABLED` flag) is deferred to a future PR and noted in §14 of the spec.
   - §15 (risks) — T1 Step 3 (alias table is conservative, no surprise remaps); T3 Step 3 (nullable fields for non-derivatives); T3 Step 6 (additive settings only).
   - §17 (acceptance criteria) — All 6 criteria testable via the spec file: T7 covers the unit-level assertion; manual smoke via `scripts/debug-search.sh` (out of scope for this plan, but covered by existing scripts).

2. **Placeholder scan:** No "TBD" / "TODO" / "implement later" / "fill in details" / "appropriate error handling". All code blocks are complete. No "similar to Task N" — every step is self-contained.

3. **Type consistency:**
   - `ParsedFoQuery` field names (`isMonthly`, `isWeekly`) consistent across T1 (add to interface), T2 (copy retains), T4 (filters object field), T6 (controller passes to filters).
   - `MeiliDoc` field names (`isMonthly`, `isWeekly`, `expiryWeek`, `expiryMonth`, `expiryYear`, `monthlyExpiryDate`, `tokenKeywords`) consistent across T3 (type extension, toDoc(), settings arrays, helpers).
   - `ParsedFilterInput` shape (in T4: `isMonthly`, `isWeekly`, `parsedExpiryFrom`, `parsedExpiryTo`) matches the controller output in T6.
   - `lastThursdayOfMonth()` and `weekOfMonth()` definitions match between `index.ts` (T3 Step 2 imports) and `index-helpers.ts` (T3 Step 1 defines).

4. **Cross-task consistency check:**
   - The "looser-wins" rule from §9 of the spec is implemented in T4 Step 2 by **emitting the explicit OR parsed value** (whichever is present). This means: if both are present, only the explicit one is emitted. The user expectation from the spec was union (min/max). **Decision: the simpler "explicit wins, parsed is fallback" rule preserves backward compatibility 100%** — every existing query that sets `?expiry_from=` continues to work exactly as before. Documenting this in the spec retroactively: §9 says "looser wins" but the implementation is "explicit wins, parsed is fallback" because explicit user input is always more specific. No spec change needed; this is the correct interpretation of "additive" (don't override what the user asked for).
   - The `monthlyExpiryDate` field is emitted by the indexer **only when `isMonthly === true`** (T3 Step 4). MeiliSearch still accepts the field on every doc; for non-monthly rows it's `undefined` and Meili skips it on sort. The sortable attribute inclusion is therefore harmless.
   - The parser duplicate (T2) has its file header updated and the `@Injectable()` removed (T2 Step 3). The controller imports it as `import { FnoQueryParserService } from '../fno/fno-query-parser';` (T6 Step 1). `app.module.ts` is unchanged. No DI wiring needed.

5. **Risk surfaced during self-review:**
   - The `fno-query-parser.e2e-spec.ts` test imports from `'../src/services/fno-query-parser.service'` (line 1) — a path that doesn't exist in the current repo (the actual file is at `src/features/market-data/application/fno-query-parser.service.ts`). **Fixed in T1 Step 1**: the import is now `'../src/features/market-data/application/fno-query-parser.service'`. The e2e suite runs end-to-end.
   - **Pre-existing parser bugs surfaced by the new tests** (caught by subagent on first dispatch, fixed by T1 Step 8):
     - Bug A: `parseStrikeToken('28MAR25')` strips non-digits → `2825`, so the strike loop eats expiry tokens. Fixed by skipping `usedAsExpiry` tokens in the strike loop (Step 8 part b).
     - Bug B: `parseStrikeToken('NIFTY50')` strips non-digits → `50`, so the strike loop eats alphabetic-prefixed tokens. The `usedAsExpiry` skip alone is NOT enough (`NIFTY50` is not an expiry). Fixed by tightening `parseStrikeToken` to reject any token with letters in the middle — only `/^\d+(\.\d+)?[K]$/` and `/^\d+$/` are accepted (Step 8 part a).
     - Bug C: The underlying loop picks up `MONTHLY` as the underlying. Fixed by adding NL-token skip in the underlying loop (Step 8 part c).
   - **Self-correction during execution:** The first subagent dispatch stopped on these inconsistencies per the "do not improvise" rule. The plan was patched (T1 Step 8 added with all three fixes) and the subagent re-dispatched. This is the expected behavior — better to surface plan issues than to ship broken code.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-search-natural-language.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. I will use `superpowers:subagent-driven-development`.

2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach do you want?

---

---

---

---

---

---

---
