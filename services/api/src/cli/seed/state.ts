import type { CompanyFx, CustomerFx, DemoFixtures, PersonFx, RequestScenarioFx, TenantFx } from './fixture-types';
import { Rng, stream } from './rng';
import { Actor, need, SeedRuntime } from './runtime';
import { Timeline } from './timeline';

/** One printed row of the "who can sign in" list. */
export interface Credential {
  tenant: string;
  app: 'Centre app' | 'Customer portal' | 'Corporate portal' | 'Platform console';
  role: string;
  name: string;
  email: string;
  /** Centre slug; empty for platform staff. */
  slug?: string;
  note?: string;
}

export interface BranchState {
  id: string;
  code: string;
  name: string;
}
export interface ServiceState {
  id: string;
  code: string;
  name: string;
  requiresApproval: boolean;
  complianceCapability: string;
  paymentPolicy: string;
  depositPercent: number | null;
}
export interface CustomerState {
  key: string;
  id: string;
  customerNo: string;
  person: PersonFx;
  fx?: CustomerFx;
  email: string | null;
  phone: string | null;
  /** Sequence number behind the fake identity numbers. */
  identityNo: number;
  /** The fake identity details on file (printed on the sample documents). */
  ids: { emiratesId?: string; emiratesIdExpiry?: string; passportNo?: string; passportExpiry?: string };
  portal?: Actor;
  companyKey?: string;
  employeeId?: string;
  /** Documents already on file (verified), by document type. */
  vault: Map<string, string>;
}
export interface CompanyState {
  key: string;
  fx: CompanyFx;
  id: string;
  accountNo: string;
  admin?: Actor;
  profileCustomerKey?: string;
}
export interface RequestState {
  ref: string;
  fx: RequestScenarioFx;
  id: string;
  requestNo: string;
  customerKey: string;
  branchCode: string;
  trackingCode?: string;
  quotationId?: string;
  invoiceId?: string;
  invoiceTotal?: string;
  paymentIds: string[];
  operatorKey?: string;
  status: string;
}

/** Everything the seed knows about one centre while it builds it. */
export class TenantState {
  id = '';
  owner!: Actor;
  subscriptionId: string | null = null;
  /** The partner authorisation record (Settings > Integrations), once submitted. */
  partnerRecordId: string | null = null;
  readonly staff = new Map<string, Actor>();
  readonly branches = new Map<string, BranchState>();
  readonly services = new Map<string, ServiceState>();
  readonly tags = new Map<string, string>();
  readonly customers = new Map<string, CustomerState>();
  readonly companies = new Map<string, CompanyState>();
  readonly requests = new Map<string, RequestState>();
  readonly counts: Record<string, number> = {};
  private idem = 0;

  constructor(
    readonly fx: TenantFx,
    readonly ctx: SeedContext,
  ) {}

  get slug() {
    return this.fx.slug;
  }
  rng(area: string): Rng {
    return stream(`${this.fx.slug}:${area}`);
  }
  actor(key: string): Actor {
    return key === 'owner' ? this.owner : need(this.staff.get(key), `staff member "${key}" of ${this.slug}`);
  }
  branch(code?: string): BranchState {
    return need(this.branches.get(code ?? this.fx.branches[0].code), `branch "${code}" of ${this.slug}`);
  }
  service(code: string): ServiceState {
    return need(this.services.get(code), `service "${code}" of ${this.slug}`);
  }
  customer(key: string): CustomerState {
    return need(this.customers.get(key), `customer "${key}" of ${this.slug}`);
  }
  company(key: string): CompanyState {
    return need(this.companies.get(key), `company "${key}" of ${this.slug}`);
  }
  request(ref: string): RequestState {
    return need(this.requests.get(ref), `request "${ref}" of ${this.slug}`);
  }
  /** First staff member with a role who may work at the branch. */
  staffByRole(roleKey: string, branchCode?: string): Actor {
    const candidates = [this.fx.owner, ...this.fx.staff].filter((s) => s.roleKey === roleKey && (s.branches === 'ALL' || !branchCode || s.branches.includes(branchCode)));
    if (!candidates.length) throw new Error(`${this.slug} has no ${roleKey}${branchCode ? ` at ${branchCode}` : ''}.`);
    return this.actor(candidates[0].key);
  }
  /** The person who may decide things (assign, cancel, approve discounts) at a branch: its manager, else the owner. */
  decider(branchCode?: string): Actor {
    const manager = this.fx.staff.find((s) => s.roleKey === 'manager' && (s.branches === 'ALL' || !branchCode || s.branches.includes(branchCode)));
    return manager ? this.actor(manager.key) : this.owner;
  }
  /** Who checks documents and completes cases: the reviewer, else the owner. */
  reviewer(): Actor {
    const reviewer = this.fx.staff.find((s) => s.roleKey === 'reviewer');
    return reviewer ? this.actor(reviewer.key) : this.owner;
  }
  receptionist(branchCode?: string): Actor {
    return this.staffByRole('receptionist', branchCode);
  }
  accountant(): Actor {
    const acc = this.fx.staff.find((s) => s.roleKey === 'accountant');
    return acc ? this.actor(acc.key) : this.owner;
  }
  idempotencyKey(purpose: string): string {
    this.idem += 1;
    return `demo-${this.slug}-${purpose}-${String(this.idem).padStart(4, '0')}`;
  }
  count(what: string, by = 1): void {
    this.counts[what] = (this.counts[what] ?? 0) + by;
  }
}

/** State shared by all phases of one seed run. */
export class SeedContext {
  readonly timeline = new Timeline();
  readonly credentials: Credential[] = [];
  readonly tenants: TenantState[] = [];
  /** Things worth showing in the final summary (tracking codes, refusals demonstrated ...). */
  readonly highlights: string[] = [];
  /** Every place the seed wrote to the database directly, for the final report. */
  readonly directDb: string[] = [];
  platformAdmin!: Actor;
  platformSupport!: Actor;
  private identitySeq = 0;
  private refSeq = 0;

  constructor(
    readonly rt: SeedRuntime,
    readonly fixtures: DemoFixtures,
  ) {
    for (const fx of fixtures.tenants) this.tenants.push(new TenantState(fx, this));
  }

  /** Next number for a person's fake identity documents and phone number (global, so nothing collides across centres). */
  nextIdentity(): number {
    this.identitySeq += 1;
    return this.identitySeq;
  }
  nextReference(prefix: string): string {
    this.refSeq += 1;
    return this.fixtures.identity.sampleReference(prefix, this.refSeq);
  }
  noteDirectDb(what: string): void {
    if (!this.directDb.includes(what)) this.directDb.push(what);
  }
}
