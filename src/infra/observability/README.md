# Observability

This module wires optional Sentry error monitoring and OpenTelemetry tracing. Both are disabled by default unless configured via environment variables. Dependencies are loaded dynamically to avoid hard requirements when disabled.

## Environment

- Sentry
  - SENTRY_DSN: Set to enable Sentry. Example: `https://<key>@sentry.io/<project>`
  - SENTRY_TRACES_SAMPLE_RATE: Fraction (0.0–1.0), default 0.1

- OpenTelemetry
  - OTEL_ENABLED: `true` to enable (default `false`)
  - OTEL_SERVICE_NAME: Service name, default `trading-backend`

## Installation (optional)

```bash
npm install @sentry/node @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/resources @opentelemetry/semantic-conventions --save
```

## Notes
- If env vars are not set or packages are not installed, initialization is skipped safely.
- Prometheus metrics exposed at `GET /api/health/metrics`.

