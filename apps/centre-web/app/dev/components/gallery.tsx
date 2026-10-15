'use client';

import * as React from 'react';
import { CalendarDays, CheckCircle2, ClipboardList, Download, FileText, Inbox, Loader, MoreHorizontal, Pencil, Plus, Trash2, Users, Wallet } from 'lucide-react';
import { z } from 'zod';
import { ApiError } from '@typease/api-client';
import type { Page } from '@typease/types';
import { RequestStatusValues } from '@typease/types';
import {
  Alert, Avatar, Badge, BrandLogo, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Checkbox, ChoiceLabel, Combobox, ConfirmDialog, CopyButton,
  CountrySelect, DataTable, DatePicker, DescriptionList, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DropdownMenu,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, FileUpload, FileViewer, Form, FormActions, FormError, FormField,
  Input, Label, LanguageSwitcher, LoadingBlock, Logo, LogoIcon, LogoMark, MoneyInput, PageHeader, Pagination, PasswordInput, PermissionGate, PhoneInput, Popover, PopoverContent,
  PopoverTrigger, QrCode, RadioGroup, RadioGroupItem, SearchInput, Select, Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger,
  Skeleton, SkeletonText, Spinner, StatCard, StatusBadge, Stepper, Switch, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList,
  TabsTrigger, Textarea, ThemeToggle, Timeline, Tooltip, useI18n, useToast, useZodForm, type ComboboxOption, type DataTableColumn,
} from '@typease/ui';

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-20 border-t pt-8">
      <h2 id={`${id}-h`} className="mb-5 text-xl font-semibold">
        {title}
      </h2>
      <div className="space-y-6">{children}</div>
    </section>
  );
}
function Row({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div>
      {label ? <p className="mb-2 text-sm text-muted-foreground">{label}</p> : null}
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

/** Written out in full: Tailwind only generates classes it can read in the source. */
const SWATCHES = [
  { name: 'primary', solid: 'bg-primary text-primary-foreground', soft: 'bg-primary-soft text-primary-text' },
  { name: 'secondary', solid: 'bg-secondary text-secondary-foreground', soft: 'bg-secondary-soft text-secondary-text' },
  { name: 'accent', solid: 'bg-accent text-accent-foreground', soft: 'bg-accent-soft text-accent-text' },
  { name: 'success', solid: 'bg-success text-success-foreground', soft: 'bg-success-soft text-success-text' },
  { name: 'warning', solid: 'bg-warning text-warning-foreground', soft: 'bg-warning-soft text-warning-text' },
  { name: 'destructive', solid: 'bg-destructive text-destructive-foreground', soft: 'bg-destructive-soft text-destructive-text' },
  { name: 'info', solid: 'bg-info text-info-foreground', soft: 'bg-info-soft text-info-text' },
];

interface DemoRow {
  id: string;
  no: string;
  customer: string;
  customerAr: string;
  service: string;
  serviceAr: string;
  status: (typeof RequestStatusValues)[number];
  amount: string;
  date: string;
}
const DEMO_ROWS: DemoRow[] = [
  { id: '1', no: 'TE-001001', customer: 'Ahmed Khalid', customerAr: 'أحمد خالد', service: 'Visa renewal', serviceAr: 'تجديد التأشيرة', status: 'IN_PREPARATION', amount: '750.00', date: '2026-10-08' },
  { id: '2', no: 'TE-001002', customer: 'Sara Mohammed', customerAr: 'سارة محمد', service: 'Emirates ID', serviceAr: 'الهوية الإماراتية', status: 'AWAITING_CUSTOMER', amount: '370.00', date: '2026-10-08' },
  { id: '3', no: 'TE-001003', customer: 'Rajesh Kumar', customerAr: 'راجيش كومار', service: 'Labour card', serviceAr: 'بطاقة العمل', status: 'COMPLETED', amount: '1250.50', date: '2026-10-07' },
  { id: '4', no: 'TE-001004', customer: 'Fatima Al Ali', customerAr: 'فاطمة العلي', service: 'Trade licence', serviceAr: 'الرخصة التجارية', status: 'AWAITING_PAYMENT', amount: '4200.00', date: '2026-10-07' },
  { id: '5', no: 'TE-001005', customer: 'John Smith', customerAr: 'جون سميث', service: 'Attestation', serviceAr: 'التصديق', status: 'SUBMITTED', amount: '95.00', date: '2026-10-06' },
  { id: '6', no: 'TE-001006', customer: 'Maria Santos', customerAr: 'ماريا سانتوس', service: 'Tenancy contract', serviceAr: 'عقد الإيجار', status: 'REJECTED', amount: '78.75', date: '2026-10-05' },
  { id: '7', no: 'TE-001007', customer: 'Omar Haddad', customerAr: 'عمر حداد', service: 'Translation', serviceAr: 'الترجمة', status: 'UNDER_REVIEW', amount: '210.00', date: '2026-10-05' },
];

const formSchema = z.object({
  fullName: z.string().trim().min(2),
  email: z.string().trim().toLowerCase().email().optional(),
  phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/, 'Use international format, e.g. +971501234567'),
  amount: z.string().regex(/^\d{1,11}(\.\d{1,2})?$/, 'Enter an amount such as 150.00'),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
});

/** Every shared component in its states, in the active language and theme. */
export function Gallery() {
  const { t, pick, locale, formatMoney, formatDate, formatNumber } = useI18n();
  const toasts = useToast();
  const L = (en: string, ar: string) => pick(en, ar);

  const [select, setSelect] = React.useState('');
  const [combo, setCombo] = React.useState('');
  const [asyncCombo, setAsyncCombo] = React.useState('');
  const [country, setCountry] = React.useState('AE');
  const [checked, setChecked] = React.useState(true);
  const [radio, setRadio] = React.useState('INDIVIDUAL');
  const [on, setOn] = React.useState(true);
  const [date, setDate] = React.useState('2027-03-31');
  const [phone, setPhone] = React.useState('+971501234567');
  const [money, setMoney] = React.useState('1250.50');
  const [search, setSearch] = React.useState('');
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [typedOpen, setTypedOpen] = React.useState(false);
  const [viewerOpen, setViewerOpen] = React.useState(false);
  const [page, setPage] = React.useState(3);
  const [tableMode, setTableMode] = React.useState<'data' | 'empty' | 'error' | 'slow'>('data');
  const [step, setStep] = React.useState(2);

  const serviceOptions: ComboboxOption[] = DEMO_ROWS.map((r) => ({ value: r.id, label: L(r.service, r.serviceAr), description: r.no }));
  const loadCustomers = React.useCallback(
    async (query: string): Promise<ComboboxOption[]> => {
      await new Promise((r) => setTimeout(r, 400));
      return DEMO_ROWS.filter((r) => `${r.customer} ${r.customerAr}`.toLowerCase().includes(query.toLowerCase())).map((r) => ({ value: r.id, label: pick(r.customer, r.customerAr), description: r.no }));
    },
    [pick],
  );

  const columns: Array<DataTableColumn<DemoRow>> = [
    { id: 'no', header: L('Request', 'الطلب'), cell: (r) => <span className="tabular">{r.no}</span>, sortField: 'requestNo', mobile: 'title' },
    { id: 'customer', header: L('Customer', 'العميل'), cell: (r) => L(r.customer, r.customerAr), sortField: 'customer' },
    { id: 'service', header: L('Service', 'الخدمة'), cell: (r) => L(r.service, r.serviceAr) },
    { id: 'status', header: L('Status', 'الحالة'), cell: (r) => <StatusBadge kind="request" status={r.status} />, mobile: 'badge' },
    { id: 'amount', header: L('Amount', 'المبلغ'), cell: (r) => <span className="tabular">{formatMoney(r.amount)}</span>, align: 'end' },
    { id: 'date', header: L('Submitted', 'تاريخ الإرسال'), cell: (r) => formatDate(r.date), sortField: 'date' },
  ];
  const demoQuery = React.useCallback(
    async (params: { page?: number; pageSize?: number; q?: string; sort?: string; status?: unknown }): Promise<Page<DemoRow>> => {
      await new Promise((r) => setTimeout(r, tableMode === 'slow' ? 60_000 : 250));
      if (tableMode === 'error') throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'offline' });
      let rows = tableMode === 'empty' ? [] : DEMO_ROWS;
      if (params.q) rows = rows.filter((r) => `${r.no} ${r.customer} ${r.customerAr}`.toLowerCase().includes(String(params.q).toLowerCase()));
      if (params.status) rows = rows.filter((r) => r.status === params.status);
      const pageSize = params.pageSize ?? 5;
      const p = params.page ?? 1;
      return { data: rows.slice((p - 1) * pageSize, p * pageSize), meta: { page: p, pageSize, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / pageSize)) } };
    },
    [tableMode],
  );

  const form = useZodForm(formSchema, { defaultValues: { fullName: '', email: '', phone: '', amount: '', expiry: '' } });

  const pngSource = React.useCallback(async () => {
    // A generated picture stands in for a document from the vault.
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 560;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 900, 560);
    ctx.fillStyle = '#0B2240';
    ctx.fillRect(0, 0, 900, 90);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 34px sans-serif';
    ctx.fillText('SAMPLE DOCUMENT', 40, 58);
    ctx.fillStyle = '#E4E9ED';
    for (let i = 0; i < 9; i++) ctx.fillRect(40, 140 + i * 42, i % 3 === 2 ? 520 : 820, 18);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b as Blob), 'image/png'));
    return { url: URL.createObjectURL(blob), mime: 'image/png', filename: 'sample-passport.png' };
  }, []);

  const fakeUpload = React.useCallback(
    (file: File, o: { onProgress: (f: number) => void; signal: AbortSignal }) =>
      new Promise<string>((resolve, reject) => {
        let p = 0;
        const timer = setInterval(() => {
          p += 0.12;
          o.onProgress(Math.min(p, 1));
          if (file.name.toLowerCase().includes('fail') && p > 0.5) {
            clearInterval(timer);
            reject(new ApiError({ status: 422, code: 'FILE_TYPE_MISMATCH', message: 'The file content does not match its type.' }));
          } else if (p >= 1) {
            clearInterval(timer);
            resolve('ok');
          }
        }, 180);
        o.signal.addEventListener('abort', () => clearInterval(timer));
      }),
    [],
  );

  const sections = [
    ['brand', L('Brand', 'العلامة')], ['buttons', L('Buttons', 'الأزرار')], ['inputs', L('Inputs', 'حقول الإدخال')], ['form', L('Form', 'النموذج')], ['upload', L('Files', 'الملفات')],
    ['overlays', L('Overlays', 'النوافذ')], ['feedback', L('Feedback', 'التنبيهات')], ['status', L('Status', 'الحالات')], ['data', L('Data', 'البيانات')], ['layout', L('Layout', 'التخطيط')],
  ] as const;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-6 sm:px-6">
      <div className="sticky top-0 z-10 -mx-4 mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <Logo size={28} />
        <nav aria-label={t('gallery.title')} className="flex flex-1 flex-wrap gap-x-4 gap-y-1 text-sm">
          {sections.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="rounded-sm text-muted-foreground hover:text-foreground">
              {label}
            </a>
          ))}
        </nav>
        <LanguageSwitcher />
        <ThemeToggle />
      </div>

      <PageHeader
        title={t('gallery.title')}
        description={t('gallery.description')}
        breadcrumbs={[{ label: L('Development', 'التطوير') }]}
        meta={<Badge tone="brand">@typease/ui</Badge>}
        action={
          <Button variant="accent">
            <Plus aria-hidden="true" />
            {L('Primary action', 'الإجراء الرئيسي')}
          </Button>
        }
        secondary={<Button variant="outline">{L('Secondary', 'ثانوي')}</Button>}
      />

      <div className="space-y-10">
        <Section id="brand" title={L('Brand', 'العلامة')}>
          <Row label={L('Lockup, mark and app icon', 'الشعار الكامل والرمز وأيقونة التطبيق')}>
            <Logo size={56} tagline />
            <Logo size={36} />
            <LogoMark size={40} />
            <LogoIcon size={48} className="rounded-xl border" />
          </Row>
          <Row label={L('On brand-coloured surfaces', 'على الأسطح الملوّنة')}>
            <span className="rounded-lg bg-sidebar p-5">
              <Logo size={40} tone="onDark" tagline />
            </span>
            <span className="rounded-lg bg-sidebar p-5">
              <LogoMark size={36} tone="onDark" />
            </span>
            <span className="rounded-lg bg-sidebar p-5">
              <BrandLogo tone="onDark" size={32} locale={locale} config={{ mode: 'WHITE_LABEL', name: 'Al Noor Typing Centre', nameAr: 'مركز النور للطباعة', logoUrl: null } as never} />
            </span>
          </Row>
          <Row label={L('Colour tokens', 'ألوان النظام')}>
            {SWATCHES.map((swatch) => (
              <div key={swatch.name} className="w-28 overflow-hidden rounded-lg border text-xs">
                <div className={`flex h-12 items-center justify-center font-medium ${swatch.solid}`}>Aa</div>
                <div className={`flex h-9 items-center justify-center font-medium ${swatch.soft}`}>{swatch.name}</div>
              </div>
            ))}
          </Row>
        </Section>

        <Section id="buttons" title={L('Buttons', 'الأزرار')}>
          <Row label={L('Variants', 'الأنواع')}>
            <Button>{t('common.save')}</Button>
            <Button variant="accent">
              <Plus aria-hidden="true" />
              {L('New request', 'طلب جديد')}
            </Button>
            <Button variant="secondary">{L('View documents', 'عرض المستندات')}</Button>
            <Button variant="outline">{t('common.cancel')}</Button>
            <Button variant="subtle">{t('common.view')}</Button>
            <Button variant="ghost">{t('common.back')}</Button>
            <Button variant="link">{t('common.learnMore')}</Button>
            <Button variant="destructive">
              <Trash2 aria-hidden="true" />
              {t('common.delete')}
            </Button>
            <Button variant="destructive-outline">{t('common.remove')}</Button>
          </Row>
          <Row label={L('Sizes, loading, disabled, icon only', 'الأحجام والتحميل والتعطيل والأيقونة فقط')}>
            <Button size="sm">{L('Small', 'صغير')}</Button>
            <Button>{L('Medium', 'متوسط')}</Button>
            <Button size="lg">{L('Large', 'كبير')}</Button>
            <Button loading loadingText={t('common.saving')}>
              {t('common.saveChanges')}
            </Button>
            <Button variant="accent" loading loadingText={t('common.saving')}>
              {t('common.saveChanges')}
            </Button>
            <Button disabled>{L('Disabled', 'معطّل')}</Button>
            <Tooltip content={t('common.edit')}>
              <Button variant="outline" size="icon" aria-label={t('common.edit')}>
                <Pencil aria-hidden="true" />
              </Button>
            </Tooltip>
            <Button variant="ghost" size="icon-sm" aria-label={t('common.moreActions')}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </Row>
        </Section>

        <Section id="inputs" title={L('Inputs', 'حقول الإدخال')}>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="g-text" required>
                {L('Full name', 'الاسم الكامل')}
              </Label>
              <Input id="g-text" placeholder={L('As in the passport', 'كما في جواز السفر')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-invalid">{L('With an error', 'مع خطأ')}</Label>
              <Input id="g-invalid" defaultValue="not-an-email" aria-invalid aria-describedby="g-invalid-e" dir="ltr" />
              <p id="g-invalid-e" className="text-sm text-destructive-text">
                {t('validation.email')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-disabled" optionalText={t('common.optional')}>
                {L('Disabled', 'معطّل')}
              </Label>
              <Input id="g-disabled" disabled defaultValue="CUS-000042" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-pass">{t('auth.password')}</Label>
              <PasswordInput id="g-pass" defaultValue="TypEase-Demo-2026" dir="ltr" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-search">{t('common.search')}</Label>
              <SearchInput id="g-search" value={search} onChange={setSearch} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-select">{L('Select (short list)', 'قائمة قصيرة')}</Label>
              <Select
                id="g-select"
                value={select}
                onValueChange={setSelect}
                placeholder={t('common.selectPlaceholder')}
                options={[
                  { value: 'LOW', label: L('Low', 'منخفضة') },
                  { value: 'NORMAL', label: L('Normal', 'عادية') },
                  { value: 'HIGH', label: L('High', 'عالية') },
                  { value: 'URGENT', label: L('Urgent', 'عاجلة'), disabled: true },
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-combo">{L('Combobox (searchable)', 'قائمة قابلة للبحث')}</Label>
              <Combobox id="g-combo" value={combo} onValueChange={setCombo} options={serviceOptions} clearable />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-async">{L('Combobox (server search)', 'بحث من الخادم')}</Label>
              <Combobox id="g-async" value={asyncCombo} onValueChange={setAsyncCombo} loadOptions={loadCustomers} placeholder={L('Find a customer', 'ابحث عن عميل')} clearable />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-country">{L('Country', 'الدولة')}</Label>
              <CountrySelect id="g-country" value={country} onValueChange={setCountry} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-date">{L('Expiry date', 'تاريخ الانتهاء')}</Label>
              <DatePicker id="g-date" value={date} onChange={setDate} />
              <p className="text-sm text-muted-foreground">{formatDate(date, 'long')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-phone">{t('auth.phone')}</Label>
              <PhoneInput id="g-phone" value={phone} onChange={setPhone} />
              <p className="ltr-value text-sm text-muted-foreground">{phone || '–'}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-money">{t('form.amount')}</Label>
              <MoneyInput id="g-money" value={money} onChange={setMoney} />
              <p className="text-sm text-muted-foreground">{formatMoney(money)}</p>
            </div>
            <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
              <Label htmlFor="g-textarea">{L('Instructions', 'التعليمات')}</Label>
              <Textarea id="g-textarea" placeholder={L('Anything the operator should know', 'أي ملاحظات يحتاجها الموظف')} />
            </div>
          </div>
          <Row label={L('Choices', 'الاختيارات')}>
            <ChoiceLabel htmlFor="g-check" control={<Checkbox id="g-check" checked={checked} onCheckedChange={(v) => setChecked(v === true)} />} label={L('Send reminders by SMS', 'إرسال التذكيرات برسالة نصية')} description={L('30, 14 and 7 days before expiry', 'قبل الانتهاء بـ 30 و14 و7 أيام')} />
            <RadioGroup value={radio} onValueChange={setRadio} aria-label={L('Customer type', 'نوع العميل')} className="flex gap-6">
              <ChoiceLabel htmlFor="g-r1" control={<RadioGroupItem id="g-r1" value="INDIVIDUAL" />} label={L('Individual', 'فرد')} />
              <ChoiceLabel htmlFor="g-r2" control={<RadioGroupItem id="g-r2" value="BUSINESS" />} label={L('Business', 'منشأة')} />
            </RadioGroup>
            <ChoiceLabel htmlFor="g-switch" control={<Switch id="g-switch" checked={on} onCheckedChange={setOn} />} label={L('Available for online requests', 'متاح للطلبات الإلكترونية')} />
          </Row>
        </Section>

        <Section id="form" title={L('Form with validation', 'نموذج مع التحقق')}>
          <Card className="max-w-2xl">
            <CardContent>
              <Form
                form={form}
                onSubmit={async (values) => {
                  await new Promise((r) => setTimeout(r, 700));
                  if (values.fullName.toLowerCase().includes('error')) throw new ApiError({ status: 400, code: 'VALIDATION_FAILED', message: 'x', details: [{ path: 'phone', message: 'Use international format, e.g. +971501234567' }] });
                  toasts.success(t('form.saved'));
                }}
              >
                <div className="grid gap-5 sm:grid-cols-2">
                  <FormField name="fullName" label={L('Full name', 'الاسم الكامل')} required hint={L('As written in the passport.', 'كما هو مكتوب في جواز السفر.')}>
                    {(field) => <Input {...field} />}
                  </FormField>
                  <FormField name="email" label={t('auth.email')} optional>
                    {(field) => <Input {...field} type="email" dir="ltr" />}
                  </FormField>
                  <FormField name="phone" label={t('auth.phone')} required>
                    {(field) => <PhoneInput {...field} />}
                  </FormField>
                  <FormField name="amount" label={t('form.amount')} required>
                    {(field) => <MoneyInput {...field} />}
                  </FormField>
                  <FormField name="expiry" label={L('Passport expiry', 'انتهاء جواز السفر')} required>
                    {(field) => <DatePicker {...field} />}
                  </FormField>
                </div>
                <FormError />
                <FormActions>
                  <Button variant="outline" onClick={() => form.reset()}>
                    {t('common.reset')}
                  </Button>
                  <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
                    {t('common.save')}
                  </Button>
                </FormActions>
              </Form>
            </CardContent>
          </Card>
        </Section>

        <Section id="upload" title={L('Files', 'الملفات')}>
          <div className="grid gap-6 lg:grid-cols-2">
            <FileUpload upload={fakeUpload} accept={['application/pdf', 'image/*']} acceptLabel="PDF, JPG, PNG" maxSizeBytes={15 * 1024 * 1024} capture="environment" />
            <div className="space-y-3">
              <Button variant="outline" onClick={() => setViewerOpen(true)}>
                <FileText aria-hidden="true" />
                {t('file.preview')}
              </Button>
              <FileViewer open={viewerOpen} onOpenChange={setViewerOpen} getSource={pngSource} title="sample-passport.png" onDownload={() => toasts.info(t('common.download'))} />
              <div className="flex items-center gap-4">
                <span className="rounded-lg border bg-white p-2">
                  <QrCode value="otpauth://totp/TypEase:owner%40alnoor-demo.test?secret=JBSWY3DPEHPK3PXP&issuer=TypEase" size={132} label={t('auth.mfaSetup.qrAlt')} />
                </span>
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">{L('QR code from the built-in encoder', 'رمز QR من المولّد المدمج')}</p>
                  <div className="flex items-center gap-1">
                    <code dir="ltr" className="rounded-md border bg-muted/60 px-2 py-1 font-mono text-sm">
                      TE-000123
                    </code>
                    <CopyButton value="TE-000123" label={L('Copy request number', 'نسخ رقم الطلب')} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Section>

        <Section id="overlays" title={L('Overlays', 'النوافذ')}>
          <Row>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">{L('Dialog', 'نافذة حوار')}</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{L('Request information', 'طلب معلومات')}</DialogTitle>
                  <DialogDescription>{L('The customer is notified and the request waits for their answer.', 'يُبلَّغ العميل وينتظر الطلب ردّه.')}</DialogDescription>
                </DialogHeader>
                <DialogBody className="space-y-1.5">
                  <Label htmlFor="g-dialog-msg" required>
                    {L('Message to the customer', 'رسالة إلى العميل')}
                  </Label>
                  <Textarea id="g-dialog-msg" defaultValue={L('Please upload a clearer copy of your passport.', 'يرجى رفع نسخة أوضح من جواز السفر.')} />
                </DialogBody>
                <DialogFooter>
                  <Button variant="outline">{t('common.cancel')}</Button>
                  <Button>{L('Send request', 'إرسال الطلب')}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Button variant="destructive-outline" onClick={() => setConfirmOpen(true)}>
              {L('Confirm dialog', 'نافذة تأكيد')}
            </Button>
            <ConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              title={L('Cancel this request?', 'إلغاء هذا الطلب؟')}
              description={L('The customer is told that the request was cancelled. Payments are not refunded automatically.', 'يُبلَّغ العميل بإلغاء الطلب. لا تُسترد المدفوعات تلقائيًا.')}
              confirmLabel={L('Cancel request', 'إلغاء الطلب')}
              cancelLabel={L('Keep request', 'الإبقاء على الطلب')}
              onConfirm={async () => {
                await new Promise((r) => setTimeout(r, 600));
                toasts.success(L('Request cancelled', 'تم إلغاء الطلب'));
              }}
            />
            <Button variant="destructive-outline" onClick={() => setTypedOpen(true)}>
              {L('Typed confirmation', 'تأكيد بالكتابة')}
            </Button>
            <ConfirmDialog
              open={typedOpen}
              onOpenChange={setTypedOpen}
              title={L('Merge customer records', 'دمج سجلات العملاء')}
              description={L('CUS-000017 is merged into CUS-000042 and retired. This cannot be undone.', 'سيُدمج السجل CUS-000017 في CUS-000042 ويُوقف. لا يمكن التراجع عن ذلك.')}
              confirmLabel={L('Merge records', 'دمج السجلات')}
              typedConfirmation="CUS-000017"
              onConfirm={() => toasts.success(L('Records merged', 'تم دمج السجلات'))}
            />
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">{L('Sheet', 'لوحة جانبية')}</Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>{L('Filters', 'عوامل التصفية')}</SheetTitle>
                  <SheetDescription>{L('Narrow the list.', 'تضييق القائمة.')}</SheetDescription>
                </SheetHeader>
                <SheetBody className="space-y-4">
                  <SkeletonText lines={5} />
                </SheetBody>
                <SheetFooter>
                  <Button>{t('common.apply')}</Button>
                </SheetFooter>
              </SheetContent>
            </Sheet>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  {L('Menu', 'قائمة')}
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>TE-000123</DropdownMenuLabel>
                <DropdownMenuItem>
                  <Pencil aria-hidden="true" />
                  {t('common.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Download aria-hidden="true" />
                  {t('common.download')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive>
                  <Trash2 aria-hidden="true" />
                  {t('common.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">{L('Popover', 'نافذة منبثقة')}</Button>
              </PopoverTrigger>
              <PopoverContent>
                <p className="text-base font-medium">{L('Estimated completion', 'الإنجاز المتوقع')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{L('2 to 5 working days after documents are verified.', 'من يومين إلى 5 أيام عمل بعد توثيق المستندات.')}</p>
              </PopoverContent>
            </Popover>
            <Tooltip content={L('Shown on hover and on keyboard focus', 'يظهر عند التمرير والتركيز بلوحة المفاتيح')}>
              <Button variant="outline">{L('Tooltip', 'تلميح')}</Button>
            </Tooltip>
          </Row>
        </Section>

        <Section id="feedback" title={L('Feedback', 'التنبيهات')}>
          <div className="grid gap-3 lg:grid-cols-2">
            <Alert tone="info" title={L('Trial ends in 9 days', 'تنتهي الفترة التجريبية بعد 9 أيام')}>
              {L('Choose a plan to keep working without interruption.', 'اختر باقة لمواصلة العمل دون انقطاع.')}
            </Alert>
            <Alert tone="success" title={L('Payment received', 'تم استلام الدفعة')}>
              {L('Receipt REC-000311 was sent to the customer.', 'أُرسل الإيصال REC-000311 إلى العميل.')}
            </Alert>
            <Alert tone="warning" title={L('2 documents expire this month', 'مستندان تنتهي صلاحيتهما هذا الشهر')} action={<Button size="sm" variant="outline">{L('Review reminders', 'مراجعة التذكيرات')}</Button>} />
            <Alert tone="danger" title={t('table.errorTitle')} action={<Button size="sm" variant="outline">{t('common.retry')}</Button>}>
              {t('errors.network')}
            </Alert>
          </div>
          <Row label={L('Toasts', 'الإشعارات المنبثقة')}>
            <Button variant="outline" onClick={() => toasts.success(L('Customer added', 'تمت إضافة العميل'), 'CUS-000043')}>
              {L('Success', 'نجاح')}
            </Button>
            <Button variant="outline" onClick={() => toasts.error(new ApiError({ status: 409, code: 'VERSION_CONFLICT', message: 'x' }))}>
              {L('Failure', 'فشل')}
            </Button>
            <Button variant="outline" onClick={() => toasts.warning(L('The plan limit is almost reached', 'اقتربت من حد الباقة'))}>
              {L('Warning', 'تحذير')}
            </Button>
            <Button variant="outline" onClick={() => toasts.info(L('A new version is available', 'يتوفر إصدار جديد'))}>
              {L('Info', 'معلومة')}
            </Button>
          </Row>
          <Row label={L('Loading', 'التحميل')}>
            <Spinner size="xs" />
            <Spinner size="sm" />
            <Spinner />
            <Spinner size="lg" className="text-secondary" />
            <div className="w-64">
              <SkeletonText />
            </div>
            <Skeleton className="size-12 rounded-full" />
            <Skeleton className="h-10 w-40" />
          </Row>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <EmptyState
                icon={<Users />}
                title={L('No customers yet', 'لا يوجد عملاء بعد')}
                description={L('Add your first customer. It takes a name; everything else can follow later.', 'أضف أول عميل. يكفي الاسم، ويمكن استكمال البقية لاحقًا.')}
                action={
                  <Button variant="accent">
                    <Plus aria-hidden="true" />
                    {L('Add customer', 'إضافة عميل')}
                  </Button>
                }
              />
            </Card>
            <Card>
              <LoadingBlock label={t('common.loading')} className="min-h-56" />
            </Card>
          </div>
        </Section>

        <Section id="status" title={L('Status', 'الحالات')}>
          <Row label={L('Request statuses (staff wording)', 'حالات الطلب (صياغة الموظفين)')}>
            {RequestStatusValues.map((s) => (
              <StatusBadge key={s} kind="request" status={s} />
            ))}
          </Row>
          <Row label={L('Request statuses (customer wording)', 'حالات الطلب (صياغة العملاء)')}>
            {(['AWAITING_CUSTOMER', 'QUOTED', 'AWAITING_PAYMENT', 'EXTERNAL_PROCESSING', 'COMPLETED'] as const).map((s) => (
              <StatusBadge key={s} kind="requestCustomer" status={s} dot />
            ))}
          </Row>
          <Row label={L('Invoices, payments, documents, priority', 'الفواتير والمدفوعات والمستندات والأولوية')}>
            {(['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID'] as const).map((s) => (
              <StatusBadge key={s} kind="invoice" status={s} />
            ))}
            {(['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED'] as const).map((s) => (
              <StatusBadge key={s} kind="payment" status={s} />
            ))}
            {(['UNVERIFIED', 'VERIFIED', 'REJECTED'] as const).map((s) => (
              <StatusBadge key={s} kind="verification" status={s} />
            ))}
            {(['HIGH', 'URGENT'] as const).map((s) => (
              <StatusBadge key={s} kind="priority" status={s} />
            ))}
          </Row>
          <Row label={L('Badges and avatars', 'الشارات والصور الرمزية')}>
            <Badge>{L('Neutral', 'محايد')}</Badge>
            <Badge tone="brand">{L('Business', 'منشأة')}</Badge>
            <Badge tone="outline">VIP</Badge>
            <Badge tone="success" dot>
              {L('Online', 'متصل')}
            </Badge>
            <Avatar name="Noor Al Mansoori" size="sm" />
            <Avatar name="أحمد خالد" />
            <Avatar name="Rajesh Kumar" size="lg" />
          </Row>
        </Section>

        <Section id="data" title={L('Data', 'البيانات')}>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label={L('New requests', 'طلبات جديدة')} value={formatNumber(28)} icon={<Inbox />} tone="info" href="#data" />
            <StatCard label={L('In progress', 'قيد التنفيذ')} value={formatNumber(56)} icon={<Loader />} tone="warning" />
            <StatCard label={L('Completed', 'مكتملة')} value={formatNumber(42)} icon={<CheckCircle2 />} tone="success" hint={t('common.today')} />
            <StatCard label={L('Awaiting payment', 'بانتظار الدفع')} value={formatNumber(8)} icon={<Wallet />} tone="danger" />
            <StatCard label={L('Appointments', 'المواعيد')} value={formatNumber(12)} icon={<CalendarDays />} tone="neutral" />
            <StatCard label={L('Customers', 'العملاء')} value={formatNumber(1284)} icon={<Users />} tone="brand" />
            <StatCard label={L('Loading', 'تحميل')} value="" icon={<ClipboardList />} tone="info" loading />
          </div>

          <div>
            <Row label={L('DataTable states', 'حالات جدول البيانات')}>
              {(['data', 'empty', 'error', 'slow'] as const).map((mode) => (
                <Button key={mode} size="sm" variant={tableMode === mode ? 'default' : 'outline'} onClick={() => setTableMode(mode)} aria-pressed={tableMode === mode}>
                  {{ data: L('With rows', 'مع صفوف'), empty: L('Empty', 'فارغ'), error: L('Error', 'خطأ'), slow: L('Loading', 'تحميل') }[mode]}
                </Button>
              ))}
            </Row>
            <DataTable<DemoRow>
              key={tableMode}
              className="mt-3"
              caption={L('Requests', 'الطلبات')}
              queryKey={['gallery', tableMode]}
              queryFn={demoQuery}
              columns={columns}
              rowKey={(r) => r.id}
              rowHref={() => '#data'}
              defaultPageSize={5}
              syncUrl={false}
              filters={[
                { id: 'status', type: 'select', label: L('Status', 'الحالة'), options: (['SUBMITTED', 'IN_PREPARATION', 'COMPLETED'] as const).map((s) => ({ value: s, label: s })) },
                { id: 'created', type: 'dateRange', label: L('Created', 'تاريخ الإنشاء'), fromKey: 'from', toKey: 'to' },
              ]}
              rowActions={[
                { id: 'edit', label: t('common.edit'), icon: <Pencil aria-hidden="true" />, onSelect: (r) => toasts.info(r.no) },
                { id: 'delete', label: t('common.delete'), icon: <Trash2 aria-hidden="true" />, destructive: true, onSelect: () => setConfirmOpen(true) },
              ]}
              empty={{ icon: <ClipboardList />, title: L('No requests yet', 'لا توجد طلبات بعد'), description: L('Requests appear here as soon as the first one is created.', 'ستظهر الطلبات هنا فور إنشاء أول طلب.') }}
            />
          </div>

          <Card>
            <Table>
              <TableCaption>{L('Plain table', 'جدول بسيط')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{L('Invoice', 'الفاتورة')}</TableHead>
                  <TableHead>{L('Customer', 'العميل')}</TableHead>
                  <TableHead>{L('Status', 'الحالة')}</TableHead>
                  <TableHead className="text-end">{L('Total', 'الإجمالي')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {DEMO_ROWS.slice(0, 3).map((r, i) => (
                  <TableRow key={r.id}>
                    <TableCell className="tabular">INV-00004{i + 5}</TableCell>
                    <TableCell>{L(r.customer, r.customerAr)}</TableCell>
                    <TableCell>
                      <StatusBadge kind="invoice" status={(['PAID', 'ISSUED', 'PARTIALLY_PAID'] as const)[i]} />
                    </TableCell>
                    <TableCell className="tabular text-end">{formatMoney(r.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <CardFooter>
              <Pagination meta={{ page, pageSize: 20, total: 135, totalPages: 7 }} onPageChange={setPage} onPageSizeChange={() => undefined} className="w-full" />
            </CardFooter>
          </Card>
        </Section>

        <Section id="layout" title={L('Layout', 'التخطيط')}>
          <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>{L('Request progress', 'سير الطلب')}</CardTitle>
                  <CardDescription>TE-000123</CardDescription>
                </div>
                <StatusBadge kind="request" status="IN_PREPARATION" />
              </CardHeader>
              <CardContent>
                <Timeline
                  items={[
                    { id: '1', title: L('Request submitted', 'تم إرسال الطلب'), time: formatDate('2026-10-06'), state: 'done' },
                    { id: '2', title: L('Documents under review', 'المستندات قيد المراجعة'), time: formatDate('2026-10-06'), state: 'done' },
                    { id: '3', title: L('Payment completed', 'اكتمل الدفع'), time: formatDate('2026-10-07'), state: 'done', description: formatMoney('750.00') },
                    { id: '4', title: L('Being prepared', 'قيد التحضير'), time: L('In progress', 'قيد التنفيذ'), state: 'current' },
                    { id: '5', title: L('Completed', 'مكتمل'), state: 'upcoming' },
                  ]}
                />
              </CardContent>
            </Card>
            <div className="min-w-0 space-y-6">
              <Card>
                <CardContent className="space-y-6">
                  <Stepper
                    current={step}
                    onStepClick={setStep}
                    steps={[
                      { id: 'service', label: L('Service', 'الخدمة') },
                      { id: 'details', label: L('Details', 'التفاصيل') },
                      { id: 'documents', label: L('Documents', 'المستندات') },
                      { id: 'review', label: L('Review', 'المراجعة') },
                    ]}
                  />
                  <div className="flex justify-between">
                    <Button variant="outline" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
                      {t('common.back')}
                    </Button>
                    <Button disabled={step === 3} onClick={() => setStep((s) => Math.min(3, s + 1))}>
                      {t('common.continue')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent>
                  <Tabs defaultValue="details">
                    <TabsList>
                      <TabsTrigger value="details">{L('Details', 'التفاصيل')}</TabsTrigger>
                      <TabsTrigger value="documents">{L('Documents', 'المستندات')}</TabsTrigger>
                      <TabsTrigger value="payments">{L('Payments', 'المدفوعات')}</TabsTrigger>
                      <TabsTrigger value="history" disabled>
                        {L('History', 'السجل')}
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="details">
                      <DescriptionList
                        items={[
                          { label: L('Customer', 'العميل'), value: L('Ahmed Khalid', 'أحمد خالد') },
                          { label: L('Customer no.', 'رقم العميل'), value: <span className="tabular">CUS-000042</span> },
                          { label: L('Mobile', 'الهاتف'), value: <span className="ltr-value">+971 50 123 4567</span> },
                          { label: L('Emirates ID', 'الهوية الإماراتية'), value: <span className="ltr-value">•••• 5671</span> },
                          { label: L('Nationality', 'الجنسية'), value: null },
                          { label: L('Address', 'العنوان'), value: L('Villa 12, Al Barsha 1, Dubai', 'فيلا 12، البرشاء 1، دبي'), wide: true },
                        ]}
                      />
                    </TabsContent>
                    <TabsContent value="documents">
                      <SkeletonText lines={4} />
                    </TabsContent>
                    <TabsContent value="payments">
                      <SkeletonText lines={3} />
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
              <Card>
                <CardContent>
                  <PermissionGate permission="customer.merge" fallback={<p className="text-sm text-muted-foreground">{L('PermissionGate: hidden without the permission (not signed in here).', 'بوابة الصلاحيات: مخفي دون الصلاحية (لم يتم تسجيل الدخول هنا).')}</p>}>
                    <Button variant="destructive-outline">{L('Merge customers', 'دمج العملاء')}</Button>
                  </PermissionGate>
                </CardContent>
              </Card>
            </div>
          </div>
          <Stepper
            orientation="vertical"
            current={1}
            className="max-w-md"
            steps={[
              { id: 'a', label: L('Choose a service', 'اختر الخدمة'), description: L('Search the catalogue or browse by category.', 'ابحث في القائمة أو تصفح حسب الفئة.') },
              { id: 'b', label: L('Upload documents', 'ارفع المستندات'), description: L('Photos from your phone are fine.', 'يمكن استخدام صور من الهاتف.') },
              { id: 'c', label: L('Pay', 'ادفع'), description: L('Online or at the centre.', 'عبر الإنترنت أو في المركز.') },
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
