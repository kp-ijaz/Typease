import { Injectable } from '@nestjs/common';
import type { DocumentShareInput } from '@typease/validation';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit.service';
import { ctx, runAsTenant, tryCtx } from '../../common/context';
import { randomToken, sha256 } from '../../common/crypto';
import { TenantDb } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { StorageService } from '../storage/storage.service';
import { DocumentAccess } from './access';
import { DocumentsService, notAvailable } from './documents.service';
import { documentDownloadable } from './presenters';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CUSTOMER_FACING = ['TRIAL', 'ACTIVE', 'PAST_DUE'];
const linkExpired = (message = 'This link has expired or is no longer valid. Ask the sender for a new one.') => Errors.forbidden('LINK_EXPIRED', message);

/**
 * A share token is "<tenant id>.<256-bit secret>". The tenant part only routes
 * the lookup into that tenant's row-level-security context (it is not a
 * secret); possession of the random part is the capability. Only the SHA-256
 * of the whole token is stored.
 */
function mintToken(tenantId: string): string {
  return `${Buffer.from(tenantId.replace(/-/g, ''), 'hex').toString('base64url')}.${randomToken(32)}`;
}
export function tenantOfShareToken(token: string): string | null {
  const [head, secret, ...rest] = (token ?? '').split('.');
  if (!head || !secret || rest.length || !/^[A-Za-z0-9_-]{43}$/.test(secret) || !/^[A-Za-z0-9_-]{22}$/.test(head)) return null;
  const hex = Buffer.from(head, 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID_RE.test(id) ? id : null;
}

/**
 * Secure sharing: time-limited (at most 7 days), download-capped links to one
 * document. A share never exposes the file itself; redeeming it returns a fresh
 * download URL that expires within DOWNLOAD_URL_TTL_SECONDS.
 */
@Injectable()
export class DocumentSharesService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly access: DocumentAccess,
    private readonly documents: DocumentsService,
  ) {}

  private present(share: { id: string; documentId: string; recipient: string | null; expiresAt: Date; maxDownloads: number; downloadCount: number; revokedAt: Date | null; createdById: string | null; createdAt: Date }) {
    const now = new Date();
    return {
      id: share.id,
      documentId: share.documentId,
      recipient: share.recipient,
      expiresAt: share.expiresAt,
      maxDownloads: share.maxDownloads,
      downloadCount: share.downloadCount,
      revokedAt: share.revokedAt,
      createdById: share.createdById,
      createdAt: share.createdAt,
      active: !share.revokedAt && share.expiresAt > now && share.downloadCount < share.maxDownloads,
    };
  }

  async create(documentId: string, input: DocumentShareInput) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const doc = await this.access.findReadable(tx, documentId);
      if (doc.requestId) await this.access.assertRequestInScope(tx, doc.requestId);
      const version = doc.currentVersionId ? await tx.documentVersion.findFirst({ where: { id: doc.currentVersionId, tenantId } }) : null;
      if (!documentDownloadable(doc, version)) throw notAvailable(doc, version);
      const token = mintToken(tenantId);
      const share = await tx.documentShare.create({
        data: {
          tenantId,
          documentId: doc.id,
          tokenHash: sha256(token),
          recipient: input.recipient ?? null,
          expiresAt: new Date(Date.now() + input.expiresInHours * 3600_000),
          maxDownloads: input.maxDownloads,
          createdById: ctx().userId ?? null,
        },
      });
      await this.documents.logAccess(tx, doc.id, doc.currentVersionId, 'SHARE_CREATED');
      await this.audit.log(
        { action: 'document.share_created', resourceType: 'DocumentShare', resourceId: share.id, after: { documentId: doc.id, expiresAt: share.expiresAt, maxDownloads: share.maxDownloads, recipient: share.recipient } },
        tx,
      );
      // The token is returned exactly once; it cannot be recovered later.
      return { ...this.present(share), token, url: `${env().API_PUBLIC_URL}/api/v1/public/shared-documents/${token}` };
    });
  }

  async list(documentId: string) {
    return this.db.tx(async (tx) => {
      const doc = await this.access.findReadable(tx, documentId);
      const shares = await tx.documentShare.findMany({ where: { tenantId: this.db.tenantId, documentId: doc.id }, orderBy: { createdAt: 'desc' } });
      return shares.map((s) => this.present(s));
    });
  }

  async revoke(documentId: string, shareId: string) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const doc = await this.access.findReadable(tx, documentId);
      const share = found(await tx.documentShare.findFirst({ where: { id: shareId, documentId: doc.id, tenantId } }), 'Share link');
      if (share.revokedAt) return this.present(share);
      const after = await tx.documentShare.update({ where: { id: share.id }, data: { revokedAt: new Date() } });
      await this.documents.logAccess(tx, doc.id, doc.currentVersionId, 'SHARE_REVOKED');
      await this.audit.log({ action: 'document.share_revoked', resourceType: 'DocumentShare', resourceId: share.id, after: { documentId: doc.id } }, tx);
      return this.present(after);
    });
  }

  /** Public: exchange a share token for a short-lived download link. Counts as one download. */
  async redeem(token: string) {
    const tenantId = tenantOfShareToken(token);
    if (!tenantId) throw Errors.notFound('Shared document');
    const caller = tryCtx();
    return runAsTenant(
      tenantId,
      () =>
        this.db.tx(async (tx) => {
          const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { status: true } });
          if (!tenant || !CUSTOMER_FACING.includes(tenant.status)) throw Errors.notFound('Shared document');
          const share = await tx.documentShare.findFirst({ where: { tokenHash: sha256(token), tenantId } });
          if (!share) throw Errors.notFound('Shared document');
          const doc = await tx.document.findFirst({ where: { id: share.documentId, tenantId } });
          const version = doc?.currentVersionId ? await tx.documentVersion.findFirst({ where: { id: doc.currentVersionId, tenantId } }) : null;
          if (!doc || !version || !documentDownloadable(doc, version)) throw linkExpired('This document is no longer available.');
          // One atomic statement decides whether this redemption still fits the limits.
          const counted = await tx.$executeRaw`
            UPDATE "document_shares" SET "downloadCount" = "downloadCount" + 1
            WHERE "id" = ${share.id}::uuid AND "tenantId" = ${tenantId}::uuid AND "revokedAt" IS NULL
              AND "expiresAt" > now() AND "downloadCount" < "maxDownloads"`;
          if (!counted) throw linkExpired();
          await this.documents.logAccess(tx, doc.id, version.id, 'SHARE_DOWNLOAD');
          await this.audit.log({ action: 'document.share_downloaded', resourceType: 'DocumentShare', resourceId: share.id, after: { documentId: doc.id, downloadNo: share.downloadCount + 1 } }, tx);
          const mime = version.detectedMime ?? version.declaredMime;
          const link = await this.storage.presignDownload(version.storageKey, { filename: version.originalFilename, contentType: mime, disposition: 'attachment' });
          return {
            title: doc.title,
            filename: version.originalFilename,
            mime,
            sizeBytes: Number(version.sizeBytes),
            download: { url: link.url, expiresAt: link.expiresAt },
            remainingDownloads: Math.max(0, share.maxDownloads - share.downloadCount - 1),
            shareExpiresAt: share.expiresAt,
          };
        }),
      { ip: caller?.ip, userAgent: caller?.userAgent, requestId: caller?.requestId, actorLabel: 'share-link' },
    );
  }
}
