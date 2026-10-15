import type { Tx } from './db/prisma.service';
import { Errors } from './errors';

/**
 * One way to say "this customer was erased", wherever a customer is mentioned.
 *
 * A privacy erasure keeps the customer row (invoices, payments and requests still point at it) but
 * blanks every personal field, renames it to a placeholder and sets the status ANONYMISED. Staff can
 * still open the record as a stub; every place that embeds a customer - an invoice, a payment, a
 * request, a document, an employee row, a merge link - marks it with `erased: true` so that a screen
 * can show "Erased customer" as a fact instead of as a strange name.
 */
export const ERASED_CUSTOMER_STATUS = 'ANONYMISED' as const;
export const ERASED_CUSTOMER_NAME = 'Erased customer';

/**
 * Erased: the record itself (status ANONYMISED), or a record that was merged into another one before
 * the person was erased - such a record keeps the status MERGED (finance still finds what stayed on
 * it) but was blanked in the same step and carries the placeholder name.
 */
export const isErasedCustomer = (customer: { status?: string | null; fullName?: string | null } | null | undefined): boolean =>
  !!customer && (customer.status === ERASED_CUSTOMER_STATUS || (customer.status === 'MERGED' && customer.fullName === ERASED_CUSTOMER_NAME));

/**
 * An embedded customer reference: the selected columns without the internal record status, plus
 * `erased`. Select `status` together with the columns you embed and pass the row through here.
 */
export function customerRef<T extends { status: string; fullName?: string | null }>(customer: T): Omit<T, 'status'> & { erased: boolean };
export function customerRef<T extends { status: string; fullName?: string | null }>(customer: T | null | undefined): (Omit<T, 'status'> & { erased: boolean }) | null;
export function customerRef<T extends { status: string; fullName?: string | null }>(customer: T | null | undefined) {
  if (!customer) return null;
  const { status: _status, ...rest } = customer;
  return { ...rest, erased: isErasedCustomer(customer) };
}

/** For presenters that spread a row with an included `customer`: replaces it by its reference form. */
export function embedCustomerRef<T extends Record<string, any>>(row: T): T {
  const customer = row.customer;
  if (!customer || typeof customer !== 'object' || !('status' in customer)) return row;
  return { ...row, customer: customerRef(customer as { status: string; fullName?: string | null }) };
}

export const customerErasedError = () =>
  Errors.conflict('CUSTOMER_ERASED', 'The personal data of this customer was erased. The record is kept only as a reference for past requests, invoices and payments: it cannot be changed and nothing new can be added to it.');

/**
 * For code that is about to attach something new to a customer (a request, an invoice, an appointment,
 * a reminder, a ticket ...): an erased record answers 409 CUSTOMER_ERASED - staff can still open the
 * record, so "not found" would be a lie. Unknown ids are left to the caller's own "not found".
 */
export async function assertCustomerNotErased(tx: Tx, tenantId: string, customerId: string | null | undefined): Promise<void> {
  if (!customerId) return;
  const row = await tx.customer.findFirst({ where: { id: customerId, tenantId }, select: { status: true } });
  if (isErasedCustomer(row)) throw customerErasedError();
}
