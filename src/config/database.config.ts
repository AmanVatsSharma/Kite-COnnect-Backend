import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Instrument } from '@features/market-data/domain/instrument.entity';
import { MarketData } from '@features/market-data/domain/market-data.entity';
import { Subscription } from '@features/market-data/domain/subscription.entity';
import { KiteSession } from '@features/kite-connect/domain/kite-session.entity';
import { ApiKey } from '@features/auth/domain/api-key.entity';
import { InstrumentMapping } from '@features/market-data/domain/instrument-mapping.entity';
import { VortexSession } from '@features/stock/domain/vortex-session.entity';
import { VortexInstrument } from '@features/stock/domain/vortex-instrument.entity';
import { FalconInstrument } from '@features/falcon/domain/falcon-instrument.entity';
import { RequestAuditLog } from '@features/admin/domain/request-audit-log.entity';
import { ApiKeyAbuseFlag } from '@features/auth/domain/api-key-abuse-flag.entity';
import { AppConfig } from '@infra/app-config/app-config.entity';
import { UniversalInstrument } from '@features/market-data/domain/universal-instrument.entity';

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
    FalconInstrument,
    RequestAuditLog,
    ApiKeyAbuseFlag,
    AppConfig,
    UniversalInstrument,
  ],
  // In production, prefer running migrations over synchronize
  // Override with DB_SYNCHRONIZE=true only for development
  synchronize: configService.get('DB_SYNCHRONIZE', 'false') === 'true',
  logging: configService.get('NODE_ENV') === 'development' || configService.get('DB_LOGGING', 'false') === 'true',
  migrations: ['dist/migrations/*.js'],
  // Enable auto-run migrations by default; disable with DB_MIGRATIONS_RUN=false if managed externally
  migrationsRun: configService.get('DB_MIGRATIONS_RUN', 'true') === 'true',
  ssl: configService.get('DB_SSL', 'false') === 'true', // Enable SSL if needed
  // Console for easy debugging
  // eslint-disable-next-line no-console
  // Note: synchronize=true will auto-create/update tables based on entity definitions
  // This ensures the description field and other changes are automatically synced
});
