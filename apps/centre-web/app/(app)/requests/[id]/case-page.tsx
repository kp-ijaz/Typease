'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock, ArrowRight, Ban, Building2, CalendarClock, CheckCircle2, ChevronDown, CircleSlash, Copy, FilePlus2, Hourglass, ListChecks, Pencil, Printer, RotateCcw,
  ScrollText, UserCog, UserRound, Wand2,
} from 'lucide-react';
import { isApiError } from '@typease/api-client';
import type { RequestStatus } from '@typease/types';
import {
  Alert, Badge, Button, Card, CopyButton, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, PageHeader, Skeleton,
  StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, cn, formatPhone, useI18n, useSession, useToast,
} from '@typease/ui';
import { useCasesApi } from '@/components/cases/api';
import { DocumentChecklist } from '@/components/cases/documents';
import { applyCaseView, blockedText, caseErrorText, isClosed, isForward, transitionLabel, useCase, useNewerWorkflow } from '@/components/cases/shared';
import type { AllowedTransition, CaseView, OtherAction } from '@/components/cases/types';
import { CASE_TABS, CaseProvider, useCaseContext, type CaseContextValue, type CaseDialog, type CaseTab } from './case-context';
import { CaseDialogs } from './case-dialogs';
import { DetailsTab, ExternalTab, HistoryTab, MessagesTab, MoneyTab, OverviewTab, TeamTab } from './case-tabs';
import { CasePrint } from './case-print';

/** Guard codes that only say "the other of two edges applies": not worth showing to a person. */
const ORIGIN_CODES = new Set(['NOT_RELEASED_FOR_PROCESSING', 'RESUME_PREPARATION']);
const DOCUMENT_CODES = new Set(['DOCUMENTS_NOT_VERIFIED', 'DOCUMENTS_REJECTED', 'REJECTED_DOCUMENTS_PENDING', 'COMPLETION_DOCUMENTS_MISSING']);
const PAYMENT_CODES = new Set(['PAYMENT_REQUIRED', 'PAYMENT_INCOMPLETE']);
const QUOTATION_WAIT_CODES = new Set(['QUOTATION_PENDING', 'QUOTATION_STILL_APPROVED', 'QUOTATION_NOT_APPROVED']);

interface ActionItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** Navigate ... */
  href?: string;
  /** ... or do something. */
  run?: () => void;
  destructive?: boolean;
}

export function CasePage({ id }: { id: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const query = useCase(id);
  const queryClient = useQueryClient();
  const [dialog, setDialog] = React.useState<CaseDialog | null>(null);

  // The active tab lives in the URL (?tab=documents) so a link or a reload opens the right one.
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const requested = search.get('tab');
  const goTo = React.useCallback(
    (tab: CaseTab) => {
      const params = new URLSearchParams(search.toString());
      if (tab === 'overview') params.delete('tab');
      else params.set('tab', tab);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, search],
  );

  const view = query.data;
  const apply = React.useCallback((next?: CaseView | null) => applyCaseView(queryClient, next, id), [queryClient, id]);
  const context = React.useMemo<CaseContextValue | null>(
    () => (view ? { view, apply, open: setDialog, goTo, can: (action: OtherAction) => view.allowedActions.other.includes(action) } : null),
    [view, apply, goTo],
  );

  if (query.isPending) return <CaseSkeleton />;
  if (query.isError || !view || !context) {
    const notFound = isApiError(query.error) && query.error.status === 404;
    return (
      <>
        <PageHeader title={t('cases.case.metaTitle')} breadcrumbs={[{ label: t('nav.requests'), href: '/requests' }]} />
        <Alert
          tone={notFound ? 'warning' : 'danger'}
          title={notFound ? t('cases.case.notFoundTitle') : t('cases.case.loadErrorTitle')}
          action={
            <>
              {notFound ? null : (
                <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                  {t('common.retry')}
                </Button>
              )}
              <Button asChild size="sm" variant="outline">
                <Link href="/requests">{t('cases.case.backToList')}</Link>
              </Button>
            </>
          }
        >
          {notFound ? t('cases.case.notFoundText') : caseErrorText(query.error, i18n)}
        </Alert>
      </>
    );
  }

  const tabs = CASE_TABS.filter((tab) => (tab === 'money' ? !!view.finance : true));
  const tab: CaseTab = tabs.includes(requested as CaseTab) ? (requested as CaseTab) : 'overview';

  return (
    <CaseProvider value={context}>
      <CaseHeader />
      <NextStepPanel />
      <Tabs value={tab} onValueChange={(value) => goTo(value as CaseTab)} className="mt-6">
        <TabsList aria-label={t('cases.case.sections')}>
          {tabs.map((key) => (
            <TabsTrigger key={key} value={key}>
              {t(`cases.tabs.${key}`)}
              <TabCount tab={key} view={view} />
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="details">
          <DetailsTab />
        </TabsContent>
        <TabsContent value="documents">
          <DocumentChecklist
            view={view}
            onChanged={apply}
            onAskCustomer={canAskCustomer(view) ? () => setDialog({ type: 'requestInfo', label: t('cases.next.askForDocuments') }) : undefined}
          />
        </TabsContent>
        {view.finance ? (
          <TabsContent value="money">
            <MoneyTab />
          </TabsContent>
        ) : null}
        <TabsContent value="team">
          <TeamTab />
        </TabsContent>
        <TabsContent value="external">
          <ExternalTab />
        </TabsContent>
        <TabsContent value="messages">
          <MessagesTab />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab />
        </TabsContent>
      </Tabs>
      <CaseDialogs dialog={dialog} onClose={() => setDialog(null)} />
      <CasePrint view={view} />
    </CaseProvider>
  );
}

function CaseSkeleton() {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t('common.loading')} className="space-y-6">
      <div className="space-y-2.5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-10 w-full max-w-2xl" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

/** A small number on a tab when something in it needs attention. */
function TabCount({ tab, view }: { tab: CaseTab; view: CaseView }) {
  const { formatNumber } = useI18n();
  let count = 0;
  let tone: 'warning' | 'neutral' = 'neutral';
  if (tab === 'documents') {
    count = view.checklist.filter((l) => l.kind === 'INPUT' && ((l.status === 'MISSING' && l.isMandatory) || l.status === 'REJECTED' || l.status === 'UPLOADED')).length;
    tone = 'warning';
  } else if (tab === 'messages') count = view.comments.length;
  else if (tab === 'team') {
    count = view.approvals.filter((a) => a.status === 'PENDING' && !a.superseded).length;
    tone = 'warning';
  } else if (tab === 'external') count = view.externalReferences.length;
  if (!count || isClosed(view.status)) return count && (tab === 'messages' || tab === 'external') ? <Badge tone="neutral">{formatNumber(count)}</Badge> : null;
  return <Badge tone={tone}>{formatNumber(count)}</Badge>;
}

// ---------------------------------------------------------------- header

function CaseHeader() {
  const { t, pick, formatDate, formatMoney } = useI18n();
  const session = useSession();
  const { view, open, can } = useCaseContext();
  const balance = view.finance?.totals?.balance;
  const facts: Array<{ icon: React.ReactNode; label: string; value: React.ReactNode }> = [
    {
      icon: <UserRound />,
      label: t('cases.fields.customer'),
      value: (
        <>
          {session.hasPermission('customer.read') ? (
            <Link href={`/customers/${view.customer.id}`} className="font-medium text-secondary-text underline-offset-4 hover:underline">
              {pick(view.customer.fullName, view.customer.fullNameAr) || view.customer.fullName}
            </Link>
          ) : (
            <span className="font-medium">{view.customer.fullName}</span>
          )}
          <span className="block text-sm text-muted-foreground">
            <span className="tabular">{view.customer.customerNo}</span>
            {view.customer.phone ? (
              <>
                {' · '}
                <span className="ltr-value tabular">{formatPhone(view.customer.phone)}</span>
              </>
            ) : null}
          </span>
        </>
      ),
    },
    {
      icon: <Building2 />,
      label: t('cases.fields.branch'),
      value: pick(view.branch.name, view.branch.nameAr),
    },
    {
      icon: <UserCog />,
      label: t('cases.fields.assignee'),
      value: (
        <>
          {view.assignee ? <span className="font-medium">{view.assignee.name}</span> : <span className="text-muted-foreground">{t('requests.unassigned')}</span>}
          {view.reviewer ? <span className="block text-sm text-muted-foreground">{t('cases.fields.reviewerIs', { name: view.reviewer.name })}</span> : null}
        </>
      ),
    },
    {
      icon: <CalendarClock />,
      label: t('cases.fields.targetDate'),
      value: (
        <span className="flex flex-wrap items-center gap-2">
          {view.targetDate ? <span className="tabular">{formatDate(view.targetDate)}</span> : <span className="text-muted-foreground">{t('common.notSet')}</span>}
          {view.overdue ? (
            <Badge tone="danger" icon={<AlarmClock />}>
              {t('requests.overdue')}
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      icon: <CheckCircle2 />,
      label: t('cases.fields.payment'),
      value: (
        <span className="flex flex-wrap items-center gap-2">
          <StatusBadge kind="requestPayment" status={view.paymentStatus} />
          {balance && Number(balance) > 0 ? <span className="tabular text-sm text-muted-foreground">{t('cases.fields.balanceDue', { amount: formatMoney(balance, view.finance?.invoices[0]?.currency) })}</span> : null}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t('nav.requests'), href: '/requests' }]}
        title={
          <span className="inline-flex items-center gap-1.5">
            <span className="tabular">{view.requestNo}</span>
            <CopyButton value={view.requestNo} label={t('requests.copyNumber')} className="print:hidden" />
          </span>
        }
        meta={
          <>
            <StatusBadge kind="request" status={view.status} label={view.statusLabel} />
            <StatusBadge kind="priority" status={view.priority} className={view.priority === 'NORMAL' || view.priority === 'LOW' ? 'border bg-transparent' : undefined} />
            {view.overdue ? <Badge tone="danger">{t('requests.overdue')}</Badge> : null}
          </>
        }
        description={
          <span dir="auto">
            {pick(view.service.name, view.service.nameAr)}
            {view.corporateAccount ? ` · ${pick(view.corporateAccount.companyName, view.corporateAccount.companyNameAr)}` : ''}
          </span>
        }
        secondary={
          can('edit_details') ? (
            <Button variant="outline" onClick={() => open({ type: 'details' })}>
              <Pencil aria-hidden="true" />
              {t('cases.actions.detailsShort')}
            </Button>
          ) : undefined
        }
      />
      <Card className="mb-5">
        <dl className="grid gap-x-6 gap-y-4 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3 xl:grid-cols-5">
          {facts.map((fact) => (
            <div key={fact.label} className="flex min-w-0 gap-3">
              <span aria-hidden="true" className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
                {fact.icon}
              </span>
              <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">{fact.label}</dt>
                <dd className="break-words text-base text-foreground">{fact.value}</dd>
              </div>
            </div>
          ))}
        </dl>
      </Card>
    </>
  );
}

/** A document of the customer was rejected and the request can be handed back to the customer now. */
function canAskCustomer(view: CaseView): boolean {
  return (
    view.status !== 'AWAITING_CUSTOMER' &&
    view.checklist.some((line) => line.kind === 'INPUT' && line.status === 'REJECTED') &&
    view.allowedActions.transitions.some((tr) => tr.to === 'AWAITING_CUSTOMER' && tr.enabled)
  );
}

// ---------------------------------------------------------------- "What happens next"

const WAITING_STYLE = {
  CENTRE: { box: 'border-secondary/30 bg-secondary-soft/60', icon: <ListChecks />, tile: 'bg-secondary text-secondary-foreground' },
  CUSTOMER: { box: 'border-warning/40 bg-warning-soft/70', icon: <Hourglass />, tile: 'bg-warning text-warning-foreground' },
  AUTHORITY: { box: 'border-info/25 bg-info-soft/70', icon: <Building2 />, tile: 'bg-info text-info-foreground' },
  NOBODY: { box: 'bg-card', icon: <CircleSlash />, tile: 'bg-muted text-muted-foreground' },
} as const;

function NextStepPanel() {
  const i18n = useI18n();
  const { t, pick, formatDateTime, formatMoney } = i18n;
  const session = useSession();
  const api = useCasesApi();
  const toasts = useToast();
  const { view, apply, open, goTo, can } = useCaseContext();
  const [running, setRunning] = React.useState<string | null>(null);
  const newerWorkflow = useNewerWorkflow(view);
  /** Why something is not possible yet. A payment guard is worded here with the balance in the reader's language and currency. */
  const guardText = (blocked: { code: string; message: string }) => {
    if (!PAYMENT_CODES.has(blocked.code)) return blockedText(blocked, i18n);
    const due = view.finance?.totals?.balance;
    return due && Number(due) > 0 ? t('cases.next.paymentOutstanding', { amount: formatMoney(due, view.finance?.invoices[0]?.currency) }) : t(`cases.errors.${blocked.code}`);
  };

  const from = view.status;
  const transitions = view.allowedActions.transitions;
  const pendingApproval = view.approvals.find((a) => a.status === 'PENDING' && !a.superseded);
  const unpaid = view.finance?.invoices.find((inv) => Number(inv.balanceDue) > 0 && inv.status !== 'VOID' && inv.status !== 'DRAFT');
  const quotation = view.finance?.quotation ?? null;

  const direct = async (to: RequestStatus, label: string) => {
    setRunning(to);
    try {
      apply(await api.transition(view.id, { to }));
      toasts.success(t('cases.actions.done', { action: label }), view.requestNo);
    } catch (error) {
      toasts.error(caseErrorText(error, i18n));
    } finally {
      setRunning(null);
    }
  };

  /** Some edges are done through their own endpoint, which also satisfies the guard that blocks the plain transition. */
  const special = (tr: AllowedTransition): (() => void) | null => {
    if (from === 'READY_TO_SUBMIT' && tr.to === 'EXTERNAL_PROCESSING' && can('record_submission')) return () => open({ type: 'submission' });
    if (from === 'EXTERNAL_PROCESSING' && tr.to === 'FINAL_REVIEW' && can('record_external_result')) return () => open({ type: 'externalResult', outcome: 'COMPLETED' });
    if (from === 'EXTERNAL_PROCESSING' && tr.to === 'RETURNED' && can('record_external_result')) return () => open({ type: 'externalResult', outcome: 'RETURNED' });
    if (from === 'EXTERNAL_PROCESSING' && tr.to === 'REJECTED' && can('record_external_result')) return () => open({ type: 'externalResult', outcome: 'REJECTED' });
    if (from === 'PENDING_APPROVAL' && pendingApproval && can('decide_approval') && (tr.to === 'READY_TO_SUBMIT' || tr.to === 'IN_PREPARATION'))
      return () => open({ type: 'approval', approval: pendingApproval, decision: tr.to === 'READY_TO_SUBMIT' ? 'APPROVED' : 'REJECTED' });
    return null;
  };
  const usable = (tr: AllowedTransition) => tr.enabled || (special(tr) !== null && tr.blocked?.code !== 'SUBMISSION_NOT_PERMITTED');

  const toAction = (tr: AllowedTransition): ActionItem => {
    const label = transitionLabel(i18n, from, tr.to, tr.action);
    const base = { id: `to-${tr.to}`, label };
    const own = special(tr);
    if (own) return { ...base, run: own };
    if (tr.to === 'CANCELLED') return { ...base, destructive: true, icon: <Ban aria-hidden="true" />, run: () => open({ type: 'cancel' }) };
    if (from === 'COMPLETED') return { ...base, icon: <RotateCcw aria-hidden="true" />, run: () => open({ type: 'reopen' }) };
    if (tr.to === 'COMPLETED') return { ...base, run: () => open({ type: 'complete' }) };
    if (tr.to === 'AWAITING_CUSTOMER') return { ...base, run: () => open({ type: 'requestInfo', label }) };
    if (from === 'DRAFT' && tr.to === 'SUBMITTED') return { ...base, href: `/requests/new?draft=${view.id}&step=review` };
    if (tr.requiresReason) return { ...base, run: () => open({ type: 'reason', to: tr.to, label, requiresReason: true }) };
    return { ...base, run: () => void direct(tr.to, label) };
  };

  // While the customer has to act, both "return" edges collapse into one action that goes through /resubmit.
  const resubmitting = from === 'AWAITING_CUSTOMER' && can('resubmit');
  const returnEdges = resubmitting ? transitions.filter((tr) => tr.to === 'UNDER_REVIEW' || tr.to === 'IN_PREPARATION') : [];
  const resubmitBlock = returnEdges.length && !returnEdges.some((tr) => tr.enabled) ? returnEdges.find((tr) => tr.blocked && !ORIGIN_CODES.has(tr.blocked.code))?.blocked ?? returnEdges[0].blocked : null;
  const resubmitAction: ActionItem | null = returnEdges.some((tr) => tr.enabled) ? { id: 'resubmit', label: t('cases.actions.resubmit.title'), run: () => open({ type: 'resubmit' }) } : null;
  const plain = transitions.filter((tr) => !returnEdges.includes(tr));

  const forward = plain.filter((tr) => isForward(from, tr.to));
  const usableForward = forward.filter(usable);
  const stepDone: ActionItem | null = can('complete_step') ? { id: 'complete-step', label: t('cases.actions.completeStep.title'), run: () => open({ type: 'completeStep' }) } : null;

  /** What a person can do about a guard that blocks the way forward. */
  const resolve = (code: string | undefined, stepType?: string): ActionItem | null => {
    if (code === 'OPERATOR_REQUIRED' && can('assign')) return { id: 'assign', label: t('cases.team.assign.OPERATOR'), run: () => open({ type: 'assign', role: 'OPERATOR' }) };
    if ((code === 'QUOTATION_REQUIRED' || stepType === 'QUOTATION') && session.hasPermission('quotation.manage') && (!quotation || quotation.status !== 'SENT'))
      return { id: 'quote', label: t('cases.next.prepareQuotation'), href: quotation && quotation.status === 'DRAFT' ? `/quotations/${quotation.id}` : `/quotations/new?requestId=${view.id}&customerId=${view.customer.id}` };
    if (code && DOCUMENT_CODES.has(code)) return { id: 'documents', label: t('cases.next.goToDocuments'), run: () => goTo('documents') };
    if (stepType === 'STAFF_VERIFICATION' && session.hasPermission('document.verify')) return { id: 'documents', label: t('cases.next.checkDocuments'), run: () => goTo('documents') };
    if (stepType === 'DOCUMENT_UPLOAD' && from !== 'DRAFT' && (session.hasPermission('document.upload') || can('waive_checklist_item'))) return { id: 'documents', label: t('cases.next.addDocuments'), run: () => goTo('documents') };
    if ((code && PAYMENT_CODES.has(code)) || stepType === 'PAYMENT') {
      if (unpaid && session.hasPermission('payment.record')) return { id: 'pay', label: t('cases.money.recordPayment'), href: `/payments/new?invoiceId=${unpaid.id}&customerId=${view.customer.id}` };
      if (unpaid && session.hasPermission('invoice.read')) return { id: 'invoice', label: t('cases.money.openInvoice'), href: `/invoices/${unpaid.id}` };
    }
    if (((code && QUOTATION_WAIT_CODES.has(code)) || stepType === 'CUSTOMER_APPROVAL') && quotation && session.hasPermission('quotation.read'))
      return { id: 'quotation', label: t('cases.money.openQuotation'), href: `/quotations/${quotation.id}` };
    if (code === 'FORM_INVALID') return { id: 'details', label: t('cases.next.completeDetails'), run: () => goTo('details') };
    return null;
  };

  let primary: ActionItem | null = null;
  if (from === 'DRAFT' && can('edit_fields')) primary = { id: 'continue-draft', label: t('cases.next.continueDraft'), href: `/requests/new?draft=${view.id}` };
  else if (resubmitAction) primary = resubmitAction;
  // A document was rejected but the customer was not asked yet (the request only starts waiting by itself during document verification).
  else if (canAskCustomer(view)) primary = { id: 'ask-customer', label: t('cases.next.askForDocuments'), run: () => open({ type: 'requestInfo', label: t('cases.next.askForDocuments') }) };
  else if (from === 'IN_PREPARATION' && stepDone && usableForward.length !== 1) primary = stepDone;
  else if (usableForward.length) primary = toAction(usableForward[0]);
  // Nothing can move yet: offer what unblocks the step the workflow is waiting at, then what unblocks an edge.
  if (!primary && resubmitBlock) primary = resolve(resubmitBlock.code);
  if (!primary && !isClosed(from)) primary = resolve(view.nextStep.step?.blocked?.code, view.nextStep.step?.type);
  if (!primary) {
    for (const tr of forward) {
      primary = resolve(tr.blocked?.code);
      if (primary) break;
    }
  }

  // Everything else the API allows goes into the menu.
  const secondary: ActionItem[] = [];
  const push = (item: ActionItem | null) => {
    if (item && item.id !== primary?.id && !secondary.some((s) => s.id === item.id)) secondary.push(item);
  };
  for (const tr of plain.filter((x) => x.to !== 'CANCELLED' && usable(x))) push(toAction(tr));
  push(stepDone);
  if (can('assign')) {
    push({ id: 'assign-operator', label: view.assignee ? t('cases.team.reassign.OPERATOR') : t('cases.team.assign.OPERATOR'), icon: <UserCog aria-hidden="true" />, run: () => open({ type: 'assign', role: 'OPERATOR' }) });
    push({ id: 'assign-reviewer', label: view.reviewer ? t('cases.team.reassign.REVIEWER') : t('cases.team.assign.REVIEWER'), icon: <UserCog aria-hidden="true" />, run: () => open({ type: 'assign', role: 'REVIEWER' }) });
  }
  if (can('edit_details')) push({ id: 'details', label: t('cases.actions.detailsTitle'), icon: <Pencil aria-hidden="true" />, run: () => open({ type: 'details' }) });
  if (can('mark_duplicate')) push({ id: 'duplicate', label: t('cases.actions.duplicateTitle'), icon: <Copy aria-hidden="true" />, run: () => open({ type: 'duplicate' }) });
  if (newerWorkflow.available) push({ id: 'migrate', label: t('cases.actions.migrateTitle'), icon: <Wand2 aria-hidden="true" />, run: () => open({ type: 'migrate' }) });
  const links: ActionItem[] = [];
  if (session.hasPermission('request.create')) links.push({ id: 'new', label: t('cases.next.newForCustomer'), icon: <FilePlus2 aria-hidden="true" />, href: `/requests/new?customerId=${view.customer.id}` });
  if (session.hasAnyPermission(['task.read', 'task.manage'])) links.push({ id: 'tasks', label: t('cases.next.tasks'), icon: <ListChecks aria-hidden="true" />, href: `/tasks?requestId=${view.id}` });
  if (session.hasPermission('audit.read')) links.push({ id: 'audit', label: t('cases.history.audit'), icon: <ScrollText aria-hidden="true" />, href: `/audit-log?resourceType=ServiceRequest&resourceId=${view.id}` });
  const cancel = plain.find((tr) => tr.to === 'CANCELLED' && tr.enabled);

  // Steps that are not possible yet, with the reason in plain words.
  const blocked = plain
    .filter((tr) => !usable(tr) && tr.blocked && !ORIGIN_CODES.has(tr.blocked.code))
    .map((tr) => ({ id: tr.to, label: transitionLabel(i18n, from, tr.to, tr.action), reason: tr.blocked ? guardText(tr.blocked) : '' }));
  if (resubmitBlock && !ORIGIN_CODES.has(resubmitBlock.code)) blocked.unshift({ id: 'UNDER_REVIEW', label: t('cases.actions.resubmit.title'), reason: guardText(resubmitBlock) });

  const style = WAITING_STYLE[view.nextStep.waitingOn] ?? WAITING_STYLE.NOBODY;
  const step = view.nextStep.step;
  const stepName = step ? (() => { const full = view.workflow.steps.find((s) => s.key === step.key); return full ? pick(full.name, full.nameAr) : step.name; })() : null;
  const waitingFor =
    view.nextStep.waitingOn === 'CENTRE'
      ? from === 'PENDING_APPROVAL' || from === 'FINAL_REVIEW'
        ? view.reviewer?.name ?? t('cases.next.who.reviewer')
        : view.assignee?.name ?? t('cases.next.who.CENTRE')
      : t(`cases.next.who.${view.nextStep.waitingOn}`);
  const primaryRunning = primary?.id.startsWith('to-') && running === primary.id.slice(3);

  return (
    <section aria-labelledby="next-step-title" className={cn('rounded-lg border p-4 shadow-xs sm:p-5 print:hidden', style.box)} data-waiting-on={view.nextStep.waitingOn}>
      <div className="flex flex-wrap items-start gap-x-5 gap-y-4">
        <span aria-hidden="true" className={cn('flex size-11 shrink-0 items-center justify-center rounded-[0.625rem] [&_svg]:size-5', style.tile)}>
          {style.icon}
        </span>
        <div className="min-w-0 flex-1 basis-56 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 id="next-step-title" className="text-sm font-semibold text-muted-foreground">
              {t('cases.next.title')}
            </h2>
            {view.nextStep.waitingOn !== 'NOBODY' ? <Badge tone="outline">{t('cases.next.waitingFor', { who: waitingFor })}</Badge> : null}
          </div>
          <p className="text-lg font-semibold leading-7 text-foreground">{t(`cases.next.status.${from}`)}</p>
          {stepName ? (
            <p className="text-sm text-foreground/80">
              {t('cases.next.currentStep', { step: stepName })}
              {step?.dueAt ? ` · ${t('cases.overview.due', { time: formatDateTime(step.dueAt) })}` : ''}
            </p>
          ) : null}
          {step?.blocked ? <p className="text-sm font-medium text-warning-text">{guardText(step.blocked)}</p> : null}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto [&>*]:flex-1 sm:[&>*]:flex-none">
          {primary ? (
            primary.href ? (
              <Button asChild size="lg" variant="accent" data-primary-action={primary.id}>
                <Link href={primary.href}>
                  {primary.label}
                  <ArrowRight className="rtl-mirror" aria-hidden="true" />
                </Link>
              </Button>
            ) : (
              <Button size="lg" variant="accent" onClick={primary.run} loading={!!primaryRunning} loadingText={t('common.loading')} data-primary-action={primary.id}>
                {primary.label}
              </Button>
            )
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="lg" disabled={running !== null}>
                {t('common.moreActions')}
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-60">
              {secondary.map((item) =>
                item.href ? (
                  <DropdownMenuItem key={item.id} asChild>
                    <Link href={item.href}>
                      {item.icon}
                      {item.label}
                    </Link>
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem key={item.id} onSelect={item.run}>
                    {item.icon}
                    {item.label}
                  </DropdownMenuItem>
                ),
              )}
              {secondary.length ? <DropdownMenuSeparator /> : null}
              {links.map((item) => (
                <DropdownMenuItem key={item.id} asChild>
                  <Link href={item.href!}>
                    {item.icon}
                    {item.label}
                  </Link>
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onSelect={() => window.setTimeout(() => window.print(), 50)}>
                <Printer aria-hidden="true" />
                {t('cases.next.print')}
              </DropdownMenuItem>
              {cancel ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={() => open({ type: 'cancel' })}>
                    <Ban aria-hidden="true" />
                    {transitionLabel(i18n, from, 'CANCELLED', cancel.action)}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {blocked.length ? (
        <ul className="mt-4 space-y-1.5 border-t border-foreground/10 pt-3 text-sm">
          {blocked.map((item) => (
            <li key={item.id} className="flex flex-wrap gap-x-2 text-foreground/85" data-blocked={item.id}>
              <span className="font-medium text-foreground">{t('cases.next.notYet', { action: item.label })}</span>
              <span>{item.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
