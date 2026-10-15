import { Injectable, Logger } from '@nestjs/common';
import { isIP } from 'node:net';
import type { CreateIntegrationInput, IntegrationListQuery, IntegrationLogQuery, IntegrationSecretsInput, UpdateIntegrationInput } from '@typease/validation';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { ctx } from '../../common/context';
import { decryptJson, encryptJson } from '../../common/crypto';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';
import { RateLimiter } from '../../common/rate-limit';
import { isPrivateAddress } from '../notifications/providers/net-guard';
import {
  AUTHORISATION_KEY, AuthorisationMeta, AuthorisationState, CATEGORIES, cleanConfig, ConfigProblem, describeProvider, findProvider, keyFieldsChanged, mergeSecrets,
  missingConfig, missingSecrets, ProviderDef, providerCode, PROVIDERS, splitProvider, storedProvider,
} from './catalogue';
import { ConnectionTester, TestOutcome } from './connection-tester';
import { assertApprovedEndpoint, EndpointNotAllowed, isDevAllowedHost } from './net-guard';
import { PlatformIntegrationsService } from './platform-integrations.service';

type Row = Prisma.IntegrationGetPayload<object>;
const LOG_SORT = ['createdAt'] as const;
const CATEGORY_LABEL: Record<string, string> = {
  PAYMENT: 'Online payments', EMAIL: 'Email', SMS: 'SMS', WHATSAPP: 'WhatsApp', PUSH: 'Push notifications', OCR: 'Document reading (OCR)',
  MALWARE_SCAN: 'File scanning', AUTOMATION: 'Automation', PARTNER: 'Partners', GOVERNMENT: 'Government service authorisations',
};

const slugify = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Settings > Integrations of one centre: which external services it uses and
 * with which credentials.
 *
 *  - Credentials are write-only. They are stored encrypted (AES-256-GCM,
 *    `secretsEnc`) and never returned: responses carry the NAMES of the stored
 *    credentials (`secretKeys`) and when they last changed, nothing else.
 *  - Status: CONFIGURED = saved, not in use; ACTIVE = the consuming module uses
 *    it; DISABLED = switched off.
 *  - GOVERNMENT / PARTNER entries are authorisation RECORDS, not connections:
 *    they hold no credentials and only become ACTIVE after a TypEase
 *    administrator has verified them.
 *  - Nothing here talks to a government website.
 */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly platform: PlatformIntegrationsService,
    private readonly tester: ConnectionTester,
    private readonly limiter: RateLimiter,
  ) {}

  // ------------------------------------------------------------------ helpers
  private fail(e: unknown): never {
    if (e instanceof ConfigProblem) throw Errors.unprocessable('INVALID_INTEGRATION_CONFIG', e.message, { field: e.field });
    if (e instanceof EndpointNotAllowed) throw Errors.unprocessable('ENDPOINT_NOT_ALLOWED', e.message, { reason: e.code });
    throw e;
  }

  private meta(row: Pick<Row, 'config' | 'createdAt' | 'authorisationVerifiedAt'>): AuthorisationMeta {
    const raw = ((row.config ?? {}) as Record<string, any>)[AUTHORISATION_KEY] ?? {};
    const state: AuthorisationState = row.authorisationVerifiedAt ? 'VERIFIED' : raw.state === 'REJECTED' ? 'REJECTED' : 'PENDING';
    return { state, submittedAt: raw.submittedAt ?? row.createdAt.toISOString(), evidenceDocumentId: raw.evidenceDocumentId ?? null, reviewNote: raw.reviewNote ?? null, reviewedAt: raw.reviewedAt ?? null };
  }
  private plainConfig(row: Pick<Row, 'config'>): Record<string, unknown> {
    const { [AUTHORISATION_KEY]: _meta, ...config } = (row.config ?? {}) as Record<string, unknown>;
    return config;
  }
  private secretsOf(row: Pick<Row, 'secretsEnc'>): Record<string, string> {
    if (!row.secretsEnc) return {};
    try {
      return decryptJson<Record<string, string>>(row.secretsEnc) ?? {};
    } catch {
      throw Errors.conflict('CREDENTIALS_UNREADABLE', 'The saved credentials could not be read. Please enter them again.');
    }
  }
  private offered(def: ProviderDef, approved: Set<string> | null) {
    const available = def.available ? def.available() : true;
    const isApproved = approved === null || approved.has(providerCode(def.category, def.provider));
    return { available, approved: isApproved };
  }

  /** The API shape of an integration. Never contains `secretsEnc` or any credential value. */
  private view(row: Row, approved: Set<string> | null) {
    const { base, instanceKey } = splitProvider(row.provider);
    const def = findProvider(row.category, row.provider);
    const config = this.plainConfig(row);
    const missing = def ? { config: missingConfig(def, config), secrets: missingSecrets(def, row.secretKeys) } : { config: [], secrets: [] };
    const isRecord = def?.kind === 'AUTHORISATION_RECORD';
    const meta = isRecord ? this.meta(row) : null;
    const expiry = (config.validUntil ?? config.agreementValidUntil) as string | undefined;
    return {
      id: row.id,
      category: row.category,
      provider: base,
      instanceKey,
      /** False for a row whose provider is not (or no longer) in the catalogue of this installation. */
      known: !!def,
      kind: def?.kind ?? 'CONNECTION',
      name: row.name,
      status: row.status,
      mode: row.mode,
      config,
      secretKeys: [...row.secretKeys].sort(),
      secretsUpdatedAt: row.secretsUpdatedAt,
      missing,
      /** Everything required is filled in (and, for a record, verified): it can be enabled. */
      ready: !!def && !missing.config.length && !missing.secrets.length && (!isRecord || meta!.state === 'VERIFIED'),
      approved: def ? this.offered(def, approved).approved : false,
      testable: !!def?.test,
      lastTestedAt: row.lastTestedAt,
      lastTestOk: row.lastTestOk,
      lastTestMessage: row.lastTestMessage,
      authorisation: meta
        ? {
            state: meta.state,
            note: row.authorisationNote,
            evidenceDocumentId: meta.evidenceDocumentId,
            submittedAt: meta.submittedAt,
            verifiedAt: row.authorisationVerifiedAt,
            reviewNote: meta.reviewNote,
            reviewedAt: meta.reviewedAt,
            expired: typeof expiry === 'string' && expiry < today(),
          }
        : null,
      usage: def?.usage ?? null,
      /** Stripe: the address to register as the webhook endpoint in the Stripe dashboard. */
      webhookUrl: row.category === 'PAYMENT' && base === 'stripe' ? `${env().API_PUBLIC_URL}/api/v1/public/webhooks/payments/stripe` : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async load(tx: Tx, id: string): Promise<Row> {
    return found(await tx.integration.findFirst({ where: { id, tenantId: this.db.tenantId } }), 'Integration');
  }
  private defOf(row: Pick<Row, 'category' | 'provider'>): ProviderDef {
    const def = findProvider(row.category, row.provider);
    if (!def) throw Errors.conflict('UNKNOWN_PROVIDER', 'This provider is no longer supported by TypEase. Delete the integration and choose another provider.');
    return def;
  }

  /** Checks that go beyond the shape of a value: approved endpoints and obviously internal addresses. */
  private checkEndpoints(def: ProviderDef, config: Record<string, unknown>) {
    for (const field of def.configFields) {
      const value = config[field.key];
      if (typeof value !== 'string') continue;
      if (field.type === 'url' && field.allowListed) assertApprovedEndpoint(value, field.label);
      // A literal private address needs no DNS to be recognised; names are checked when a connection is made.
      if (field.type === 'host' && isIP(value) && isPrivateAddress(value) && !isDevAllowedHost(value)) {
        throw new EndpointNotAllowed(`${field.label}: "${value}" is a private or internal network address, which is not allowed. Use the public address of the server.`, 'HOST_NOT_ALLOWED');
      }
    }
  }

  private async assertEvidence(tx: Tx, documentId: string | null | undefined) {
    if (!documentId) return;
    const doc = await tx.document.findFirst({ where: { id: documentId, tenantId: this.db.tenantId, deletedAt: null }, select: { id: true } });
    if (!doc) throw Errors.unprocessable('EVIDENCE_NOT_FOUND', 'The evidence document was not found in your document vault. Upload it first, then attach it here.');
  }

  private assertOffered(def: ProviderDef, approved: Set<string> | null, doing: 'add' | 'enable') {
    const { available, approved: ok } = this.offered(def, approved);
    if (!available) throw Errors.unprocessable('PROVIDER_NOT_AVAILABLE', `${def.name} is not available on this TypEase installation.`);
    if (!ok) {
      throw Errors.unprocessable(
        'PROVIDER_NOT_APPROVED',
        `${def.name} has not been approved by TypEase, so you cannot ${doing} it. Customer data may only be sent to approved services. Contact TypEase support if you need this provider.`,
        { category: def.category, provider: def.provider },
      );
    }
  }

  // ------------------------------------------------------------------ catalogue + reads
  async catalogue() {
    const approved = await this.platform.approved();
    const configured = await this.db.tx((tx) => tx.integration.findMany({ where: { tenantId: this.db.tenantId }, select: { id: true, category: true, provider: true, status: true } }));
    return CATEGORIES.map((category) => ({
      category,
      label: CATEGORY_LABEL[category],
      providers: PROVIDERS.filter((p) => p.category === category)
        .map((def) => ({ def, offer: this.offered(def, approved) }))
        // The sandbox does not exist at all where test payments are switched off.
        .filter(({ offer }) => offer.available)
        .map(({ def, offer }) => ({
          ...describeProvider(def),
          approved: offer.approved,
          configured: configured.filter((c) => c.category === def.category && splitProvider(c.provider).base === def.provider).map((c) => ({ id: c.id, instanceKey: splitProvider(c.provider).instanceKey, status: c.status })),
        })),
    }));
  }

  async list(query: IntegrationListQuery) {
    const approved = await this.platform.approved();
    const rows = await this.db.tx((tx) =>
      tx.integration.findMany({
        where: { tenantId: this.db.tenantId, ...(query.category ? { category: query.category } : {}), ...(query.status ? { status: query.status } : {}) },
        orderBy: [{ category: 'asc' }, { createdAt: 'asc' }],
      }),
    );
    return rows.map((r) => this.view(r, approved));
  }

  async get(id: string) {
    const approved = await this.platform.approved();
    return this.view(await this.db.tx((tx) => this.load(tx, id)), approved);
  }

  // ------------------------------------------------------------------ create / update
  async create(input: CreateIntegrationInput) {
    const def = findProvider(input.category, input.provider);
    if (!def || def.provider !== input.provider) throw Errors.unprocessable('UNKNOWN_PROVIDER', `"${input.provider}" is not a provider of the ${input.category} category. Use GET /integrations/catalogue for the list.`);
    const approved = await this.platform.approved();
    this.assertOffered(def, approved, 'add');
    const isRecord = def.kind === 'AUTHORISATION_RECORD';
    if (input.instanceKey && !def.multiple) throw Errors.unprocessable('INSTANCE_NOT_SUPPORTED', `Only one ${def.name} integration can exist per centre.`);
    if (isRecord && (input.authorisationNote ?? '').length < 10) {
      throw Errors.unprocessable('AUTHORISATION_NOTE_REQUIRED', 'Describe the authorisation in at least 10 characters: who issued it, what it covers, and how TypEase can check it.');
    }
    if (!isRecord && (input.authorisationNote || input.evidenceDocumentId)) throw Errors.unprocessable('NOT_AN_AUTHORISATION_RECORD', `${def.name} is a connection: it has no authorisation note or evidence.`);

    let config: Record<string, unknown>;
    let secrets: Record<string, string> = {};
    try {
      config = cleanConfig(def, input.config, { complete: true });
      this.checkEndpoints(def, config);
      if (input.secrets && Object.keys(input.secrets).length) secrets = mergeSecrets(def, {}, input.secrets);
    } catch (e) {
      this.fail(e);
    }
    const instanceKey = def.multiple ? input.instanceKey ?? slugify(String(config.authorityName ?? config.partnerLegalName ?? '')) : null;
    if (def.multiple && (!instanceKey || instanceKey.length < 2)) throw Errors.unprocessable('INSTANCE_KEY_REQUIRED', 'Send a short key for this record (instanceKey), e.g. "mohre".');
    const provider = storedProvider(def.provider, instanceKey);
    const mode = def.modes.includes(input.mode) ? input.mode : def.modes[0];
    const secretKeys = Object.keys(secrets);

    const row = await this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const existing = await tx.integration.findFirst({ where: { tenantId, category: def.category, provider }, select: { id: true } });
      if (existing) {
        throw Errors.conflict('INTEGRATION_EXISTS', def.multiple ? `A record with the key "${instanceKey}" already exists. Edit it, or choose another key.` : `${def.name} is already set up for your centre. Edit the existing integration instead.`, { id: existing.id });
      }
      if (isRecord) await this.assertEvidence(tx, input.evidenceDocumentId);
      const meta: AuthorisationMeta | null = isRecord ? { state: 'PENDING', submittedAt: new Date().toISOString(), evidenceDocumentId: input.evidenceDocumentId ?? null, reviewNote: null, reviewedAt: null } : null;
      const created = await tx.integration.create({
        data: {
          tenantId,
          category: def.category,
          provider,
          name: input.name ?? (isRecord ? String(config.authorityName ?? config.partnerLegalName ?? def.name) : def.name),
          // A record waits for verification switched off: a CONFIGURED partner would already count as usable for the catalogue module.
          status: isRecord ? 'DISABLED' : 'CONFIGURED',
          mode,
          config: (meta ? { ...config, [AUTHORISATION_KEY]: meta } : config) as Prisma.InputJsonValue,
          secretsEnc: secretKeys.length ? encryptJson(secrets) : null,
          secretKeys,
          secretsUpdatedAt: secretKeys.length ? new Date() : null,
          authorisationNote: isRecord ? input.authorisationNote : null,
          createdById: ctx().userId ?? null,
        },
      });
      await this.audit.log(
        { action: isRecord ? 'integration.authorisation_submitted' : 'integration.created', resourceType: 'Integration', resourceId: created.id, summary: `${created.name} (${def.category}) added`, after: { category: def.category, provider, mode, status: created.status, config, credentialFields: secretKeys } },
        tx,
      );
      return created;
    });
    return this.view(row, approved);
  }

  async update(id: string, input: UpdateIntegrationInput) {
    const approved = await this.platform.approved();
    const row = await this.db.tx(async (tx) => {
      const current = await this.load(tx, id);
      const def = this.defOf(current);
      const isRecord = def.kind === 'AUTHORISATION_RECORD';
      const before = this.plainConfig(current);
      const data: Prisma.IntegrationUncheckedUpdateInput = {};
      let config = before;
      if (input.config !== undefined) {
        try {
          config = cleanConfig(def, input.config, { complete: true });
          this.checkEndpoints(def, config);
        } catch (e) {
          this.fail(e);
        }
      }
      if (input.name !== undefined) data.name = input.name;
      if (input.mode !== undefined) {
        if (!def.modes.includes(input.mode)) throw Errors.unprocessable('MODE_NOT_SUPPORTED', `${def.name} only supports ${def.modes.join(' / ')} mode.`);
        data.mode = input.mode;
      }
      const configChanged = JSON.stringify(config) !== JSON.stringify(before);
      let meta: AuthorisationMeta | null = isRecord ? this.meta(current) : null;
      let verificationReset = false;
      if (isRecord) {
        if (input.authorisationNote !== undefined) {
          if ((input.authorisationNote ?? '').length < 10) throw Errors.unprocessable('AUTHORISATION_NOTE_REQUIRED', 'Describe the authorisation in at least 10 characters.');
          data.authorisationNote = input.authorisationNote;
        }
        if (input.evidenceDocumentId !== undefined) await this.assertEvidence(tx, input.evidenceDocumentId);
        const evidence = input.evidenceDocumentId !== undefined ? (input.evidenceDocumentId ?? null) : meta!.evidenceDocumentId;
        const substantive = keyFieldsChanged(def, before, config);
        const noteChanged = input.authorisationNote !== undefined && input.authorisationNote !== current.authorisationNote;
        const evidenceChanged = evidence !== meta!.evidenceDocumentId;
        if (meta!.state === 'VERIFIED' && substantive) {
          // What was verified is no longer what the record says.
          verificationReset = true;
          data.authorisationVerifiedAt = null;
          data.authorisationVerifiedById = null;
          data.status = 'DISABLED';
          meta = { state: 'PENDING', submittedAt: new Date().toISOString(), evidenceDocumentId: evidence, reviewNote: null, reviewedAt: null };
        } else if (meta!.state !== 'VERIFIED' && (configChanged || noteChanged || evidenceChanged)) {
          // An edited record goes back into the review queue.
          meta = { state: 'PENDING', submittedAt: new Date().toISOString(), evidenceDocumentId: evidence, reviewNote: meta!.state === 'REJECTED' ? meta!.reviewNote : null, reviewedAt: meta!.state === 'REJECTED' ? meta!.reviewedAt : null };
        } else {
          meta = { ...meta!, evidenceDocumentId: evidence };
        }
      } else if (input.authorisationNote || input.evidenceDocumentId) {
        throw Errors.unprocessable('NOT_AN_AUTHORISATION_RECORD', `${def.name} is a connection: it has no authorisation note or evidence.`);
      }
      data.config = (meta ? { ...config, [AUTHORISATION_KEY]: meta } : config) as Prisma.InputJsonValue;
      if (configChanged) Object.assign(data, { lastTestedAt: null, lastTestOk: null, lastTestMessage: null });
      const updated = await tx.integration.update({ where: { id: current.id }, data });
      await this.audit.log(
        {
          action: verificationReset ? 'integration.verification_reset' : 'integration.updated',
          resourceType: 'Integration',
          resourceId: id,
          summary: verificationReset ? `${updated.name}: key details changed, so the verification was withdrawn and the record was switched off until TypEase checks it again` : `${updated.name} updated`,
          before: { name: current.name, mode: current.mode, status: current.status, config: before },
          after: { name: updated.name, mode: updated.mode, status: updated.status, config },
        },
        tx,
      );
      return updated;
    });
    return this.view(row, approved);
  }

  /** Write-only: stores or removes credentials. The response names the stored fields, never their values. */
  async setSecrets(id: string, input: IntegrationSecretsInput) {
    const approved = await this.platform.approved();
    const row = await this.db.tx(async (tx) => {
      const current = await this.load(tx, id);
      const def = this.defOf(current);
      let next: Record<string, string>;
      try {
        next = mergeSecrets(def, this.secretsOf(current), input.secrets);
      } catch (e) {
        this.fail(e);
      }
      const secretKeys = Object.keys(next);
      const stillComplete = !missingSecrets(def, secretKeys).length;
      const updated = await tx.integration.update({
        where: { id: current.id },
        data: {
          secretsEnc: secretKeys.length ? encryptJson(next) : null,
          secretKeys,
          secretsUpdatedAt: new Date(),
          lastTestedAt: null,
          lastTestOk: null,
          lastTestMessage: null,
          // An integration cannot stay in use without a credential it needs.
          ...(current.status === 'ACTIVE' && !stillComplete ? { status: 'CONFIGURED' as const } : {}),
        },
      });
      await this.audit.log(
        {
          action: 'integration.credentials_changed',
          resourceType: 'Integration',
          resourceId: id,
          summary: `${updated.name}: credentials changed`,
          after: { stored: secretKeys, set: Object.entries(input.secrets).filter(([, v]) => v !== null).map(([k]) => k), removed: Object.entries(input.secrets).filter(([, v]) => v === null).map(([k]) => k), status: updated.status },
        },
        tx,
      );
      return updated;
    });
    return this.view(row, approved);
  }

  // ------------------------------------------------------------------ enable / disable / delete
  async enable(id: string) {
    const approved = await this.platform.approved();
    const result = await this.db.tx(async (tx) => {
      const current = await this.load(tx, id);
      const def = this.defOf(current);
      this.assertOffered(def, approved, 'enable');
      const config = this.plainConfig(current);
      const missing = { config: missingConfig(def, config), secrets: missingSecrets(def, current.secretKeys) };
      if (missing.config.length || missing.secrets.length) {
        const labels = [...def.configFields.filter((f) => missing.config.includes(f.key)), ...def.secretFields.filter((f) => missing.secrets.includes(f.key))].map((f) => f.label);
        throw Errors.unprocessable('INTEGRATION_INCOMPLETE', `Before switching this on, please fill in: ${labels.join(', ')}.`, { missing });
      }
      if (def.kind === 'AUTHORISATION_RECORD') {
        const meta = this.meta(current);
        if (meta.state !== 'VERIFIED') {
          throw Errors.conflict(
            'AUTHORISATION_NOT_VERIFIED',
            meta.state === 'REJECTED' ? 'TypEase did not accept this authorisation. Correct the record and it will be reviewed again.' : 'This authorisation is waiting to be checked by TypEase. It is switched on automatically once it has been verified.',
          );
        }
        const expiry = (config.validUntil ?? config.agreementValidUntil) as string | undefined;
        if (typeof expiry === 'string' && expiry < today()) throw Errors.conflict('AUTHORISATION_EXPIRED', `This authorisation ended on ${expiry}. Enter the renewed validity dates; TypEase will then check the record again.`);
      }
      if (current.status === 'ACTIVE') return { row: current, disabled: [] as Row[] };
      // The consuming module uses one provider per category, so switching one on switches the other off.
      const others = def.exclusive ? await tx.integration.findMany({ where: { tenantId: this.db.tenantId, category: current.category, status: 'ACTIVE', id: { not: current.id } } }) : [];
      for (const other of others) {
        await tx.integration.update({ where: { id: other.id }, data: { status: 'DISABLED' } });
        await this.audit.log({ action: 'integration.disabled', resourceType: 'Integration', resourceId: other.id, summary: `${other.name} switched off because ${current.name} was switched on`, before: { status: 'ACTIVE' }, after: { status: 'DISABLED' } }, tx);
      }
      const updated = await tx.integration.update({ where: { id: current.id }, data: { status: 'ACTIVE' } });
      await this.audit.log({ action: 'integration.enabled', resourceType: 'Integration', resourceId: id, summary: `${updated.name} switched on (${updated.mode})`, before: { status: current.status }, after: { status: 'ACTIVE', mode: updated.mode } }, tx);
      return { row: updated, disabled: others };
    });
    return { ...this.view(result.row, approved), switchedOff: result.disabled.map((r) => ({ id: r.id, name: r.name })) };
  }

  async disable(id: string) {
    const approved = await this.platform.approved();
    const row = await this.db.tx(async (tx) => {
      const current = await this.load(tx, id);
      if (current.status === 'DISABLED') return current;
      const updated = await tx.integration.update({ where: { id: current.id }, data: { status: 'DISABLED' } });
      await this.audit.log({ action: 'integration.disabled', resourceType: 'Integration', resourceId: id, summary: `${updated.name} switched off`, before: { status: current.status }, after: { status: 'DISABLED' } }, tx);
      return updated;
    });
    return this.view(row, approved);
  }

  async remove(id: string) {
    await this.db.tx(async (tx) => {
      const current = await this.load(tx, id);
      await tx.integration.delete({ where: { id: current.id } });
      await this.audit.log(
        { action: 'integration.deleted', resourceType: 'Integration', resourceId: id, summary: `${current.name} (${current.category}) deleted together with its stored credentials`, before: { category: current.category, provider: current.provider, status: current.status, config: this.plainConfig(current), credentialFields: current.secretKeys } },
        tx,
      );
    });
    return { status: 'DELETED' as const };
  }

  // ------------------------------------------------------------------ test connection
  async test(id: string) {
    const tenantId = this.db.tenantId;
    const { row, def } = await this.db.tx(async (tx) => {
      const current = await this.load(tx, id);
      return { row: current, def: this.defOf(current) };
    });
    if (!def.test) return { supported: false as const, ok: null, message: def.testNote, testedAt: null };
    const config = this.plainConfig(row);
    const missing = { config: missingConfig(def, config), secrets: missingSecrets(def, row.secretKeys) };
    if (missing.config.length || missing.secrets.length) throw Errors.unprocessable('INTEGRATION_INCOMPLETE', 'Fill in the required settings and credentials before testing the connection.', { missing });
    // A connection test makes our servers call an address the centre chose: keep it rare.
    await this.limiter.consume(`integration-test:${tenantId}`, 12, 60);
    const secrets = this.secretsOf(row);

    let outcome: TestOutcome;
    const started = Date.now();
    try {
      // Deliberately outside any database transaction: never hold a connection during network I/O.
      outcome = await this.tester.run(def, config, secrets, row.mode);
    } catch (e: any) {
      this.logger.warn(`connection test for ${def.category}/${def.provider} failed unexpectedly: ${e?.message ?? e}`);
      outcome = { ok: false, message: 'The test could not be completed. Please try again.', statusCode: null, durationMs: Date.now() - started, request: { operation: 'test' }, response: null, error: 'TEST_FAILED' };
    }
    const testedAt = new Date();
    await this.db.tx(async (tx) => {
      // The integration may have been deleted while the test ran.
      const still = await tx.integration.findFirst({ where: { id, tenantId }, select: { id: true } });
      if (still) await tx.integration.update({ where: { id }, data: { lastTestedAt: testedAt, lastTestOk: outcome.ok, lastTestMessage: outcome.message.slice(0, 500) } });
      await tx.integrationLog.create({
        data: {
          tenantId,
          integrationId: id,
          category: row.category,
          provider: row.provider,
          operation: 'TEST_CONNECTION',
          direction: 'OUTBOUND',
          success: outcome.ok,
          statusCode: outcome.statusCode,
          durationMs: outcome.durationMs,
          request: outcome.request as Prisma.InputJsonValue,
          response: (outcome.response ?? undefined) as Prisma.InputJsonValue | undefined,
          error: outcome.ok ? null : `${outcome.error ?? 'FAILED'}: ${outcome.message}`.slice(0, 500),
          relatedType: 'Integration',
          relatedId: id,
        },
      });
      await this.audit.log({ action: 'integration.tested', resourceType: 'Integration', resourceId: id, summary: `${row.name}: connection test ${outcome.ok ? 'succeeded' : 'failed'}`, after: { ok: outcome.ok, message: outcome.message } }, tx);
    });
    return { supported: true as const, ok: outcome.ok, message: outcome.message, testedAt };
  }

  // ------------------------------------------------------------------ logs
  async logs(query: IntegrationLogQuery) {
    const where: Prisma.IntegrationLogWhereInput = {
      tenantId: this.db.tenantId,
      ...(query.integrationId ? { integrationId: query.integrationId } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.operation ? { operation: query.operation } : {}),
      ...(query.success !== undefined ? { success: query.success } : {}),
      ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}),
    };
    return this.db.tx(async (tx) => {
      const [rows, total] = await Promise.all([tx.integrationLog.findMany({ where, ...pageArgs(query, LOG_SORT, 'createdAt:desc') }), tx.integrationLog.count({ where })]);
      return pageResult(rows, total, query);
    });
  }

  // ------------------------------------------------------------------ housekeeping
  /**
   * Daily, per centre: an ACTIVE authorisation record whose validity date has
   * passed is switched off, so services can no longer rely on a lapsed licence
   * or agreement. Idempotent.
   */
  async expireAuthorisations(): Promise<number> {
    return this.db.tx(async (tx) => {
      const rows = await tx.integration.findMany({ where: { tenantId: this.db.tenantId, category: { in: ['GOVERNMENT', 'PARTNER'] }, status: 'ACTIVE' } });
      let expired = 0;
      for (const row of rows) {
        const config = this.plainConfig(row);
        const until = (config.validUntil ?? config.agreementValidUntil) as string | undefined;
        if (typeof until !== 'string' || until >= today()) continue;
        await tx.integration.update({ where: { id: row.id }, data: { status: 'DISABLED' } });
        await this.audit.log({ action: 'integration.authorisation_expired', resourceType: 'Integration', resourceId: row.id, summary: `${row.name}: the authorisation ended on ${until} and was switched off`, before: { status: 'ACTIVE' }, after: { status: 'DISABLED', validUntil: until } }, tx);
        expired += 1;
      }
      return expired;
    });
  }
}
