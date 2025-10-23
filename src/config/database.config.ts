import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Instrument } from '../entities/instrument.entity';
import { MarketData } from '../entities/market-data.entity';
import { Subscription } from '../entities/subscription.entity';
import { KiteSession } from '../entities/kite-session.entity';
import { ApiKey } from '../entities/api-key.entity';
import { InstrumentMapping } from '../entities/instrument-mapping.entity';
import { VortexSession } from '../entities/vortex-session.entity';

export const getDatabaseConfig = (configService: ConfigService): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: configService.get('DB_HOST', 'localhost'),
  port: configService.get('DB_PORT', 5432),
  username: configService.get('DB_USERNAME', 'trading_user'),
  password: configService.get('DB_PASSWORD', 'trading_password'),
  database: configService.get('DB_DATABASE', 'trading_app'),
  entities: [Instrument, MarketData, Subscription, KiteSession, ApiKey, InstrumentMapping, VortexSession],
  synchronize: configService.get('NODE_ENV') === 'development',
  logging: configService.get('NODE_ENV') === 'development',
  migrations: ['dist/migrations/*.js'],
  // Allow enabling migrations on boot via env in production
  migrationsRun: (() => {
    const run = configService.get<string | boolean>('DB_MIGRATIONS_RUN', 'false');
    return String(run).toLowerCase() === 'true';
  })(),
  // SSL can be toggled via DB_SSL env for hosted Postgres providers
  ssl: (() => {
    const ssl = configService.get<string | boolean>('DB_SSL', false as unknown as string);
    if (String(ssl).toLowerCase() === 'true') {
      return { rejectUnauthorized: false } as unknown as boolean;
    }
    return false;
  })(),
});
