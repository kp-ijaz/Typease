import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { env } from '../config/env';
import { Errors } from './errors';
import { RedisService } from './redis';

export interface RateLimitRule {
  /** Bucket name. */
  name: string;
  limit: number;
  windowSeconds: number;
  /** Extra body fields that scope the bucket (e.g. the email being attacked). */
  bodyKeys?: string[];
}
const KEY = 'typease:rate-limit';
export const RateLimit = (rule: RateLimitRule) => SetMetadata(KEY, rule);

@Injectable()
export class RateLimiter {
  constructor(private readonly redis: RedisService) {}

  /** Fixed-window counter. Fails open if Redis is down (availability over strictness), except in production. */
  async consume(key: string, limit: number, windowSeconds: number): Promise<void> {
    if (!env().RATE_LIMIT_ENABLED) return;
    let count: number;
    try {
      const k = `rl:${key}`;
      count = await this.redis.client.incr(k);
      if (count === 1) await this.redis.client.expire(k, windowSeconds);
    } catch {
      if (env().NODE_ENV === 'production') throw Errors.tooMany('Service is busy. Please try again shortly.');
      return;
    }
    if (count > limit) throw Errors.tooMany(undefined, { retryAfterSeconds: windowSeconds });
  }
  async reset(key: string) {
    await this.redis.client.del(`rl:${key}`).catch(() => undefined);
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const ip = req.ip ?? 'unknown';
    await this.limiter.consume(`global:${ip}`, env().RATE_LIMIT_GLOBAL_PER_MINUTE, 60);
    const rule = this.reflector.getAllAndOverride<RateLimitRule>(KEY, [context.getHandler(), context.getClass()]);
    if (rule) {
      const scope = (rule.bodyKeys ?? []).map((k) => String((req.body ?? {})[k] ?? '').toLowerCase()).join('|');
      await this.limiter.consume(`${rule.name}:${ip}:${scope}`, rule.limit, rule.windowSeconds);
    }
    return true;
  }
}
