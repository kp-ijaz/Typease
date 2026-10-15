'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, KeyRound, ListPlus, Pencil, UserCheck, UserPlus, UserX, Users } from 'lucide-react';
import type { Page } from '@typease/types';
import { CORPORATE_EMPLOYEE_BULK_MAX, corporateEmployeeSchema, normalisePhoneSearch, updateCorporateEmployeeSchema } from '@typease/validation';
import { fieldErrorsOf, isApiError } from '@typease/api-client';
import {
  Alert, Badge, Button, CountrySelect, DataTable, DatePicker, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, FormSection, Input, Label,
  PhoneInput, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, countryName, formatPhone, localiseValidationMessage, normaliseEmpty, useApi, useErrorMessage, useI18n, useSession, useToast,
  useZodForm, type DataTableColumn, type DataTableFilter, type RowAction,
} from '@typease/ui';
import { peopleKeys } from '@/lib/keys/people';
import { Ltr, RecordLink, usePersonName } from '../shared';
import { EmployeeLoginBadge, EmployeeLoginDialog, isErasedEmployee } from './employee-login';
import type { BulkEmployeesResult, CorporateAccountDetail, CorporateEmployee } from '../types';

/** The employee directory of a company. Every employee is backed by a customer record of the centre. */
export function EmployeesTab({ account }: { account: CorporateAccountDetail }) {
  const { t, locale, formatDate, today } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const canManage = session.hasPermission('corporate.manage') && account.status !== 'ARCHIVED';
  const [editing, setEditing] = React.useState<CorporateEmployee | 'new' | null>(null);
  const [bulk, setBulk] = React.useState(false);
  const [login, setLogin] = React.useState<CorporateEmployee | null>(null);
  const personName = usePersonName();

  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: peopleKeys.corporate.detail(account.id) }), queryClient.invalidateQueries({ queryKey: peopleKeys.customers.all })]);
  const setStatus = useMutation({
    mutationFn: ({ employee, status }: { employee: CorporateEmployee; status: 'ACTIVE' | 'INACTIVE' }) => api.client.patch<CorporateEmployee>(`/corporate-accounts/${account.id}/employees/${employee.id}`, { status }),
    onSuccess: async (_r, { employee, status }) => {
      toasts.success(status === 'INACTIVE' ? t('people.corporate.employees.deactivated') : t('people.corporate.employees.reactivated'), employee.fullName);
      await refresh();
    },
    onError: (error) => toasts.error(error),
  });

  const expiry = React.useCallback(
    (masked: string | null, date: string | null) =>
      masked || date ? (
        <>
          {masked ? <Ltr className="block">{masked}</Ltr> : null}
          {date ? <span className={`tabular block text-sm ${date < today() ? 'font-medium text-destructive-text' : 'text-muted-foreground'}`}>{formatDate(date)}</span> : null}
        </>
      ) : null,
    [formatDate, today],
  );

  const columns = React.useMemo<Array<DataTableColumn<CorporateEmployee>>>(
    () => [
      {
        id: 'name',
        header: t('customers.columns.name'),
        sortField: 'fullName',
        mobile: 'title',
        className: 'min-w-40',
        cell: (e) => (
          <>
            <span className={isErasedEmployee(e) ? 'block font-normal text-muted-foreground' : 'block'}>
              {personName(e.fullName)}
              {/* Only employees who are not active say so (the default list shows active employees only). */}
              {isErasedEmployee(e) ? (
                <Badge tone="neutral" className="ms-2 align-middle">
                  {t('people.corporate.employees.erased')}
                </Badge>
              ) : e.status === 'INACTIVE' ? (
                <Badge tone="neutral" className="ms-2 align-middle">
                  {t('people.corporate.employees.inactive')}
                </Badge>
              ) : null}
            </span>
            <span className="tabular block whitespace-nowrap text-sm font-normal text-muted-foreground">{e.customerNo}</span>
          </>
        ),
      },
      { id: 'login', header: t('people.corporate.logins.column'), mobile: 'badge', className: 'whitespace-nowrap', cell: (e) => <EmployeeLoginBadge login={e.login} /> },
      { id: 'employeeNo', header: t('people.corporate.employees.employeeNo'), sortField: 'employeeNo', className: 'whitespace-nowrap', cell: (e) => (e.employeeNo ? <Ltr>{e.employeeNo}</Ltr> : null) },
      { id: 'designation', header: t('people.corporate.employees.designation'), cell: (e) => (e.designation ? <span dir="auto">{e.designation}</span> : null) },
      { id: 'nationality', header: t('customers.columns.nationality'), cell: (e) => countryName(e.nationality, locale) || null },
      { id: 'contact', header: t('customers.columns.contact'), mobile: 'hidden', cell: (e) => (e.phone ? <Ltr className="whitespace-nowrap">{formatPhone(e.phone)}</Ltr> : e.email ? <Ltr className="block max-w-40 truncate">{e.email}</Ltr> : null) },
      { id: 'emiratesId', header: t('people.customer.fields.emiratesId'), className: 'whitespace-nowrap', cell: (e) => expiry(e.emiratesIdMasked, e.emiratesIdExpiry) },
      { id: 'passport', header: t('people.customer.fields.passportNo'), className: 'whitespace-nowrap', cell: (e) => expiry(e.passportNoMasked, e.passportExpiry) },
    ],
    [t, locale, expiry, personName],
  );
  const filters = React.useMemo<DataTableFilter[]>(
    () => [
      {
        id: 'status',
        type: 'select',
        label: t('people.corporate.employees.show'),
        allLabel: t('people.corporate.employees.activeOnly'),
        options: [
          { value: 'INACTIVE', label: t('people.corporate.employees.inactiveOnly') },
          { value: 'ALL', label: t('people.corporate.employees.everyone') },
        ],
      },
    ],
    [t],
  );
  const rowActions = React.useMemo<Array<RowAction<CorporateEmployee>>>(
    () => [
      // The customer record of an erased employee no longer exists for staff (404): nothing to open, nothing to change.
      { id: 'open', label: t('people.corporate.employees.openCustomer'), icon: <ExternalLink aria-hidden="true" />, hidden: isErasedEmployee, href: (e) => `/customers/${e.customerId}` },
      { id: 'login', label: t('people.corporate.logins.title'), icon: <KeyRound aria-hidden="true" />, hidden: isErasedEmployee, onSelect: (e) => setLogin(e) },
      ...(session.hasPermission('request.create') && account.status === 'ACTIVE'
        ? [{ id: 'request', label: t('customers.newRequestFor'), icon: <ListPlus aria-hidden="true" />, hidden: (e: CorporateEmployee) => e.status !== 'ACTIVE', href: (e: CorporateEmployee) => `/requests/new?customerId=${e.customerId}&corporateAccountId=${account.id}` }]
        : []),
      ...(canManage
        ? [
            { id: 'edit', label: t('common.edit'), icon: <Pencil aria-hidden="true" />, hidden: isErasedEmployee, onSelect: (e: CorporateEmployee) => setEditing(e) },
            { id: 'deactivate', label: t('people.corporate.employees.deactivate'), icon: <UserX aria-hidden="true" />, destructive: true, hidden: (e: CorporateEmployee) => e.status !== 'ACTIVE', onSelect: (e: CorporateEmployee) => setStatus.mutate({ employee: e, status: 'INACTIVE' }) },
            { id: 'reactivate', label: t('people.corporate.employees.reactivate'), icon: <UserCheck aria-hidden="true" />, hidden: (e: CorporateEmployee) => e.status !== 'INACTIVE' || isErasedEmployee(e), onSelect: (e: CorporateEmployee) => setStatus.mutate({ employee: e, status: 'ACTIVE' }) },
          ]
        : []),
    ],
    [t, session, account.id, account.status, canManage, setStatus],
  );

  const add = canManage ? (
    <>
      <Button variant="ghost" onClick={() => setBulk(true)}>
        <ListPlus aria-hidden="true" />
        {t('people.corporate.employees.bulk')}
      </Button>
      <Button variant="outline" onClick={() => setEditing('new')}>
        <UserPlus aria-hidden="true" />
        {t('people.corporate.employees.add')}
      </Button>
    </>
  ) : null;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="max-w-2xl text-base text-muted-foreground">{t('people.corporate.employees.text')}</p>
        <div className="flex flex-wrap items-center gap-2">{add}</div>
      </div>
      <DataTable<CorporateEmployee>
        caption={t('people.corporate.tabs.employees')}
        queryKey={peopleKeys.corporate.employees(account.id)}
        queryFn={(params, signal) => api.client.get<Page<CorporateEmployee>>(`/corporate-accounts/${account.id}/employees`, { query: params, signal })}
        columns={columns}
        filters={filters}
        rowKey={(e) => e.id}
        rowHref={(e) => (isErasedEmployee(e) ? '' : `/customers/${e.customerId}`)}
        rowActions={rowActions}
        searchPlaceholder={t('people.corporate.employees.search')}
        defaultSort="fullName:asc"
        defaultPageSize={10}
        syncUrl={false}
        empty={{ icon: <Users />, title: t('people.corporate.employees.empty'), description: t('people.corporate.employees.emptyText'), action: canManage ? <div className="flex flex-wrap justify-center gap-2">{add}</div> : undefined }}
      />
      {editing ? <EmployeeDialog account={account} employee={editing === 'new' ? null : editing} open onOpenChange={(next) => !next && setEditing(null)} onSaved={refresh} /> : null}
      {bulk ? <BulkEmployeesDialog account={account} open onOpenChange={setBulk} onSaved={refresh} /> : null}
      {login ? <EmployeeLoginDialog account={account} employee={login} canManage={canManage} open onOpenChange={(next) => !next && setLogin(null)} onChanged={refresh} /> : null}
    </>
  );
}

// ---------------------------------------------------------------- add / edit one

function employeeDefaults(e: CorporateEmployee | null) {
  return {
    fullName: e?.fullName ?? '',
    fullNameAr: e?.fullNameAr ?? '',
    employeeNo: e?.employeeNo ?? '',
    designation: e?.designation ?? '',
    email: e?.email ?? '',
    phone: e?.phone ?? '',
    nationality: e?.nationality ?? '',
    dateOfBirth: e?.dateOfBirth ?? '',
    // Identity numbers are masked in every response: an empty field keeps the stored number.
    emiratesId: '',
    emiratesIdExpiry: e?.emiratesIdExpiry ?? '',
    passportNo: '',
    passportCountry: e?.passportCountry ?? '',
    passportExpiry: e?.passportExpiry ?? '',
  };
}

function EmployeeDialog({ account, employee, open, onOpenChange, onSaved }: { account: CorporateAccountDetail; employee: CorporateEmployee | null; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => Promise<unknown> }) {
  const { t, today } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const schema = employee ? updateCorporateEmployeeSchema : corporateEmployeeSchema;
  const form = useZodForm(schema, { defaultValues: employeeDefaults(employee), emptyAs: employee ? 'null' : 'undefined' });

  const save = async (values: Record<string, unknown>) => {
    try {
      if (employee) {
        const before = normaliseEmpty(employeeDefaults(employee), 'null') as Record<string, unknown>;
        const body = Object.fromEntries(
          Object.entries(values).filter(([key, value]) => (key === 'emiratesId' || key === 'passportNo' ? !!value : (value ?? null) !== (before[key] ?? null))),
        );
        if (Object.keys(body).length === 0) {
          onOpenChange(false);
          return;
        }
        const saved = await api.client.patch<CorporateEmployee>(`/corporate-accounts/${account.id}/employees/${employee.id}`, body);
        toasts.success(t('people.corporate.employees.saved'), saved.fullName);
      } else {
        const created = await api.client.post<CorporateEmployee>(`/corporate-accounts/${account.id}/employees`, values);
        toasts.success(t('people.corporate.employees.added'), created.outcome === 'LINKED_EXISTING_CUSTOMER' ? t('people.corporate.employees.linked', { name: created.fullName, number: created.customerNo }) : t('people.corporate.employees.created', { name: created.fullName, number: created.customerNo }));
      }
      await onSaved();
      onOpenChange(false);
    } catch (error) {
      if (isApiError(error) && error.code === 'EMPLOYEE_EXISTS') {
        form.setError('root.server', { type: error.code, message: t('people.corporate.employees.exists') });
        return;
      }
      throw error;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <Form form={form} onSubmit={(values) => save(values as Record<string, unknown>)} className="flex min-h-0 flex-1 flex-col space-y-0">
          <DialogHeader>
            <DialogTitle>{employee ? t('people.corporate.employees.editTitle') : t('people.corporate.employees.addTitle')}</DialogTitle>
            <DialogDescription>{employee ? t('people.corporate.employees.editText', { number: employee.customerNo }) : t('people.corporate.employees.addText', { name: account.companyName })}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="fullName" label={t('customers.form.fullName')} required hint={t('people.corporate.employees.nameHint')}>
                {(field) => <Input {...field} autoComplete="off" dir="ltr" lang="en" autoFocus={!employee} />}
              </FormField>
              <FormField name="fullNameAr" label={t('customers.form.fullNameAr')} optional>
                {(field) => <Input {...field} autoComplete="off" dir="rtl" lang="ar" />}
              </FormField>
              <FormField name="employeeNo" label={t('people.corporate.employees.employeeNo')} hint={t('people.corporate.employees.employeeNoHint')}>
                {(field) => <Input {...field} autoComplete="off" dir="ltr" className="tabular" />}
              </FormField>
              <FormField name="designation" label={t('people.corporate.employees.designation')}>
                {(field) => <Input {...field} autoComplete="off" dir="auto" />}
              </FormField>
              <FormField name="phone" label={t('customers.form.phone')}>
                {(field) => <PhoneInput {...field} />}
              </FormField>
              <FormField name="email" label={t('customers.form.email')}>
                {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
              </FormField>
              <FormField name="nationality" label={t('customers.form.nationality')}>
                {(field) => <CountrySelect {...field} onValueChange={field.onChange} />}
              </FormField>
              <FormField name="dateOfBirth" label={t('people.customer.fields.dateOfBirth')}>
                {(field) => <DatePicker {...field} max={today()} />}
              </FormField>
            </div>
            <FormSection title={t('people.customer.identity.title')} description={employee ? t('people.customer.edit.identityHint') : t('people.corporate.employees.identityHint')}>
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField
                  name="emiratesId"
                  label={employee?.emiratesIdMasked ? t('people.customer.edit.newEmiratesId') : t('customers.form.emiratesId')}
                  hint={employee?.emiratesIdMasked ? t('people.customer.edit.onFile', { masked: employee.emiratesIdMasked }) : t('people.customer.edit.emiratesIdFormat')}
                >
                  {(field) => <Input {...field} inputMode="numeric" autoComplete="off" dir="ltr" placeholder="784-0000-0000000-0" className="tabular" />}
                </FormField>
                <FormField name="emiratesIdExpiry" label={t('people.customer.fields.emiratesIdExpiry')}>
                  {(field) => <DatePicker {...field} />}
                </FormField>
                <FormField name="passportNo" label={employee?.passportNoMasked ? t('people.customer.edit.newPassportNo') : t('people.customer.fields.passportNo')} hint={employee?.passportNoMasked ? t('people.customer.edit.onFile', { masked: employee.passportNoMasked }) : undefined}>
                  {(field) => <Input {...field} autoComplete="off" autoCapitalize="characters" spellCheck={false} dir="ltr" className="tabular uppercase" />}
                </FormField>
                <FormField name="passportCountry" label={t('people.customer.fields.passportCountry')}>
                  {(field) => <CountrySelect {...field} onValueChange={field.onChange} />}
                </FormField>
                <FormField name="passportExpiry" label={t('people.customer.fields.passportExpiry')}>
                  {(field) => <DatePicker {...field} />}
                </FormField>
              </div>
            </FormSection>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {employee ? t('common.saveChanges') : t('people.corporate.employees.add')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- bulk add by pasting rows

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

function BulkEmployeesDialog({ account, open, onOpenChange, onSaved }: { account: CorporateAccountDetail; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => Promise<unknown> }) {
  const i18n = useI18n();
  const { t, tn, formatNumber } = i18n;
  const api = useApi();
  const toasts = useToast();
  const describe = useErrorMessage();
  const [text, setText] = React.useState('');
  const [serverErrors, setServerErrors] = React.useState<Record<number, string>>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<BulkEmployeesResult | null>(null);
  const textId = React.useId();

  const rows = React.useMemo(() => parseEmployeeRows(text, (message) => localiseValidationMessage(message, i18n)), [text, i18n]);
  const invalid = rows.filter((r) => !r.value).length;
  const tooMany = rows.length > CORPORATE_EMPLOYEE_BULK_MAX;
  const ready = rows.length > 0 && invalid === 0 && !tooMany;
  const columnLabel = (column: BulkColumn) => t(`people.corporate.employees.bulkColumns.${column}`);

  const submit = useMutation({
    mutationFn: () => api.client.post<BulkEmployeesResult>(`/corporate-accounts/${account.id}/employees/bulk`, { employees: rows.map((r) => r.value) }),
    onMutate: () => {
      setServerErrors({});
      setFailure(null);
    },
    onSuccess: async (data) => {
      setResult(data);
      toasts.success(tn('people.corporate.employees.bulkDone', data.createdCount));
      await onSaved();
    },
    onError: (error) => {
      // One invalid row rejects the whole call; the API names each problem as employees.<index>.<field>.
      const mapped: Record<number, string> = {};
      for (const [path, message] of Object.entries(fieldErrorsOf(error))) {
        const m = /^employees\.(\d+)(?:\.(\w+))?/.exec(path);
        if (m) mapped[Number(m[1])] = `${m[2] && (BULK_COLUMNS as readonly string[]).includes(m[2]) ? `${columnLabel(m[2] as BulkColumn)}: ` : ''}${localiseValidationMessage(message, i18n)}`;
      }
      setServerErrors(mapped);
      setFailure(Object.keys(mapped).length ? t('people.corporate.employees.bulkRejected') : describe(error));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (submit.isPending && !next ? undefined : onOpenChange(next))}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t('people.corporate.employees.bulkTitle')}</DialogTitle>
          <DialogDescription>{t('people.corporate.employees.bulkText', { name: account.companyName })}</DialogDescription>
        </DialogHeader>

        {result ? (
          <>
            <DialogBody className="space-y-4">
              <Alert tone="success" live title={tn('people.corporate.employees.bulkDone', result.createdCount)}>
                {result.created.some((c) => c.outcome === 'LINKED_EXISTING_CUSTOMER') ? tn('people.corporate.employees.bulkLinked', result.created.filter((c) => c.outcome === 'LINKED_EXISTING_CUSTOMER').length) : t('people.corporate.employees.bulkDoneText')}
              </Alert>
              {result.skippedCount > 0 ? (
                <Alert tone="warning" title={tn('people.corporate.employees.bulkSkipped', result.skippedCount)}>
                  <ul className="mt-1 list-disc space-y-0.5 ps-5">
                    {result.skipped.map((s) => (
                      <li key={s.index}>
                        {t('people.corporate.employees.bulkSkippedRow', { row: formatNumber(s.index + 1), name: s.fullName })}
                      </li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
              <ul className="divide-y rounded-lg border">
                {result.created.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-base">
                    <span>
                      {c.fullName} <span className="tabular text-sm text-muted-foreground">{c.customerNo}</span>
                    </span>
                    <RecordLink href={`/customers/${c.customerId}`}>{t('people.corporate.employees.openCustomer')}</RecordLink>
                  </li>
                ))}
              </ul>
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>{t('common.done')}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogBody className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor={textId}>{t('people.corporate.employees.bulkPaste')}</Label>
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
                <p className="text-sm text-muted-foreground">{t('people.corporate.employees.bulkHint', { columns: BULK_COLUMNS.map(columnLabel).join(' · '), max: formatNumber(CORPORATE_EMPLOYEE_BULK_MAX) })}</p>
              </div>

              {rows.length > 0 ? (
                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-md font-semibold text-foreground">{t('people.corporate.employees.bulkPreview')}</h3>
                    <p className="text-sm text-muted-foreground" role="status">
                      {tn('people.corporate.employees.bulkRows', rows.length)}
                      {invalid ? ` · ${tn('people.corporate.employees.bulkInvalid', invalid)}` : ''}
                    </p>
                  </div>
                  <div className="max-h-80 overflow-y-auto rounded-lg border">
                    <Table>
                      <caption className="sr-only">{t('people.corporate.employees.bulkPreview')}</caption>
                      <TableHeader className="sticky top-0 z-10 bg-muted">
                        <TableRow className="hover:bg-transparent">
                          <TableHead className="w-10">#</TableHead>
                          <TableHead>{t('people.corporate.employees.bulkCheck')}</TableHead>
                          {BULK_COLUMNS.map((column) => (
                            <TableHead key={column}>{columnLabel(column)}</TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((row, index) => {
                          const problems = [
                            ...Object.entries(row.errors).map(([column, message]) => (column === 'row' ? t('people.corporate.employees.bulkTooManyColumns') : `${columnLabel(column as BulkColumn)}: ${message}`)),
                            ...(serverErrors[index] ? [serverErrors[index]] : []),
                          ];
                          return (
                            <TableRow key={row.line} className={problems.length ? 'bg-destructive-soft/40 hover:bg-destructive-soft/40' : 'hover:bg-transparent'}>
                              <TableCell className="tabular py-2 align-top text-sm text-muted-foreground">{formatNumber(index + 1)}</TableCell>
                              {/* The result comes first: on a narrow screen the data columns scroll sideways, the verdict must not. */}
                              <TableCell className="min-w-56 py-2 align-top text-sm">
                                {problems.length ? (
                                  <ul className="space-y-0.5 text-destructive-text">
                                    {problems.map((p) => (
                                      <li key={p}>{p}</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <Badge tone="success">{t('people.corporate.employees.bulkOk')}</Badge>
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

              {tooMany ? <Alert tone="danger">{t('people.corporate.employees.bulkTooMany', { max: formatNumber(CORPORATE_EMPLOYEE_BULK_MAX) })}</Alert> : null}
              {failure ? (
                <Alert tone="danger" live>
                  {failure}
                </Alert>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submit.isPending}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => submit.mutate()} disabled={!ready} loading={submit.isPending} loadingText={t('common.saving')}>
                {ready ? tn('people.corporate.employees.bulkSubmit', rows.length) : t('people.corporate.employees.bulkSubmitEmpty')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
