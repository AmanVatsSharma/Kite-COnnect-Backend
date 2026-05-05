/** Shared API response shapes (subset of backend). */

export interface ApiKeyRow {
  id?: string;
  key: string;
  tenant_id: string;
  name?: string | null;
  is_active: boolean;
  rate_limit_per_minute?: number;
  connection_limit?: number;
  ws_subscribe_rps?: number | null;
  ws_unsubscribe_rps?: number | null;
  ws_mode_rps?: number | null;
  provider?: 'kite' | 'vortex' | 'massive' | 'binance' | null;
  metadata?: { exchanges?: string[] } | null;
  created_at?: string;
}

export interface UsageReport {
  [k: string]: unknown;
}

export interface ApiKeyUsageItem {
  key: string;
  tenant_id: string;
  is_active: boolean;
  limits: Record<string, unknown>;
  usage: UsageReport;
}

export interface PaginatedUsage {
  page: number;
  pageSize: number;
  total: number;
  items: ApiKeyUsageItem[];
}

export interface GlobalProviderRes {
  provider: string | null;
}

export interface StreamStatus {
  [k: string]: unknown;
}

export interface WsStatus {
  protocol_version?: string;
  namespace?: string;
  connections?: number;
  subscriptions?: unknown[];
  byApiKey?: unknown[];
  provider?: unknown;
  redis_ok?: boolean;
}

export interface WsConfig {
  rate_limits: {
    subscribe_rps: number;
    unsubscribe_rps: number;
    mode_rps: number;
  };
  maxSubscriptionsPerSocket: number;
  entitlement_defaults: string[];
}

export interface AuditConfig {
  http_sample_rate: number;
  http_always_log_errors: boolean;
  ws_sub_sample_rate: number;
}

export interface AbuseFlag {
  id?: string;
  api_key: string;
  tenant_id?: string | null;
  risk_score: number;
  reason_codes?: string[];
  blocked: boolean;
  detected_at?: string;
  last_seen_at?: string;
}

export interface PaginatedAbuse {
  page: number;
  pageSize: number;
  total: number;
  items: AbuseFlag[];
}

// ─── Falcon (Kite) types ───────────────────────────────────────────────────

export interface FalconInstrument {
  instrument_token: number;
  exchange_token: number;
  tradingsymbol: string;
  name: string;
  last_price: number;
  expiry: string | null;
  strike: number | null;
  tick_size: number;
  lot_size: number;
  instrument_type: string;
  segment: string;
  exchange: string;
  is_active: boolean;
  description: string | null;
}

export interface FalconStats {
  total: number;
  active: number;
  inactive: number;
  by_exchange: Record<string, number>;
  by_type: Record<string, number>;
}

export interface FalconOhlc {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface FalconQuoteDepthItem {
  quantity: number;
  price: number;
  orders: number;
}

export interface FalconQuote {
  instrument_token: number;
  timestamp: string;
  last_trade_time: string;
  last_price: number;
  last_traded_quantity: number;
  average_traded_price: number;
  volume_traded: number;
  total_buy_quantity: number;
  total_sell_quantity: number;
  ohlc: FalconOhlc;
  change: number;
  oi: number;
  oi_day_high: number;
  oi_day_low: number;
  depth: {
    buy: FalconQuoteDepthItem[];
    sell: FalconQuoteDepthItem[];
  };
}

/** [date, open, high, low, close, volume, oi?] */
export type FalconCandle = [
  string,
  number,
  number,
  number,
  number,
  number,
  number?,
];

export interface KiteProfile {
  user_id: string;
  user_name: string;
  user_shortname: string;
  email: string;
  user_type: string;
  broker: string;
  exchanges: string[];
  products: string[];
  order_types: string[];
  avatar_url: string | null;
}

export interface KiteMarginDetail {
  enabled: boolean;
  net: number;
  available: {
    adhoc_margin: number;
    cash: number;
    opening_balance: number;
    live_balance: number;
    collateral: number;
    intraday_payin: number;
  };
  utilised: Record<string, number>;
}

export interface KiteMargins {
  equity?: KiteMarginDetail;
  commodity?: KiteMarginDetail;
}
