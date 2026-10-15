import type { Tx } from './db/prisma.service';

/**
 * The customer ids that stand for one person after records were merged.
 *
 * A merge retires the duplicate record (`status = MERGED`, `mergedIntoId` = the
 * record that was kept). Rows that may no longer change - issued invoices,
 * completed payments - keep the id of the retired record. Whoever filters or
 * groups by customer therefore has to treat the whole family as one customer.
 *
 * Returns the kept record, the id that was asked for and every record merged
 * into the kept one (directly or through an older chain). An id of another
 * centre, or an unknown id, resolves to itself and so matches nothing there.
 */
export async function mergedCustomerIds(tx: Tx, tenantId: string, customerId: string): Promise<string[]> {
  const rootId = await survivingCustomerId(tx, tenantId, customerId);
  const ids = new Set<string>([rootId, customerId]);
  let frontier = [rootId];
  for (let depth = 0; depth < 10 && frontier.length; depth++) {
    const merged = await tx.customer.findMany({ where: { tenantId, status: 'MERGED', mergedIntoId: { in: frontier } }, select: { id: true } });
    frontier = merged.map((m) => m.id).filter((id) => !ids.has(id));
    for (const id of frontier) ids.add(id);
  }
  return [...ids];
}

/** The record that was kept. The merge keeps the history flat; the loop only guards against older data. */
export async function survivingCustomerId(tx: Tx, tenantId: string, customerId: string): Promise<string> {
  let rootId = customerId;
  for (let hop = 0; hop < 10; hop++) {
    const row = await tx.customer.findFirst({ where: { id: rootId, tenantId }, select: { status: true, mergedIntoId: true } });
    if (!row || row.status !== 'MERGED' || !row.mergedIntoId) break;
    rootId = row.mergedIntoId;
  }
  return rootId;
}
