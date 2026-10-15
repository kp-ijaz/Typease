'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CORPORATE_EMPLOYEE_BULK_MAX, corporateEmployeeLoginSchema, corporateEmployeeSchema, normalisePhoneSearch, updateCorporateEmployeeSchema } from '@typease/validation';
import { fieldErrorsOf, isApiError } from '@typease/api-client';
import {
  Alert, Badge, Button, ConfirmDialog, CountrySelect, DatePicker, DevTokenHint, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError,
  FormField, FormSection, Input, Label, PhoneInput, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, localiseValidationMessage, normaliseEmpty, useErrorMessage, useI18n,
  useToast, useZodForm,
} from '@typease/ui';
import { usePortalApi } from '@/lib/api';
import { ROUTES } from '@/lib/config';
import { keys } from '@/lib/query-keys';
import type { BulkEmployeesResult, Employee } from '@/lib/types';

/** After anything that changes the directory: the lists, the open employee and the company's counters. */
export function useRefreshEmployees() {
  const queryClient = useQueryClient();
  return React.useCallback(() => Promise.all([queryClient.invalidateQueries({ queryKey: keys.employees.all }), queryClient.invalidateQueries({ queryKey: keys.account })]), [queryClient]);
}

/** Codes that mean "the company's account does not allow this right now" get the portal's own sentence. */
function useAccountBlocked() {
  const { t } = useI18n();
  return (error: unknown): string | null => {
    if (!isApiError(error)) return null;
    if (error.code === 'CORPORATE_ACCOUNT_NOT_ACTIVE') return t('my.employees.errors.accountNotActive');
    if (error.code === 'PLAN_LIMIT_REACHED') return t('my.employees.errors.portalNotIncluded');
    return null;
  };
}

// ---------------------------------------------------------------- add / edit one employee

function employeeDefaults(e: Employee | null) {
  return {
    fullName: e?.fullName ?? '',
    fullNameAr: e?.fullNameAr ?? '',
    employeeNo: e?.employeeNo ?? '',
    designation: e?.designation ?? '',
    email: e?.email ?? '',
    phone: e?.phone ?? '',
    nationality: e?.nationality ?? '',
    dateOfBirth: e?.dateOfBirth ?? '',
    // Identity numbers are masked in every answer: an empty field keeps the stored number.
    emiratesId: '',
    emiratesIdExpiry: e?.emiratesIdExpiry ?? '',
    passportNo: '',
    passportCountry: e?.passportCountry ?? '',
    passportExpiry: e?.passportExpiry ?? '',
  };
}

/** Add an employee to the company's directory, or correct one. Uses the API's own schema, so the same rules apply on both sides. */
export function EmployeeDialog({ employee, onClose, onSaved }: { employee: Employee | null; onClose: () => void; onSaved?: (saved: Employee) => void }) {
  const { t, today } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const refresh = useRefreshEmployees();
  const blocked = useAccountBlocked();
  const schema = employee ? updateCorporateEmployeeSchema : corporateEmployeeSchema;
  const form = useZodForm(schema, { defaultValues: employeeDefaults(employee), emptyAs: employee ? 'null' : 'undefined' });

  const save = async (values: Record<string, unknown>) => {
    try {
      let saved: Employee;
      if (employee) {
        const before = normaliseEmpty(employeeDefaults(employee), 'null') as Record<string, unknown>;
        // Only what changed is sent; an identity number only when a new one was typed.
        const body = Object.fromEntries(Object.entries(values).filter(([key, value]) => (key === 'emiratesId' || key === 'passportNo' ? !!value : (value ?? null) !== (before[key] ?? null))));
        if (Object.keys(body).length === 0) return onClose();
        saved = await api.updateEmployee(employee.id, body);
        toasts.success(t('my.employees.saved'), saved.fullName);
      } else {
        saved = await api.createEmployee(values as Parameters<typeof api.createEmployee>[0]);
        toasts.success(t('my.employees.added'), saved.outcome === 'LINKED_EXISTING_CUSTOMER' ? t('my.employees.addedLinked', { name: saved.fullName }) : saved.fullName);
      }
      await refresh();
      onSaved?.(saved);
      onClose();
    } catch (error) {
      if (isApiError(error) && error.code === 'EMPLOYEE_EXISTS') {
        form.setError('root.server', { type: error.code, message: t('my.employees.errors.exists') });
        return;
      }
      const message = blocked(error);
      if (message) {
        form.setError('root.server', { type: 'blocked', message });
        return;
      }
      throw error;
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !form.formState.isSubmitting && onClose()}>
      <DialogContent size="lg">
        <Form form={form} onSubmit={(values) => save(values as Record<string, unknown>)} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{employee ? t('my.employees.editTitle') : t('my.employees.add')}</DialogTitle>
            <DialogDescription>{employee ? t('my.employees.editText') : t('my.employees.addText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="fullName" label={t('my.employees.fields.fullName')} required hint={t('my.employees.fields.fullNameHint')}>
                {(field) => <Input {...field} autoComplete="off" dir="ltr" lang="en" autoFocus={!employee} />}
              </FormField>
              <FormField name="fullNameAr" label={t('my.employees.fields.fullNameAr')}>
                {(field) => <Input {...field} autoComplete="off" dir="rtl" lang="ar" />}
              </FormField>
              <FormField name="employeeNo" label={t('my.employees.fields.employeeNo')} hint={t('my.employees.fields.employeeNoHint')}>
                {(field) => <Input {...field} autoComplete="off" dir="ltr" className="tabular" />}
              </FormField>
              <FormField name="designation" label={t('my.employees.fields.designation')}>
                {(field) => <Input {...field} autoComplete="off" dir="auto" />}
              </FormField>
              <FormField name="phone" label={t('my.employees.fields.phone')}>
                {(field) => <PhoneInput {...field} />}
              </FormField>
              <FormField name="email" label={t('my.employees.fields.email')} hint={t('my.employees.fields.emailHint')}>
                {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
              </FormField>
              <FormField name="nationality" label={t('my.employees.fields.nationality')}>
                {(field) => <CountrySelect {...field} onValueChange={field.onChange} />}
              </FormField>
              <FormField name="dateOfBirth" label={t('my.employees.fields.dateOfBirth')}>
                {(field) => <DatePicker {...field} max={today()} />}
              </FormField>
            </div>
            <FormSection title={t('my.employees.identity.title')} description={employee ? t('my.employees.identity.editHint') : t('my.employees.identity.addHint')}>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField
                  name="emiratesId"
                  label={employee?.emiratesIdMasked ? t('my.employees.identity.newEmiratesId') : t('my.employees.fields.emiratesId')}
                  hint={employee?.emiratesIdMasked ? t('my.employees.identity.onFile', { masked: employee.emiratesIdMasked }) : t('my.employees.identity.emiratesIdFormat')}
                >
                  {(field) => <Input {...field} inputMode="numeric" autoComplete="off" dir="ltr" placeholder="784-0000-0000000-0" className="tabular" />}
                </FormField>
                <FormField name="emiratesIdExpiry" label={t('my.employees.fields.emiratesIdExpiry')}>
                  {(field) => <DatePicker {...field} />}
                </FormField>
                <FormField
                  name="passportNo"
                  label={employee?.passportNoMasked ? t('my.employees.identity.newPassportNo') : t('my.employees.fields.passportNo')}
                  hint={employee?.passportNoMasked ? t('my.employees.identity.onFile', { masked: employee.passportNoMasked }) : undefined}
                >
                  {(field) => <Input {...field} autoComplete="off" autoCapitalize="characters" spellCheck={false} dir="ltr" className="tabular uppercase" />}
                </FormField>
                <FormField name="passportCountry" label={t('my.employees.fields.passportCountry')}>
                  {(field) => <CountrySelect {...field} onValueChange={field.onChange} />}
                </FormField>
                <FormField name="passportExpiry" label={t('my.employees.fields.passportExpiry')}>
                  {(field) => <DatePicker {...field} />}
                </FormField>
              </div>
            </FormSection>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {employee ? t('common.saveChanges') : t('my.employees.add')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- import a list (POST /corporate/employees/bulk)

const BULK_COLUMNS = ['fullName', 'employeeNo', 'designation', 'phone', 'email', 'nationality', 'passportNo', 'emiratesId'] as const;
type BulkColumn = (typeof BULK_COLUMNS)[number];
interface BulkRow {
  line: number;
  cells: Partial<Record<BulkColumn, string>>;
  /** Parsed body for the API, when the row is valid. */
  value: Record<string, unknown> | null;
  errors: Partial<Record<BulkColumn | 'row', string>>;
}

/** Splits pasted spreadsheet rows (tabs) or comma / semicolon separated lines into cells. A heading row is skipped. */
export function parseEmployeeRows(text: string, translate: (message: string) => string): BulkRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((raw, index) => ({ raw, line: index + 1 }))
    .filter((l) => l.raw.trim() !== '');
  const split = (raw: string) => (raw.includes('\t') ? raw.split('\t') : raw.split(/[,;]/)).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
  const first = lines[0] ? split(lines[0].raw)[0]?.toLowerCase() ?? '' : '';
  const body = /name|الاسم/.test(first) ? lines.slice(1) : lines;
  return body.map(({ raw, line }) => {
    const parts = split(raw);
    const cells: Partial<Record<BulkColumn, string>> = {};
    BULK_COLUMNS.forEach((column, i) => {
      if (parts[i]) cells[column] = parts[i];
    });
    const candidate: Record<string, string> = { ...cells };
    if (cells.phone) candidate.phone = normalisePhoneSearch(cells.phone) ?? cells.phone;
    if (cells.nationality) candidate.nationality = cells.nationality.toUpperCase();
    const errors: BulkRow['errors'] = {};
    if (parts.length > BULK_COLUMNS.length && parts.slice(BULK_COLUMNS.length).some(Boolean)) errors.row = 'TOO_MANY';
    const parsed = corporateEmployeeSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const column = (issue.path[0] as BulkColumn | undefined) ?? 'row';
        if (!errors[column]) errors[column] = translate(issue.message);
      }
    }
    return { line, cells, value: parsed.success && !errors.row ? (parsed.data as Record<string, unknown>) : null, errors };
  });
}

/** Paste rows from a spreadsheet: every row is checked here first, then all are saved in one call (all or nothing). */
export function ImportEmployeesDialog({ onClose }: { onClose: () => void }) {
  const i18n = useI18n();
  const { t, tn, formatNumber } = i18n;
  const api = usePortalApi();
  const toasts = useToast();
  const describe = useErrorMessage();
  const refresh = useRefreshEmployees();
  const blocked = useAccountBlocked();
  const [text, setText] = React.useState('');
  const [serverErrors, setServerErrors] = React.useState<Record<number, string>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<BulkEmployeesResult | null>(null);
  const textId = React.useId();

  const rows = React.useMemo(() => parseEmployeeRows(text, (message) => localiseValidationMessage(message, i18n)), [text, i18n]);
  const invalid = rows.filter((r) => !r.value).length;
  const tooMany = rows.length > CORPORATE_EMPLOYEE_BULK_MAX;
  const ready = rows.length > 0 && invalid === 0 && !tooMany;
  const columnLabel = (column: BulkColumn) => t(`my.employees.import.columns.${column}`);

  const submit = useMutation({
    mutationFn: () => api.createEmployees(rows.map((r) => r.value as Record<string, unknown>)),
    onMutate: () => {
      setServerErrors({});
      setFailure(null);
    },
    onSuccess: async (data) => {
      setResult(data);
      toasts.success(tn('my.employees.import.done', data.createdCount));
      await refresh();
    },
    onError: (error) => {
      // One invalid row rejects the whole call; the API names each problem as employees.<index>.<field>.
      const mapped: Record<number, string> = {};
      for (const [path, message] of Object.entries(fieldErrorsOf(error))) {
        const m = /^employees\.(\d+)(?:\.(\w+))?/.exec(path);
        if (m) mapped[Number(m[1])] = `${m[2] && (BULK_COLUMNS as readonly string[]).includes(m[2]) ? `${columnLabel(m[2] as BulkColumn)}: ` : ''}${localiseValidationMessage(message, i18n)}`;
      }
      setServerErrors(mapped);
      setFailure(Object.keys(mapped).length ? t('my.employees.import.rejected') : blocked(error) ?? describe(error));
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !submit.isPending && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t('my.employees.import.title')}</DialogTitle>
          <DialogDescription>{t('my.employees.import.text')}</DialogDescription>
        </DialogHeader>

        {result ? (
          <>
            <DialogBody className="space-y-4">
              <Alert tone="success" live title={tn('my.employees.import.done', result.createdCount)} data-import-created={result.createdCount}>
                {t('my.employees.import.doneText')}
              </Alert>
              {result.skippedCount > 0 ? (
                <Alert tone="warning" title={tn('my.employees.import.skipped', result.skippedCount)} data-import-skipped={result.skippedCount}>
                  <ul className="mt-1 list-disc space-y-0.5 ps-5">
                    {result.skipped.map((s) => (
                      <li key={s.index}>{t('my.employees.import.skippedRow', { row: formatNumber(s.index + 1), name: s.fullName })}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
              {result.created.length ? (
                <ul className="divide-y rounded-lg border">
                  {result.created.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-base">
                      <span dir="auto">{c.fullName}</span>
                      <Link href={`${ROUTES.employees}/${c.id}`} className="text-sm font-medium text-secondary-text hover:underline">
                        {t('common.open')}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button onClick={onClose}>{t('common.done')}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogBody className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor={textId}>{t('my.employees.import.paste')}</Label>
                <Textarea
                  id={textId}
                  rows={6}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setServerErrors({});
                    setFailure(null);
                  }}
                  dir="ltr"
                  spellCheck={false}
                  className="tabular whitespace-pre font-mono text-sm sm:text-sm"
                  placeholder={'Ravi Kumar\tE-100\tElectrician\t0551230001\travi@example.com\tIN\tN1234567\t784-1990-1234567-1'}
                />
                <p className="text-sm text-muted-foreground">{t('my.employees.import.hint', { columns: BULK_COLUMNS.map(columnLabel).join(' · '), max: formatNumber(CORPORATE_EMPLOYEE_BULK_MAX) })}</p>
              </div>

              {rows.length > 0 ? (
                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-md font-semibold text-foreground">{t('my.employees.import.preview')}</h3>
                    <p className="text-sm text-muted-foreground" role="status">
                      {tn('my.employees.import.rows', rows.length)}
                      {invalid ? ` · ${tn('my.employees.import.invalid', invalid)}` : ''}
                    </p>
                  </div>
                  <div className="max-h-80 overflow-auto rounded-lg border">
                    <Table>
                      <caption className="sr-only">{t('my.employees.import.preview')}</caption>
                      <TableHeader className="sticky top-0 z-10 bg-muted">
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="w-10">#</TableHead>
                          <TableHead>{t('my.employees.import.check')}</TableHead>
                          {BULK_COLUMNS.map((column) => (
                            <TableHead key={column}>{columnLabel(column)}</TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((row, index) => {
                          const problems = [
                            ...Object.entries(row.errors).map(([column, message]) => (column === 'row' ? t('my.employees.import.tooManyColumns') : `${columnLabel(column as BulkColumn)}: ${message}`)),
                            ...(serverErrors[index] ? [serverErrors[index]] : []),
                          ];
                          return (
                            <TableRow key={row.line} className={problems.length ? 'bg-destructive-soft/40 hover:bg-destructive-soft/40' : 'hover:bg-transparent'}>
                              <TableCell className="tabular py-2 align-top text-sm text-muted-foreground">{formatNumber(index + 1)}</TableCell>
                              {/* The verdict comes first: on a narrow screen the data columns scroll sideways, the verdict must not. */}
                              <TableCell className="min-w-56 py-2 align-top text-sm">
                                {problems.length ? (
                                  <ul className="space-y-0.5 text-destructive-text">
                                    {problems.map((p) => (
                                      <li key={p}>{p}</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <Badge tone="success">{t('my.employees.import.ok')}</Badge>
                                )}
                              </TableCell>
                              {BULK_COLUMNS.map((column) => (
                                <TableCell key={column} className={`whitespace-nowrap py-2 align-top text-sm ${row.errors[column] ? 'font-medium text-destructive-text' : ''}`}>
                                  {row.cells[column] ? <span dir="auto" className={column === 'fullName' || column === 'designation' ? undefined : 'ltr-value tabular'}>{row.cells[column]}</span> : <span className="text-muted-foreground">–</span>}
                                </TableCell>
                              ))}
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              ) : null}

              {tooMany ? <Alert tone="danger">{t('my.employees.import.tooMany', { max: formatNumber(CORPORATE_EMPLOYEE_BULK_MAX) })}</Alert> : null}
              {failure ? (
                <Alert tone="danger" live>
                  {failure}
                </Alert>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={submit.isPending}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => submit.mutate()} disabled={!ready} loading={submit.isPending} loadingText={t('common.saving')} data-action="import-submit">
                {ready ? tn('my.employees.import.submit', rows.length) : t('my.employees.import.submitEmpty')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- portal login of one employee

/**
 * Invites an employee to this portal (role "corporate employee": their own requests and documents
 * only). The invitation goes to the address given here, or to the one on the employee's record.
 */
export function InviteLoginDialog({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const { t } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const refresh = useRefreshEmployees();
  const blocked = useAccountBlocked();
  const form = useZodForm(corporateEmployeeLoginSchema, { defaultValues: { email: employee.email ?? employee.login?.email ?? '' } });
  const [sent, setSent] = React.useState<{ email: string; devToken: string } | null>(null);
  const again = employee.login?.status === 'INVITED';

  if (sent) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('my.employees.login.sentTitle')}</DialogTitle>
            <DialogDescription>{t('my.employees.login.sentText', { name: employee.fullName, email: sent.email })}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <DevTokenHint>
              <Link className="text-secondary-text underline-offset-4 hover:underline" href={`/accept-invitation?token=${encodeURIComponent(sent.devToken)}`} target="_blank" rel="noreferrer" data-invitation-link>
                {t('my.employees.login.devLink')}
              </Link>
            </DevTokenHint>
          </DialogBody>
          <DialogFooter>
            <Button onClick={onClose}>{t('common.done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !form.formState.isSubmitting && onClose()}>
      <DialogContent size="sm">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            try {
              const reply = await api.inviteEmployeeLogin(employee.id, values);
              toasts.success(t('my.employees.login.invited'), t('my.employees.login.invitedTo', { email: reply.email }));
              await refresh();
              // A development server sends no email: show the link instead of closing (see DevTokenHint).
              if (reply.dev?.invitationToken) setSent({ email: reply.email, devToken: reply.dev.invitationToken });
              else onClose();
            } catch (error) {
              if (isApiError(error) && (error.code === 'EMAIL_REQUIRED' || error.code === 'EMAIL_IN_USE')) {
                form.setError('email', { type: 'server', message: error.code === 'EMAIL_REQUIRED' ? t('my.employees.login.emailRequired') : t('my.employees.login.emailInUse') });
                form.setFocus('email');
                return;
              }
              const message = blocked(error);
              if (message) {
                form.setError('root.server', { type: 'blocked', message });
                return;
              }
              // ALREADY_HAS_ACCESS, INVITATION_PENDING, EMPLOYEE_INACTIVE ...: somebody else changed it meanwhile.
              if (isApiError(error) && error.status === 409) await refresh();
              throw error;
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{again ? t('my.employees.login.inviteOtherTitle') : t('my.employees.login.inviteTitle')}</DialogTitle>
            <DialogDescription>{t('my.employees.login.inviteText', { name: employee.fullName })}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <FormField name="email" label={t('my.employees.login.email')} required hint={again ? t('my.employees.login.otherHint') : t('my.employees.login.emailHint')}>
              {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" autoFocus />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
              {t('my.employees.login.send')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Everything an administrator can do about one employee, as dialogs opened from the row menu of the
 * directory and from the employee's page: edit, invite to the portal, send the invitation again,
 * take the portal access away, deactivate and reactivate.
 */
export type EmployeeAction = { kind: 'edit' | 'invite' | 'revoke' | 'deactivate'; employee: Employee };

export function useEmployeeActions() {
  const { t } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const refresh = useRefreshEmployees();
  const blocked = useAccountBlocked();
  const [action, setAction] = React.useState<EmployeeAction | null>(null);
  // On a development server no email leaves the machine: the new link is shown instead (see DevTokenHint).
  const [resent, setResent] = React.useState<{ employee: Employee; email: string; devToken: string } | null>(null);

  const fail = (error: unknown) => {
    const message = blocked(error);
    if (message) toasts.error(message);
    else toasts.error(error);
  };
  const resend = useMutation({
    mutationFn: (employee: Employee) => api.resendEmployeeLogin(employee.id),
    onSuccess: (reply, employee) => {
      toasts.success(t('my.employees.login.resent'), t('my.employees.login.invitedTo', { email: reply.email }));
      if (reply.dev?.invitationToken) setResent({ employee, email: reply.email, devToken: reply.dev.invitationToken });
    },
    onError: async (error) => {
      fail(error);
      if (isApiError(error) && error.status === 409) await refresh();
    },
  });
  const reactivate = useMutation({
    mutationFn: (employee: Employee) => api.updateEmployee(employee.id, { status: 'ACTIVE' }),
    onSuccess: async (saved) => {
      toasts.success(t('my.employees.reactivated'), saved.fullName);
      await refresh();
    },
    onError: fail,
  });

  const target = action?.employee;
  const dialogs = (
    <>
      {action?.kind === 'edit' && target ? <EmployeeDialog employee={target} onClose={() => setAction(null)} /> : null}
      {action?.kind === 'invite' && target ? <InviteLoginDialog employee={target} onClose={() => setAction(null)} /> : null}
      <ConfirmDialog
        open={action?.kind === 'revoke'}
        onOpenChange={(open) => !open && setAction(null)}
        title={target?.login?.status === 'INVITED' ? t('my.employees.login.withdrawTitle', { name: target?.fullName ?? '' }) : t('my.employees.login.revokeTitle', { name: target?.fullName ?? '' })}
        description={target?.login?.status === 'INVITED' ? t('my.employees.login.withdrawText') : t('my.employees.login.revokeText')}
        confirmLabel={target?.login?.status === 'INVITED' ? t('my.employees.login.withdraw') : t('my.employees.login.revoke')}
        onConfirm={async () => {
          if (!target) return;
          try {
            await api.revokeEmployeeLogin(target.id);
            toasts.success(target.login?.status === 'INVITED' ? t('my.employees.login.withdrawn') : t('my.employees.login.revoked'), target.fullName);
            await refresh();
          } catch (error) {
            fail(error);
            // NO_LOGIN: it was already taken away; show the directory as it is now.
            if (isApiError(error) && error.status === 409) {
              await refresh();
              return;
            }
            throw error;
          }
        }}
      />
      <ConfirmDialog
        open={action?.kind === 'deactivate'}
        onOpenChange={(open) => !open && setAction(null)}
        title={t('my.employees.deactivateTitle', { name: target?.fullName ?? '' })}
        description={target?.login && target.login.status !== 'NONE' ? t('my.employees.deactivateTextLogin') : t('my.employees.deactivateText')}
        confirmLabel={t('my.employees.deactivate')}
        onConfirm={async () => {
          if (!target) return;
          try {
            await api.updateEmployee(target.id, { status: 'INACTIVE' });
            toasts.success(t('my.employees.deactivated'), target.fullName);
            await refresh();
          } catch (error) {
            fail(error);
            throw error;
          }
        }}
      />
      {resent ? (
        <Dialog open onOpenChange={(open) => !open && setResent(null)}>
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>{t('my.employees.login.resent')}</DialogTitle>
              <DialogDescription>{t('my.employees.login.sentText', { name: resent.employee.fullName, email: resent.email })}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <DevTokenHint>
                <Link className="text-secondary-text underline-offset-4 hover:underline" href={`/accept-invitation?token=${encodeURIComponent(resent.devToken)}`} target="_blank" rel="noreferrer" data-invitation-link>
                  {t('my.employees.login.devLink')}
                </Link>
              </DevTokenHint>
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => setResent(null)}>{t('common.done')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );

  return { open: setAction, resend: (employee: Employee) => resend.mutate(employee), reactivate: (employee: Employee) => reactivate.mutate(employee), busy: resend.isPending || reactivate.isPending, dialogs };
}
