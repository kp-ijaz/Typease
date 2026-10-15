import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { Prisma } from '@typease/database';

/**
 * Finance responses carry every decimal as a fixed two-decimal string
 * ("150.00", never 150 or "150"), so clients can display and compare amounts
 * without parsing or rounding. Dates and everything else are left untouched.
 */
export function toApi<T>(value: T, depth = 0): T {
  if (value === null || value === undefined || depth > 12) return value;
  if (Prisma.Decimal.isDecimal(value)) return (value as unknown as Prisma.Decimal).toFixed(2) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => toApi(v, depth + 1)) as unknown as T;
  if (typeof value === 'object') {
    if (value instanceof Date || Buffer.isBuffer(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toApi(v, depth + 1);
    return out as T;
  }
  return value;
}

@Injectable()
export class MoneyInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body) => toApi(body)));
  }
}
