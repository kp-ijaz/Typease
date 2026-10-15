/**
 * Order in which a tenant's rows are deleted during offboarding.
 *
 * Pure (no database): the caller reads the tables that carry a tenant id and
 * the foreign keys between them from the PostgreSQL catalogue, so a table added
 * by a later migration is purged without touching this code.
 *
 * Why an explicit order is needed: `DELETE FROM tenants` alone would cascade,
 * but many foreign keys BETWEEN tenant tables are ON DELETE RESTRICT (a request
 * references its customer, a payment allocation its invoice ...). A referencing
 * row therefore has to be deleted before the row it points at.
 */
export interface ForeignKey {
  /** Table holding the foreign key column. */
  child: string;
  /** Table it points at. */
  parent: string;
  /** pg_constraint.confdeltype: a = no action, r = restrict, c = cascade, n = set null, d = set default. */
  rule: string;
}

/**
 * Platform registers that outlive a centre. The incident register documents
 * what TypEase did about a security incident and has to stay available to
 * regulators after the centre is gone.
 */
export const KEPT_AFTER_PURGE = ['security_incidents'];

/**
 * Children before parents (Kahn's algorithm, alphabetical among equals so the
 * result is stable). SET NULL / SET DEFAULT keys never block a delete and are
 * ignored; a table that references itself is fine. A cycle of blocking keys
 * cannot be ordered and is reported instead of guessed at.
 */
export function purgeOrder(tables: string[], foreignKeys: ForeignKey[], keep: string[] = KEPT_AFTER_PURGE): string[] {
  const nodes = [...new Set(tables)].filter((t) => t !== 'tenants' && !keep.includes(t)).sort();
  const known = new Set(nodes);
  const parentsOf = new Map<string, Set<string>>(nodes.map((n) => [n, new Set<string>()]));
  const waitingOn = new Map<string, number>(nodes.map((n) => [n, 0]));
  for (const fk of foreignKeys) {
    if (!['a', 'r', 'c'].includes(fk.rule)) continue;
    if (fk.child === fk.parent || !known.has(fk.child) || !known.has(fk.parent)) continue;
    const parents = parentsOf.get(fk.child)!;
    if (parents.has(fk.parent)) continue;
    parents.add(fk.parent);
    // The parent can only be deleted once this child is gone.
    waitingOn.set(fk.parent, waitingOn.get(fk.parent)! + 1);
  }
  const order: string[] = [];
  const ready = nodes.filter((n) => waitingOn.get(n) === 0);
  while (ready.length) {
    ready.sort();
    const table = ready.shift()!;
    order.push(table);
    for (const parent of parentsOf.get(table)!) {
      const left = waitingOn.get(parent)! - 1;
      waitingOn.set(parent, left);
      if (left === 0) ready.push(parent);
    }
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => !order.includes(n));
    throw new Error(`Tenant purge: foreign keys form a cycle between ${stuck.join(', ')}. Add an explicit order for these tables.`);
  }
  return order;
}

/** Table names come from the catalogue, but they are still interpolated into SQL: accept plain identifiers only. */
export function safeIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unexpected table name "${name}".`);
  return `"${name}"`;
}
