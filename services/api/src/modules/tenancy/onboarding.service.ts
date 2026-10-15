import { Injectable } from '@nestjs/common';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { randomToken } from '../../common/crypto';
import { SystemDb, TenantDb } from '../../common/db/prisma.service';
import { Errors } from '../../common/errors';
import { Messenger } from '../../common/messenger';
import { assertPasswordPolicy } from '../../common/password-policy';
import { AuthService, hashPassword } from '../auth/auth.service';
import { ProvisioningService } from './provisioning.service';

export const RESERVED_SLUGS = ['www', 'api', 'app', 'admin', 'portal', 'typease', 'platform', 'support', 'help', 'status', 'mail', 'static', 'assets', 'cdn', 'corporate', 'centre', 'center', 'login', 'signup', 'docs', 's3', 'storage', 'files', 'n8n', 'grafana', 'prometheus', 'monitoring', 'metrics', 'internal', 'webhooks', 'billing', 'auth', 'sso', 'mx', 'smtp', 'ftp', 'ns1', 'ns2', 'demo', 'test', 'staging', 'dev'];

export interface OnboardingStep {
  key: 'account' | 'business' | 'plan' | 'branding' | 'services' | 'branches' | 'staff';
  title: string;
  done: boolean;
  required: boolean;
  hint?: string;
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly sys: SystemDb,
    private readonly db: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly auth: AuthService,
    private readonly messenger: Messenger,
    private readonly audit: AuditService,
  ) {}

  /** Step 1: a new typing centre signs up. Creates the owner account and the provisioned workspace. */
  async signup(input: { businessName: string; slug: string; ownerName: string; email: string; phone: string; password: string; preferredLanguage: string }) {
    if (!env().SELF_SIGNUP_ENABLED) throw Errors.forbidden('SIGNUP_CLOSED', 'Sign-up is currently by invitation. Please contact TypEase.');
    assertPasswordPolicy(input.password);
    if (RESERVED_SLUGS.includes(input.slug)) throw Errors.conflict('SLUG_TAKEN', 'That web address is not available. Please choose another.');
    if (await this.sys.client.tenant.findUnique({ where: { slug: input.slug } })) {
      throw Errors.conflict('SLUG_TAKEN', 'That web address is already in use. Please choose another.');
    }
    if (await this.sys.client.user.findFirst({ where: { OR: [{ email: input.email }, { phone: input.phone }] } })) {
      throw Errors.conflict('ACCOUNT_EXISTS', 'An account with this email or phone already exists. Sign in, or use a different email.');
    }
    const passwordHash = await hashPassword(input.password);
    const token = randomToken(32);
    const result = await this.sys.tx(async (tx) => {
      const user = await tx.user.create({
        data: { email: input.email, phone: input.phone, fullName: input.ownerName, passwordHash, preferredLanguage: input.preferredLanguage, passwordChangedAt: new Date() },
      });
      const tenant = await tx.tenant.create({
        data: { slug: input.slug, name: input.businessName, status: 'ONBOARDING', onboardingStep: 1, contactEmail: input.email, contactPhone: input.phone, defaultLanguage: input.preferredLanguage },
      });
      await this.provisioning.provisionTenant(tx, tenant);
      const owner = await tx.role.findFirstOrThrow({ where: { tenantId: tenant.id, key: 'owner' } });
      await tx.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, roleId: owner.id, kind: 'STAFF', status: 'ACTIVE', allBranches: true, jobTitle: 'Owner', joinedAt: new Date() } });
      await this.auth.createToken('EMAIL_VERIFY', { userId: user.id, tenantId: tenant.id, target: user.email, ttlSeconds: 48 * 3600, secret: token, meta: { app: 'centre' } }, tx);
      return { user, tenant };
    }, { timeoutMs: 60_000 });

    await this.messenger.send({
      eventKey: 'account.email_verification',
      channel: 'EMAIL',
      to: result.user.email,
      language: result.user.preferredLanguage,
      tenantId: result.tenant.id,
      data: { name: result.user.fullName, centre: result.tenant.name, link: `${env().CENTRE_WEB_URL}/verify-email?token=${token}` },
    });
    await this.audit.logSystem({ action: 'tenant.signup', resourceType: 'Tenant', resourceId: result.tenant.id, summary: `${result.tenant.name} signed up` }, result.tenant.id);
    const body = { tenantId: result.tenant.id, slug: result.tenant.slug, status: 'VERIFICATION_SENT' as const, email: result.user.email };
    return env().EXPOSE_DEV_TOKENS && env().NODE_ENV !== 'production' ? { ...body, dev: { emailVerificationToken: token } } : body;
  }

  async status() {
    const c = ctx();
    const tenantId = c.tenantId!;
    const user = await this.sys.client.user.findUniqueOrThrow({ where: { id: c.userId! } });
    return this.db.tx(async (tx) => {
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId } });
      const [subscription, services, branches, staff, branding] = await Promise.all([
        tx.subscription.findFirst({ where: { tenantId }, include: { plan: true } }),
        tx.service.count({ where: { tenantId, deletedAt: null } }),
        tx.branch.count({ where: { tenantId, isActive: true } }),
        tx.tenantMembership.count({ where: { tenantId, kind: 'STAFF', status: { in: ['ACTIVE', 'INVITED'] } } }),
        tx.brandingSettings.findFirst({ where: { tenantId, branchId: null } }),
      ]);
      const needPhone = env().ONBOARDING_REQUIRE_PHONE_VERIFICATION;
      const steps: OnboardingStep[] = [
        { key: 'account', title: 'Verify your email and phone', required: true, done: !!user.emailVerifiedAt && (!needPhone || !!user.phoneVerifiedAt), hint: !user.emailVerifiedAt ? 'Open the link we emailed you.' : 'Confirm the code we send to your phone.' },
        { key: 'business', title: 'Business information', required: true, done: !!tenant.legalName && !!tenant.emirate && !!tenant.contactEmail },
        { key: 'plan', title: 'Choose your plan', required: true, done: !!subscription },
        { key: 'branding', title: 'Branding', required: false, done: !!branding?.updatedById },
        { key: 'services', title: 'Add your services', required: true, done: services > 0, hint: 'Add at least one service so customers can request it.' },
        { key: 'branches', title: 'Branches', required: true, done: branches > 0 },
        { key: 'staff', title: 'Invite your team', required: false, done: staff > 1 },
      ];
      return {
        tenantStatus: tenant.status,
        currentStep: tenant.onboardingStep,
        draft: tenant.onboardingData,
        steps,
        canComplete: steps.filter((s) => s.required).every((s) => s.done),
        completed: !['ONBOARDING'].includes(tenant.status),
        plan: subscription ? { key: subscription.plan.key, name: subscription.plan.name, status: subscription.status, trialEndsAt: subscription.trialEndsAt } : null,
      };
    });
  }

  /** Unfinished onboarding is resumable from any device. */
  async saveDraft(step: number, data: Record<string, unknown>) {
    return this.db.tx(async (tx) => {
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId } });
      const merged = { ...(tenant.onboardingData as object), [`step${step}`]: data };
      await tx.tenant.update({ where: { id: tenant.id }, data: { onboardingData: merged as any, onboardingStep: Math.max(tenant.onboardingStep, step) } });
      return { status: 'SAVED' as const, step };
    });
  }

  async saveBusiness(input: { legalName: string; tradeLicenceNo?: string | null; taxRegistrationNo?: string | null; emirate: string; contactEmail: string; contactPhone: string; defaultLanguage: string }) {
    return this.db.tx(async (tx) => {
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId } });
      await tx.tenant.update({ where: { id: tenant.id }, data: { ...input, onboardingStep: Math.max(tenant.onboardingStep, 3) } });
      await tx.branch.updateMany({ where: { tenantId: tenant.id, isHeadOffice: true, emirate: null }, data: { emirate: input.emirate } });
      await this.audit.log({ action: 'tenant.business_info_saved', resourceType: 'Tenant', resourceId: tenant.id }, tx);
      return { status: 'SAVED' as const };
    });
  }

  /** Final step: the centre becomes operational (or waits for platform approval when required). */
  async complete() {
    const state = await this.status();
    if (state.completed) return { status: state.tenantStatus };
    if (!state.canComplete) {
      const missing = state.steps.filter((s) => s.required && !s.done).map((s) => s.title);
      throw Errors.unprocessable('ONBOARDING_INCOMPLETE', `Please finish: ${missing.join(', ')}.`, { missing });
    }
    const tenantId = ctx().tenantId!;
    const next = env().TENANT_APPROVAL_REQUIRED ? 'PENDING_APPROVAL' : state.plan?.status === 'TRIALING' ? 'TRIAL' : 'ACTIVE';
    // Tenant status is platform-controlled, so it is changed on the system connection.
    await this.sys.client.tenant.update({ where: { id: tenantId }, data: { status: next, onboardingStep: 10, ...(next !== 'PENDING_APPROVAL' ? { approvedAt: new Date() } : {}) } });
    await this.audit.logSystem({ action: 'tenant.onboarding_completed', resourceType: 'Tenant', resourceId: tenantId, summary: `Status ${next}` }, tenantId);
    return { status: next };
  }
}
