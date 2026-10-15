import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from '../config/env';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client = new Redis(env().REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false, enableOfflineQueue: true });

  constructor() {
    // Never crash the process because the cache is briefly unavailable.
    this.client.on('error', () => undefined);
  }
  /** BullMQ requires its own connections with maxRetriesPerRequest = null. */
  duplicateForQueue(): Redis {
    return new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
  }
  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
  async onModuleDestroy() {
    this.client.disconnect();
  }
}
