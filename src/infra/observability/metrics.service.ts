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
  }

  getMetricsRegister() {
    return register;
  }
}
