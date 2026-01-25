import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FalconController } from './interface/falcon.controller';
import { FalconInstrument } from './domain/falcon-instrument.entity';
import { FalconInstrumentService } from './application/falcon-instrument.service';
import { FalconProviderAdapter } from './infra/falcon-provider.adapter';
import { RedisModule } from '@infra/redis/redis.module';
import { StockModule } from '../stock/stock.module';
import { AuthModule } from '../auth/auth.module';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([FalconInstrument]),
    RedisModule,
    forwardRef(() => StockModule),
    AuthModule,
    MarketDataModule,
  ],
  controllers: [FalconController],
  providers: [FalconInstrumentService, FalconProviderAdapter],
  exports: [FalconInstrumentService],
})
export class FalconModule {}
