import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, register } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly httpRequestsTotal: Counter;
  readonly httpRequestDuration: Histogram;

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
  }

  getMetricsRegister() {
    return register;
  }
}
