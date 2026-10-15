'use client';

import * as React from 'react';
import Link from 'next/link';
import { Download, Lock, Printer } from 'lucide-react';
import { saveBlob } from '@typease/api-client';
import { z } from 'zod';
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField,
  LoadingBlock, Select, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, cn, focusRing, useApiClient, useErrorMessage, useI18n, useSession, useToast, useZodForm,
  type DataTableFilter, type SelectProps,
} from '@typease/ui';
import { useBranches } from '@/components/branch';
import { useRoles, useStaffOptions } from '@/components/pickers';
import type { FeeComponentType, LineItem, MoneyTotals } from './types';

// ---------------------------------------------------------------- small pieces

/** An amount from the API (decimal string) in the centre's format. Always left-to-right digits, never wrapped. */
export function Money({ amount, currency, className }: { amount: string | number | null | undefined; currency?: string | null; className?: string }) {
  const { formatMoney } = useI18n();
  return <span className={cn('tabular whitespace-nowrap', className)}>{formatMoney(amount, currency)}</span>;
}

/** A link that reads as text inside tables and lists. */
export function TextLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={cn('rounded-sm font-medium text-secondary-text hover:underline', focusRing, className)}>
      {children}
    </Link>
  );
}

const COMPONENT_TONE: Record<FeeComponentType, 'brand' | 'info' | 'neutral'> = { SERVICE_FEE: 'brand', GOVERNMENT_FEE: 'info', THIRD_PARTY_FEE: 'neutral' };
export function ComponentBadge({ component }: { component: FeeComponentType }) {
  const { t } = useI18n();
  return <Badge tone={COMPONENT_TONE[component]}>{t(`fin.components.${component}`)}</Badge>;
}

/** Failed read: the message where the data would be, with a retry. */
export function LoadError({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const { t } = useI18n();
  const describe = useErrorMessage();
  return (
    <Alert
      tone="danger"
      className={className}
      action={
        onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : undefined
      }
    >
      {describe(error)}
    </Alert>
  );
}

/** Shape of a detail page while it loads: header, a wide card and a side card. */
export function DetailSkeleton() {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t('common.loading')} className="space-y-6">
      <div className="space-y-2.5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-80 lg:col-span-2" />
        <Skeleton className="h-80" />
      </div>
    </div>
  );
}

/** Says plainly that a record can no longer be edited, and what to do instead. */
export function ImmutableNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn('flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground', className)}>
      <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** A plain titled card used by the detail pages. */
export function Section({ title, description, action, children, className, flush }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; flush?: boolean }) {
  return (
    <Card className={className}>
      <CardHeader className={cn('items-center', flush ? 'pb-4' : 'pb-0')}>
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </CardHeader>
      {flush ? <div className="border-t">{children}</div> : <CardContent>{children}</CardContent>}
    </Card>
  );
}

/**
 * <Select> for a form field whose value is also set by the page (a default branch, a record
 * being loaded). Inside a <form> the underlying control reports an empty value when its value
 * changes before the options were ever opened; that echo must not wipe the field.
 */
export function FieldSelect({ onValueChange, ...props }: SelectProps) {
  return <Select {...props} onValueChange={(value) => (value ? onValueChange?.(value) : undefined)} />;
}

// ---------------------------------------------------------------- breakdown

interface BreakdownExtras {
  amountPaid?: string;
  amountCredited?: string;
  amountRefunded?: string;
  balanceDue?: string;
}

/**
 * The money breakdown every quotation, invoice and receipt shows: the centre's SERVICE FEE
 * apart from GOVERNMENT FEES and THIRD-PARTY CHARGES (collected on behalf of others, never the
 * centre's revenue), then discount, tax and total; for invoices also paid / credited / balance.
 */
export function FeeBreakdown({ totals, extras, preview, className }: { totals: Omit<MoneyTotals, 'currency'> & { currency?: string }; extras?: BreakdownExtras; preview?: boolean; className?: string }) {
  const { t } = useI18n();
  const currency = totals.currency;
  const row = (label: string, amount: string, options: { hint?: string; negative?: boolean; strong?: boolean; muted?: boolean } = {}) => (
    <div className={cn('flex items-start justify-between gap-4 py-2', options.strong && 'border-t pt-3')}>
      <dt className={cn('min-w-0', options.strong ? 'text-base font-semibold text-foreground' : 'text-base text-foreground')}>
        {label}
        {options.hint ? <span className="block text-sm font-normal text-muted-foreground">{options.hint}</span> : null}
      </dt>
      <dd className={cn('shrink-0 text-end', options.strong ? 'text-md font-semibold text-foreground' : options.muted ? 'text-muted-foreground' : 'text-foreground')}>
        {options.negative && Number(amount) !== 0 ? <span aria-hidden="true">−&nbsp;</span> : null}
        <Money amount={amount} currency={currency} />
      </dd>
    </div>
  );
  const zero = (v: string | undefined) => !v || Number(v) === 0;
  return (
    <dl className={cn('text-base', className)}>
      {row(t('fin.breakdown.serviceFee'), totals.subtotalServiceFee, { hint: t('fin.breakdown.serviceFeeHint') })}
      {row(t('fin.breakdown.governmentFee'), totals.subtotalGovernmentFee, { hint: t('fin.breakdown.governmentFeeHint'), muted: zero(totals.subtotalGovernmentFee) })}
      {row(t('fin.breakdown.thirdParty'), totals.subtotalThirdParty, { hint: t('fin.breakdown.thirdPartyHint'), muted: zero(totals.subtotalThirdParty) })}
      {row(t('fin.breakdown.discount'), totals.discountTotal, { negative: true, muted: zero(totals.discountTotal) })}
      {row(t('fin.breakdown.tax'), totals.taxTotal, { muted: zero(totals.taxTotal) })}
      {row(preview ? t('fin.breakdown.totalPreview') : t('fin.breakdown.total'), totals.total, { strong: true })}
      {extras ? (
        <>
          {extras.amountPaid !== undefined ? row(t('fin.breakdown.paid'), extras.amountPaid, { negative: true, muted: zero(extras.amountPaid) }) : null}
          {extras.amountCredited !== undefined && !zero(extras.amountCredited) ? row(t('fin.breakdown.credited'), extras.amountCredited, { negative: true, hint: t('fin.breakdown.creditedHint') }) : null}
          {extras.amountRefunded !== undefined && !zero(extras.amountRefunded) ? row(t('fin.breakdown.refunded'), extras.amountRefunded, { hint: t('fin.breakdown.refundedHint') }) : null}
          {extras.balanceDue !== undefined ? row(t('fin.breakdown.balanceDue'), extras.balanceDue, { strong: true }) : null}
        </>
      ) : null}
    </dl>
  );
}

// ---------------------------------------------------------------- lines (read-only)

/** The lines of a quotation or invoice as saved by the API. A table from `md` up, stacked below. */
export function LinesTable({ items, currency, caption }: { items: LineItem[]; currency: string; caption: string }) {
  const { t, formatNumber } = useI18n();
  const sorted = [...items].sort((a, b) => a.sortOrder - b.sortOrder);
  const percent = (rate: string) => `${formatNumber(rate, { maximumFractionDigits: 2 })}%`;
  const anyDiscount = sorted.some((item) => Number(item.discountAmount) > 0);
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <caption className="sr-only">{caption}</caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('fin.lines.description')}</TableHead>
              <TableHead className="text-end">{t('fin.lines.quantity')}</TableHead>
              <TableHead className="text-end">{t('fin.lines.unitAmount')}</TableHead>
              {anyDiscount ? <TableHead className="text-end">{t('fin.lines.discount')}</TableHead> : null}
              <TableHead className="text-end">{t('fin.lines.tax')}</TableHead>
              <TableHead className="text-end">{t('fin.lines.lineTotal')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((item) => (
              <TableRow key={item.id} className="hover:bg-transparent">
                <TableCell className="min-w-56">
                  <span className="block" dir="auto">
                    {item.description}
                  </span>
                  <span className="mt-1 block">
                    <ComponentBadge component={item.component} />
                  </span>
                </TableCell>
                <TableCell className="tabular text-end">{formatNumber(item.quantity, { maximumFractionDigits: 2 })}</TableCell>
                <TableCell className="text-end">
                  <Money amount={item.unitAmount} currency={currency} />
                </TableCell>
                {anyDiscount ? (
                  <TableCell className="text-end">{Number(item.discountAmount) > 0 ? <Money amount={item.discountAmount} currency={currency} /> : <span className="text-muted-foreground">–</span>}</TableCell>
                ) : null}
                <TableCell className="text-end">
                  <Money amount={item.taxAmount} currency={currency} />
                  <span className="tabular block text-xs text-muted-foreground">{percent(item.taxRatePercent)}</span>
                </TableCell>
                <TableCell className="text-end font-medium">
                  <Money amount={item.lineTotal} currency={currency} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="divide-y md:hidden" aria-label={caption}>
        {sorted.map((item) => (
          <li key={item.id} className="space-y-2 p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 font-medium text-foreground" dir="auto">
                {item.description}
              </p>
              <Money amount={item.lineTotal} currency={currency} className="font-semibold" />
            </div>
            <ComponentBadge component={item.component} />
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t('fin.lines.quantity')}</dt>
              <dd className="tabular">
                {formatNumber(item.quantity, { maximumFractionDigits: 2 })} × <Money amount={item.unitAmount} currency={currency} />
              </dd>
              {Number(item.discountAmount) > 0 ? (
                <>
                  <dt className="text-muted-foreground">{t('fin.lines.discount')}</dt>
                  <dd>
                    <Money amount={item.discountAmount} currency={currency} />
                  </dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">{t('fin.lines.tax')}</dt>
              <dd>
                <Money amount={item.taxAmount} currency={currency} /> <span className="tabular text-muted-foreground">({percent(item.taxRatePercent)})</span>
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------- downloads and PDFs

/**
 * Authenticated file downloads (PDFs, exports). `busy` is the id passed to `save`
 * while that file is on its way, so the button that was pressed can show progress.
 */
export function useDownload() {
  const client = useApiClient();
  const toasts = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const save = React.useCallback(
    async (id: string, path: string, options: { query?: object; fallbackFilename?: string } = {}) => {
      setBusy(id);
      try {
        const file = await client.download(path, { query: options.query, fallbackFilename: options.fallbackFilename });
        saveBlob(file);
        return file;
      } catch (error) {
        toasts.error(error);
        return null;
      } finally {
        setBusy((current) => (current === id ? null : current));
      }
    },
    [client, toasts],
  );
  return { save, busy };
}

/**
 * Shows a PDF from the API (receipt, invoice) in a dialog with Print and Download.
 * The bytes are fetched with the session and shown from an in-memory blob (frame-src blob:).
 */
export function PdfDialog({ open, onOpenChange, path, title, fallbackFilename }: { open: boolean; onOpenChange: (open: boolean) => void; path: string; title: string; fallbackFilename: string }) {
  const { t } = useI18n();
  const client = useApiClient();
  const describe = useErrorMessage();
  const frame = React.useRef<HTMLIFrameElement>(null);
  const [state, setState] = React.useState<{ status: 'loading' | 'ready' | 'error'; url?: string; blob?: Blob; filename?: string; error?: string }>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let created: string | undefined;
    setState({ status: 'loading' });
    client
      .download(path, { fallbackFilename })
      .then((file) => {
        if (cancelled) return;
        const blob = new Blob([file.blob], { type: 'application/pdf' });
        created = URL.createObjectURL(blob);
        setState({ status: 'ready', url: created, blob, filename: file.filename });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: 'error', error: describe(error) });
      });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path, attempt]);

  const print = () => {
    try {
      frame.current?.contentWindow?.focus();
      frame.current?.contentWindow?.print();
    } catch {
      // Some browsers do not allow printing an embedded PDF: the download still works.
      if (state.blob) saveBlob({ blob: state.blob, filename: state.filename ?? fallbackFilename });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="sm:h-[88dvh]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('fin.pdf.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex min-h-[50dvh] flex-col bg-muted/40 p-0 sm:p-0">
          {state.status === 'loading' ? <LoadingBlock label={t('common.loading')} className="flex-1" /> : null}
          {state.status === 'error' ? (
            <div className="m-auto max-w-md p-6">
              <Alert tone="danger" live action={<Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>{t('common.retry')}</Button>}>
                {state.error}
              </Alert>
            </div>
          ) : null}
          {state.status === 'ready' ? <iframe ref={frame} title={title} src={state.url} className="min-h-[60dvh] w-full flex-1 border-0 bg-white" /> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
          <Button variant="outline" disabled={state.status !== 'ready'} onClick={() => state.blob && saveBlob({ blob: state.blob, filename: state.filename ?? fallbackFilename })}>
            <Download aria-hidden="true" />
            {t('common.download')}
          </Button>
          <Button disabled={state.status !== 'ready'} onClick={print}>
            <Printer aria-hidden="true" />
            {t('fin.pdf.print')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- reason dialog

const reasonSchema = (required: boolean, min: number) =>
  z.object({ reason: required ? z.string().trim().min(min).max(500) : z.string().trim().max(500).optional() });

/**
 * A dialog that asks for one piece of text before an action (void, reject, cancel, a note
 * for the audit trail). `onSubmit` may throw: the API's message is shown above the buttons
 * and what was typed stays.
 */
export function ReasonDialog({
  open, onOpenChange, title, description, label, hint, submitLabel, submitVariant = 'default', required = true, minLength = 3, onSubmit, children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  label: string;
  hint?: string;
  submitLabel: string;
  submitVariant?: 'default' | 'destructive' | 'accent';
  required?: boolean;
  minLength?: number;
  onSubmit: (reason: string) => Promise<void>;
  /** Extra content between the description and the field (a warning, the amounts involved). */
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const schema = React.useMemo(() => reasonSchema(required, minLength), [required, minLength]);
  const form = useZodForm(schema, { defaultValues: { reason: '' } });
  React.useEffect(() => {
    if (open) form.reset({ reason: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => !form.formState.isSubmitting && onOpenChange(next)}>
      <DialogContent>
        <Form
          form={form}
          onSubmit={async (values) => {
            await onSubmit((values.reason ?? '').trim());
            onOpenChange(false);
          }}
          className="flex min-h-0 flex-1 flex-col space-y-0"
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <DialogBody className="space-y-4">
            {children}
            <FormField name="reason" label={label} required={required} optional={!required} hint={hint}>
              {(field) => <Textarea {...field} rows={3} maxLength={500} />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant={submitVariant} loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- people and branches

/**
 * Names of staff members by USER id (records store `createdById`, `requestedById` ...).
 * Only for viewers who may read the staff list; others get null and the page words it without a name.
 */
export function useStaffDirectory() {
  const session = useSession();
  const allowed = session.hasAnyPermission(['staff.read', 'request.assign']);
  const staff = useStaffOptions(allowed);
  return React.useMemo(() => {
    const byUser = new Map((staff.data ?? []).map((m) => [m.userId, m]));
    return {
      allowed,
      members: staff.data ?? [],
      nameOf: (userId: string | null | undefined) => (userId ? byUser.get(userId)?.user.fullName ?? null : null),
      isMe: (userId: string | null | undefined) => !!userId && userId === session.user?.id,
    };
  }, [staff.data, allowed, session.user?.id]);
}

/** The branch filter of a list, present only when the centre has more than one branch the viewer can see. */
export function useBranchFilter(id = 'branchId'): DataTableFilter[] {
  const { t, pick } = useI18n();
  const branches = useBranches();
  return React.useMemo(
    () => (branches.data && branches.data.length > 1 ? [{ id, type: 'select' as const, label: t('fin.common.branch'), options: branches.data.map((b) => ({ value: b.id, label: pick(b.name, b.nameAr) })) }] : []),
    [branches.data, id, t, pick],
  );
}

/**
 * Who could give an approval that needs a second person (a discount, a refund): the active
 * staff members whose role holds the permission, without the person who asked for it.
 * Null for viewers who may not read the staff list.
 */
export function useApprovers(permission: string, excludeUserId: string | null | undefined): string[] | null {
  const session = useSession();
  const allowed = session.hasPermission('staff.read');
  const staff = useStaffOptions(allowed);
  const roles = useRoles(allowed);
  return React.useMemo(() => {
    if (!allowed || !staff.data || !roles.data) return null;
    const holders = new Set(roles.data.filter((r) => r.permissions.includes(permission)).map((r) => r.key));
    return staff.data.filter((m) => holders.has(m.role.key) && m.userId !== excludeUserId).map((m) => m.user.fullName);
  }, [allowed, staff.data, roles.data, permission, excludeUserId]);
}
