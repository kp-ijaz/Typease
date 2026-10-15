import { Global, Module, OnModuleInit } from '@nestjs/common';
import { JobQueue } from '../../common/jobs/job-queue';
import { IntegrationsModule } from '../integrations/integrations.module';
import { StorageModule } from '../storage/storage.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { ACCESS_EXPIRY_JOB, AccessGrantsService } from './access-grants.service';
import { PlatformDashboardService } from './dashboard.service';
import { FeatureFlagAdminService, FeatureFlags } from './feature-flags.service';
import { SystemHealthService } from './health.service';
import { PlatformMetricsService } from './metrics.service';
import { OFFBOARDING_JOB, OffboardingService } from './offboarding.service';
import { PlatformAuditService } from './platform-audit.service';
import {
  FeatureFlagsController, InternalMetricsController, PlatformAccessController, PlatformAuditController, PlatformDashboardController, PlatformDomainsController, PlatformFeatureFlagsController,
  PlatformSettingsController, PlatformStaffController, PlatformSystemController, PlatformTenantsController, SupportAccessController,
} from './platform.controller';
import { SystemProvidersService } from './system-providers.service';
import { PlatformSettingsService } from './settings.service';
import { PlatformStaffService } from './staff.service';
import { SupportAccessService } from './support-access.service';
import { PlatformTenantsService } from './tenants.service';

/**
 * The TypEase platform console: centres (tenants) and their life cycle,
 * controlled offboarding, time-limited support access, feature flags and
 * settings, platform staff, the platform audit / security trail, the SaaS
 * dashboard and the monitoring endpoint.
 *
 * Global so that any module can inject `FeatureFlags`.
 */
@Global()
@Module({
  imports: [SubscriptionsModule, StorageModule, IntegrationsModule],
  controllers: [
    PlatformDashboardController, PlatformTenantsController, PlatformAccessController, SupportAccessController, PlatformFeatureFlagsController, FeatureFlagsController,
    PlatformSettingsController, PlatformStaffController, PlatformAuditController, InternalMetricsController, PlatformDomainsController, PlatformSystemController,
  ],
  providers: [
    PlatformTenantsService, OffboardingService, AccessGrantsService, SupportAccessService, FeatureFlags, FeatureFlagAdminService, PlatformSettingsService, PlatformStaffService,
    PlatformAuditService, SystemHealthService, SystemProvidersService, PlatformDashboardService, PlatformMetricsService,
  ],
  exports: [FeatureFlags, SystemHealthService],
})
export class PlatformModule implements OnModuleInit {
  constructor(
    private readonly jobs: JobQueue,
    private readonly offboarding: OffboardingService,
    private readonly grants: AccessGrantsService,
  ) {}

  onModuleInit() {
    this.jobs.register(OFFBOARDING_JOB, async () => void (await this.offboarding.runDue()), { attempts: 1 });
    this.jobs.schedule({ name: OFFBOARDING_JOB, cron: '40 2 * * *', description: 'Permanently delete centres whose offboarding date has passed (files first, then all rows in one transaction)' });

    this.jobs.register(ACCESS_EXPIRY_JOB, async () => void (await this.grants.expireDue()), { attempts: 1 });
    this.jobs.schedule({ name: ACCESS_EXPIRY_JOB, everySeconds: 60, description: 'Mark support access grants whose time is over as EXPIRED, end their sessions and lapse unanswered requests' });
  }
}
