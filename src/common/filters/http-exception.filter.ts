import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? (exception as HttpException).getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const payload: any = {
      success: false,
      statusCode: status,
      path: request?.url,
      timestamp: new Date().toISOString(),
    };

    if (isHttp) {
      const res = (exception as HttpException).getResponse() as any;
      if (typeof res === 'string') {
        payload.message = res;
      } else if (res && typeof res === 'object') {
        payload.message = res.message || res.error || 'Request failed';
        if (res.error) payload.error = res.error;
        if (res.details) payload.details = res.details;
      }
    } else {
      payload.message = 'Internal server error';
    }

    try {
      response.status(status).json(payload);
    } catch {
      // fallback
      response.status(status).send(payload);
    }
  }
}


