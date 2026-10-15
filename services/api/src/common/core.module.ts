import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { PrincipalService } from './auth/principal.service';
import { SystemDb, TenantDb } from './db/prisma.service';
import { ErasureRegistry } from './erasure';
import { DomainEvents } from './events.service';
import { JobQueue } from './jobs/job-queue';
import { WorkerHeartbeat } from './jobs/worker-heartbeat';
import { Messenger } from './messenger';
import { RateLimiter } from './rate-limit';
import { RedisService } from './redis';
import { SequenceService } from './sequence.service';
import { TenantDirectory } from './tenant-directory';
import { UsageService } from './usage.service';

const providers = [TenantDb, SystemDb, RedisService, RateLimiter, JobQueue, WorkerHeartbeat, DomainEvents, AuditService, SequenceService, Messenger, PrincipalService, UsageService, TenantDirectory, ErasureRegistry];

/** Infrastructure shared by every module. */
@Global()
@Module({ providers, exports: providers })
export class CoreModule {}
