import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { tryCtx } from './context';

/** Business error with a stable machine-readable code. */
export class AppError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super({ statusCode: status, code, message, details }, status);
  }
}

export const Errors = {
  badRequest: (code: string, message: string, details?: unknown) => new AppError(400, code, message, details),
  unauthorized: (code = 'UNAUTHENTICATED', message = 'Please sign in to continue.') => new AppError(401, code, message),
  forbidden: (code = 'FORBIDDEN', message = 'You do not have permission to do this.') => new AppError(403, code, message),
  /** Also used for resources of another tenant: never reveal that they exist. */
  notFound: (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} was not found.`),
  conflict: (code: string, message: string, details?: unknown) => new AppError(409, code, message, details),
  unprocessable: (code: string, message: string, details?: unknown) => new AppError(422, code, message, details),
  tooMany: (message = 'Too many attempts. Please wait and try again.', details?: unknown) =>
    new AppError(429, 'RATE_LIMITED', message, details),
  notConfigured: (what: string, how: string) =>
    new AppError(503, 'INTEGRATION_NOT_CONFIGURED', `${what} is not configured. ${how}`),
  planLimit: (limit: string, message: string) => new AppError(402, 'PLAN_LIMIT_REACHED', message, { limit }),
};

/** Throw NOT_FOUND when a tenant-scoped lookup returns nothing. */
export function found<T>(value: T | null | undefined, what = 'Record'): T {
  if (value === null || value === undefined) throw Errors.notFound(what);
  return value;
}

const PG_MESSAGES: Array<[RegExp, number, string, string]> = [
  [/cross-tenant reference blocked/i, 403, 'TENANT_FORBIDDEN', 'That record does not belong to this centre.'],
  [/row-level security/i, 403, 'TENANT_FORBIDDEN', 'That record does not belong to this centre.'],
  [/is append-only|immutable|has been issued|never deleted|frozen once/i, 409, 'IMMUTABLE_RECORD', 'This record can no longer be changed. Use a correction (credit note, refund or new version) instead.'],
  [/violates check constraint/i, 422, 'CONSTRAINT_VIOLATION', 'The data does not satisfy a business rule.'],
  [/allocation exceeds payment amount/i, 422, 'ALLOCATION_EXCEEDS_PAYMENT', 'The allocation is larger than the payment.'],
];

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = tryCtx()?.requestId;
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: any = { statusCode: status, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };

    if (exception instanceof AppError) {
      status = exception.getStatus();
      body = exception.getResponse();
    } else if (exception instanceof ZodError || exception?.name === 'ZodValidationException') {
      const zerr: ZodError | undefined = exception instanceof ZodError ? exception : exception.getZodError?.();
      status = 400;
      body = {
        statusCode: 400,
        code: 'VALIDATION_FAILED',
        message: 'Please check the highlighted fields.',
        details: (zerr?.issues ?? []).map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r: any = exception.getResponse();
      body = {
        statusCode: status,
        code: typeof r === 'object' && r.code ? r.code : (HttpStatus[status] ?? 'ERROR'),
        message: typeof r === 'string' ? r : Array.isArray(r.message) ? r.message.join('; ') : (r.message ?? exception.message),
      };
    } else if (exception?.code === 'P2002') {
      status = 409;
      body = {
        statusCode: 409,
        code: 'DUPLICATE',
        message: 'A record with the same value already exists.',
        details: { fields: exception.meta?.target ?? exception.meta?.driverAdapterError?.cause?.constraint?.fields },
      };
    } else if (exception?.code === 'P2025') {
      status = 404;
      body = { statusCode: 404, code: 'NOT_FOUND', message: 'Record was not found.' };
    } else if (exception?.code === 'P2003') {
      status = 409;
      body = { statusCode: 409, code: 'REFERENCE_CONFLICT', message: 'This record is linked to other records.' };
    } else if (exception?.type === 'entity.too.large') {
      status = 413;
      body = { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The upload is too large.' };
    } else {
      const text = `${exception?.message ?? ''} ${exception?.meta?.driverAdapterError?.cause?.originalMessage ?? ''} ${exception?.cause?.message ?? ''}`;
      const match = PG_MESSAGES.find(([re]) => re.test(text));
      if (match) {
        status = match[1];
        body = { statusCode: match[1], code: match[2], message: match[3] };
      }
    }

    if (status >= 500) {
      this.logger.error(`${requestId ?? '-'} ${exception?.stack ?? exception}`);
    }
    res.status(status).json({ ...body, requestId });
  }
}
