'use client';

import * as React from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, Smartphone } from 'lucide-react';
import { language, trimmed, z } from '@typease/validation';
import type { AuthSessionRow } from '@typease/api-client';
import { useI18n } from '../i18n/provider';
import { useApi, useSession } from '../providers/auth';
import { describeError } from '../lib/errors';
import { Alert } from '../components/alert';
import { Badge } from '../components/badge';
import { Button } from '../components/button';
import { ConfirmDialog } from '../components/confirm-dialog';
import { Form, FormActions, FormError, FormField, useZodForm } from '../components/form';
import { Input } from '../components/input';
import { Select } from '../components/select';
import { Skeleton } from '../components/skeleton';
import { useToast } from '../components/toast';

/** "Chrome on Windows" from a user-agent string; good enough to recognise your own devices. */
export function describeUserAgent(ua: string | null | undefined): { name: string; mobile: boolean } | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /Dart|okhttp|CFNetwork/i.test(ua) ? 'App' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  if (!browser && !os) return null;
  return { name: [browser, os].filter(Boolean).join(', '), mobile: /Android|iPhone|iPad|Mobile/.test(ua) };
}

const KEY = ['auth', 'sessions'] as const;
/** The current device plus the ten most recently used others. */
const FIRST = 11;
const STEP = 20;
/** The API never lists more than this. */
const MAX = 100;

/**
 * Where the account is signed in: this device first, then the most recently used ones (ten, "Show
 * more" asks for more, the API lists at most 100), how many there are in all, "sign out" per device
 * and "sign out all other devices" (which also ends the ones that are not listed).
 */
export function SessionsPanel() {
  const i18n = useI18n();
  const { t, tn, formatRelative, formatNumber } = i18n;
  const api = useApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const [limit, setLimit] = React.useState(FIRST);
  const sessions = useQuery({ queryKey: [...KEY, limit], queryFn: () => api.auth.sessionsPage({ limit }), placeholderData: keepPreviousData });
  const [target, setTarget] = React.useState<AuthSessionRow | null>(null);
  const [othersOpen, setOthersOpen] = React.useState(false);

  const revoke = useMutation({
    mutationFn: (id: string) => api.auth.revokeSession(id),
    onSuccess: () => {
      toasts.success(t('auth.sessions.revoked'));
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toasts.error(e),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api.auth.revokeOtherSessions(),
    onSuccess: (r) => {
      toasts.success(tn('auth.sessions.revokedOthers', r.revoked));
      setLimit(FIRST);
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toasts.error(e),
  });

  if (sessions.isPending) {
    return (
      <div className="space-y-3" role="status" aria-label={t('common.loading')}>
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }
  if (sessions.isError) {
    return (
      <Alert tone="danger" action={<Button size="sm" variant="outline" onClick={() => void sessions.refetch()}>{t('common.retry')}</Button>}>
        {describeError(sessions.error, i18n)}
      </Alert>
    );
  }

  // This device first, whatever the API's order; then the most recently used.
  const rows = [...sessions.data.sessions].sort((a, b) => Number(b.current) - Number(a.current) || b.lastUsedAt.localeCompare(a.lastUsedAt));
  const total = Math.max(sessions.data.total, rows.length);
  const others = total - (rows.some((r) => r.current) ? 1 : 0);
  const hidden = total - rows.length;
  const canShowMore = hidden > 0 && limit < MAX;

  return (
    <div className="space-y-4">
      <ul className="divide-y rounded-lg border" aria-busy={sessions.isFetching}>
        {rows.map((row) => {
          const device = describeUserAgent(row.userAgent);
          const Icon = device?.mobile || row.app === 'mobile' ? Smartphone : Laptop;
          return (
            <li key={row.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
              <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1 basis-48">
                <p className="flex flex-wrap items-center gap-2 text-base font-medium text-foreground">
                  <span dir="ltr">{row.deviceName ?? device?.name ?? t('auth.sessions.unknownDevice')}</span>
                  {row.current ? <Badge tone="success">{t('auth.sessions.current')}</Badge> : null}
                  {row.supportSession ? <Badge tone="warning">{t('auth.sessions.supportSession')}</Badge> : null}
                </p>
                <p className="text-sm text-muted-foreground">
                  {i18n.has(`auth.sessions.app.${row.app}`) ? t(`auth.sessions.app.${row.app}`) : row.app}
                  <span aria-hidden="true"> – </span>
                  {t('auth.sessions.lastUsed', { time: formatRelative(row.lastUsedAt) })}
                  {row.ip ? (
                    <>
                      <span aria-hidden="true"> – </span>
                      <span className="ltr-value">{row.ip}</span>
                    </>
                  ) : null}
                </p>
              </div>
              {row.current ? null : (
                <Button variant="outline" size="sm" onClick={() => setTarget(row)}>
                  {t('auth.sessions.revoke')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {hidden > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {canShowMore ? t('auth.sessions.showing', { shown: formatNumber(rows.length), total: formatNumber(total) }) : t('auth.sessions.capped', { shown: formatNumber(rows.length) })}
          </p>
          {canShowMore ? (
            <Button variant="outline" size="sm" loading={sessions.isFetching} onClick={() => setLimit((n) => Math.min(MAX, n + STEP))}>
              {t('auth.sessions.showMore')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {others > 0 ? (
        <Button variant="destructive-outline" onClick={() => setOthersOpen(true)}>
          {t('auth.sessions.revokeOthers')}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">{t('auth.sessions.empty')}</p>
      )}

      <ConfirmDialog
        open={!!target}
        onOpenChange={(open) => !open && setTarget(null)}
        title={t('auth.sessions.revokeTitle')}
        description={t('auth.sessions.revokeText')}
        confirmLabel={t('auth.sessions.revoke')}
        onConfirm={async () => {
          if (target) await revoke.mutateAsync(target.id);
        }}
      />
      <ConfirmDialog
        open={othersOpen}
        onOpenChange={setOthersOpen}
        title={t('auth.sessions.revokeOthersTitle')}
        // Says how many, including the ones the list does not show.
        description={`${tn('auth.sessions.revokeOthersCount', others)} ${t('auth.sessions.revokeOthersText')}`}
        confirmLabel={t('auth.sessions.revokeOthers')}
        onConfirm={async () => {
          await revokeOthers.mutateAsync();
        }}
      />
    </div>
  );
}

const profileSchema = z.object({ fullName: trimmed(120, 2), preferredLanguage: language });

/** Name and the language of messages. The email address is the sign-in name and is shown read-only. */
export function ProfileForm() {
  const { t, setLocale } = useI18n();
  const api = useApi();
  const session = useSession();
  const toasts = useToast();
  const user = session.user;
  const form = useZodForm(profileSchema, { defaultValues: { fullName: user?.fullName ?? '', preferredLanguage: (user?.preferredLanguage as 'en' | 'ar') ?? 'en' } });
  React.useEffect(() => {
    if (user) form.reset({ fullName: user.fullName, preferredLanguage: (user.preferredLanguage as 'en' | 'ar') ?? 'en' });
  }, [user, form]);
  return (
    <Form
      form={form}
      className="max-w-md"
      onSubmit={async (values) => {
        await api.auth.updateProfile(values);
        await session.reload();
        // The interface follows the language the person just chose for themselves.
        setLocale(values.preferredLanguage);
        toasts.success(t('auth.profile.saved'));
      }}
    >
      <FormField name="fullName" label={t('auth.fullName')} required>
        {(field) => <Input {...field} autoComplete="name" />}
      </FormField>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t('auth.email')}</p>
        <p className="ltr-value block rounded-md border bg-muted/60 px-3 py-2 text-base">{user?.email}</p>
        <p className="text-sm text-muted-foreground">{t('auth.profile.emailReadonly')}</p>
      </div>
      <FormField name="preferredLanguage" label={t('auth.profile.preferredLanguage')} required>
        {(field) => (
          <Select
            {...field}
            onValueChange={field.onChange}
            options={[
              { value: 'en', label: 'English' },
              { value: 'ar', label: 'العربية' },
            ]}
          />
        )}
      </FormField>
      <FormError />
      <FormActions className="sm:justify-start">
        <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
          {t('common.saveChanges')}
        </Button>
      </FormActions>
    </Form>
  );
}
