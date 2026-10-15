import { Global, Module, OnModuleInit } from '@nestjs/common';
import { JobMeta, JobQueue } from '../../common/jobs/job-queue';
import { Messenger } from '../../common/messenger';
import { TenantDirectory } from '../../common/tenant-directory';
import { ProvisioningService } from '../tenancy/provisioning.service';
import { NotificationAdminService } from './admin.service';
import { DeliveryService, DIRECT_JOB, MAINTENANCE_JOB } from './delivery.service';
import { NotificationEventMapper } from './event-mapper.service';
import { InboxService } from './inbox.service';
import { DELIVER_ATTEMPTS, DELIVER_BACKOFF_MS, DELIVER_JOB, NotificationService } from './notification.service';
import { MyNotificationsController, NotificationsController } from './notifications.controller';
import { ProviderRegistry } from './providers/registry';
import { TemplateService } from './template.service';
import { NotificationsErasure } from './notifications.erasure';

/**
 * Notifications: templates, consent-aware creation, the delivery pipeline with
 * retries, provider adapters, the in-app inbox and the transport behind the
 * account-security `Messenger`.
 */
@Global()
@Module({
  controllers: [NotificationsController, MyNotificationsController],
  providers: [ProviderRegistry, TemplateService, NotificationService, DeliveryService, NotificationEventMapper, NotificationAdminService, InboxService, NotificationsErasure],
  exports: [NotificationService, TemplateService, ProviderRegistry, DeliveryService],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    private readonly jobs: JobQueue,
    private readonly messenger: Messenger,
    private readonly provisioning: ProvisioningService,
    private readonly tenants: TenantDirectory,
    private readonly templates: TemplateService,
    private readonly delivery: DeliveryService,
  ) {}

  onModuleInit() {
    // Platform default templates: insert what is missing, never overwrite an edited row.
    this.provisioning.registerGlobalStep('notifications.templates', async (tx) => void (await this.templates.seedDefaults(tx)));

    this.jobs.register(DELIVER_JOB, (payload: { tenantId: string; notificationId: string }, meta: JobMeta) => this.delivery.deliver(payload.notificationId, meta), {
      attempts: DELIVER_ATTEMPTS,
      backoffMs: DELIVER_BACKOFF_MS,
    });
    this.jobs.register(DIRECT_JOB, (payload: { enc: string }, meta: JobMeta) => this.delivery.sendDirect(payload, meta), { attempts: 5, backoffMs: 15_000 });
    this.jobs.register(MAINTENANCE_JOB, async () => void (await this.tenants.forEachTenant(MAINTENANCE_JOB, async () => void (await this.delivery.maintain()))), { attempts: 1 });
    this.jobs.schedule({ name: MAINTENANCE_JOB, everySeconds: 600, description: 'Re-queue notifications whose delivery job was lost and purge sent account-message payloads' });

    // Account-security messages (verification, reset, OTP, invitations) use the same templates and providers.
    this.messenger.setTransport((message) => this.delivery.sendTransactional(message));
  }
}
