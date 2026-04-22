import { Controller, Get } from '@nestjs/common';

const startedAt = Date.now();

@Controller('health')
export class HealthController {
  @Get()
  get() {
    return {
      status: 'ok',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('metrics')
  metrics() {
    // Placeholder metrics; can be extended with Prometheus exporter
    return {
      success: true,
      data: {
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      },
      timestamp: new Date().toISOString(),
    };
  }
}


