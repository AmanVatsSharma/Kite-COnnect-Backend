import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Instrument } from '../entities/instrument.entity';
import { MarketData } from '../entities/market-data.entity';
import { Subscription } from '../entities/subscription.entity';
import { KiteSession } from '../entities/kite-session.entity';
import { ApiKey } from '../entities/api-key.entity';
import { InstrumentMapping } from '../entities/instrument-mapping.entity';
import { VortexSession } from '../entities/vortex-session.entity';
import { VortexInstrument } from '../entities/vortex-instrument.entity';

export const getDatabaseConfig = (
  configService: ConfigService,
): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: configService.get('DB_HOST', 'localhost'),
  port: configService.get('DB_PORT', 5432),
  username: configService.get('DB_USERNAME', 'trading_user'),
  password: configService.get('DB_PASSWORD', 'trading_password'),
  database: configService.get('DB_DATABASE', 'trading_app'),
  entities: [
    Instrument,
    MarketData,
    Subscription,
    KiteSession,
    ApiKey,
    InstrumentMapping,
    VortexSession,
    VortexInstrument,
  ],
  synchronize: configService.get('DB_SYNCHRONIZE', 'true') === 'true', // Auto-sync schema (creates/updates tables based on entities)
  logging: configService.get('NODE_ENV') === 'development' || configService.get('DB_LOGGING', 'false') === 'true',
  migrations: ['dist/migrations/*.js'],
  migrationsRun: configService.get('DB_MIGRATIONS_RUN', 'false') === 'true', // Set to true to auto-run migrations on startup
  ssl: configService.get('DB_SSL', 'false') === 'true', // Enable SSL if needed
  // Console for easy debugging
  // eslint-disable-next-line no-console
  // Note: synchronize=true will auto-create/update tables based on entity definitions
  // This ensures the description field and other changes are automatically synced
});
