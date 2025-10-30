import { Module } from '@nestjs/common';
import { SearchModule } from './search/search.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [SearchModule, HealthModule],
})
export class AppModule {}


