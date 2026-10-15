'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, ExternalLink, Pencil } from 'lucide-react';
import { brandingSchema } from '@typease/validation';
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ChoiceLabel, Form, FormError, FormField, Input, PageHeader, PhoneInput, RadioGroup, RadioGroupItem,
  RequirePermission, Textarea, cn, useApi, useI18n, useSession, useToast, useZodForm,
} from '@typease/ui';
import { BrandPreview, tooSimilar } from '@/components/adm/brand-preview';
import { BranchBrandingDialog, BrandAssetUpload, ColourField } from '@/components/adm/branding-parts';
import { usePortalUrl } from '@/components/adm/portal-url';
import { CardSkeleton, LoadError, PlanLimitAlert, SettingSwitch, isPlanLimit } from '@/components/adm/shared';
import type { BranchRow, BrandingState } from '@/components/adm/types';
import { admKeys } from '@/lib/keys/adm';
import { keys } from '@/lib/query-keys';

const FORM_ID = 'branding-form';
const COLOURS = ['primaryColor', 'secondaryColor', 'accentColor'] as const;

export function BrandingPage() {
  return (
    <RequirePermission anyOf={['branding.manage']}>
      <Branding />
    </RequirePermission>
  );
}

function Branding() {
  const { t } = useI18n();
  const api = useApi();
  const portalUrl = usePortalUrl();
  const branding = useQuery({ queryKey: admKeys.branding.all, queryFn: () => api.client.get<BrandingState>('/branding') });
  const [saving, setSaving] = React.useState(false);

  return (
    <>
      <PageHeader
        title={t('adm.branding.title')}
        description={t('adm.branding.description')}
        action={
          <Button type="submit" form={FORM_ID} disabled={!branding.data} loading={saving} loadingText={t('common.saving')}>
            {t('adm.branding.save')}
          </Button>
        }
        secondary={
          portalUrl ? (
            <Button asChild variant="outline">
              <a href={portalUrl} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden="true" />
                {t('adm.branding.viewPortal')}
              </a>
            </Button>
          ) : undefined
        }
      />
      {branding.isPending ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="space-y-6">
            <CardSkeleton />
            <CardSkeleton lines={6} />
          </div>
          <CardSkeleton lines={6} />
        </div>
      ) : branding.isError ? (
        <LoadError error={branding.error} onRetry={() => void branding.refetch()} />
      ) : (
        <BrandingForm state={branding.data} onSaving={setSaving} />
      )}
    </>
  );
}

function BrandingForm({ state, onSaving }: { state: BrandingState; onSaving: (saving: boolean) => void }) {
  const { t, pick } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const session = useSession();
  const queryClient = useQueryClient();
  const slug = session.tenant?.slug ?? '';
  const row = state.tenant;
  const fallback = { primaryColor: state.defaults.primary, secondaryColor: state.defaults.secondary, accentColor: state.defaults.accent };
  const form = useZodForm(brandingSchema, {
    emptyAs: 'null',
    defaultValues: {
      mode: (row?.mode as 'TYPEASE' | 'WHITE_LABEL' | undefined) ?? 'TYPEASE',
      businessName: row?.businessName ?? session.tenant?.name ?? '',
      businessNameAr: row?.businessNameAr ?? '',
      primaryColor: row?.primaryColor ?? '',
      secondaryColor: row?.secondaryColor ?? '',
      accentColor: row?.accentColor ?? '',
      websiteTitle: row?.websiteTitle ?? '',
      tagline: row?.tagline ?? '',
      supportEmail: row?.supportEmail ?? '',
      supportPhone: row?.supportPhone ?? '',
      emailFromName: row?.emailFromName ?? '',
      emailFromAddress: row?.emailFromAddress ?? '',
      invoiceFooter: row?.invoiceFooter ?? '',
      receiptFooter: row?.receiptFooter ?? '',
      publicCatalogueEnabled: row?.publicCatalogueEnabled ?? true,
    },
  });
  const [limit, setLimit] = React.useState<unknown>(null);
  const [branchDialog, setBranchDialog] = React.useState<BranchRow | null>(null);
  const modeId = React.useId();
  const catalogueId = React.useId();
  const branches = useQuery({ queryKey: admKeys.branches.admin, queryFn: () => api.client.get<BranchRow[]>('/branches', { query: { includeInactive: true } }), enabled: session.hasPermission('branch.read'), staleTime: 60_000 });

  const values = form.watch();
  const whiteLabel = values.mode === 'WHITE_LABEL';
  const submitting = form.formState.isSubmitting;
  React.useEffect(() => onSaving(submitting), [submitting, onSaving]);

  const colour = (name: (typeof COLOURS)[number]) => (values[name] as string | null | undefined) || fallback[name];
  const similar = whiteLabel && tooSimilar(colour('primaryColor'), colour('secondaryColor'));
  const senderChanged = (values.emailFromAddress ?? '') !== (row?.emailFromAddress ?? '');
  const activeBranches = (branches.data ?? []).filter((b) => b.isActive);

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <Form
        id={FORM_ID}
        form={form}
        className="space-y-6"
        onSubmit={async (input) => {
          setLimit(null);
          // Colours, website title and tagline are white-label fields: the API treats sending them as "wants white label".
          const { primaryColor, secondaryColor, accentColor, websiteTitle, tagline, ...rest } = input;
          const body = input.mode === 'WHITE_LABEL' || state.whiteLabelIncluded ? input : rest;
          try {
            await api.client.put('/branding', body);
            toasts.success(t('adm.branding.saved'), input.mode === 'WHITE_LABEL' ? t('adm.branding.savedWhiteLabel') : t('adm.branding.savedTypease'));
            await queryClient.invalidateQueries({ queryKey: admKeys.branding.all });
            await queryClient.invalidateQueries({ queryKey: keys.tenantConfig(slug) });
          } catch (error) {
            if (isPlanLimit(error)) {
              setLimit(error);
              return;
            }
            throw error;
          }
        }}
      >
        {/* ---- mode */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t('adm.branding.mode.title')}</CardTitle>
              <CardDescription>{t('adm.branding.mode.text')}</CardDescription>
            </div>
            {state.whiteLabelIncluded ? <Badge tone="success">{t('adm.branding.mode.included')}</Badge> : <Badge tone="warning">{t('adm.branding.mode.notIncluded')}</Badge>}
          </CardHeader>
          <CardContent className="space-y-4">
            <RadioGroup value={values.mode ?? 'TYPEASE'} onValueChange={(mode) => form.setValue('mode', mode as 'TYPEASE' | 'WHITE_LABEL', { shouldDirty: true })} aria-label={t('adm.branding.mode.title')} className="grid gap-3 sm:grid-cols-2">
              {(['TYPEASE', 'WHITE_LABEL'] as const).map((mode) => (
                <div key={mode} className={cn('rounded-lg border p-4', values.mode === mode && 'border-secondary bg-secondary-soft/50')}>
                  <ChoiceLabel htmlFor={`${modeId}-${mode}`} control={<RadioGroupItem id={`${modeId}-${mode}`} value={mode} />} label={<span className="font-medium">{t(`adm.branding.mode.${mode}`)}</span>} description={t(`adm.branding.mode.${mode}_text`)} />
                </div>
              ))}
            </RadioGroup>
            {limit ? <PlanLimitAlert error={limit} /> : whiteLabel && !state.whiteLabelIncluded ? <PlanLimitAlert message={t('adm.branding.mode.upgradeNote')} /> : null}
          </CardContent>
        </Card>

        {/* ---- identity */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t('adm.branding.identity.title')}</CardTitle>
              <CardDescription>{t('adm.branding.identity.text')}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="businessName" label={t('adm.branding.fields.businessName')}>
                {(field) => <Input {...field} autoComplete="off" dir="ltr" lang="en" />}
              </FormField>
              <FormField name="businessNameAr" label={t('adm.branding.fields.businessNameAr')}>
                {(field) => <Input {...field} autoComplete="off" dir="rtl" lang="ar" />}
              </FormField>
            </div>
            {whiteLabel ? (
              <>
                <div className="grid gap-6 lg:grid-cols-2">
                  <BrandAssetUpload kind="logo" url={row?.logoUrl ?? null} slug={slug} />
                  <BrandAssetUpload kind="favicon" url={row?.faviconUrl ?? null} slug={slug} />
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  <FormField name="websiteTitle" label={t('adm.branding.fields.websiteTitle')} hint={t('adm.branding.fields.websiteTitleHint')}>
                    {(field) => <Input {...field} autoComplete="off" dir="auto" />}
                  </FormField>
                  <FormField name="tagline" label={t('adm.branding.fields.tagline')} hint={t('adm.branding.fields.taglineHint')}>
                    {(field) => <Input {...field} autoComplete="off" dir="auto" />}
                  </FormField>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('adm.branding.identity.typeaseNote')}</p>
            )}
          </CardContent>
        </Card>

        {/* ---- colours */}
        {whiteLabel ? (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>{t('adm.branding.colours.title')}</CardTitle>
                <CardDescription>{t('adm.branding.colours.text')}</CardDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={() => COLOURS.forEach((c) => form.setValue(c, fallback[c], { shouldDirty: true, shouldValidate: true }))}>
                {t('adm.branding.colours.reset')}
              </Button>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-5 md:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
                {COLOURS.map((name) => (
                  <FormField key={name} name={name} label={t(`adm.branding.colours.${name}`)} hint={t(`adm.branding.colours.${name}Hint`)}>
                    {(field) => <ColourField id={field.id} value={(field.value as string) ?? ''} onChange={field.onChange} fallback={fallback[name]} invalid={field['aria-invalid']} describedBy={field['aria-describedby']} />}
                  </FormField>
                ))}
              </div>
              {similar ? (
                <Alert tone="warning" live>
                  {t('adm.branding.colours.tooSimilar')}
                </Alert>
              ) : null}
              <p className="text-sm text-muted-foreground">{t('adm.branding.colours.accessible')}</p>
            </CardContent>
          </Card>
        ) : null}

        {/* ---- contact and email sender */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t('adm.branding.contact.title')}</CardTitle>
              <CardDescription>{t('adm.branding.contact.text')}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="supportEmail" label={t('adm.branding.fields.supportEmail')}>
                {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
              </FormField>
              <FormField name="supportPhone" label={t('adm.branding.fields.supportPhone')}>
                {(field) => <PhoneInput {...field} />}
              </FormField>
              <FormField name="emailFromName" label={t('adm.branding.fields.emailFromName')} hint={t('adm.branding.fields.emailFromNameHint')}>
                {(field) => <Input {...field} autoComplete="off" dir="auto" />}
              </FormField>
              <FormField name="emailFromAddress" label={t('adm.branding.fields.emailFromAddress')}>
                {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
              </FormField>
            </div>
            {values.emailFromAddress ? (
              row?.emailSenderVerified && !senderChanged ? (
                <Alert tone="success" title={t('adm.branding.sender.verifiedTitle')}>
                  {t('adm.branding.sender.verifiedText', { address: row.emailFromAddress ?? '' })}
                </Alert>
              ) : (
                <Alert tone="warning" title={t('adm.branding.sender.pendingTitle')}>
                  {senderChanged ? t('adm.branding.sender.changedText') : t('adm.branding.sender.pendingText')}
                </Alert>
              )
            ) : (
              <p className="text-sm text-muted-foreground">{t('adm.branding.sender.noneText')}</p>
            )}
          </CardContent>
        </Card>

        {/* ---- documents and catalogue */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t('adm.branding.documents.title')}</CardTitle>
              <CardDescription>{t('adm.branding.documents.text')}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="invoiceFooter" label={t('adm.branding.fields.invoiceFooter')} hint={t('adm.branding.fields.invoiceFooterHint')}>
                {(field) => <Textarea {...field} rows={3} dir="auto" maxLength={500} />}
              </FormField>
              <FormField name="receiptFooter" label={t('adm.branding.fields.receiptFooter')} hint={t('adm.branding.fields.receiptFooterHint')}>
                {(field) => <Textarea {...field} rows={3} dir="auto" maxLength={500} />}
              </FormField>
            </div>
            <div className="rounded-lg border p-4">
              <SettingSwitch id={catalogueId} label={t('adm.branding.catalogue.title')} description={t('adm.branding.catalogue.text')} checked={values.publicCatalogueEnabled !== false} onCheckedChange={(checked) => form.setValue('publicCatalogueEnabled', checked, { shouldDirty: true })} />
            </div>
            <FormError />
          </CardContent>
        </Card>

        {/* ---- per-branch overrides */}
        {activeBranches.length > 1 ? (
          <Card>
            <CardHeader className="pb-4">
              <div>
                <CardTitle>{t('adm.branding.branches.title')}</CardTitle>
                <CardDescription>{t('adm.branding.branches.text')}</CardDescription>
              </div>
            </CardHeader>
            <ul className="divide-y border-t">
              {activeBranches.map((b) => {
                const override = state.branches.find((o) => o.branchId === b.id) ?? null;
                const changed = override ? [override.businessName, override.businessNameAr, override.supportEmail, override.supportPhone, override.invoiceFooter, override.receiptFooter].filter(Boolean).length : 0;
                return (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                    <span className="min-w-0">
                      <span className="block font-medium">{pick(b.name, b.nameAr)}</span>
                      <span className="block text-sm text-muted-foreground">{changed ? t('adm.branding.branches.custom') : t('adm.branding.branches.same')}</span>
                    </span>
                    <Button variant="subtle" size="sm" onClick={() => setBranchDialog(b)}>
                      <Pencil aria-hidden="true" />
                      {t('adm.branding.branches.edit')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </Card>
        ) : null}

        <Alert tone="info" title={t('adm.branding.mobile.title')}>
          {t('adm.branding.mobile.text')}
        </Alert>
        <p className="text-sm text-muted-foreground">
          {t('adm.branding.domainsHint')}{' '}
          <Link href="/domains" className="text-secondary-text underline-offset-4 hover:underline">
            {t('adm.branding.domainsLink')}
          </Link>
        </p>
      </Form>

      {/* ---- live preview */}
      <aside className="xl:sticky xl:top-20" aria-labelledby="brand-preview-title">
        <Card>
          <CardHeader className="items-center">
            <CardTitle id="brand-preview-title">{t('adm.branding.preview.title')}</CardTitle>
            <Badge tone="neutral" icon={<BadgeCheck />}>
              {t('adm.branding.preview.live')}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{whiteLabel ? t('adm.branding.preview.text') : t('adm.branding.preview.typeaseText')}</p>
            <BrandPreview
              brand={{
                mode: whiteLabel ? 'WHITE_LABEL' : 'TYPEASE',
                name: values.businessName || session.tenant?.name || '',
                nameAr: values.businessNameAr || null,
                logoUrl: row?.logoUrl ?? null,
                tagline: values.tagline || null,
                colors: { primary: colour('primaryColor'), secondary: colour('secondaryColor'), accent: colour('accentColor') },
                invoiceFooter: values.invoiceFooter || null,
              }}
            />
          </CardContent>
        </Card>
      </aside>

      <BranchBrandingDialog branch={branchDialog} current={branchDialog ? (state.branches.find((o) => o.branchId === branchDialog.id) ?? null) : null} onClose={() => setBranchDialog(null)} />
    </div>
  );
}
