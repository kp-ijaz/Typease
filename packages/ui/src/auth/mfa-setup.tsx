'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, ShieldCheck, ShieldOff } from 'lucide-react';
import { mfaDisableSchema } from '@typease/validation';
import type { MfaSetup } from '@typease/api-client';
import { useI18n } from '../i18n/provider';
import { useApi, useSession } from '../providers/auth';
import { useBranding } from '../providers/branding';
import { describeError } from '../lib/errors';
import { Alert } from '../components/alert';
import { Badge } from '../components/badge';
import { Button } from '../components/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/dialog';
import { CopyButton } from '../components/display';
import { PasswordInput } from '../components/fields';
import { Form, FormError, FormField, useZodForm } from '../components/form';
import { Input } from '../components/input';
import { Label } from '../components/label';
import { QrCode } from '../components/qr-code';
import { useToast } from '../components/toast';
import { CodeInput } from './layout';

/**
 * The API issues the authenticator link with the issuer "TypEase". The issuer is only a label (it is not
 * part of the secret or of the code calculation), so in a white-label app the link is rewritten to carry
 * the centre's name: that is what the person then sees in the authenticator app, next to their email.
 */
export function otpauthUrlFor(otpauthUrl: string, brand: string): string {
  const match = /^otpauth:\/\/(totp|hotp)\/([^?]*)\?(.*)$/.exec(otpauthUrl);
  const issuer = brand.trim().replace(/:/g, ' ');
  if (!match || !issuer) return otpauthUrl;
  const [, type, label, query] = match;
  const decoded = (() => {
    try {
      return decodeURIComponent(label);
    } catch {
      return label;
    }
  })();
  const account = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1).trim() : decoded;
  const params = new URLSearchParams(query);
  if (params.get('issuer') === issuer) return otpauthUrl;
  params.set('issuer', issuer);
  // URLSearchParams writes spaces as "+", which some authenticator apps show literally.
  return `otpauth://${type}/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${params.toString().replace(/\+/g, '%20')}`;
}

/** "Al Noor Typing Centre" -> "al-noor-typing-centre"; Arabic and other scripts are kept. */
const fileSlug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'account';

export interface MfaSetupPanelProps {
  /** The role requires two-step verification: explain why the person landed here. */
  required?: boolean;
  /** Called after the recovery codes were acknowledged (continue to the app). */
  onCompleted?: () => void;
}

/**
 * Two-step verification with an authenticator app (TOTP).
 *
 *  Off -> "Start setup" -> scan the QR code (or type the key) -> enter a code
 *  -> recovery codes are shown once -> On.
 *
 * The QR code is drawn in the browser by the built-in encoder (lib/qr.ts): the
 * secret is never sent to a third-party QR service.
 */
export function MfaSetupPanel({ required, onCompleted }: MfaSetupPanelProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApi();
  const session = useSession();
  const toasts = useToast();
  // What the authenticator app and the instructions call this account: the centre in a white-label app.
  const { brandName } = useBranding();
  const enabled = !!session.user?.mfaEnabled;
  const [setup, setSetup] = React.useState<MfaSetup | null>(null);
  const [code, setCode] = React.useState('');
  const [codeError, setCodeError] = React.useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = React.useState(false);
  const codeId = React.useId();

  const start = useMutation({ mutationFn: () => api.auth.mfaSetup(), onSuccess: setSetup, onError: (e) => toasts.error(e) });
  const enable = useMutation({
    mutationFn: () => api.auth.mfaEnable(code),
    onSuccess: async (r) => {
      setRecoveryCodes(r.recoveryCodes);
      setSetup(null);
      setCode('');
      await session.reload();
    },
    onError: (e) => {
      setCodeError(describeError(e, i18n));
      setCode('');
    },
  });

  const downloadCodes = () => {
    if (!recoveryCodes) return;
    const blob = new Blob([`${t('auth.mfaSetup.recoveryFileTitle', { brand: brandName })} (${session.user?.email ?? ''})\n\n${recoveryCodes.join('\n')}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileSlug(brandName)}-recovery-codes.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  if (recoveryCodes) {
    return (
      <div className="space-y-5">
        <Alert tone="success" title={t('auth.mfaSetup.enabledTitle')} />
        <div>
          <h3 className="text-md font-semibold">{t('auth.mfaSetup.recoveryTitle')}</h3>
          <p className="mt-1 max-w-prose text-base text-muted-foreground">{t('auth.mfaSetup.recoveryText')}</p>
        </div>
        <ul dir="ltr" className="grid max-w-md grid-cols-2 gap-2 rounded-lg border bg-muted/50 p-4 font-mono text-base">
          {recoveryCodes.map((c) => (
            <li key={c} className="tabular">
              {c}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <CopyButton value={recoveryCodes.join('\n')} label={t('auth.mfaSetup.copyCodes')} showLabel variant="outline" size="md" />
          <Button variant="outline" onClick={downloadCodes}>
            <Download aria-hidden="true" />
            {t('auth.mfaSetup.downloadCodes')}
          </Button>
          <Button
            onClick={() => {
              setRecoveryCodes(null);
              onCompleted?.();
            }}
          >
            {t('auth.mfaSetup.savedCodes')}
          </Button>
        </div>
      </div>
    );
  }

  if (enabled) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <ShieldCheck className="size-6 text-success-text" aria-hidden="true" />
          <p className="text-base">{t('auth.mfaSetup.subtitle')}</p>
          <Badge tone="success">{t('auth.mfaSetup.statusOn')}</Badge>
        </div>
        <Button variant="destructive-outline" onClick={() => setDisableOpen(true)}>
          <ShieldOff aria-hidden="true" />
          {t('auth.mfaSetup.disable')}
        </Button>
        <DisableMfaDialog open={disableOpen} onOpenChange={setDisableOpen} />
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="space-y-4">
        {required ? <Alert tone="warning">{t('auth.mfaSetup.requiredNotice')}</Alert> : null}
        <div className="flex flex-wrap items-center gap-3">
          <p className="max-w-prose text-base text-muted-foreground">{t('auth.mfaSetup.subtitle')}</p>
          <Badge tone="neutral">{t('auth.mfaSetup.statusOff')}</Badge>
        </div>
        <Button onClick={() => start.mutate()} loading={start.isPending} loadingText={t('common.loading')}>
          {t('auth.mfaSetup.start')}
        </Button>
      </div>
    );
  }

  const steps: Array<{ title: string; text: string; body?: React.ReactNode }> = [
    { title: t('auth.mfaSetup.step1'), text: t('auth.mfaSetup.step1Text') },
    {
      title: t('auth.mfaSetup.step2'),
      text: t('auth.mfaSetup.step2Text'),
      body: (
        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="w-fit rounded-lg border bg-white p-2">
            <QrCode value={otpauthUrlFor(setup.otpauthUrl, brandName)} size={176} label={t('auth.mfaSetup.qrAlt', { brand: brandName })} />
          </div>
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm font-medium">{t('auth.mfaSetup.secret')}</p>
            <div className="flex items-center gap-1.5">
              <code dir="ltr" className="tabular break-all rounded-md border bg-muted/60 px-2.5 py-1.5 font-mono text-base">
                {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
              </code>
              <CopyButton value={setup.secret} label={`${t('common.copy')}: ${t('auth.mfaSetup.secret')}`} />
            </div>
          </div>
        </div>
      ),
    },
    {
      title: t('auth.mfaSetup.step3'),
      text: t('auth.mfaSetup.step3Text', { brand: brandName }),
      body: (
        <form
          noValidate
          className="mt-3 max-w-xs space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length !== 6) return setCodeError(t('validation.otp'));
            setCodeError(null);
            enable.mutate();
          }}
        >
          <Label htmlFor={codeId} className="sr-only">
            {t('auth.mfa.code')}
          </Label>
          <CodeInput id={codeId} value={code} onChange={setCode} aria-invalid={!!codeError} aria-describedby={codeError ? `${codeId}-e` : undefined} />
          {codeError ? (
            <p id={`${codeId}-e`} role="alert" className="text-sm text-destructive-text">
              {codeError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={enable.isPending} loadingText={t('common.loading')}>
              {t('auth.mfaSetup.enable')}
            </Button>
            <Button variant="ghost" onClick={() => setSetup(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ),
    },
  ];

  return (
    <ol className="space-y-6">
      {steps.map((step, index) => (
        <li key={step.title} className="flex gap-4">
          <span aria-hidden="true" className="tabular flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary-soft text-sm font-semibold text-secondary-text">
            {i18n.formatNumber(index + 1)}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-md font-semibold leading-7">{step.title}</h3>
            <p className="max-w-prose text-base text-muted-foreground">{step.text}</p>
            {step.body}
          </div>
        </li>
      ))}
    </ol>
  );
}

function DisableMfaDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const api = useApi();
  const session = useSession();
  const toasts = useToast();
  const form = useZodForm(mfaDisableSchema, { defaultValues: { password: '', code: '' } });
  React.useEffect(() => {
    if (open) form.reset();
  }, [open, form]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            await api.auth.mfaDisable(values);
            await session.reload();
            toasts.success(t('auth.mfaSetup.disabled'));
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('auth.mfaSetup.disableTitle')}</DialogTitle>
            <DialogDescription>{t('auth.mfaSetup.disableText')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <FormField name="password" label={t('auth.password')} required>
              {(field) => <PasswordInput {...field} autoComplete="current-password" dir="ltr" />}
            </FormField>
            <FormField name="code" label={t('auth.mfa.code')} required hint={t('auth.mfa.recoveryHint')}>
              {(field) => <Input {...field} autoComplete="one-time-code" spellCheck={false} dir="ltr" className="font-mono" />}
            </FormField>
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" loading={form.formState.isSubmitting} loadingText={t('common.loading')}>
              {t('auth.mfaSetup.disable')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
