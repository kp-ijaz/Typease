import { Injectable } from '@nestjs/common';
import type { PublicTrackRequestBody } from '@typease/validation';
import { runAsTenant } from '../../common/context';
import { safeEqual } from '../../common/crypto';
import { TenantDb } from '../../common/db/prisma.service';
import { Errors } from '../../common/errors';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import { trackingHash } from './request-state-machine.service';
import { externalStatusView, statusLabel } from './request-view.service';

/**
 * Public tracking with the request number and the tracking code the customer
 * received at submission. It answers "where is my request?" and nothing else:
 * no names, no documents, no amounts, no internal reasons, no staff.
 */
@Injectable()
export class TrackingService {
  constructor(
    private readonly db: TenantDb,
    private readonly resolver: TenantResolver,
  ) {}

  async track(input: PublicTrackRequestBody) {
    // Unknown centre, unknown number and wrong code are indistinguishable.
    const notFound = Errors.notFound('Request');
    const tenantId = await this.resolver.resolveId(input.tenantSlug || null);
    const supplied = trackingHash(input.trackingCode);
    if (!tenantId) throw notFound;
    return runAsTenant(tenantId, () =>
      this.db.tx(async (tx) => {
        const request = await tx.serviceRequest.findFirst({
          where: { tenantId, requestNo: input.requestNo, deletedAt: null },
          select: {
            id: true, requestNo: true, status: true, serviceSnapshot: true, submittedAt: true, completedAt: true, trackingCodeHash: true,
            externalStatus: true, externalStatusSource: true, externalStatusAt: true, service: { select: { name: true, nameAr: true } },
          },
        });
        // Compare against a dummy hash when there is no such request, so both paths do the same work.
        const ok = safeEqual(supplied, request?.trackingCodeHash ?? '0'.repeat(64));
        if (!request || !request.trackingCodeHash || !ok) throw notFound;
        const history = await tx.requestStatusHistory.findMany({ where: { tenantId, requestId: request.id, customerVisible: true }, select: { toStatus: true, fromStatus: true, createdAt: true, meta: true } });
        const snapshot = (request.serviceSnapshot ?? {}) as { name?: string; nameAr?: string | null };
        return {
          requestNo: request.requestNo,
          service: { name: snapshot.name ?? request.service.name, nameAr: snapshot.nameAr ?? request.service.nameAr },
          status: request.status,
          statusLabel: statusLabel(request.status, true),
          submittedAt: request.submittedAt,
          completedAt: request.completedAt,
          timeline: history
            // Status changes only: free-text messages may contain personal details and stay in the portal.
            .filter((h) => h.fromStatus !== h.toStatus)
            .sort((a, b) => Number((a.meta as any)?.seq ?? 0) - Number((b.meta as any)?.seq ?? 0) || a.createdAt.getTime() - b.createdAt.getTime())
            .map((h) => ({ status: h.toStatus, statusLabel: statusLabel(h.toStatus, true), at: h.createdAt })),
          externalStatus: externalStatusView(request.externalStatus, request.externalStatusSource, request.externalStatusAt),
        };
      }),
    );
  }
}
