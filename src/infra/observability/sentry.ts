import { ConfigService } from '@nestjs/config';

export function initSentry(config: ConfigService) {
  try {
    const dsn = config.get('SENTRY_DSN');
    const env = config.get('NODE_ENV', 'development');
    if (!dsn) return;
    // Use dynamic require to avoid build-time dependency if not installed
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require('@sentry/node');
    const tracesSampleRate = Number(config.get('SENTRY_TRACES_SAMPLE_RATE', 0.1));
    Sentry.init({ dsn, environment: env, tracesSampleRate });
    // eslint-disable-next-line no-console
    console.log('[Sentry] Initialized with DSN');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[Sentry] Initialization skipped or failed:', (e as any)?.message);
  }
}


