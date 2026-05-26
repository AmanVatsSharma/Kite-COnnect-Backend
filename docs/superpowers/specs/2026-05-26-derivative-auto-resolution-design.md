# Derivative Auto-Resolution for WebSocket Subscriptions

**Date:** 2026-05-26
**Author:** AmanVatsSharma
**Status:** Approved

## Goal

Allow clients to subscribe to futures and options using logical symbols like `MCX:GOLD:FUT` instead of requiring exact instrument tokens. The system auto-resolves to the nearest-expiry contract.

## Symbol Syntax

| Symbol | Exchange inference | Resolution |
|--------|-------------------|------------|
| `MCX:GOLD:FUT` | Explicit MCX | Gold futures, nearest non-expired |
| `MCX:GOLD:CE` | Explicit MCX | Gold call options, nearest ATM strike, nearest expiry |
| `MCX:GOLD:PE` | Explicit MCX | Gold put options, nearest ATM strike, nearest expiry |
| `NFO:BANKNIFTY:FUT` | Explicit NFO | BankNifty futures, nearest non-expired |
| `NSE:BANKNIFTY:CE` | Explicit NSE | BankNifty call options, nearest ATM strike |
| `NFO:NIFTY:PE` | Explicit NFO | Nifty put options, nearest ATM strike |
| `GOLD:FUT` | Provider preference | MCX → NFO → BFO → first match |

## Resolution Flow

```
Client subscribes with: "MCX:GOLD:FUT"
                        │
                        ▼
         parseProviderPrefix → "MCX" = exchange, "GOLD" = underlying, "FUT" = type
                        │
                        ▼
         Query underlyingToEntries:
           - exchange = "MCX" (or any if not specified)
           - instrument_type = "FUT"
           - expiry > now (non-expired)
                        │
                        ▼
         Sort by expiry ASC → pick nearest
                        │
                        ▼
         Return UIR ID + canonical + provider token
```

## Options Strike Selection (CE/PE)

For CE/PE, pick the **nearest ATM** strike (closest to underlying's last traded price).

Algorithm:
1. Fetch LTP of underlying EQ from `underlyingToEntries`
2. Filter CE/PE entries where strike is closest to underlying LTP
3. Pick nearest — ties broken by expiry ASC

If LTP unavailable → fallback to **nearest strike above** (CE) / **nearest below** (PE).

## Architecture

### Files to Modify

1. **`src/features/market-data/application/instrument-registry.service.ts`**
   - Update `UnderlyingEntry` interface to include `expiry`
   - Update `warmMaps()` to populate expiry in `underlyingToEntries`
   - Add `resolveDerivativeSymbol(symbol: string): DerivativeResolveResult`
   - Update `resolveFlexSymbol` to handle `:FUT`, `:CE`, `:PE` suffixes

2. **`src/features/market-data/interface/market-data.gateway.ts`**
   - Update `doSubscribe` to call `resolveDerivativeSymbol` for derivative symbols
   - Add derivative info to `subscription_confirmed` response

### Data Structures

```typescript
interface DerivativeResolveResult {
  status: 'resolved' | 'ambiguous' | 'not_found';
  uirId?: number;
  canonical?: string;
  providerToken?: string;
  candidates?: string[];  // for ambiguous
  reason?: string;         // for not_found (expired, no underlying, etc.)
}
```

### Response Shape (subscription_confirmed)

```json
{
  "resolved": [...],
  "derivative": [
    {
      "symbol": "MCX:GOLD:FUT",
      "resolvedAs": "MCX:GOLD26JUN26FUT",
      "uirId": 1234,
      "canonical": "MCX:GOLD26JUN26FUT",
      "expiry": "2026-06-26",
      "type": "FUT"
    }
  ]
}
```

## Error Cases

| Case | Response |
|------|----------|
| Underlying not found | `unresolved: ["MCX:GOLD:FUT (not found)"]` |
| Multiple non-expired FUT | `unresolved: ["MCX:GOLD:FUT (ambiguous — MCX:GOLD-26JUN26FUT, MCX:GOLD-30JUL26FUT)"]` |
| All contracts expired | `unresolved: ["MCX:GOLD:FUT (no active contracts)"]` |
| Options LTP unavailable | Fallback ATM selection; if ambiguous, return candidates |

## Exchange Preference Order

When no exchange is specified (e.g., `GOLD:FUT`):
1. MCX (commodities)
2. NFO (Indian equity derivatives)
3. BFO
4. First match found

## Non-Breaking

- Existing subscriptions work unchanged
- No DB migration (uses existing `expiry` column)
- No breaking changes to public API

## Test Cases

1. `MCX:GOLD:FUT` → resolves to nearest gold futures contract
2. `NFO:NIFTY:FUT` → resolves to nearest Nifty futures contract
3. `NFO:BANKNIFTY:CE` → resolves to nearest ATM BankNifty CE
4. `GOLD:FUT` (no exchange) → picks MCX first
5. `INVALID:FUT` → not_found error
6. Multiple non-expired → ambiguous with candidates