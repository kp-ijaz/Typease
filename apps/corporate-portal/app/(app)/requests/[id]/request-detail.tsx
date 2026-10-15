'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CircleCheck, Clock, FileText, Hourglass, Landmark, LifeBuoy, UserRound } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, DescriptionList, PageHeader, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger, Timeline, cn, useI18n, useToast, type TimelineItem,
} from '@typease/ui';
import { CompletedDocuments, DocumentChecklist, missingDocuments } from '@/components/portal/checklist';
import { FeedbackCard } from '@/components/portal/feedback';
import { PayInvoiceButton, type PayableInvoice } from '@/components/portal/pay';
import { useApplyRequest, useRequestView } from '@/components/portal/request-hooks';
import { DetailSkeleton, ExternalStatus, Gate, LoadError, Ltr, Money, NotFoundCard, SectionTitle, isForbidden, isNotFound, NoAccess, useRole } from '@/components/portal/shared';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { RequestView } from '@/lib/types';
import { RequestSubject } from '../new/wizard-steps';
import { CancelRequestDialog, RequestAnswers, RequestMessages } from './request-parts';

const TABS = ['overview', 'documents', 'messages', 'details'] as const;
type Tab = (typeof TABS)[number];
const isTab = (value: string | null): value is Tab => TABS.includes(value as Tab);

/** Guard codes with one meaning get the portal's own words; anything else keeps the API's sentence. */
function useBlockedText() {
  const { t, has } = useI18n();
  return (blocked: { code: string; message: string } | null | undefined) => (blocked ? (has(`my.request.blocked.${blocked.code}`) ? t(`my.request.blocked.${blocked.code}`) : blocked.message) : null);
}

export function RequestDetail({ id }: { id: string }) {
  return (
    <Gate anyOf={['corp.requests.read', 'self.requests']}>
      <Detail id={id} />
    </Gate>
  );
}

/** One request: where it stands in plain words, what the centre needs now, documents, messages, approval and money. */
function Detail({ id }: { id: string }) {
  const { t, pick, formatDate } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const role = useRole();
  const queryClient = useQueryClient();
  const query = useRequestView(id);
  const apply = useApplyRequest(id);
  const [cancelOpen, setCancelOpen] = React.useState(false);

  const tabParam = search.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'overview';
  const setTab = (next: string) => {
    const params = new URLSearchParams(search.toString());
    if (next === 'overview') params.delete('tab');
    else params.set('tab', next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const listLabel = role.company ? t('nav.requests') : t('my.requests.mineTitle');
  const crumbs = [{ label: listLabel, href: ROUTES.requests }];
  if (query.isPending) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={t('titles.requestDetail')} />
        <DetailSkeleton />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader breadcrumbs={crumbs} title={t('titles.requestDetail')} />
        {isNotFound(query.error) ? (
          <NotFoundCard title={t('my.request.notFoundTitle')} text={role.company ? t('my.request.notFoundText') : t('my.request.notFoundTextSelf')} backHref={ROUTES.requests} backLabel={listLabel} />
        ) : isForbidden(query.error) ? (
          <NoAccess />
        ) : (
          <LoadError error={query.error} onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }

  const view = query.data;
  const other = view.allowedActions.other;
  const cancelEdge = view.allowedActions.transitions.find((edge) => edge.to === 'CANCELLED' && edge.enabled);
  const canUpload = other.includes('upload_documents');
  const inputs = view.checklist.filter((line) => line.kind === 'INPUT');
  const toFix = inputs.filter((line) => line.actionRequired || line.status === 'REJECTED').length;
  const hasCompleted = view.checklist.some((line) => line.kind === 'COMPLETION' && line.document?.status === 'AVAILABLE');

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={pick(view.service.name, view.service.nameAr)}
        meta={<StatusBadge kind="requestCustomer" status={view.status} label={view.statusLabel} className="px-3 py-1 text-sm" />}
        description={
          <>
            <Ltr>{view.requestNo}</Ltr>
            {role.company ? (
              <>
                <span aria-hidden="true"> – </span>
                {t('my.request.forSubject')} <RequestSubject view={view} />
              </>
            ) : null}
            <span aria-hidden="true"> – </span>
            {view.submittedAt ? t('my.request.submittedOn', { date: formatDate(view.submittedAt) }) : t('my.request.startedOn', { date: formatDate(view.createdAt) })}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="min-w-0">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="-mx-4 px-4 sm:mx-0 sm:px-0">
              <TabsTrigger value="overview">{t('my.request.tabs.overview')}</TabsTrigger>
              <TabsTrigger value="documents">
                {t('my.request.tabs.documents')}
                {toFix > 0 ? <Badge tone="danger">{toFix}</Badge> : null}
              </TabsTrigger>
              <TabsTrigger value="messages">
                {t('my.request.tabs.messages')}
                {view.comments.length ? <Badge tone="neutral">{view.comments.length}</Badge> : null}
              </TabsTrigger>
              <TabsTrigger value="details">{t('my.request.tabs.details')}</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-5">
              <NowCard view={view} apply={apply} onOpenDocuments={() => setTab('documents')} />
              <ExternalCard view={view} />
              {hasCompleted ? (
                <section aria-labelledby="ready-h" className="space-y-3" data-completed-documents>
                  <SectionTitle id="ready-h">{t('my.request.completedDocuments')}</SectionTitle>
                  <CompletedDocuments view={view} />
                </section>
              ) : null}
              <MoneyCard view={view} />
              <Card>
                <CardContent className="space-y-4">
                  <SectionTitle>{t('my.request.history')}</SectionTitle>
                  <Progress view={view} />
                </CardContent>
              </Card>
              {view.status === 'COMPLETED' && (view.feedback || view.canRate) ? (
                <Card data-request-feedback>
                  <CardContent>
                    <FeedbackCard target={{ requestId: view.id }} existing={view.feedback ?? null} canRate={!!view.canRate} onRated={() => void queryClient.invalidateQueries({ queryKey: keys.requests.detail(view.id) })} />
                  </CardContent>
                </Card>
              ) : null}
            </TabsContent>

            <TabsContent value="documents" className="space-y-5">
              {hasCompleted ? (
                <section aria-labelledby="ready2-h" className="space-y-3">
                  <SectionTitle id="ready2-h">{t('my.request.completedDocuments')}</SectionTitle>
                  <CompletedDocuments view={view} />
                </section>
              ) : null}
              <section aria-labelledby="mine-h" className="space-y-3">
                <SectionTitle id="mine-h">{t('my.request.yourDocuments')}</SectionTitle>
                {canUpload && missingDocuments(view).length ? <p className="text-base text-muted-foreground">{t('my.request.documentsHint')}</p> : null}
                <DocumentChecklist view={view} editable={canUpload} onChanged={apply} />
              </section>
            </TabsContent>

            <TabsContent value="messages">
              <RequestMessages view={view} canWrite={other.includes('comment')} onSent={() => apply()} />
            </TabsContent>

            <TabsContent value="details">
              <RequestAnswers view={view} canEdit={other.includes('edit_fields') && view.status !== 'DRAFT'} apply={apply} />
            </TabsContent>
          </Tabs>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardContent>
              <DescriptionList
                columns={1}
                items={[
                  { label: t('my.requests.columns.number'), value: <Ltr>{view.requestNo}</Ltr> },
                  ...(role.company
                    ? [{ label: t('my.requests.columns.person'), value: <RequestSubject view={view} /> }]
                    : [{ label: t('my.requests.columns.madeBy'), value: view.corporateAccount ? t('my.requests.madeBy.company') : t('my.requests.madeBy.self') }]),
                  { label: t('my.wizard.service.branch'), value: pick(view.branch.name, view.branch.nameAr) },
                  ...(view.targetDate && !view.completedAt && !view.cancelledAt
                    ? [
                        {
                          label: t('my.request.expectedBy'),
                          value: (
                            <>
                              {formatDate(view.targetDate)}
                              <span className="mt-0.5 block text-sm text-muted-foreground">{t('my.request.expectedHint')}</span>
                            </>
                          ),
                        },
                      ]
                    : []),
                  ...(view.completedAt ? [{ label: t('my.request.completedOn'), value: formatDate(view.completedAt) }] : []),
                  ...(view.cancelledAt ? [{ label: t('my.request.cancelledOn'), value: formatDate(view.cancelledAt) }] : []),
                  // "Unpaid" only means something once there is an invoice.
                  ...(view.finance?.invoices.length && view.paymentStatus !== 'NOT_REQUIRED' ? [{ label: t('my.requests.columns.payment'), value: <StatusBadge kind="requestPayment" status={view.paymentStatus} /> }] : []),
                ]}
              />
            </CardContent>
          </Card>
          <StepsCard view={view} />
          <div className="flex flex-col gap-2">
            <Button asChild variant="outline">
              <Link href={`${ROUTES.support}?new=1&requestId=${view.id}`}>
                <LifeBuoy aria-hidden="true" />
                {t('my.request.askSupport')}
              </Link>
            </Button>
            {cancelEdge ? (
              <Button variant="destructive-outline" onClick={() => setCancelOpen(true)}>
                {t('my.request.cancel')}
              </Button>
            ) : null}
          </div>
        </aside>
      </div>

      {cancelOpen ? <CancelRequestDialog view={view} onClose={() => setCancelOpen(false)} apply={apply} /> : null}
    </>
  );
}

// ---------------------------------------------------------------- what happens now

const WAITING_ICON = { CUSTOMER: UserRound, CENTRE: Hourglass, AUTHORITY: Landmark, NOBODY: CircleCheck } as const;

/** The top of the page: who has to act now, in one sentence, with the one button that moves the request on. */
function NowCard({ view, apply, onOpenDocuments }: { view: RequestView; apply: (view?: RequestView | null) => void; onOpenDocuments: () => void }) {
  const { t, pick, has } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const role = useRole();
  const blockedText = useBlockedText();
  const waitingOn = view.status === 'CANCELLED' ? 'NOBODY' : view.nextStep?.waitingOn ?? 'CENTRE';
  const Icon = WAITING_ICON[waitingOn] ?? Clock;
  // The company's administrators decide on the quotation and pay the invoice; an employee only follows.
  const moneyElsewhere = !role.canSeeMoney && (view.status === 'QUOTED' || view.status === 'AWAITING_PAYMENT');
  const companyTurn = waitingOn === 'CUSTOMER' && (role.company || moneyElsewhere);
  const mine = waitingOn === 'CUSTOMER' && !moneyElsewhere;
  const quotation = view.finance?.quotation;
  const unpaid = (view.finance?.invoices ?? []).filter((invoice): invoice is PayableInvoice & typeof invoice => (invoice.status === 'ISSUED' || invoice.status === 'PARTIALLY_PAID') && Number(invoice.balanceDue ?? 0) > 0 && !!invoice.currency);
  const toFix = view.checklist.filter((line) => line.kind === 'INPUT' && (line.actionRequired || line.status === 'REJECTED'));
  const resubmitEdge = view.status === 'AWAITING_CUSTOMER' ? view.allowedActions.transitions.find((edge) => edge.to !== 'CANCELLED') : undefined;
  const canResubmit = view.allowedActions.other.includes('resubmit');
  const lastMessage = view.status === 'AWAITING_CUSTOMER' ? [...view.history].reverse().find((entry) => entry.status === 'AWAITING_CUSTOMER')?.message : null;
  // The centre's message usually names the documents already: list only the ones it does not mention.
  const listed = toFix.filter((line) => !lastMessage || !lastMessage.includes(line.label));
  const resubmit = useMutation({
    mutationFn: () => api.resubmitRequest(view.id),
    onSuccess: (next) => {
      apply(next);
      toasts.success(t('my.request.resubmitted'));
    },
    onError: (error) => toasts.error(error),
  });

  // The portal's own sentence per status reads the same in both languages; the API's text is the fallback.
  const ownKey = `my.request.next.${view.status}`;
  const text = moneyElsewhere ? t(`my.request.moneyElsewhere.${view.status}`) : has(ownKey) ? t(ownKey) : view.nextStep ? pick(view.nextStep.text.en, view.nextStep.text.ar) : '';

  let action: React.ReactNode = null;
  if (view.status === 'DRAFT') {
    action = (
      <Button asChild size="lg">
        <Link href={`${ROUTES.newRequest}?draft=${view.id}`}>
          {t('my.request.continueDraft')}
          <ArrowRight className="rtl-mirror" aria-hidden="true" />
        </Link>
      </Button>
    );
  } else if (view.status === 'QUOTED' && quotation && role.canApprove) {
    action = (
      <Button asChild size="lg" data-action="review-quotation">
        <Link href={`${ROUTES.approvals}/${quotation.id}`}>
          <FileText aria-hidden="true" />
          {t('my.request.reviewQuotation')}
        </Link>
      </Button>
    );
  } else if (unpaid.length && role.canSeeMoney && (view.status === 'AWAITING_PAYMENT' || mine)) {
    action = (
      <>
        <PayInvoiceButton size="lg" invoice={unpaid[0]} />
        <Button asChild size="lg" variant="outline">
          <Link href={`${ROUTES.invoices}/${unpaid[0].id}`}>{t('my.request.openInvoice')}</Link>
        </Button>
      </>
    );
  } else if (view.status === 'AWAITING_CUSTOMER') {
    action = (
      <>
        {toFix.length ? (
          <Button size="lg" variant={resubmitEdge?.enabled ? 'outline' : 'default'} onClick={onOpenDocuments}>
            {t('my.request.fixDocuments')}
          </Button>
        ) : null}
        {canResubmit ? (
          <Button size="lg" variant={resubmitEdge?.enabled === false ? 'outline' : 'default'} disabled={resubmitEdge?.enabled === false} loading={resubmit.isPending} loadingText={t('common.loading')} onClick={() => resubmit.mutate()}>
            {t('my.request.resubmit')}
          </Button>
        ) : null}
      </>
    );
  }

  const waitingLabel = waitingOn === 'CUSTOMER' ? (companyTurn ? t('my.request.waitingOn.COMPANY') : t('my.request.waitingOn.CUSTOMER')) : t(`my.request.waitingOn.${waitingOn}`);
  return (
    <Card className={cn(mine && 'border-warning/60 bg-warning-soft/50', view.status === 'COMPLETED' && 'border-success/40 bg-success-soft/50')} data-waiting-on={waitingOn}>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3.5">
          <span
            aria-hidden="true"
            className={cn(
              'flex size-11 shrink-0 items-center justify-center rounded-full',
              mine ? 'bg-warning text-warning-foreground' : view.status === 'COMPLETED' ? 'bg-success text-success-foreground' : 'bg-secondary-soft text-secondary-text',
            )}
          >
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-muted-foreground">{waitingLabel}</p>
            <p className="mt-0.5 text-md font-semibold text-foreground">{text}</p>
          </div>
        </div>

        {view.status === 'AWAITING_CUSTOMER' ? (
          <div className="space-y-3">
            {lastMessage ? (
              <div className="rounded-md border bg-card p-3">
                <p className="text-sm font-medium text-muted-foreground">{t('my.request.centreSays')}</p>
                <p className="mt-1 whitespace-pre-wrap text-base text-foreground" dir="auto">
                  {lastMessage}
                </p>
              </div>
            ) : null}
            {listed.length ? (
              <ul className="space-y-1.5">
                {listed.map((line) => (
                  <li key={line.id} className="flex flex-wrap items-baseline gap-x-2 text-base">
                    <span className="font-medium">{pick(line.label, line.labelAr)}</span>
                    {line.note ? (
                      <span className="text-foreground/80" dir="auto">
                        {line.note}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {resubmitEdge && !resubmitEdge.enabled ? <p className="text-sm text-muted-foreground">{blockedText(resubmitEdge.blocked)}</p> : canResubmit ? <p className="text-sm text-muted-foreground">{t('my.request.resubmitHint')}</p> : null}
          </div>
        ) : null}

        {action ? <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap [&>*]:w-full sm:[&>*]:w-auto">{action}</div> : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- status outside the centre

/**
 * What happened to the application outside the centre. Every status here is shown
 * WITH its source: a status typed by staff is never presented as an official one.
 */
function ExternalCard({ view }: { view: RequestView }) {
  const { t, formatDate } = useI18n();
  const references = view.externalReferences;
  if (!references.length && !view.externalStatus) return null;
  return (
    <Card data-external-status>
      <CardContent className="space-y-4">
        <div>
          <SectionTitle>{t('my.request.external.title')}</SectionTitle>
          <p className="mt-1 text-sm text-muted-foreground">{t('my.request.external.text')}</p>
        </div>
        {references.length ? (
          <ul className="space-y-4">
            {references.map((reference) => (
              <li key={reference.id} className="space-y-2">
                <DescriptionList
                  items={[
                    { label: t('my.request.external.authority'), value: reference.authorityName ? <span dir="auto">{reference.authorityName}</span> : null },
                    { label: t('my.request.external.reference'), value: <Ltr>{reference.referenceNo}</Ltr> },
                    { label: t('my.request.external.channel'), value: t(`my.request.external.channels.${reference.channel}`) },
                    { label: t('my.request.external.recorded'), value: formatDate(reference.recordedAt) },
                  ]}
                />
                {reference.status ? <ExternalStatus status={reference.status} sourceLabel={reference.statusSourceLabel} /> : <p className="text-sm text-muted-foreground">{t('my.request.external.noStatus')}</p>}
                {reference.result ? <Badge tone={reference.result === 'COMPLETED' ? 'success' : 'warning'}>{t(`my.request.external.results.${reference.result}`)}</Badge> : null}
              </li>
            ))}
          </ul>
        ) : view.externalStatus ? (
          <ExternalStatus status={view.externalStatus.status} sourceLabel={view.externalStatus.sourceLabel} at={view.externalStatus.at} />
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- quotation, its approval, invoices

/**
 * The quotation with the state of the company's approval, and the invoices. A company administrator sees the
 * amounts and opens them; an employee of the company gets `amountsHidden` (where things stand, no amounts, no
 * decision: the quotation and the invoice are the company's).
 */
function MoneyCard({ view }: { view: RequestView }) {
  const { t, formatDate } = useI18n();
  const role = useRole();
  const finance = view.finance;
  if (!finance || (!finance.quotation && !finance.invoices.length)) return null;
  const { quotation, invoices, totals } = finance;
  const hidden = finance.amountsHidden === true;
  const waiting = quotation?.status === 'SENT';
  return (
    <Card data-money-card data-amounts-hidden={hidden || undefined}>
      <CardContent className="space-y-4">
        <SectionTitle>{t('my.request.money.title')}</SectionTitle>
        {hidden ? <p className="text-base text-muted-foreground">{t('my.request.money.hiddenText')}</p> : null}
        <ul className="divide-y rounded-lg border">
          {quotation ? (
            <li className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3.5" data-approval-state={quotation.status}>
              <div className="min-w-0 flex-1 basis-40">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium">
                  <span>
                    {t('titles.quotationDetail')} <Ltr>{quotation.quotationNo}</Ltr>
                  </span>
                  <StatusBadge kind="quotation" status={quotation.status} label={waiting ? { en: t('my.approvals.waiting'), ar: t('my.approvals.waiting') } : undefined} />
                </p>
                <p className="text-sm text-muted-foreground">
                  {quotation.total && quotation.currency ? <Money amount={quotation.total} currency={quotation.currency} /> : null}
                  {waiting && quotation.validUntil ? (
                    <>
                      {quotation.total ? <span aria-hidden="true"> – </span> : null}
                      {t('my.approvals.validUntil', { date: formatDate(quotation.validUntil) })}
                    </>
                  ) : null}
                </p>
              </div>
              {!hidden && (role.canApprove || role.canSeeMoney) ? (
                <Button asChild size="sm" variant={waiting && role.canApprove ? 'default' : 'outline'}>
                  <Link href={`${ROUTES.approvals}/${quotation.id}`}>{waiting && role.canApprove ? t('my.request.reviewQuotation') : t('common.view')}</Link>
                </Button>
              ) : null}
            </li>
          ) : null}
          {invoices.map((invoice) => {
            const payable = invoice.status === 'ISSUED' || invoice.status === 'PARTIALLY_PAID';
            return (
              <li key={invoice.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3.5">
                <div className="min-w-0 flex-1 basis-40">
                  <p className="flex flex-wrap items-center gap-2 text-base font-medium">
                    <span>
                      {t('titles.invoiceDetail')} <Ltr>{invoice.invoiceNo}</Ltr>
                    </span>
                    <StatusBadge kind="invoice" status={invoice.status} />
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {invoice.total && invoice.currency ? <Money amount={invoice.total} currency={invoice.currency} /> : null}
                    {payable && invoice.dueAt ? (
                      <>
                        {invoice.total ? <span aria-hidden="true"> – </span> : null}
                        {t('my.invoices.dueOn', { date: formatDate(invoice.dueAt) })}
                      </>
                    ) : null}
                  </p>
                </div>
                {!hidden ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`${ROUTES.invoices}/${invoice.id}`}>{t('common.view')}</Link>
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {totals && invoices.length ? (
          <dl className="grid grid-cols-2 gap-3 text-base sm:grid-cols-3">
            <div>
              <dt className="text-sm text-muted-foreground">{t('my.request.money.invoiced')}</dt>
              <dd className="font-medium">
                <Money amount={totals.invoiced} />
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t('my.request.money.paid')}</dt>
              <dd className="font-medium">
                <Money amount={totals.paid} />
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t('my.invoices.toPay')}</dt>
              <dd className="font-medium">
                <Money amount={totals.balance} />
              </dd>
            </div>
          </dl>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- the steps of the process

/**
 * The steps the centre takes for this request and where it is now, including the company's own
 * approval of the quotation. Steps that only send a message are not milestones and are left out.
 */
function StepsCard({ view }: { view: RequestView }) {
  const { t, pick, formatDate } = useI18n();
  const steps = (view.workflow?.steps ?? []).filter((step) => step.type !== 'NOTIFICATION').sort((a, b) => a.position - b.position);
  if (!steps.length || view.status === 'DRAFT') return null;
  const stopped = view.status === 'CANCELLED';
  const items: TimelineItem[] = steps.map((step) => {
    const done = step.status === 'COMPLETED' || step.status === 'SKIPPED';
    const current = !stopped && (step.current || step.status === 'ACTIVE');
    return {
      id: step.key,
      title: pick(step.name, step.nameAr),
      time: step.status === 'SKIPPED' ? t('my.request.steps.skipped') : done && step.completedAt ? formatDate(step.completedAt) : current ? t('my.request.steps.now') : undefined,
      state: done ? 'done' : current ? 'current' : 'upcoming',
    };
  });
  return (
    <Card data-steps>
      <CardContent className="space-y-4">
        <h2 className="text-md font-semibold text-foreground">{t('my.request.steps.title')}</h2>
        <Timeline items={items} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- what happened so far

/** The history the centre shares, in plain words, oldest first; the last entry is where the request stands now. */
function Progress({ view }: { view: RequestView }) {
  const { t, pick, formatDateTime } = useI18n();
  // "Draft" is noise once the request was submitted.
  const entries = view.history.filter((entry, index) => !(entry.status === 'DRAFT' && view.history.length > 1 && index === 0));
  const closed = view.status === 'COMPLETED' || view.status === 'CANCELLED';
  const items: TimelineItem[] = entries.map((entry, index) => {
    const label = pick(entry.statusLabel.en, entry.statusLabel.ar);
    // The centre's own words for this step, when it wrote some (otherwise the API repeats the English label).
    const own = entry.message && entry.message !== entry.statusLabel.en ? entry.message : null;
    const last = index === entries.length - 1;
    // A second entry with the same status is a message of the centre, not a new step.
    const update = own && index > 0 && entries[index - 1].status === entry.status;
    return {
      id: entry.id,
      title: update ? t('my.request.update') : label,
      time: formatDateTime(entry.at),
      description: own ? <span dir="auto" className="block">{own}</span> : undefined,
      state: last && !closed ? 'current' : 'done',
      tone: entry.status === 'CANCELLED' || entry.status === 'REJECTED' ? 'danger' : entry.status === 'AWAITING_CUSTOMER' || entry.status === 'RETURNED' ? 'warning' : undefined,
    };
  });
  return <Timeline items={items} />;
}
