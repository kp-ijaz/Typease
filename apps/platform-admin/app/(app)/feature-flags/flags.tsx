'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Building2, Flag, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { featureFlagKey } from '@typease/validation';
import {
  Badge, Button, Card, ChoiceLabel, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  EmptyState, Form, FormError, FormField, Input, PageHeader, RequirePermission, Select, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, Switch, Table, TableBody,
  TableCaption, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger, useI18n, useToast, useZodForm,
} from '@typease/ui';
import { CentreCell, Code, ConfirmAction, Field, LoadError, RelativeTime, RowsSkeleton, useUrlState } from '@/components/shared';
import { TenantPicker, type PickedTenant } from '@/components/tenant-picker';
import { usePlatformApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { FeatureFlag } from '@/lib/types';
import { PlatformSettings } from './settings';

const descriptionOf = (flag: Pick<FeatureFlag, 'payload'>) => (typeof flag.payload?.description === 'string' ? flag.payload.description : '');

export function FeatureFlags() {
  return (
    <RequirePermission anyOf={['platform.features.manage']}>
      <FlagsScreen />
    </RequirePermission>
  );
}

function FlagsScreen() {
  const { t } = useI18n();
  const [tab, setTab] = useUrlState('tab', 'flags');
  const [creating, setCreating] = React.useState(false);
  const current = tab === 'settings' ? 'settings' : 'flags';
  return (
    <>
      <PageHeader
        title={t('nav.flags')}
        description={t('flags.description')}
        action={
          current === 'flags' ? (
            <Button variant="accent" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {t('flags.create.action')}
            </Button>
          ) : undefined
        }
      />
      <Tabs value={current} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="flags">{t('flags.tabs.flags')}</TabsTrigger>
          <TabsTrigger value="settings">{t('flags.tabs.settings')}</TabsTrigger>
        </TabsList>
        <TabsContent value="flags">{current === 'flags' ? <FlagsList onCreate={() => setCreating(true)} /> : null}</TabsContent>
        <TabsContent value="settings">{current === 'settings' ? <PlatformSettings /> : null}</TabsContent>
      </Tabs>
      <FlagDialog target={creating ? 'new' : null} onClose={() => setCreating(false)} />
    </>
  );
}

/**
 * Global feature flags (GET /platform/feature-flags). A flag's default applies to every
 * centre without its own setting; a centre's own setting wins; no row at all means "off".
 */
function FlagsList({ onCreate }: { onCreate: () => void }) {
  const { t, tn } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const flags = useQuery({ queryKey: keys.flags.all, queryFn: ({ signal }) => api.flags.list(signal) });
  const [toggle, setToggle] = React.useState<{ flag: FeatureFlag; enabled: boolean } | null>(null);
  const [removing, setRemoving] = React.useState<FeatureFlag | null>(null);
  const [editing, setEditing] = React.useState<FeatureFlag | null>(null);
  const [overridesOf, setOverridesOf] = React.useState<string | null>(null);
  const refresh = () => Promise.all([keys.flags.all, keys.tenants.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));

  if (flags.isPending) return <Card><RowsSkeleton rows={5} /></Card>;
  if (flags.isError) return <LoadError lead={t('flags.loadError')} error={flags.error} onRetry={() => void flags.refetch()} />;

  return (
    <>
      {flags.data.length === 0 ? (
        <Card>
          <EmptyState
            size="page"
            icon={<Flag />}
            title={t('flags.emptyTitle')}
            description={t('flags.emptyText')}
            action={
              <Button variant="accent" onClick={onCreate}>
                <Plus aria-hidden="true" />
                {t('flags.create.action')}
              </Button>
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableCaption className="sr-only">{t('nav.flags')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t('flags.columns.flag')}</TableHead>
                <TableHead>{t('flags.columns.default')}</TableHead>
                <TableHead>{t('flags.columns.overrides')}</TableHead>
                <TableHead>{t('pc.updated')}</TableHead>
                {/* "relative" keeps the visually hidden label inside the scrolling table: without it the label widens the page on a phone. */}
                <TableHead className="relative">
                  <span className="sr-only">{t('common.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {flags.data.map((flag) => (
                <TableRow key={flag.key}>
                  <TableCell className="min-w-48 sm:min-w-64">
                    <Code>{flag.key}</Code>
                    {descriptionOf(flag) ? (
                      <span className="mt-1 block max-w-xl text-sm text-muted-foreground" dir="auto">
                        {descriptionOf(flag)}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <span className="flex items-center gap-3">
                      <Switch aria-label={t('flags.defaultFor', { flag: flag.key })} checked={flag.enabled} onCheckedChange={(enabled) => setToggle({ flag, enabled })} />
                      <span className="text-base">
                        {flag.enabled ? t('pc.on') : t('pc.off')}
                        {flag.hasGlobalDefault ? null : <span className="block text-sm text-muted-foreground">{t('flags.noDefault')}</span>}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    {flag.overrides.total > 0 ? (
                      <Button variant="link" onClick={() => setOverridesOf(flag.key)}>
                        {tn('flags.overrides.count', flag.overrides.total)}
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">{t('flags.overrides.none')}</span>
                    )}
                    {flag.overrides.total > 0 ? (
                      <span className="mt-0.5 flex flex-wrap gap-1.5">
                        {flag.overrides.enabled > 0 ? <Badge tone="success">{t('flags.overrides.on', { count: flag.overrides.enabled })}</Badge> : null}
                        {flag.overrides.disabled > 0 ? <Badge tone="neutral">{t('flags.overrides.off', { count: flag.overrides.disabled })}</Badge> : null}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{flag.updatedAt ? <RelativeTime value={flag.updatedAt} /> : '–'}</TableCell>
                  <TableCell className="w-12 text-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={t('flags.actionsFor', { flag: flag.key })}>
                          <MoreHorizontal aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setOverridesOf(flag.key)}>
                          <Building2 aria-hidden="true" />
                          {t('flags.overrides.action')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setEditing(flag)}>
                          <Pencil aria-hidden="true" />
                          {t('flags.edit.action')}
                        </DropdownMenuItem>
                        <DropdownMenuItem destructive onSelect={() => setRemoving(flag)}>
                          <Trash2 aria-hidden="true" />
                          {t('flags.delete.action')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <p className="mt-3 text-sm text-muted-foreground">{t('flags.rule')}</p>

      <ConfirmAction
        open={!!toggle}
        onOpenChange={(open) => !open && setToggle(null)}
        tone={toggle?.enabled ? 'default' : 'destructive'}
        title={toggle ? t(toggle.enabled ? 'flags.toggle.onTitle' : 'flags.toggle.offTitle', { flag: toggle.flag.key }) : ''}
        description={toggle ? tn(toggle.enabled ? 'flags.toggle.onText' : 'flags.toggle.offText', toggle.flag.overrides.total) : ''}
        confirmLabel={toggle?.enabled ? t('flags.toggle.on') : t('flags.toggle.off')}
        onConfirm={async () => {
          await api.flags.set(toggle!.flag.key, { enabled: toggle!.enabled });
          await refresh();
          toasts.success(t(toggle!.enabled ? 'flags.toggle.onDone' : 'flags.toggle.offDone', { flag: toggle!.flag.key }));
        }}
      />
      <ConfirmAction
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('flags.delete.title', { flag: removing?.key ?? '' })}
        description={removing ? tn('flags.delete.text', removing.overrides.total) : ''}
        confirmLabel={t('flags.delete.action')}
        typedConfirmation={removing?.key}
        onConfirm={async () => {
          await api.flags.remove(removing!.key);
          await refresh();
          toasts.success(t('flags.delete.done', { flag: removing!.key }));
        }}
      />
      <FlagDialog target={editing} onClose={() => setEditing(null)} />
      <OverridesSheet flag={overridesOf} onClose={() => setOverridesOf(null)} />
    </>
  );
}

// ---------------------------------------------------------------- create / describe

function FlagDialog({ target, onClose }: { target: FeatureFlag | 'new' | null; onClose: () => void }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const existing = target && target !== 'new' ? target : null;
  // The key rule is the shared one (featureFlagKey); only its message is worded here, in the reader's language.
  const schema = React.useMemo(
    () =>
      z.object({
        key: z.string().trim().refine((value) => featureFlagKey.safeParse(value).success, t('flags.create.keyInvalid')),
        description: z.string().trim().max(300).optional(),
        enabled: z.boolean(),
      }),
    [t],
  );
  const form = useZodForm(schema, { defaultValues: { key: '', description: '', enabled: false } });
  React.useEffect(() => {
    if (target) form.reset(existing ? { key: existing.key, description: descriptionOf(existing), enabled: existing.enabled } : { key: '', description: '', enabled: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && !form.formState.isSubmitting && onClose()}>
      <DialogContent>
        <Form
          form={form}
          className="flex min-h-0 flex-1 flex-col space-y-0"
          onSubmit={async (values) => {
            // The description travels in the flag's payload; other payload entries are kept.
            const payload = { ...(existing?.payload ?? {}), description: values.description ?? '' };
            await api.flags.set(values.key, { enabled: existing ? existing.enabled : values.enabled, payload });
            await Promise.all([keys.flags.all, keys.tenants.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
            toasts.success(t(existing ? 'flags.edit.done' : 'flags.create.done', { flag: values.key }));
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>{existing ? t('flags.edit.title', { flag: existing.key }) : t('flags.create.title')}</DialogTitle>
            <DialogDescription>{existing ? t('flags.edit.text') : t('flags.create.text')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            {existing ? null : (
              <FormField name="key" label={t('flags.create.key')} required hint={t('flags.create.keyHint')}>
                {(field) => <Input {...field} autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" className="font-mono" placeholder="new_quotation_editor" autoFocus />}
              </FormField>
            )}
            <FormField name="description" label={t('flags.create.descriptionLabel')} optional hint={t('flags.create.descriptionHint')}>
              {(field) => <Input {...field} autoComplete="off" dir="auto" maxLength={300} />}
            </FormField>
            {existing ? null : (
              <FormField name="enabled" label={t('flags.columns.default')}>
                {(field) => (
                  <ChoiceLabel
                    htmlFor={field.id}
                    control={<Switch id={field.id} ref={field.ref} checked={!!field.value} onCheckedChange={field.onChange} />}
                    label={field.value ? t('flags.create.startOn') : t('flags.create.startOff')}
                    description={t('flags.create.startHint')}
                  />
                )}
              </FormField>
            )}
            <FormError />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={form.formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting} loadingText={t('common.saving')}>
              {existing ? t('common.saveChanges') : t('flags.create.submit')}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- overrides

/** The centres that have their own setting for a flag, and a way to add one. */
function OverridesSheet({ flag, onClose }: { flag: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const api = usePlatformApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const overrides = useQuery({ queryKey: keys.flags.overrides(flag ?? ''), queryFn: ({ signal }) => api.flags.overrides(flag as string, signal), enabled: !!flag });
  const [centre, setCentre] = React.useState<PickedTenant | null>(null);
  const [value, setValue] = React.useState<'on' | 'off'>('on');
  const [change, setChange] = React.useState<{ centre: { id: string; name: string }; to: 'on' | 'off' | 'default' } | null>(null);
  React.useEffect(() => {
    if (flag) {
      setCentre(null);
      setValue('on');
    }
  }, [flag]);
  const refresh = () => Promise.all([keys.flags.all, keys.tenants.all, keys.audit.all].map((queryKey) => queryClient.invalidateQueries({ queryKey })));

  return (
    <>
      <Sheet open={!!flag} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="end" className="w-[min(36rem,96vw)]">
          <SheetHeader>
            <SheetTitle>{t('flags.overrides.title')}</SheetTitle>
            <SheetDescription>
              <Code>{flag}</Code> · {t('flags.overrides.text')}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            <section className="space-y-3 rounded-lg border p-4" aria-label={t('flags.overrides.add')}>
              <h3 className="text-md font-semibold text-foreground">{t('flags.overrides.add')}</h3>
              <Field label={t('pc.centre')} htmlFor="override-centre">
                <TenantPicker id="override-centre" value={centre?.id} selectedLabel={centre?.name} onChange={(_, picked) => setCentre(picked)} />
              </Field>
              <div className="flex flex-wrap items-end gap-3">
                <Field label={t('flags.overrides.setting')} htmlFor="override-value" className="min-w-40 flex-1">
                  <Select
                    id="override-value"
                    value={value}
                    onValueChange={(next) => setValue(next as 'on' | 'off')}
                    options={[
                      { value: 'on', label: t('flags.tenant.alwaysOn') },
                      { value: 'off', label: t('flags.tenant.alwaysOff') },
                    ]}
                  />
                </Field>
                <Button disabled={!centre} onClick={() => centre && setChange({ centre, to: value })}>
                  {t('flags.overrides.addAction')}
                </Button>
              </div>
            </section>

            {overrides.isPending ? (
              <RowsSkeleton className="p-0" />
            ) : overrides.isError ? (
              <LoadError error={overrides.error} onRetry={() => void overrides.refetch()} />
            ) : overrides.data.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">{t('flags.overrides.empty')}</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {overrides.data.map((override) => (
                  <li key={override.centre.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
                    <CentreCell centre={override.centre} />
                    <span className="flex items-center gap-2">
                      <Badge tone={override.enabled ? 'success' : 'neutral'} dot>
                        {override.enabled ? t('pc.on') : t('pc.off')}
                      </Badge>
                      <Button size="sm" variant="ghost" onClick={() => setChange({ centre: override.centre, to: 'default' })}>
                        {t('flags.overrides.remove')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>
      <ConfirmAction
        open={!!change}
        onOpenChange={(open) => !open && setChange(null)}
        tone="default"
        title={t('flags.tenant.confirmTitle', { flag: flag ?? '' })}
        description={change ? t(`flags.tenant.confirm.${change.to}`, { name: change.centre.name }) : ''}
        confirmLabel={t('common.saveChanges')}
        onConfirm={async () => {
          if (!flag || !change) return;
          if (change.to === 'default') await api.tenants.clearFlag(change.centre.id, flag);
          else await api.tenants.setFlag(change.centre.id, flag, { enabled: change.to === 'on' });
          await refresh();
          setCentre(null);
          toasts.success(t('flags.tenant.saved', { flag }));
        }}
      />
    </>
  );
}
