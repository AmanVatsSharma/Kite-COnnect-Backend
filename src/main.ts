import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import helmet from 'helmet';
import compression from 'compression';
import * as path from 'path';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { MetricsInterceptor } from './interceptors/metrics.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
   
  try {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    const configService = app.get(ConfigService);

    // Guidance: if Kite credentials are not configured, keep app running and guide user to login
    const kiteApiKey = configService.get('KITE_API_KEY');
    const kiteAccessToken = configService.get('KITE_ACCESS_TOKEN');
    if (!kiteApiKey || !kiteAccessToken) {
      logger.warn('Kite credentials not configured (KITE_API_KEY / KITE_ACCESS_TOKEN)');
      logger.warn('The server will start without live ticker. To connect Kite:');
      logger.warn('1) Set KITE_API_KEY and KITE_API_SECRET in .env');
      logger.warn('2) Open GET /api/auth/kite/login to obtain the OAuth URL and complete login');
      logger.warn('3) After callback, ticker will auto-restart with the new access token');
    }

    // Security middleware
    if (configService.get('NODE_ENV') === 'production') {
      app.use(helmet());
    }
    app.use(compression());

    // Global validation pipe
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    // Metrics interceptor
    app.useGlobalInterceptors(app.get(MetricsInterceptor));

    // CORS configuration
    app.enableCors({
      origin: configService.get('CORS_ORIGIN', '*'),
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-admin-token'],
      credentials: true,
    });

    // Global prefix
    app.setGlobalPrefix('api');

    // Serve static dashboard from compiled dist in production, src in dev
    const staticRoot = configService.get('NODE_ENV') === 'production'
      ? path.join(__dirname, 'public')
      : path.join(process.cwd(), 'src', 'public');
    app.useStaticAssets(staticRoot, { prefix: '/dashboard', index: ['dashboard.html'] });

    // Swagger setup
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Trading Data Provider API')
      .setDescription('Pluggable providers: Kite and Vortex. Use optional x-provider header for HTTP; WS uses a global provider set by admin endpoint.')
      .setVersion('1.0.0')
      .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'apiKey')
      .addApiKey({ type: 'apiKey', name: 'x-admin-token', in: 'header' }, 'admin')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);

    const port = configService.get('PORT', 3000);
    await app.listen(port);

    logger.log(`🚀 Trading App Backend is running on port ${port}`);
    logger.log(`📊 Health check available at http://localhost:${port}/api/health`);
    logger.log(`📘 Swagger docs at http://localhost:${port}/api/docs`);
    logger.log(`📈 WebSocket available at ws://localhost:${port}/market-data`);
    if (!kiteApiKey || !kiteAccessToken) {
      logger.log('🟡 Kite is disconnected. Visit http://localhost:' + port + '/api/auth/kite/login to start OAuth');
    }
  } catch (error) {
    logger.error('❌ Failed to start application', error);
    process.exit(1);
  }
}

bootstrap();
