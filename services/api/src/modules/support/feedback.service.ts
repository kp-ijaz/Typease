import { Injectable } from '@nestjs/common';
import type { FeedbackInput, FeedbackListQuery, FeedbackSummaryQuery, PageQueryInput } from '@typease/validation';
import { AuditService } from '../../common/audit.service';
import { Prisma, TenantDb, Tx } from '../../common/db/prisma.service';
import { Errors, found } from '../../common/errors';
import { pageArgs, pageResult } from '../../common/pagination';
import { ctx } from '../../common/context';
import { ownCustomerId } from '../../common/scope';

const monthOf = (date: Date, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).format(date).slice(0, 7);
  } catch {
    return date.toISOString().slice(0, 7);
  }
};
const addMonths = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Customer satisfaction: one rating (1-5) per resolved ticket or completed request. */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
  ) {}

  private async shape(tx: Tx, rows: Array<Prisma.CustomerFeedbackGetPayload<{ include: { customer: { select: { fullName: true } } } }>>) {
    const tenantId = this.db.tenantId;
    const ticketIds = rows.map((r) => r.ticketId).filter((v): v is string => !!v);
    const requestIds = rows.map((r) => r.requestId).filter((v): v is string => !!v);
    const tickets = ticketIds.length ? await tx.supportTicket.findMany({ where: { tenantId, id: { in: ticketIds } }, select: { id: true, ticketNo: true, subject: true } }) : [];
    const requests = requestIds.length ? await tx.serviceRequest.findMany({ where: { tenantId, id: { in: requestIds } }, select: { id: true, requestNo: true } }) : [];
    return rows.map((r) => ({
      id: r.id,
      kind: r.ticketId ? ('TICKET' as const) : ('REQUEST' as const),
      rating: r.rating,
      comment: r.comment,
      customerId: r.customerId,
      customerName: r.customer.fullName,
      ticketId: r.ticketId,
      ticketNo: tickets.find((t) => t.id === r.ticketId)?.ticketNo ?? null,
      ticketSubject: tickets.find((t) => t.id === r.ticketId)?.subject ?? null,
      requestId: r.requestId,
      requestNo: requests.find((q) => q.id === r.requestId)?.requestNo ?? null,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Who is rating, and which requests they may rate:
   *  - a customer, or an employee signed in to the corporate portal: requests about themselves;
   *  - a company administrator (permission "see the company's requests"): every request of the company.
   * A request carries one rating, whoever gives it; it is stored against the person the request is about.
   */
  private rater(): { customerId: string | null; requests: Prisma.ServiceRequestWhereInput } {
    const c = ctx();
    if (c.actorType === 'CORPORATE') {
      if (!c.corporateAccountId) throw Errors.forbidden('NO_CORPORATE_ACCOUNT', 'Your account is not linked to a company.');
      if (c.permissions.has('corp.requests.read')) return { customerId: null, requests: { corporateAccountId: c.corporateAccountId } };
    }
    const customerId = ownCustomerId(c);
    return { customerId, requests: { customerId } };
  }

  /** A customer rates one of their own resolved tickets or completed requests, once; a company administrator a completed request of the company. */
  async rate(input: FeedbackInput) {
    const rater = this.rater();
    let customerId = rater.customerId;
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const subject = input.ticketId ? `ticket:${input.ticketId}` : `request:${input.requestId}`;
      // Serialises concurrent ratings of the same ticket / request: there can only ever be one.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`feedback:${tenantId}:${subject}`}, 0))`;
      if (input.ticketId) {
        // Tickets opened by a company have no customer record behind them, and a rating is stored against one.
        if (!customerId) throw Errors.unprocessable('TICKET_RATING_NOT_AVAILABLE', 'Tickets opened for a company cannot be rated. You can rate the completed requests of your company.');
        const ticket = found(await tx.supportTicket.findFirst({ where: { id: input.ticketId, tenantId, scope: 'CUSTOMER', customerId }, select: { id: true, status: true } }), 'Ticket');
        if (!['RESOLVED', 'CLOSED'].includes(ticket.status)) throw Errors.conflict('NOT_RESOLVED', 'You can rate this ticket once it has been resolved.');
        if (await tx.customerFeedback.findFirst({ where: { tenantId, ticketId: ticket.id }, select: { id: true } })) throw Errors.conflict('ALREADY_RATED', 'This ticket has already been rated. Thank you for your feedback.');
      } else {
        const request = found(await tx.serviceRequest.findFirst({ where: { id: input.requestId!, tenantId, deletedAt: null, AND: [rater.requests] }, select: { id: true, status: true, customerId: true } }), 'Request');
        customerId = request.customerId;
        if (request.status !== 'COMPLETED') throw Errors.conflict('NOT_COMPLETED', 'You can rate this request once it has been completed.');
        if (await tx.customerFeedback.findFirst({ where: { tenantId, requestId: request.id }, select: { id: true } })) throw Errors.conflict('ALREADY_RATED', 'This request has already been rated. Thank you for your feedback.');
      }
      const row = await tx.customerFeedback.create({ data: { tenantId, customerId: customerId!, ticketId: input.ticketId ?? null, requestId: input.requestId ?? null, rating: input.rating, comment: input.comment ?? null } });
      await this.audit.log({ action: 'feedback.submitted', resourceType: 'CustomerFeedback', resourceId: row.id, after: { ticketId: row.ticketId, requestId: row.requestId, rating: row.rating } }, tx);
      return { id: row.id, ticketId: row.ticketId, requestId: row.requestId, rating: row.rating, comment: row.comment, createdAt: row.createdAt };
    });
  }

  /**
   * The ratings a person may see: a customer their own; a company administrator the ratings of the
   * company's requests (whoever gave them, with the name of the person the request is about).
   */
  async mine(query: PageQueryInput) {
    const rater = this.rater();
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const company = !rater.customerId;
      let where: Prisma.CustomerFeedbackWhereInput;
      if (company) {
        // `customer_feedback.requestId` is a plain column (no relation): the company's rated requests are looked up first.
        const rated = await tx.serviceRequest.findMany({ where: { tenantId, deletedAt: null, status: 'COMPLETED', AND: [rater.requests] }, select: { id: true } });
        where = { tenantId, requestId: { in: rated.map((r) => r.id) } };
      } else where = { tenantId, customerId: rater.customerId! };
      const rows = await tx.customerFeedback.findMany({ where, ...pageArgs(query, ['createdAt'] as const, 'createdAt:desc'), include: { customer: { select: { fullName: true } } } });
      const total = await tx.customerFeedback.count({ where });
      const shaped = await this.shape(tx, rows);
      // A company administrator sees whom each rating is about; a person's own list needs no name.
      return pageResult(company ? shaped : shaped.map(({ customerId: _c, customerName: _n, ...rest }) => rest), total, query);
    });
  }

  async list(query: FeedbackListQuery) {
    return this.db.tx(async (tx) => {
      const where: Prisma.CustomerFeedbackWhereInput = {
        tenantId: this.db.tenantId,
        ...(query.customerId ? { customerId: query.customerId } : {}),
        ...(query.maxRating ? { rating: { lte: query.maxRating } } : {}),
        ...(query.kind === 'TICKET' ? { ticketId: { not: null } } : query.kind === 'REQUEST' ? { requestId: { not: null } } : {}),
        ...(query.q ? { comment: { contains: query.q, mode: 'insensitive' } } : {}),
      };
      const rows = await tx.customerFeedback.findMany({ where, ...pageArgs(query, ['createdAt', 'rating'] as const, 'createdAt:desc'), include: { customer: { select: { fullName: true } } } });
      const total = await tx.customerFeedback.count({ where });
      return pageResult(await this.shape(tx, rows), total, query);
    });
  }

  /** Average rating per month (centre time zone), for reports. Default: the last 12 months. */
  async summary(query: FeedbackSummaryQuery) {
    return this.db.tx(async (tx) => {
      const tenantId = this.db.tenantId;
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { timezone: true } });
      const to = query.to ?? monthOf(new Date(), tenant.timezone);
      const from = query.from ?? addMonths(to, -11);
      if (from > to) throw Errors.badRequest('INVALID_RANGE', 'The first month must not be after the last month.');
      if (addMonths(from, 36) <= to) throw Errors.badRequest('RANGE_TOO_LONG', 'Choose a period of at most 36 months.');
      // One day of slack on both sides covers every time zone; rows are then bucketed by the centre's local month.
      const rows = await tx.customerFeedback.findMany({
        where: { tenantId, createdAt: { gte: new Date(new Date(`${from}-01T00:00:00Z`).getTime() - 86_400_000), lt: new Date(new Date(`${addMonths(to, 1)}-01T00:00:00Z`).getTime() + 86_400_000) } },
        select: { rating: true, createdAt: true, ticketId: true },
      });
      const months: Array<{ month: string; count: number; average: number | null; tickets: number; requests: number; distribution: Record<string, number> }> = [];
      for (let m = from; m <= to; m = addMonths(m, 1)) months.push({ month: m, count: 0, average: null, tickets: 0, requests: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
      const sums = new Map<string, number>();
      for (const r of rows) {
        const bucket = months.find((b) => b.month === monthOf(r.createdAt, tenant.timezone));
        if (!bucket) continue;
        bucket.count += 1;
        bucket[r.ticketId ? 'tickets' : 'requests'] += 1;
        bucket.distribution[String(r.rating)] += 1;
        sums.set(bucket.month, (sums.get(bucket.month) ?? 0) + r.rating);
      }
      for (const b of months) if (b.count) b.average = Math.round(((sums.get(b.month) ?? 0) / b.count) * 100) / 100;
      const count = months.reduce((n, b) => n + b.count, 0);
      const total = [...sums.values()].reduce((n, v) => n + v, 0);
      return { from, to, timezone: tenant.timezone, overall: { count, average: count ? Math.round((total / count) * 100) / 100 : null }, months };
    });
  }
}
