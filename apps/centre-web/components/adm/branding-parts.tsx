'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ImageUp } from 'lucide-react';
import { brandingSchema } from '@typease/validation';
import {
  Alert, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Form, FormError, FormField, Input, PhoneInput, Textarea, cn,
  matchesAccept, useApi, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { admKeys } from '@/lib/keys/adm';
import { keys } from '@/lib/query-keys';
import { checkColour, isDarkText } from './brand-preview';
import { ActionError, PlanLimitAlert, isPlanLimit } from './shared';
import type { BranchRow, BrandingRow } from './types';

const HEX = /^#[0-9A-Fa-f]{6}$/;
const ASSET_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const ASSET_MAX_BYTES = 1024 * 1024;

/**
 * One brand colour: the browser's colour picker next to a hex field. Under it, what the theme does
 * with the colour: which text colour goes on it, and whether it had to be adjusted to stay readable.
 */
export function ColourField({ id, value, onChange, fallback, invalid, describedBy }: { id: string; value: string; onChange: (value: string) => void; fallback: string; invalid?: boolean; describedBy?: string }) {
  const { t } = useI18n();
  const valid = HEX.test(value);
  const shown = valid ? value : fallback;
  const check = checkColour(shown);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={shown.toLowerCase()}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          aria-label={t('adm.branding.colours.pick')}
          className="size-10 shrink-0 cursor-pointer rounded-md border border-input bg-card p-1 [&::-moz-color-swatch]:rounded [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0"
        />
        <Input
          id={id}
          value={value}
          onChange={(e) => {
            const raw = e.target.value.trim().toUpperCase().replace(/[^#0-9A-F]/g, '');
            onChange(raw && !raw.startsWith('#') ? `#${raw}`.slice(0, 7) : raw.slice(0, 7));
          }}
          placeholder={fallback}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          className="tabular w-32"
        />
        {check ? (
          <span aria-hidden="true" className="inline-flex h-10 items-center rounded-md px-3 text-sm font-medium" style={{ backgroundColor: shown, color: check.foreground }}>
            Aa
          </span>
        ) : null}
      </div>
      {check && valid ? (
        <p className={cn('text-sm', check.adjusted ? 'text-warning-text' : 'text-muted-foreground')}>
          {check.adjusted ? t('adm.branding.colours.adjusted') : isDarkText(check.foreground) ? t('adm.branding.colours.darkText') : t('adm.branding.colours.lightText')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Logo or favicon: shows the current image and uploads a new one at once (POST /branding/logo | favicon).
 * Type and size are checked in the browser first (PNG, JPEG or WebP, 1 MB at most), as the API does.
 */
export function BrandAssetUpload({ kind, url, slug, disabled }: { kind: 'logo' | 'favicon'; url: string | null; slug: string; disabled?: boolean }) {
  const { t, formatFileSize } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [error, setError] = React.useState<unknown>(null);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setProblem(null);
    setError(null);
    if (!matchesAccept(file, ASSET_TYPES)) return setProblem(t('adm.branding.assets.wrongType'));
    if (file.size > ASSET_MAX_BYTES) return setProblem(t('adm.branding.assets.tooLarge', { size: formatFileSize(file.size) }));
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.client.upload<BrandingRow>(`/branding/${kind}`, form);
      toasts.success(kind === 'logo' ? t('adm.branding.assets.logoSaved') : t('adm.branding.assets.faviconSaved'));
      await queryClient.invalidateQueries({ queryKey: admKeys.branding.all });
      await queryClient.invalidateQueries({ queryKey: keys.tenantConfig(slug) });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{kind === 'logo' ? t('adm.branding.assets.logo') : t('adm.branding.assets.favicon')}</p>
      <div className="flex items-center gap-4">
        <span className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted/50', kind === 'logo' ? 'h-16 w-40' : 'size-16')}>
          {url ? (
            // Plain <img>: tenant-uploaded logo URL, outside next/image's loader allow-list.
            <img src={url} alt={kind === 'logo' ? t('adm.branding.assets.logoAlt') : t('adm.branding.assets.faviconAlt')} className={cn('object-contain', kind === 'logo' ? 'max-h-12 max-w-36' : 'size-8')} />
          ) : (
            <span className="px-2 text-center text-xs text-muted-foreground">{t('adm.branding.assets.none')}</span>
          )}
        </span>
        <div className="min-w-0 space-y-1">
          <Button variant="outline" size="sm" disabled={disabled} loading={busy} loadingText={t('file.uploading')} onClick={() => input.current?.click()}>
            <ImageUp aria-hidden="true" />
            {url ? t('adm.branding.assets.replace') : t('adm.branding.assets.upload')}
          </Button>
          <p className="text-sm text-muted-foreground">{kind === 'logo' ? t('adm.branding.assets.logoHint') : t('adm.branding.assets.faviconHint')}</p>
        </div>
        <input
          ref={input}
          type="file"
          accept={ASSET_TYPES.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-label={kind === 'logo' ? t('adm.branding.assets.logo') : t('adm.branding.assets.favicon')}
          data-asset={kind}
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {problem ? (
        <p role="alert" className="text-sm text-destructive-text">
          {problem}
        </p>
      ) : null}
      <ActionError error={error} />
    </div>
  );
}

const branchSchema = brandingSchema.pick({ businessName: true, businessNameAr: true, supportEmail: true, supportPhone: true, invoiceFooter: true, receiptFooter: true });

/** What one branch shows instead of the centre's values (PUT /branding/branches/:branchId). Empty = same as the centre. */
export function BranchBrandingDialog({ branch, current, onClose }: { branch: BranchRow | null; current: BrandingRow | null; onClose: () => void }) {
  const { t, pick } = useI18n();
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(branchSchema, { emptyAs: 'null', defaultValues: { businessName: '', businessNameAr: '', supportEmail: '', supportPhone: '', invoiceFooter: '', receiptFooter: '' } });
  const [limit, setLimit] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (!branch) return;
    setLimit(null);
    form.reset({
      businessName: current?.businessName ?? '',
      businessNameAr: current?.businessNameAr ?? '',
      supportEmail: current?.supportEmail ?? '',
      supportPhone: current?.supportPhone ?? '',
      invoiceFooter: current?.invoiceFooter ?? '',
      receiptFooter: current?.receiptFooter ?? '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, current]);

  return (
    <Dialog open={!!branch} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            if (!branch) return;
            setLimit(null);
            try {
              await api.client.put(`/branding/branches/${branch.id}`, values);
              toasts.success(t('adm.branding.branches.saved'), pick(branch.name, branch.nameAr));
              await queryClient.invalidateQueries({ queryKey: admKeys.branding.all });
              onClose();
            } catch (error) {
              if (isPlanLimit(error)) {
                setLimit(error);
                return;
              }
              throw error;
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{branch ? t('adm.branding.branches.dialogTitle', { name: pick(branch.name, branch.nameAr) }) : ''}</DialogTitle>
            <DialogDescription>{t('adm.branding.branches.dialogText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <Alert tone="info">{t('adm.branding.branches.inherit')}</Alert>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField name="businessName" label={t('adm.branding.fields.businessName')}>
                {(field) => <Input {...field} autoComplete="off" dir="ltr" lang="en" />}
              </FormField>
              <FormField name="businessNameAr" label={t('adm.branding.fields.businessNameAr')}>
                {(field) => <Input {...field} autoComplete="off" dir="rtl" lang="ar" />}
              </FormField>
              <FormField name="supportEmail" label={t('adm.branding.fields.supportEmail')}>
                {(field) => <Input {...field} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />}
              </FormField>
              <FormField name="supportPhone" label={t('adm.branding.fields.supportPhone')}>
                {(field) => <PhoneInput {...field} />}
              </FormField>
              <FormField name="invoiceFooter" label={t('adm.branding.fields.invoiceFooter')} className="sm:col-span-2">
                {(field) => <Textarea {...field} rows={2} dir="auto" />}
              </FormField>
              <FormField name="receiptFooter" label={t('adm.branding.fields.receiptFooter')} className="sm:col-span-2">
                {(field) => <Textarea {...field} rows={2} dir="auto" />}
              </FormField>
            </div>
            {limit ? <PlanLimitAlert error={limit} /> : null}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {t('common.saveChanges')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
