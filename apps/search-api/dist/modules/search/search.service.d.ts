export type StreamProviderName = 'kite' | 'vortex' | 'massive' | 'binance';
export type SearchResultItem = {
  id: number;
  canonicalSymbol: string;
  symbol: string;
  name?: string;
  exchange?: string;
  segment?: string;
  instrumentType?: string;
  assetClass?: string;
  optionType?: string | null;
  expiry?: string | null;
  strike?: number | null;
  lotSize?: number;
  tickSize?: number;
  isDerivative?: boolean;
  underlyingSymbol?: string;
  kiteToken?: number;
  vortexToken?: number;
  vortexExchange?: string;
  massiveToken?: string;
  binanceToken?: string;
  streamProvider?: StreamProviderName;
};
export declare const PUBLIC_FIELD_ALLOWLIST: readonly string[];
export declare const PUBLIC_ALWAYS_INCLUDED: readonly string[];
export declare const INTERNAL_ONLY_FIELDS: readonly string[];
export declare class SearchService {
  private readonly logger;
  private readonly meili;
  private readonly hydrator;
  private readonly redis?;
  private hydrationFailures;
  private hydrationBreakerUntil;
  constructor();
  private static readonly DEFAULT_ATTRS_TO_RETRIEVE;
  searchInstruments(
    q: string,
    limit?: number,
    filters?: {
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
    },
    attributesToRetrieve?: readonly string[],
  ): Promise<SearchResultItem[]>;
  facetCounts(
    filters?: Record<string, string | undefined>,
  ): Promise<Record<string, any>>;
  hydrateQuotes(
    tokens: number[],
    mode?: 'ltp' | 'ohlc' | 'full',
  ): Promise<Record<string, any>>;
  hydrateLtpByItems(items: SearchResultItem[]): Promise<Record<string, any>>;
  logSelectionTelemetry(
    q: string,
    symbol: string,
    universalId?: number,
  ): Promise<void>;
  buildFilter(filters: Record<string, any>): string | undefined;
  private dedupeById;
}
