import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConversationQuery, QuickRepliesInput, SimulateInboundInput } from '@typease/validation';
import type { IncomingHttpHeaders } from 'node:http';
import { createHmac } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { ctx, runAsTenant } from '../../common/context';
import { decryptJson, safeEqual } from '../../common/crypto';
import { Prisma, SystemDb, TenantDb, Tx } from '../../common/db/prisma.service';
import { ErasureRegistry, ErasureSubject } from '../../common/erasure';
import { AppError, Errors, found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';
import { SequenceService } from '../../common/sequence.service';
import { env } from '../../config/env';
import { DocumentsService } from '../documents/documents.service';
import { ProviderRegistry } from '../notifications/providers/registry';
import { ProviderError } from '../notifications/providers/types';
import { MetaWhatsAppProvider } from '../notifications/providers/whatsapp';

const WINDOW_MS = 24 * 3_600_000;
const preview = (text: string | null | undefined, kind: string) => (text?.trim() ? text.trim().slice(0, 140) : `[${kind.toLowerCase()}]`);
const KIND: Record<string, string> = { text: 'TEXT', image: 'IMAGE', document: 'DOCUMENT', audio: 'AUDIO', voice: 'AUDIO' };
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

/** The parts of Meta's webhook body the inbox reads. */
interface MetaMedia {
  id?: string;
  mime_type?: string;
  filename?: string;
  caption?: string;
}
interface MetaPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
        messages?: Array<{ id: string; from: string; timestamp?: string; type: string; text?: { body?: string }; image?: MetaMedia; document?: MetaMedia }>;
        statuses?: Array<{ id: string; status: string; errors?: Array<{ title?: string }> }>;
      };
    }>;
  }>;
}

/** One inbound message, from the Meta webhook or the development sandbox. */
export interface Inbound {
  providerMessageId: string;
  phone: string;
  name: string | null;
  kind: string;
  text: string | null;
  at: Date;
  media?: { providerId?: string; data?: Buffer; mime: string; name: string | null };
}

/**
 * WhatsApp team inbox: every customer's chat in one shared list, with assignment, status, internal notes and quick
 * replies. Customers who send a photo or PDF have it stored (and malware-scanned) in their document vault, so it can
 * become part of a request. Free-form replies are possible for 24 hours after the customer's last message; after
 * that WhatsApp only accepts approved templates.
 */
@Injectable()
export class WhatsAppInboxService implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppInboxService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly sys: SystemDb,
    private readonly audit: AuditService,
    private readonly providers: ProviderRegistry,
    private readonly sequences: SequenceService,
    private readonly documents: DocumentsService,
    private readonly erasure: ErasureRegistry,
  ) {}

  onModuleInit() {
    this.erasure.register('whatsapp', (tx, subject) => this.erase(tx, subject));
  }

  // ------------------------------------------------------------------ reading
  private windowOpen(lastInboundAt: Date | null) {
    return !!lastInboundAt && Date.now() - lastInboundAt.getTime() < WINDOW_MS;
  }

  async list(query: ConversationQuery) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const where: Prisma.WaConversationWhereInput = {
        tenantId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.mine ? { assignedToId: ctx().membershipId ?? '00000000-0000-0000-0000-000000000000' } : {}),
        ...(query.unassigned ? { assignedToId: null } : {}),
        ...(query.q ? { OR: [{ phone: { contains: query.q.replace(/\s/g, '') } }, { contactName: { contains: query.q, mode: 'insensitive' } }, { customer: { fullName: { contains: query.q, mode: 'insensitive' } } }] } : {}),
      };
      const [rows, total, unread] = await Promise.all([
        tx.waConversation.findMany({ where, ...pageArgs(query, ['lastMessageAt'], 'lastMessageAt:desc'), include: { customer: { select: { id: true, fullName: true, customerNo: true } } } }),
        tx.waConversation.count({ where }),
        tx.waConversation.aggregate({ where: { tenantId, status: { not: 'CLOSED' } }, _sum: { unreadCount: true } }),
      ]);
      const names = await this.memberNames(tx, rows.map((r) => r.assignedToId));
      return {
        ...pageResult(rows.map((r) => ({ ...r, assigneeName: r.assignedToId ? (names.get(r.assignedToId) ?? null) : null, windowOpen: this.windowOpen(r.lastInboundAt) })), total, query),
        unreadTotal: unread._sum.unreadCount ?? 0,
        /** Development: messages can be simulated instead of arriving from Meta. */
        sandbox: env().NODE_ENV !== 'production' && env().WHATSAPP_DRIVER === 'log',
      };
    });
  }

  private async memberNames(tx: Tx, ids: Array<string | null>) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = list.length ? await tx.tenantMembership.findMany({ where: { tenantId: this.db.tenantId, id: { in: list } }, select: { id: true, user: { select: { fullName: true } } } }) : [];
    return new Map(rows.map((r) => [r.id, r.user.fullName]));
  }

  private async load(tx: Tx, id: string) {
    return found(await tx.waConversation.findFirst({ where: { id, tenantId: this.db.tenantId }, include: { customer: { select: { id: true, fullName: true, customerNo: true, phone: true, email: true } } } }), 'Conversation');
  }

  /** The conversation with its messages (newest 300); opening it marks it read. */
  async get(id: string) {
    return this.db.tx(async (tx) => {
      const c = await this.load(tx, id);
      if (c.unreadCount) await tx.waConversation.update({ where: { id }, data: { unreadCount: 0 } });
      const messages = (await tx.waMessage.findMany({ where: { tenantId: this.db.tenantId, conversationId: id }, orderBy: { createdAt: 'desc' }, take: 300 })).reverse();
      const authors = await tx.user.findMany({ where: { id: { in: [...new Set(messages.map((m) => m.authorId).filter((x): x is string => !!x))] } }, select: { id: true, fullName: true } });
      const names = await this.memberNames(tx, [c.assignedToId]);
      const lead = await tx.lead.findFirst({ where: { tenantId: this.db.tenantId, conversationId: id }, orderBy: { createdAt: 'desc' }, select: { id: true, leadNo: true, status: true } });
      const requests = c.customerId
        ? await tx.serviceRequest.findMany({ where: { tenantId: this.db.tenantId, customerId: c.customerId, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, requestNo: true, status: true, serviceSnapshot: true } })
        : [];
      return {
        ...c,
        unreadCount: 0,
        assigneeName: c.assignedToId ? (names.get(c.assignedToId) ?? null) : null,
        windowOpen: this.windowOpen(c.lastInboundAt),
        windowClosesAt: c.lastInboundAt ? new Date(c.lastInboundAt.getTime() + WINDOW_MS) : null,
        messages: messages.map((m) => ({ ...m, authorName: authors.find((a) => a.id === m.authorId)?.fullName ?? null })),
        lead,
        requests: requests.map((r) => ({ id: r.id, requestNo: r.requestNo, status: r.status, serviceName: (r.serviceSnapshot as { name?: string } | null)?.name ?? null })),
      };
    });
  }

  // ------------------------------------------------------------------ staff actions
  async reply(id: string, text: string) {
    const prepared = await this.db.tx(async (tx) => {
      const c = await this.load(tx, id);
      if (!this.windowOpen(c.lastInboundAt)) throw Errors.conflict('WINDOW_CLOSED', 'More than 24 hours have passed since the customer\'s last message. WhatsApp only allows approved template messages now; ask the customer to message you, or call them.');
      const { provider } = await this.providers.resolve('WHATSAPP', tx);
      const message = await tx.waMessage.create({ data: { tenantId: this.db.tenantId, conversationId: id, direction: 'OUT', kind: 'TEXT', body: text, status: 'QUEUED', authorId: ctx().userId ?? null } });
      await tx.waConversation.update({ where: { id }, data: { lastMessageAt: message.createdAt, lastPreview: preview(text, 'TEXT'), ...(c.status === 'CLOSED' ? { status: 'OPEN' } : {}), ...(!c.assignedToId && ctx().membershipId ? { assignedToId: ctx().membershipId } : {}) } });
      return { provider, message, to: c.phone };
    });
    // The provider is called outside the transaction: a slow API never holds database locks.
    let update: Prisma.WaMessageUpdateInput;
    try {
      const sent = await prepared.provider.send({ to: prepared.to, text, freeForm: true });
      update = { status: 'SENT', providerMessageId: sent.providerMessageId ?? null };
    } catch (e) {
      update = { status: 'FAILED', error: (e instanceof ProviderError || e instanceof Error ? e.message : 'Sending failed').slice(0, 500) };
    }
    return this.db.tx((tx) => tx.waMessage.update({ where: { id: prepared.message.id }, data: update }));
  }

  async note(id: string, text: string) {
    return this.db.tx(async (tx) => {
      await this.load(tx, id);
      return tx.waMessage.create({ data: { tenantId: this.db.tenantId, conversationId: id, direction: 'NOTE', kind: 'TEXT', body: text, status: 'NOTE', authorId: ctx().userId ?? null } });
    });
  }

  async assign(id: string, membershipId: string | null) {
    return this.db.tx(async (tx) => {
      const c = await this.load(tx, id);
      if (membershipId) found(await tx.tenantMembership.findFirst({ where: { id: membershipId, tenantId: this.db.tenantId, kind: 'STAFF', status: 'ACTIVE' }, select: { id: true } }), 'Staff member');
      await tx.waConversation.update({ where: { id }, data: { assignedToId: membershipId } });
      await this.audit.log({ action: 'whatsapp.assigned', resourceType: 'WaConversation', resourceId: id, before: { assignedToId: c.assignedToId }, after: { assignedToId: membershipId } }, tx);
      return { id, assignedToId: membershipId };
    });
  }

  async setStatus(id: string, status: 'OPEN' | 'PENDING' | 'CLOSED') {
    return this.db.tx(async (tx) => {
      await this.load(tx, id);
      await tx.waConversation.update({ where: { id }, data: { status, ...(status === 'CLOSED' ? { unreadCount: 0 } : {}) } });
      return { id, status };
    });
  }

  async linkCustomer(id: string, customerId: string | null) {
    return this.db.tx(async (tx) => {
      await this.load(tx, id);
      if (customerId) found(await tx.customer.findFirst({ where: { id: customerId, tenantId: this.db.tenantId, deletedAt: null }, select: { id: true } }), 'Customer');
      await tx.waConversation.update({ where: { id }, data: { customerId } });
      return { id, customerId };
    });
  }

  async quickReplies() {
    return this.db.tx(async (tx) => {
      const s = ((await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } })).settings ?? {}) as Record<string, unknown>;
      return { replies: Array.isArray(s.inboxQuickReplies) ? (s.inboxQuickReplies as QuickRepliesInput['replies']) : [] };
    });
  }
  async setQuickReplies(input: QuickRepliesInput) {
    return this.db.tx(async (tx) => {
      const t = await tx.tenant.findFirstOrThrow({ where: { id: this.db.tenantId }, select: { settings: true } });
      await tx.tenant.update({ where: { id: this.db.tenantId }, data: { settings: { ...((t.settings ?? {}) as object), inboxQuickReplies: input.replies } as Prisma.InputJsonValue } });
      return { replies: input.replies };
    });
  }

  // ------------------------------------------------------------------ inbound
  /** Stores one inbound message (idempotent by provider id) and, for a photo or PDF, files it in the customer's vault. */
  async ingest(message: Inbound, provider: MetaWhatsAppProvider | null): Promise<{ conversationId: string; duplicate: boolean }> {
    const tenantId = this.db.tenantId;
    const stored = await this.db.tx(async (tx) => {
      const dup = await tx.waMessage.findFirst({ where: { tenantId, providerMessageId: message.providerMessageId }, select: { conversationId: true } });
      if (dup) return { conversationId: dup.conversationId, messageId: null, customerId: null as string | null, duplicate: true };
      let conversation = await tx.waConversation.findFirst({ where: { tenantId, phone: message.phone } });
      if (!conversation) {
        const customer = await tx.customer.findFirst({ where: { tenantId, phone: message.phone, deletedAt: null, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
        conversation = await tx.waConversation.create({ data: { tenantId, phone: message.phone, contactName: message.name, customerId: customer?.id ?? null } });
      }
      // Documents need an owner: somebody new who sends a file becomes a customer, named as on WhatsApp.
      let customerId = conversation.customerId;
      if (!customerId && message.media) {
        const created = await tx.customer.create({ data: { tenantId, customerNo: await this.sequences.next(tx, 'customer'), fullName: message.name?.trim() || message.phone, phone: message.phone } });
        customerId = created.id;
        await this.audit.log({ action: 'customer.created', resourceType: 'Customer', resourceId: created.id, summary: `${created.customerNo} created from a WhatsApp message (${message.phone})` }, tx);
      }
      const row = await tx.waMessage.create({
        data: { tenantId, conversationId: conversation.id, direction: 'IN', kind: message.kind, body: message.text, status: 'RECEIVED', providerMessageId: message.providerMessageId, mediaProviderId: message.media?.providerId ?? null, mediaMime: message.media?.mime ?? null, mediaName: message.media?.name ?? null, createdAt: message.at },
      });
      await tx.waConversation.update({
        where: { id: conversation.id },
        data: { unreadCount: { increment: 1 }, lastMessageAt: message.at, lastInboundAt: message.at, lastPreview: preview(message.text, message.kind), contactName: message.name ?? conversation.contactName, customerId, ...(conversation.status === 'CLOSED' ? { status: 'OPEN' } : {}) },
      });
      return { conversationId: conversation.id, messageId: row.id, customerId, duplicate: false };
    });
    if (stored.duplicate || !message.media || !stored.messageId || !stored.customerId) return { conversationId: stored.conversationId, duplicate: stored.duplicate };
    try {
      const data = message.media.data ?? (provider ? (await provider.downloadMedia(message.media.providerId!)).data : null);
      if (!data) throw new Error('No media driver is configured.');
      const name = message.media.name ?? `whatsapp-${message.providerMessageId.slice(-8)}.${EXT[message.media.mime] ?? 'bin'}`;
      const doc = await this.documents.uploadMultipart(
        { customerId: stored.customerId, documentTypeKey: 'other', title: `WhatsApp: ${name}`.slice(0, 200), customerVisible: true },
        { originalname: name, mimetype: message.media.mime, size: data.length, buffer: data },
      );
      await this.db.tx((tx) => tx.waMessage.update({ where: { id: stored.messageId! }, data: { documentId: doc.documentId } }));
    } catch (e) {
      // The message is kept either way; staff see why the file is missing.
      const reason = e instanceof AppError || e instanceof Error ? e.message : 'unknown error';
      this.logger.warn(`whatsapp media of ${stored.messageId} not stored: ${reason}`);
      await this.db.tx((tx) => tx.waMessage.update({ where: { id: stored.messageId! }, data: { error: `The file could not be stored: ${reason}`.slice(0, 500) } }));
    }
    return { conversationId: stored.conversationId, duplicate: false };
  }

  /** Development sandbox: what the webhook would do for a customer's message. Never available in production. */
  async simulate(input: SimulateInboundInput) {
    if (env().NODE_ENV === 'production' || env().WHATSAPP_DRIVER !== 'log') throw Errors.forbidden('SANDBOX_ONLY', 'Simulated messages are only available in the development sandbox.');
    const media = input.media ? { mime: input.media.slice(5, input.media.indexOf(';')), data: Buffer.from(input.media.split(',')[1] ?? '', 'base64'), name: input.mediaName ?? null } : undefined;
    return this.ingest({ providerMessageId: `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, phone: input.phone, name: input.name ?? null, kind: media ? (media.mime === 'application/pdf' ? 'DOCUMENT' : 'IMAGE') : 'TEXT', text: input.text ?? null, at: new Date(), media }, null);
  }

  // ------------------------------------------------------------------ Meta webhook (public)
  private async integration(id: string) {
    const row = await this.sys.client.integration.findFirst({ where: { id, category: 'WHATSAPP', provider: 'meta', status: 'ACTIVE' }, select: { id: true, tenantId: true, config: true, secretsEnc: true } });
    if (!row?.tenantId) throw Errors.notFound('Webhook');
    const config = (row.config ?? {}) as Record<string, string>;
    let secrets: Record<string, string> = {};
    try {
      secrets = row.secretsEnc ? decryptJson(row.secretsEnc) : {};
    } catch {
      throw Errors.notFound('Webhook');
    }
    return { tenantId: row.tenantId, config, secrets };
  }

  /** Meta's subscription handshake: echo the challenge when the verify token matches. */
  async verify(integrationId: string, mode: string | undefined, token: string | undefined, challenge: string | undefined) {
    const i = await this.integration(integrationId);
    if (mode !== 'subscribe' || !i.config.verifyToken || !token || !safeEqual(token, i.config.verifyToken)) throw Errors.forbidden('VERIFY_FAILED', 'The verify token does not match.');
    return challenge ?? '';
  }

  /** Signature-verified over the raw body; unknown numbers and other centres' numbers are ignored. */
  async receive(integrationId: string, raw: Buffer | undefined, headers: IncomingHttpHeaders) {
    const i = await this.integration(integrationId);
    const signature = String(headers['x-hub-signature-256'] ?? '');
    if (!raw || !i.secrets.appSecret || !signature.startsWith('sha256=')) throw Errors.unauthorized('SIGNATURE_REQUIRED', 'The request is not signed.');
    const expected = `sha256=${createHmac('sha256', i.secrets.appSecret).update(raw).digest('hex')}`;
    if (!safeEqual(signature, expected)) throw Errors.unauthorized('SIGNATURE_INVALID', 'The signature does not match.');
    let payload: MetaPayload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw Errors.badRequest('INVALID_JSON', 'The body is not JSON.');
    }
    const provider = i.secrets.accessToken && i.config.phoneNumberId ? new MetaWhatsAppProvider({ phoneNumberId: i.config.phoneNumberId, accessToken: i.secrets.accessToken, apiVersion: i.config.apiVersion }) : null;
    let received = 0;
    let statuses = 0;
    await runAsTenant(i.tenantId, async () => {
      for (const entry of payload?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          const value = change?.value ?? {};
          if (i.config.phoneNumberId && value?.metadata?.phone_number_id && String(value.metadata.phone_number_id) !== String(i.config.phoneNumberId)) continue;
          const names = new Map<string, string>((value.contacts ?? []).map((c) => [String(c.wa_id), String(c.profile?.name ?? '')]));
          for (const m of value.messages ?? []) {
            const kind = KIND[m.type] ?? 'OTHER';
            const media = m.image ?? m.document;
            await this.ingest(
              {
                providerMessageId: String(m.id),
                phone: `+${String(m.from).replace(/\D/g, '')}`,
                name: names.get(String(m.from)) || null,
                kind,
                text: m.text?.body ?? media?.caption ?? null,
                at: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
                media: media?.id ? { providerId: String(media.id), mime: String(media.mime_type ?? 'application/octet-stream'), name: media.filename ? String(media.filename) : null } : undefined,
              },
              provider,
            );
            received += 1;
          }
          for (const s of value.statuses ?? []) {
            const status = ({ sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' } as Record<string, string>)[String(s.status)];
            if (!status) continue;
            await this.db.tx((tx) => tx.waMessage.updateMany({ where: { tenantId: i.tenantId, providerMessageId: String(s.id), direction: 'OUT' }, data: { status, ...(status === 'FAILED' ? { error: String(s.errors?.[0]?.title ?? 'Not delivered').slice(0, 500) } : {}) } }));
            statuses += 1;
          }
        }
      }
    });
    return { received, statuses };
  }

  // ------------------------------------------------------------------ privacy
  async erase(tx: Tx, subject: ErasureSubject) {
    const tenantId = this.db.tenantId;
    const conversations = await tx.waConversation.findMany({ where: { tenantId, customerId: { in: subject.customerIds } }, select: { id: true } });
    const messages = await tx.waMessage.deleteMany({ where: { tenantId, conversationId: { in: conversations.map((c) => c.id) } } });
    const removed = await tx.waConversation.deleteMany({ where: { tenantId, id: { in: conversations.map((c) => c.id) } } });
    return { conversations: removed.count, messages: messages.count };
  }
}
