import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import * as helmet from 'helmet';
import * as compression from 'compression';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { MetricsInterceptor } from './interceptors/metrics.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
   
  try {
    const app = await NestFactory.create(AppModule);
    const configService = app.get(ConfigService);

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

    // Metrics interceptor
    app.useGlobalInterceptors(app.get(MetricsInterceptor));

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
    app.useStaticAssets('src/public', { prefix: '/dashboard' });

    // Swagger setup
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Trading Data Provider API')
      .setDescription('Kite-backed market data provider for NSE/MCX')
      .setVersion('1.0.0')
      .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'apiKey')
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
  } catch (error) {
    logger.error('❌ Failed to start application', error);
    process.exit(1);
  }
}

bootstrap();
