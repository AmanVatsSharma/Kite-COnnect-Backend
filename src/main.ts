import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import * as helmet from 'helmet';
import * as compression from 'compression';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { MetricsInterceptor } from './interceptors/metrics.interceptor';
import { NativeWsService } from './services/native-ws.service';

// Basic Auth for Swagger (hardcoded per request)
const SWAGGER_USERNAME = 'support@vedpragya.com';
const SWAGGER_PASSWORD = 'aman1sharma';

function swaggerBasicAuth(req: any, res: any, next: any) {
  const authLogger = new Logger('SwaggerBasicAuth');
  const realm = 'Swagger Docs';
  const authHeader = req.headers['authorization'];
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', `Basic realm="${realm}"`);
    authLogger.warn(`[401] Missing/invalid Authorization for ${req.method} ${req.originalUrl}`);
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
    authLogger.warn(`[401] Invalid credentials user="${username}" for ${req.method} ${req.originalUrl}`);
    return res.status(401).send('Invalid credentials.');
  } catch (e) {
    authLogger.error(`[500] Error decoding Authorization for ${req.method} ${req.originalUrl}`, e);
    return res.status(500).send('Auth error.');
  }
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  try {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    const configService = app.get(ConfigService);

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
    app.useGlobalInterceptors(app.get(MetricsInterceptor));
    app.useGlobalInterceptors(new ResponseInterceptor());

    // CORS configuration
    app.enableCors({
      origin: configService.get('CORS_ORIGIN', '*'),
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    });

    // Global prefix
    app.setGlobalPrefix('api');

    // Serve static dashboard
    app.useStaticAssets('src/public', {
      prefix: '/dashboard',
      index: ['dashboard.html'],
    });

    // Protect Swagger endpoints with Basic Auth
    // Note: cover both UI and potential JSON endpoints
    app.use(['/api/docs', '/api/docs/json', '/api-json', '/api/docs-json'], swaggerBasicAuth);

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
        expressInstance.get('/api/docs/json', (req: any, res: any) => res.json(document));
      }
    } catch (e) {
      logger.warn('Failed to bind /api/docs/json route for Swagger JSON; default /api-json may be used instead.', e);
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
