import { ConfigService } from '@nestjs/config';

let started = false;

export async function initOpenTelemetry(config: ConfigService) {
  try {
    if (started) return;
    const enabled = String(config.get('OTEL_ENABLED', 'false')) === 'true';
    if (!enabled) return;
    // Dynamic requires to avoid hard dep when disabled
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Resource } = require('@opentelemetry/resources');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

    const serviceName = config.get('OTEL_SERVICE_NAME', 'trading-backend');
    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: config.get('NODE_ENV', 'development'),
    });

    const sdk = new NodeSDK({
      resource,
      instrumentations: [getNodeAutoInstrumentations()],
    });
    await sdk.start();
    started = true;
    // eslint-disable-next-line no-console
    console.log('[OTel] OpenTelemetry SDK started');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[OTel] Initialization skipped or failed:', (e as any)?.message);
  }
}


