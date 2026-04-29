import {
  ExceptionFilter, Catch, ArgumentsHost,
  HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = uuidv4();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        error = (b['error'] as string) ?? exception.name;
        message = (b['message'] as string) ?? exception.message;
        details = b['details'];
        // Merge all extra fields as details
        if (!details) {
          const { error: _e, message: _m, statusCode: _s, ...rest } = b;
          if (Object.keys(rest).length) details = rest;
        }
      } else {
        message = String(body);
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(`[Unhandled] ${exception.message}`, exception.stack);
    }

    res.status(status).json({
      statusCode: status,
      error,
      message,
      ...(details ? { details } : {}),
      requestId,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}