import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse() as any;
      message = r?.message || exception.message || message;
    }

    const payload = {
      success: false,
      message,
      traceId: request.headers['x-request-id'] || undefined,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    this.logger.error(
      `HTTP ${status} ${request.method} ${request.url} -> ${message}`,
    );
    response.status(status).json(payload);
  }
}


