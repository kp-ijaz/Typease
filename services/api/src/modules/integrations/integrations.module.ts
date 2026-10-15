import { Module, OnModuleInit } from '@nestjs/common';
import { JobQueue } from '../../common/jobs/job-queue';
import { TenantDirectory } from '../../common/tenant-directory';
import { ConnectionTester } from './connection-tester';
import { IntegrationsController, PlatformIntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { PlatformIntegrationsService } from './platform-integrations.service';

export const AUTHORISATION_EXPIRY_JOB = 'integrations.authorisation_expiry';

/**
 * Settings > Integrations: the one place where a centre configures external
 * services, plus the platform's allow-list of providers and its review of
 * authorisation records. The modules that USE an integration read the rows
 * themselves (see catalogue.ts for the contract); nothing here sends a
 * message, takes a payment or talks to an authority.
 */
@Module({
  controllers: [IntegrationsController, PlatformIntegrationsController],
  providers: [IntegrationsService, PlatformIntegrationsService, ConnectionTester],
  exports: [PlatformIntegrationsService],
})
export class IntegrationsModule implements OnModuleInit {
  constructor(
    private readonly jobs: JobQueue,
    private readonly tenants: TenantDirectory,
    private readonly integrations: IntegrationsService,
  ) {}

  onModuleInit() {
    this.jobs.register(AUTHORISATION_EXPIRY_JOB, async () => void (await this.tenants.forEachTenant(AUTHORISATION_EXPIRY_JOB, async () => void (await this.integrations.expireAuthorisations()))), { attempts: 1 });
    this.jobs.schedule({ name: AUTHORISATION_EXPIRY_JOB, cron: '20 1 * * *', description: 'Switch off partner / government authorisation records whose validity date has passed' });
  }
}
