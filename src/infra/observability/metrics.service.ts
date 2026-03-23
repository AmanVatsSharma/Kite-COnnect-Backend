/**
 * @file metrics.service.ts
 * @module infra/observability
 * @description Prometheus metrics registry and counters/gauges/histograms for HTTP, providers, market stream, Vortex WS.
 * @author BharatERP
 * @created 2025-01-01
 * @updated 2025-03-23
 */
import { Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
  register,
} from 'prom-client';

@Injectable()
export class MetricsService {
  readonly httpRequestsTotal: Counter;
  readonly httpRequestDuration: Histogram;
  readonly providerRequestsTotal: Counter;
  readonly providerRequestErrorsTotal: Counter;
  readonly providerLatencySeconds: Histogram;
  readonly ltpCacheHitTotal: Counter;
  readonly ltpCacheMissTotal: Counter;
  readonly providerQueueDepth: Gauge;
  readonly foSearchRequestsTotal: Counter;
  readonly foSearchLatencySeconds: Histogram;
  readonly httpRequestsByApiKeyTotal: Counter;
  readonly httpRequestsByCountryTotal: Counter;
  readonly wsConnectionsByApiKey: Gauge;
  readonly wsEventsByApiKeyTotal: Counter;
  /** Ingested tick messages from upstream provider (batch size summed in caller). */
  readonly marketDataStreamTicksIngestedTotal: Counter;
  /** Subscription/unsubscription queue evictions when caps are exceeded. */
  readonly marketDataStreamQueueDroppedTotal: Counter;
  /** Time to process one subscription batch window (subscribe + unsubscribe). */
  readonly marketDataStreamBatchSeconds: Histogram;
  /** 1 when upstream WS ticker is connected, 0 otherwise (low-cardinality). */
  readonly marketDataStreamTickerConnected: Gauge;
  /** 1 when active HTTP provider has no credentials / client (degraded), 0 otherwise. */
  readonly providerDegradedMode: Gauge;
  /** Vortex: subscribe dropped (per-shard cap or all shards full). */
  readonly vortexSubscribeDroppedTotal: Counter;
  /** Vortex: count of WebSocket shards currently connected (0–3). */
  readonly vortexWsShardsConnected: Gauge;

  constructor() {
    collectDefaultMetrics({ register });
    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status'],
      registers: [register],
    });
    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [register],
    });

    // Provider metrics
    this.providerRequestsTotal = new Counter({
      name: 'provider_requests_total',
      help: 'Total provider requests',
      labelNames: ['endpoint'],
      registers: [register],
    });
    this.providerRequestErrorsTotal = new Counter({
      name: 'provider_request_errors_total',
      help: 'Total provider request errors',
      labelNames: ['endpoint', 'error'],
      registers: [register],
    });
    this.providerLatencySeconds = new Histogram({
      name: 'provider_latency_seconds',
      help: 'Provider request latency seconds',
      labelNames: ['endpoint'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [register],
    });
    this.providerQueueDepth = new Gauge({
      name: 'provider_queue_depth',
      help: 'Approximate provider queue depth per endpoint',
      labelNames: ['endpoint'],
      registers: [register],
    });

    // LTP cache metrics
    this.ltpCacheHitTotal = new Counter({
      name: 'ltp_cache_hit_total',
      help: 'LTP cache hits by layer',
      labelNames: ['layer'],
      registers: [register],
    });
    this.ltpCacheMissTotal = new Counter({
      name: 'ltp_cache_miss_total',
      help: 'LTP cache misses by layer',
      labelNames: ['layer'],
      registers: [register],
    });

    // F&O search metrics
    this.foSearchRequestsTotal = new Counter({
      name: 'fo_search_requests_total',
      help: 'Total F&O search requests',
      labelNames: ['endpoint', 'ltp_only', 'parsed'],
      registers: [register],
    });
    this.foSearchLatencySeconds = new Histogram({
      name: 'fo_search_latency_seconds',
      help: 'F&O search latency in seconds',
      labelNames: ['endpoint', 'ltp_only'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [register],
    });

    // HTTP origin metrics (low-cardinality labels)
    this.httpRequestsByApiKeyTotal = new Counter({
      name: 'http_requests_by_api_key_total',
      help: 'Total HTTP requests by (truncated) API key label',
      labelNames: ['api_key', 'route'],
      registers: [register],
    });
    this.httpRequestsByCountryTotal = new Counter({
      name: 'http_requests_by_country_total',
      help: 'Total HTTP requests by country code',
      labelNames: ['country', 'route'],
      registers: [register],
    });

    // WebSocket metrics
    this.wsConnectionsByApiKey = new Gauge({
      name: 'ws_connections_by_api_key',
      help: 'Active WebSocket connections by API key',
      labelNames: ['api_key'],
      registers: [register],
    });
    this.wsEventsByApiKeyTotal = new Counter({
      name: 'ws_events_by_api_key_total',
      help: 'Total WebSocket events by API key and event type',
      labelNames: ['api_key', 'event'],
      registers: [register],
    });

    this.marketDataStreamTicksIngestedTotal = new Counter({
      name: 'market_data_stream_ticks_ingested_total',
      help: 'Total ticks ingested from provider ticker into stream service',
      labelNames: ['provider'],
      registers: [register],
    });
    this.marketDataStreamQueueDroppedTotal = new Counter({
      name: 'market_data_stream_queue_dropped_total',
      help: 'Dropped or evicted items from stream subscription queues',
      labelNames: ['reason'],
      registers: [register],
    });
    this.marketDataStreamBatchSeconds = new Histogram({
      name: 'market_data_stream_batch_seconds',
      help: 'Latency of subscription batch processing',
      labelNames: ['provider'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
      registers: [register],
    });
    this.marketDataStreamTickerConnected = new Gauge({
      name: 'market_data_stream_ticker_connected',
      help: 'Whether market data provider ticker WebSocket is connected (1=yes)',
      labelNames: ['provider'],
      registers: [register],
    });
    this.providerDegradedMode = new Gauge({
      name: 'provider_degraded_mode',
      help: 'Provider operating without full credentials or HTTP client (1=degraded)',
      labelNames: ['provider'],
      registers: [register],
    });
    this.vortexSubscribeDroppedTotal = new Counter({
      name: 'vortex_subscribe_dropped_total',
      help: 'Vortex upstream subscribe dropped (shard or global capacity)',
      labelNames: ['reason'],
      registers: [register],
    });
    this.vortexWsShardsConnected = new Gauge({
      name: 'vortex_ws_shards_connected',
      help: 'Connected Vortex WebSocket shards (max 3 per access token)',
      labelNames: ['provider'],
      registers: [register],
    });
  }

  getMetricsRegister() {
    return register;
  }
}
