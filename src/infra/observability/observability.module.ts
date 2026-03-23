import { Module, Global } from '@nestjs/common';
import { MetricsInterceptor } from '@shared/interceptors/metrics.interceptor';
import { MetricsService } from './metrics.service';

@Global()
@Module({
  providers: [MetricsService, MetricsInterceptor],
  exports: [MetricsService, MetricsInterceptor],
})
export class ObservabilityModule {}
