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
  }

  getMetricsRegister() {
    return register;
  }
}
