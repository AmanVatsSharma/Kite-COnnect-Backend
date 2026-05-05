import { Response, Request } from 'express';
import { SearchService } from './search.service';
type PublicSearchResultItem = {
  id: number;
  canonicalSymbol: string;
  wsSubscribeUirId: number;
  last_price: number | null;
  priceStatus: 'live' | 'stale';
  streamProvider?: 'falcon' | 'vayu' | 'atlas' | 'drift';
  [k: string]: unknown;
};
export declare class SearchController {
  private readonly searchService;
  private readonly logger;
  constructor(searchService: SearchService);
  search(
    q: string,
    limitRaw?: string,
    exchange?: string,
    segment?: string,
    instrumentType?: string,
    vortexExchange?: string,
    optionType?: string,
    assetClass?: string,
    streamProvider?: string,
    mode?: string,
    expiry_from?: string,
    expiry_to?: string,
    strike_min?: string,
    strike_max?: string,
    ltpOnlyRaw?: string | boolean,
    fieldsRaw?: string,
    includeRaw?: string,
    adminTokenHeader?: string,
  ): Promise<{
    success: boolean;
    data: PublicSearchResultItem[];
    timestamp: string;
  }>;
  suggest(
    q: string,
    limitRaw?: string,
    exchange?: string,
    segment?: string,
    instrumentType?: string,
    vortexExchange?: string,
    optionType?: string,
    streamProvider?: string,
    mode?: string,
    expiry_from?: string,
    expiry_to?: string,
    strike_min?: string,
    strike_max?: string,
    ltpOnlyRaw?: string | boolean,
    fieldsRaw?: string,
    includeRaw?: string,
    adminTokenHeader?: string,
  ): Promise<{
    success: boolean;
    data: PublicSearchResultItem[];
    timestamp: string;
  }>;
  filters(
    exchange?: string,
    segment?: string,
    instrumentType?: string,
    assetClass?: string,
  ): Promise<{
    success: boolean;
    data: Record<string, any>;
    timestamp: string;
  }>;
  schema(): {
    success: boolean;
    data: {
      endpoints: {
        search: string;
        suggest: string;
        filters: string;
        schema: string;
        stream: string;
      };
      params: {
        q: {
          type: string;
          required: boolean;
          note: string;
        };
        limit: {
          type: string;
          default: number;
          max: number;
        };
        exchange: {
          type: string;
          filterable: boolean;
          enums: string[];
        };
        segment: {
          type: string;
          filterable: boolean;
          enums: string[];
        };
        instrumentType: {
          type: string;
          filterable: boolean;
          enums: string[];
        };
        assetClass: {
          type: string;
          filterable: boolean;
          enums: string[];
          note: string;
        };
        streamProvider: {
          type: string;
          filterable: boolean;
          enums: string[];
          note: string;
        };
        optionType: {
          type: string;
          filterable: boolean;
          enums: string[];
          note: string;
        };
        isDerivative: {
          type: string;
          filterable: boolean;
          note: string;
        };
        mode: {
          type: string;
          note: string;
        };
        expiry_from: {
          type: string;
          format: string;
          note: string;
        };
        expiry_to: {
          type: string;
          format: string;
          note: string;
        };
        strike_min: {
          type: string;
          note: string;
        };
        strike_max: {
          type: string;
          note: string;
        };
        ltp_only: {
          type: string;
          default: boolean;
          note: string;
        };
        fields: {
          type: string;
          note: string;
        };
      };
      responseFields: {
        id: string;
        wsSubscribeUirId: string;
        canonicalSymbol: string;
        last_price: string;
        priceStatus: string;
        streamProvider: string;
      };
      wsSubscribe: {
        note: string;
        example: {
          event: string;
          data: {
            instruments: number[];
            mode: string;
          };
        };
      };
      filterTip: string;
    };
    timestamp: string;
  };
  popular(limitRaw?: string): Promise<{
    success: boolean;
    data: never[];
    timestamp: string;
  }>;
  selection(body: {
    q?: string;
    symbol?: string;
    universalId?: number;
    instrumentToken?: number;
  }): Promise<{
    success: boolean;
  }>;
  stream(
    res: Response,
    req: Request,
    idsRaw?: string,
    tokensRaw?: string,
    q?: string,
    ltpOnlyRaw?: string | boolean,
  ): Promise<void>;
}
export {};
