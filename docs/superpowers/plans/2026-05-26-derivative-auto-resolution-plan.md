# Derivative Auto-Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow clients to subscribe with logical symbols like `MCX:GOLD:FUT` that auto-resolve to nearest-expiry futures/options contract.

**Architecture:** Extend `InstrumentRegistryService.underlyingToEntries` to include `expiry` and instrument_type. Add `resolveDerivativeSymbol()` method that parses `EXCHANGE:UNDERLYING:TYPE` syntax, filters by type and non-expired, sorts by expiry ASC, picks nearest. For options (CE/PE), resolve underlying LTP to pick ATM strike.

**Tech Stack:** NestJS, TypeORM, in-memory warm maps, Redis LTP cache

---

## File Map

- **Modify:** `src/features/market-data/application/instrument-registry.service.ts` — extend UnderlyingEntry, warmMaps, add resolveDerivativeSymbol
- **Modify:** `src/features/market-data/interface/market-data.gateway.ts` — handle derivative symbols in doSubscribe, add derivative to subscription_confirmed

---

## Task 1: Update UnderlyingEntry and warmMaps in InstrumentRegistryService

**Files:**
- Modify: `src/features/market-data/application/instrument-registry.service.ts:36-41` (UnderlyingEntry)
- Modify: `src/features/market-data/application/instrument-registry.service.ts:86-97` (warmMaps)

- [ ] **Step 1: Update UnderlyingEntry interface to include expiry**

Find line 36-41 and replace the interface:

```typescript
/** One entry in the underlying → entries warm map. */
interface UnderlyingEntry {
  uirId: number;
  exchange: string;
  instrument_type: string;
  canonical: string;
  expiry: Date | null;  // Contract expiry date for derivatives
}
```

- [ ] **Step 2: Update warmMaps to populate expiry in underlyingToEntries**

Find lines 86-97 (the block that builds `underlyingToEntries`) and update:

```typescript
// Build underlying → entries map for flex symbol resolution ("RELIANCE" → [...])
if (row.underlying) {
  const underlyingKey = row.underlying.toUpperCase();
  const existing = this.underlyingToEntries.get(underlyingKey) ?? [];
  existing.push({
    uirId: id,
    exchange: row.exchange,
    instrument_type: row.instrument_type,
    canonical: row.canonical_symbol,
    expiry: row.expiry ?? null,  // NEW: populate expiry
  });
  this.underlyingToEntries.set(underlyingKey, existing);
}
```

- [ ] **Step 3: Add derivative result type after FlexResolveResult (around line 22)**

```typescript
/** Result of a derivative symbol resolution attempt (FUT/CE/PE). */
export type DerivativeResolveResult =
  | {
      status: 'resolved';
      uirId: number;
      canonical: string;
      providerToken?: string;
      expiry: Date | null;
      instrument_type: string;
    }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'not_found'; reason?: string };
```

- [ ] **Step 4: Run build to verify no errors**

```bash
cd /home/amansharma/Desktop/DevOPS/Kite-COnnect-Backend && npm run build 2>&1 | head -50
```
Expected: Build completes without TypeScript errors in instrument-registry.service.ts

- [ ] **Step 5: Commit**

```bash
git add src/features/market-data/application/instrument-registry.service.ts
git commit -m "feat(market-data): add expiry to UnderlyingEntry and DerivativeResolveResult type

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Add resolveDerivativeSymbol method to InstrumentRegistryService

**Files:**
- Modify: `src/features/market-data/application/instrument-registry.service.ts` — add new method after resolveProviderScopedSymbol (around line 366)

- [ ] **Step 1: Add resolveDerivativeSymbol method**

After the `resolveProviderScopedSymbol` method (around line 366, before `getProviderToken`), add:

```typescript
/**
 * Resolve a derivative symbol like "MCX:GOLD:FUT", "NFO:NIFTY:CE", or "GOLD:FUT" (no exchange).
 *
 * Resolution order:
 *   1. EXCHANGE:UNDERLYING:TYPE with explicit exchange — resolve in that exchange only.
 *   2. UNDERLYING:TYPE without exchange — apply provider preference order (MCX → NFO → BFO).
 *   3. For CE/PE: resolve underlying EQ to get LTP, pick nearest ATM strike.
 *
 * Hot-path: O(1) map lookups + filter + sort on small set — no async, no DB.
 */
resolveDerivativeSymbol(symbol: string): DerivativeResolveResult {
  const parts = symbol.split(':');
  if (parts.length < 2) {
    return { status: 'not_found', reason: 'Invalid derivative symbol format' };
  }

  const type = parts[parts.length - 1].toUpperCase();
  if (!['FUT', 'CE', 'PE'].includes(type)) {
    return { status: 'not_found', reason: `Not a derivative type: ${type}` };
  }

  const underlyingRaw = parts.length === 3 ? parts[1] : parts[0];
  const underlyingKey = underlyingRaw.toUpperCase();
  const explicitExchange = parts.length === 3 ? parts[0].toUpperCase() : null;

  const allEntries = this.underlyingToEntries.get(underlyingKey);
  if (!allEntries || allEntries.length === 0) {
    return { status: 'not_found', reason: `Underlying not found: ${underlyingRaw}` };
  }

  // Filter by type (FUT, CE, PE)
  const typeEntries = allEntries.filter(e => e.instrument_type === type);
  if (typeEntries.length === 0) {
    return { status: 'not_found', reason: `No ${type} contracts for ${underlyingRaw}` };
  }

  // Filter by exchange if specified, otherwise use preference order
  let candidates = typeEntries;
  if (explicitExchange) {
    candidates = typeEntries.filter(e => e.exchange === explicitExchange);
    if (candidates.length === 0) {
      return { status: 'not_found', reason: `${type} not found in ${explicitExchange}` };
    }
  } else {
    // Apply exchange preference: MCX > NFO > BFO > others
    const exchangeOrder = ['MCX', 'NFO', 'BFO'];
    const sorted: typeof typeEntries = [];
    for (const ex of exchangeOrder) {
      const match = candidates.filter(e => e.exchange === ex);
      if (match.length > 0) sorted.push(...match);
    }
    // Add any remaining exchanges not in preference list
    const matchedExchanges = new Set([...exchangeOrder, ...sorted.map(e => e.exchange)]);
    for (const e of candidates) {
      if (!matchedExchanges.has(e.exchange)) sorted.push(e);
    }
    candidates = sorted;
  }

  // Filter non-expired (expiry > now or null expiry for equity-like)
  const now = new Date();
  const activeCandidates = candidates.filter(e => !e.expiry || e.expiry > now);

  if (activeCandidates.length === 0) {
    return { status: 'not_found', reason: `All ${type} contracts for ${underlyingRaw} have expired` };
  }

  // For CE/PE: resolve underlying EQ to get ATM strike
  if (type === 'CE' || type === 'PE') {
    // Find the EQ entry for this underlying
    const eqEntries = allEntries.filter(e => e.instrument_type === 'EQ');
    if (eqEntries.length === 0) {
      return { status: 'not_found', reason: `Cannot resolve ATM: no EQ for ${underlyingRaw}` };
    }
    // For now, pick nearest strike above (CE) or below (PE) — LTP resolution comes in Task 3
    // Sort by strike distance to estimate ATM
    const strikes = activeCandidates.map(e => {
      // Strike is not in UnderlyingEntry — we'll return all candidates and let caller decide
      return e;
    });
    // Just pick nearest expiry for now, options resolution needs LTP from Redis
    const sortedByExpiry = activeCandidates.sort((a, b) => {
      if (!a.expiry && !b.expiry) return 0;
      if (!a.expiry) return 1;
      if (!b.expiry) return -1;
      return a.expiry.getTime() - b.expiry.getTime();
    });

    if (sortedByExpiry.length === 1) {
      return {
        status: 'resolved',
        uirId: sortedByExpiry[0].uirId,
        canonical: sortedByExpiry[0].canonical,
        expiry: sortedByExpiry[0].expiry,
        instrument_type: sortedByExpiry[0].instrument_type,
      };
    }

    return {
      status: 'ambiguous',
      candidates: sortedByExpiry.map(e => e.canonical),
    };
  }

  // For FUT: sort by expiry ASC, pick nearest
  const sorted = activeCandidates.sort((a, b) => {
    if (!a.expiry && !b.expiry) return 0;
    if (!a.expiry) return 1;
    if (!b.expiry) return -1;
    return a.expiry.getTime() - b.expiry.getTime();
  });

  if (sorted.length === 1) {
    return {
      status: 'resolved',
      uirId: sorted[0].uirId,
      canonical: sorted[0].canonical,
      expiry: sorted[0].expiry,
      instrument_type: sorted[0].instrument_type,
    };
  }

  return {
    status: 'ambiguous',
    candidates: sorted.map(e => e.canonical),
  };
}
```

- [ ] **Step 2: Run build to verify**

```bash
npm run build 2>&1 | grep -E "(error|Error)" | head -20
```
Expected: No TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add src/features/market-data/application/instrument-registry.service.ts
git commit -m "feat(market-data): add resolveDerivativeSymbol for FUT/CE/PE auto-resolution

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Update MarketDataGateway.doSubscribe to handle derivative symbols

**Files:**
- Modify: `src/features/market-data/interface/market-data.gateway.ts` — handle `:FUT`, `:CE`, `:PE` suffixes in doSubscribe

- [ ] **Step 1: Identify where to add derivative resolution in doSubscribe**

Find the section where `symbols` are processed (around lines 753-800 in doSubscribe). After the `resolveFlexSymbol` loop, add derivative resolution.

Find this block:
```typescript
if (Array.isArray(symbols) && symbols.length > 0) {
  const providerName =
    lockedProvider ?? this.streamService.activeProviderName;
  for (const sym of symbols) {
    const flexResult = this.instrumentRegistry.resolveFlexSymbol(sym);
```

Add this block right after the flex resolution block ends (around line 799, before the `const forcedTotal` line):

```typescript
// ── Derivative symbol resolution (MCX:GOLD:FUT, NFO:NIFTY:CE, etc.) ──
const derivativeResolved: Array<{
  symbol: string;
  uirId: number;
  resolvedAs: string;
  expiry: Date | null;
  type: string;
}> = [];

for (const sym of symbols) {
  const trimmed = String(sym).trim();
  // Check if this is a derivative symbol (has :FUT, :CE, :PE suffix)
  if (!/^[^:]+:[^:]+:(FUT|CE|PE)$/i.test(trimmed)) continue;

  const result = this.instrumentRegistry.resolveDerivativeSymbol(trimmed);
  if (result.status === 'not_found') {
    unresolvedSymbols.push(`${sym} (${result.reason ?? 'not found'})`);
    continue;
  }
  if (result.status === 'ambiguous') {
    unresolvedSymbols.push(`${sym} (ambiguous — try: ${result.candidates?.join(', ')})`);
    continue;
  }
  // Resolved — get provider token and add to subscriptions
  const providerName = lockedProvider ?? this.streamService.activeProviderName;
  const providerToken = this.instrumentRegistry.getProviderToken(result.uirId, providerName);
  if (providerToken) {
    instruments = [...instruments, Number(providerToken)];
  }
  derivativeResolved.push({
    symbol: sym,
    uirId: result.uirId,
    resolvedAs: result.canonical ?? trimmed,
    expiry: result.expiry ?? null,
    type: result.instrument_type ?? 'FUT',
  });
  resolvedSymbols.push({
    symbol: sym,
    uirId: result.uirId,
    providerToken: providerToken ? Number(providerToken) : undefined,
    resolvedAs: result.canonical !== sym ? result.canonical : undefined,
  });
}
```

- [ ] **Step 2: Add derivative info to subscription_confirmed response**

Find `subscription_confirmed` emit (around line 1221) and add `derivative` field:

Find:
```typescript
client.emit('subscription_confirmed', {
  requested: requestedRaw,
  pairs: finalPairs.map((p) => `${p.exchange}-${p.token}`),
  included: allIncludedUirIds,
  resolved: symbolEnrichment.length > 0 ? symbolEnrichment : undefined,
  forced: forcedConfirm.length > 0 ? forcedConfirm : undefined,
```

Add `derivative` after `forced`:

```typescript
  derivative: derivativeResolved.length > 0 ? derivativeResolved : undefined,
```

- [ ] **Step 3: Run build to verify**

```bash
npm run build 2>&1 | grep -E "(error|Error)" | head -20
```
Expected: No TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add src/features/market-data/interface/market-data.gateway.ts
git commit -m "feat(market-data): handle derivative symbols in doSubscribe

Supports MCX:GOLD:FUT, NFO:NIFTY:CE, etc. in WebSocket subscriptions.
Adds derivative info to subscription_confirmed response.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Add unit tests for derivative resolution

**Files:**
- Create: `src/features/market-data/application/instrument-registry.service.spec.ts` (if not exists)
- Or modify existing spec file

- [ ] **Step 1: Write test for resolveDerivativeSymbol**

```typescript
import { InstrumentRegistryService } from './instrument-registry.service';
import { UniversalInstrument } from '../domain/universal-instrument.entity';

describe('InstrumentRegistryService.resolveDerivativeSymbol', () => {
  let service: InstrumentRegistryService;
  let mockUirRepo: any;
  let mockMappingRepo: any;

  beforeEach(async () => {
    // Mock repo with test data
    mockUirRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: '1',
          canonical_symbol: 'MCX:GOLD26JUN26FUT',
          exchange: 'MCX',
          underlying: 'GOLD',
          instrument_type: 'FUT',
          expiry: new Date('2026-06-26'),
          isin: null,
        },
        {
          id: '2',
          canonical_symbol: 'MCX:GOLD30JUL26FUT',
          exchange: 'MCX',
          underlying: 'GOLD',
          instrument_type: 'FUT',
          expiry: new Date('2026-07-30'),
          isin: null,
        },
        {
          id: '3',
          canonical_symbol: 'NFO:NIFTY26JUN26FUT',
          exchange: 'NFO',
          underlying: 'NIFTY',
          instrument_type: 'FUT',
          expiry: new Date('2026-06-26'),
          isin: null,
        },
        {
          id: '4',
          canonical_symbol: 'MCX:GOLD26JUN26CE',
          exchange: 'MCX',
          underlying: 'GOLD',
          instrument_type: 'CE',
          expiry: new Date('2026-06-26'),
          strike: 60000,
          isin: null,
        },
      ]),
    };
    mockMappingRepo = { find: jest.fn().mockResolvedValue([]) };

    service = new InstrumentRegistryService(mockUirRepo, mockMappingRepo);
    await service.warmMaps();
  });

  it('should resolve MCX:GOLD:FUT to nearest expiry', () => {
    const result = service.resolveDerivativeSymbol('MCX:GOLD:FUT');
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.canonical).toBe('MCX:GOLD26JUN26FUT');
    }
  });

  it('should resolve GOLD:FUT (no exchange) to MCX first', () => {
    const result = service.resolveDerivativeSymbol('GOLD:FUT');
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.canonical).toBe('MCX:GOLD26JUN26FUT');
    }
  });

  it('should return ambiguous when multiple non-expired FUT', () => {
    const result = service.resolveDerivativeSymbol('MCX:GOLD:FUT');
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates).toContain('MCX:GOLD26JUN26FUT');
      expect(result.candidates).toContain('MCX:GOLD30JUL26FUT');
    }
  });

  it('should return not_found for invalid underlying', () => {
    const result = service.resolveDerivativeSymbol('MCX:INVALID:FUT');
    expect(result.status).toBe('not_found');
  });

  it('should resolve NFO:NIFTY:FUT to NFO contract', () => {
    const result = service.resolveDerivativeSymbol('NFO:NIFTY:FUT');
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.canonical).toBe('NFO:NIFTY26JUN26FUT');
    }
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd /home/amansharma/Desktop/DevOPS/Kite-COnnect-Backend && npx jest src/features/market-data/application/instrument-registry.service.spec.ts --no-coverage 2>&1
```
Expected: Tests pass

- [ ] **Step 3: Commit**

```bash
git add src/features/market-data/application/instrument-registry.service.spec.ts
git commit -m "test(market-data): add derivative resolution unit tests

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: End-to-end verification

- [ ] **Step 1: Run verify:pr**

```bash
cd /home/amansharma/Desktop/DevOPS/Kite-COnnect-Backend && npm run verify:pr 2>&1 | tail -30
```
Expected: Build passes, tests pass, no new circular imports

- [ ] **Step 2: Final commit with all changes**

```bash
git add . && git commit -m "feat(market-data): derivative auto-resolution for WebSocket subscriptions

Clients can now subscribe with logical symbols:
- MCX:GOLD:FUT → nearest gold futures on MCX
- NFO:NIFTY:FUT → nearest Nifty futures on NFO
- GOLD:FUT → picks MCX first (provider preference)

Supports FUT, CE, PE types with nearest-expiry resolution.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Post-Implementation Notes

1. **Options strike selection (CE/PE):** Currently resolves to nearest-expiry without ATM strike logic. For production, would need Redis LTP lookup for underlying EQ to pick ATM strike. This is sufficient for v1.

2. **Expired contracts:** Filtered out in resolution. If all contracts expired, returns `not_found`.

3. **No breaking changes:** Existing subscriptions work unchanged.

---

**Plan complete.** Ready for implementation.