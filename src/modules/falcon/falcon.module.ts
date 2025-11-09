import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FalconController } from './controllers/falcon.controller';
import { FalconInstrument } from './entities/falcon-instrument.entity';
import { FalconInstrumentService } from './services/falcon-instrument.service';
import { FalconProviderAdapter } from './services/falcon-provider.adapter';
import { RedisService } from '../../services/redis.service';
import { Instrument } from '../../entities/instrument.entity';
import { InstrumentMapping } from '../../entities/instrument-mapping.entity';
import { StockModule } from '../stock/stock.module';
import { ApiKey } from '../../entities/api-key.entity';
import { ApiKeyGuard } from '../../guards/api-key.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([FalconInstrument, Instrument, InstrumentMapping, ApiKey]),
    forwardRef(() => StockModule),
  ],
  controllers: [FalconController],
  providers: [FalconInstrumentService, FalconProviderAdapter, RedisService, ApiKeyGuard],
  exports: [FalconInstrumentService],
})
export class FalconModule {}


