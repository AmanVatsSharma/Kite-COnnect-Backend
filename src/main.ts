import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { join } from 'path';
import { existsSync } from 'fs';
import * as express from 'express';
import * as compression from 'compression';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { HttpExceptionFilter } from '@shared/common/filters/http-exception.filter';
import { ResponseInterceptor } from '@shared/common/interceptors/response.interceptor';
import { RequestIdInterceptor } from '@shared/interceptors/request-id.interceptor';
import { RateLimitInterceptor } from '@shared/interceptors/rate-limit.interceptor';
import { RedisService } from '@infra/redis/redis.service';
import { MetricsInterceptor } from '@shared/interceptors/metrics.interceptor';
import { OriginAuditInterceptor } from '@shared/interceptors/origin-audit.interceptor';
import { NativeWsService } from '@features/market-data/application/native-ws.service';
import { initSentry } from '@infra/observability/sentry';
import { initOpenTelemetry } from '@infra/observability/otel';

import { RedisIoAdapter } from '@infra/adapters/redis-io.adapter';

// Basic Auth for Swagger (hardcoded per request)
const SWAGGER_USERNAME = 'support@vedpragya.com';
const SWAGGER_PASSWORD = 'aman1sharma';

function swaggerBasicAuth(req: any, res: any, next: any) {
  const authLogger = new Logger('SwaggerBasicAuth');
  const realm = 'Swagger Docs';
  const authHeader = req.headers['authorization'];
  if (
    !authHeader ||
    typeof authHeader !== 'string' ||
    !authHeader.startsWith('Basic ')
  ) {
    res.setHeader('WWW-Authenticate', `Basic realm="${realm}"`);
    authLogger.warn(
      `[401] Missing/invalid Authorization for ${req.method} ${req.originalUrl}`,
    );
    return res.status(401).send('Authentication required.');
  }
  try {
    const base64Credentials = authHeader.slice(6).trim();
    const decoded = Buffer.from(base64Credentials, 'base64').toString('utf8');
    const sepIndex = decoded.indexOf(':');
    const username = sepIndex >= 0 ? decoded.slice(0, sepIndex) : decoded;
    const password = sepIndex >= 0 ? decoded.slice(sepIndex + 1) : '';
    if (username === SWAGGER_USERNAME && password === SWAGGER_PASSWORD) {
      return next();
    }
    res.setHeader('WWW-Authenticate', `Basic realm="${realm}"`);
    authLogger.warn(
      `[401] Invalid credentials user="${username}" for ${req.method} ${req.originalUrl}`,
    );
    return res.status(401).send('Invalid credentials.');
  } catch (e) {
    authLogger.error(
      `[500] Error decoding Authorization for ${req.method} ${req.originalUrl}`,
      e,
    );
    return res.status(500).send('Auth error.');
  }
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  try {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    const configService = app.get(ConfigService);
    // Observability (dynamic, safe when deps are missing)
    try {
      initSentry(configService);
    } catch {}
    try {
      await initOpenTelemetry(configService);
    } catch {}

    // Guidance: if Kite credentials are not configured, keep app running and guide user to login
    const kiteApiKey = configService.get('KITE_API_KEY');
    const kiteAccessToken = configService.get('KITE_ACCESS_TOKEN');
    if (!kiteApiKey || !kiteAccessToken) {
      logger.warn(
        'Kite credentials not configured (KITE_API_KEY / KITE_ACCESS_TOKEN)',
      );
      logger.warn(
        'The server will start without live ticker. To connect Kite:',
      );
      logger.warn('1) Set KITE_API_KEY and KITE_API_SECRET in .env');
      logger.warn(
        '2) Open GET /api/auth/kite/login to obtain the OAuth URL and complete login',
      );
      logger.warn(
        '3) After callback, ticker will auto-restart with the new access token',
      );
    }

    // Security middleware
    // app.use(helmet());
    app.use(compression());

    // Global validation pipe
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    // Global filters & interceptors
    app.useGlobalFilters(new HttpExceptionFilter());
    // Metrics (Prometheus)
    app.useGlobalInterceptors(app.get(MetricsInterceptor));
    // Per-request origin audit (API key, IP, UA, etc.)
    try {
      app.useGlobalInterceptors(app.get(OriginAuditInterceptor));
    } catch (e) {
      logger.warn(
        'OriginAuditInterceptor not initialized; continuing without origin auditing',
        e as any,
      );
    }
    app.useGlobalInterceptors(new RequestIdInterceptor());
    app.useGlobalInterceptors(new ResponseInterceptor());
    // Rate limiting (per API key and IP)
    try {
      const redis = app.get(RedisService);
      app.useGlobalInterceptors(new RateLimitInterceptor(redis, configService));
    } catch (e) {
      logger.warn(
        'Rate limiter not initialized; continuing without throttling',
        e as any,
      );
    }

    // CORS configuration (admin dashboard sends x-admin-token / x-api-key)
    app.enableCors({
      origin: configService.get('CORS_ORIGIN', '*'),
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'x-admin-token',
        'x-api-key',
        'x-provider',
      ],
      credentials: true,
    });

    // Redis Adapter for Socket.IO
    const redisIoAdapter = new RedisIoAdapter(app);
    await redisIoAdapter.connectToRedis();
    app.useWebSocketAdapter(redisIoAdapter);

    // Global prefix
    app.setGlobalPrefix('api');

    // Static: Vite SPA in public/dashboard + legacy HTML at public root (URLs under /dashboard/*)
    const publicRoot = existsSync(join(__dirname, 'public'))
      ? join(__dirname, 'public')
      : join(process.cwd(), 'src', 'public');
    const spaRoot = join(publicRoot, 'dashboard');
    const spaIndexPath = join(spaRoot, 'index.html');
    if (!existsSync(spaIndexPath)) {
      logger.error(
        `Admin SPA missing (${spaIndexPath}). Run: npm run admin:build`,
      );
      if (process.env.NODE_ENV === 'production') {
        logger.error(
          'Refusing to start in production without dashboard assets.',
        );
        process.exit(1);
      }
    }
    app.use('/dashboard', express.static(spaRoot, { index: 'index.html' }));
    app.use('/dashboard', express.static(publicRoot));
    app.use(
      '/dashboard',
      (
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        if (req.method !== 'GET') return next();
        const pathOnly = req.path.split('?')[0];
        if (pathOnly.includes('.') && !pathOnly.endsWith('/')) return next();
        res.sendFile(join(spaRoot, 'index.html'), (err) => next(err));
      },
    );

    // Protect Swagger endpoints with Basic Auth
    // Note: cover both UI and potential JSON endpoints
    app.use(
      ['/api/docs', '/api/docs/json', '/api-json', '/api/docs-json'],
      swaggerBasicAuth,
    );

    // Swagger setup
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Trading Data Provider API')
      .setDescription(
        'Pluggable providers: Kite and Vortex. Use optional x-provider header for HTTP; WS uses a global provider set by admin endpoint.',
      )
      .setVersion('1.0.0')
      .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'apiKey')
      .addApiKey(
        { type: 'apiKey', name: 'x-admin-token', in: 'header' },
        'admin',
      )
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'json' });

    // Explicitly expose JSON under /api/docs/json as well (fallback for UI link alignment)
    try {
      const httpAdapter: any = app.getHttpAdapter();
      const expressInstance = httpAdapter.getInstance?.() ?? httpAdapter;
      if (expressInstance && typeof expressInstance.get === 'function') {
        expressInstance.get('/api/docs/json', (req: any, res: any) =>
          res.json(document),
        );
      }
    } catch (e) {
      logger.warn(
        'Failed to bind /api/docs/json route for Swagger JSON; default /api-json may be used instead.',
        e,
      );
    }

    const port = configService.get('PORT', 3000);
    await app.listen(port);

    // Initialize native WebSocket server on /ws path (behind Nginx SSL)
    try {
      const httpServer = app.getHttpServer();
      const nativeWs = app.get(NativeWsService);
      await nativeWs.init(httpServer, '/ws');
    } catch (e) {
      // Console for easy later debugging
      // eslint-disable-next-line no-console
      console.error('[Bootstrap] Failed to init NativeWsService', e);
    }

    logger.log(`🚀 Trading App Backend is running on port ${port}`);
    logger.log(
      `📊 Health check available at http://localhost:${port}/api/health`,
    );
    logger.log(`📘 Swagger docs at http://localhost:${port}/api/docs`);
    logger.log(`🧭 Admin dashboard at http://localhost:${port}/dashboard/`);
    logger.log(`📈 WebSocket available at ws://localhost:${port}/market-data`);
    if (!kiteApiKey || !kiteAccessToken) {
      logger.log(
        '🟡 Kite is disconnected. Visit http://localhost:' +
          port +
          '/api/auth/kite/login to start OAuth',
      );
    }
  } catch (error) {
    logger.error('❌ Failed to start application', error);
    process.exit(1);
  }
}

bootstrap();
