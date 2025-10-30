import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './modules/app.module';
import { HttpExceptionFilter } from './modules/common/http-exception.filter';
import { LoggingInterceptor } from './modules/common/logging.interceptor';
import { TimeoutInterceptor } from './modules/common/timeout.interceptor';

async function bootstrap() {
  const logger = new Logger('search-api-bootstrap');
  try {
    const app = await NestFactory.create(AppModule, { bufferLogs: true });
    app.setGlobalPrefix('api');

    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true })
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new LoggingInterceptor(), new TimeoutInterceptor());

    const port = Number(process.env.PORT || 3000);
    await app.listen(port);
    logger.log(`search-api listening on ${port}`);
  } catch (err: any) {
    // Console for easy later debugging
    // Critical startup error: crash with non-zero status to trigger restarts
    // eslint-disable-next-line no-console
    console.error('search-api failed to start', err?.stack || err);
    process.exit(1);
  }
}

bootstrap();


