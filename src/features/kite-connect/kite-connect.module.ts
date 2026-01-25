import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { KiteConnectService } from './application/kite-connect.service';
import { KiteProviderService } from './infra/kite-provider.service';
import { KiteSession } from './domain/kite-session.entity';
import { RedisModule } from '@infra/redis/redis.module';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([KiteSession]),
    ConfigModule,
    RedisModule,
  ],
  providers: [KiteConnectService, KiteProviderService],
  exports: [KiteConnectService, KiteProviderService, TypeOrmModule],
})
export class KiteConnectModule {}
