'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, ExternalLink, History, MoreHorizontal, Play, Plus, Trash2, TriangleAlert, Zap } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import type { Page } from '@typease/types';
import {
  Alert, Badge, Button, Card, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, PageHeader, RequirePermission, Skeleton, StatCard, Switch, cn,
  focusRing, useApi, useI18n, useToast,
} from '@typease/ui';
import { ActionChips, useAutomationLabels } from '@/components/ops/automation';
import { ListSkeleton, Loadable, useRun } from '@/components/ops/common';
import type { AutomationProblem, AutomationRule, AutomationSummary, AutomationTemplate } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';

export function AutomationsList() {
  return (
    <RequirePermission anyOf={['automation.manage']}>
      <Automations />
    </RequirePermission>
  );
}

/** The problems the API found in a rule ("No n8n address is configured"), as one sentence for a toast. */
export const problemsOf = (error: unknown): AutomationProblem[] => {
  if (!isApiError(error)) return [];
  const details = error.details as { problems?: AutomationProblem[] } | undefined;
  return Array.isArray(details?.problems) ? details.problems : [];
};

/** The centre's automations, what they did lately, and ready-made ones to start from. */
function Automations() {
  const { t, tn, formatNumber, formatRelative } = useI18n();
  const api = useApi();
  const router = useRouter();
  const toasts = useToast();
  const labels = useAutomationLabels();
  const { run, busy } = useRun();
  const [deleting, setDeleting] = React.useState<AutomationRule | null>(null);
  const summary = useQuery({ queryKey: opsKeys.automations.summary, queryFn: () => api.client.get<AutomationSummary>('/automations/summary') });
  const rules = useQuery({ queryKey: [...opsKeys.automations.all, 'list'], queryFn: () => api.client.get<Page<AutomationRule>>('/automations', { query: { page: 1, pageSize: 100 } }) });
  const templates = useQuery({ queryKey: opsKeys.automations.templates, queryFn: () => api.client.get<{ available: boolean; templates: AutomationTemplate[] }>('/automations/templates'), staleTime: 10 * 60_000 });
  const invalidate = [opsKeys.automations.all];
  const locked = summary.data?.available === false;
  const counters = summary.data?.executions;

  const planAlert = (
    <Alert
      tone="warning"
      title={t('ops.common.planTitle')}
      className="mb-4"
      action={
        <Button asChild size="sm" variant="outline">
          <Link href="/subscription">{t('ops.common.openSubscription')}</Link>
        </Button>
      }
    >
      {t('ops.automations.planText')}
    </Alert>
  );

  /** Switching on is refused when the rule cannot run (a missing role, no n8n address): the reason is shown. */
  const toggle = (rule: AutomationRule, on: boolean) =>
    run(`toggle-${rule.id}`, () => api.client.post<AutomationRule>(`/automations/${rule.id}/${on ? 'enable' : 'disable'}`), {
      success: t(on ? 'ops.automations.enabled' : 'ops.automations.disabled'),
      description: rule.name,
      invalidate,
      onError: (error) => {
        const problems = problemsOf(error);
        if (!problems.length) return false;
        toasts.error(problems.map((p) => p.message).join(' '));
        return true;
      },
    });

  const startFrom = (template: AutomationTemplate) =>
    run(`template-${template.key}`, () => api.client.post<AutomationRule>(`/automations/from-template/${template.key}`, {}), {
      success: t('ops.automations.createdFromTemplate'),
      description: t('ops.automations.createdFromTemplateText'),
      invalidate,
    }).then((created) => {
      if (created) router.push(`/automations/${created.id}`);
    });

  const newButton = locked ? undefined : (
    <Button asChild variant="accent">
      <Link href="/automations/new">
        <Plus aria-hidden="true" />
        {t('ops.automations.new')}
      </Link>
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t('ops.automations.title')}
        description={t('ops.automations.description')}
        action={newButton}
        secondary={
          <Button asChild variant="outline">
            <Link href="/automations/executions">
              <History aria-hidden="true" />
              {t('ops.automations.log.title')}
            </Link>
          </Button>
        }
      />
      {locked ? planAlert : null}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('ops.automations.stats.enabled')} value={formatNumber(summary.data?.rules.enabled ?? 0)} hint={t('ops.automations.stats.ofTotal', { total: formatNumber(summary.data?.rules.total ?? 0) })} icon={<Zap />} tone="brand" loading={summary.isPending} />
        <StatCard label={t('ops.automations.stats.runs24h')} value={formatNumber(counters?.last24h.total ?? 0)} hint={t('ops.automations.stats.succeeded', { count: formatNumber(counters?.last24h.succeeded ?? 0) })} icon={<Play />} tone="info" loading={summary.isPending} href="/automations/executions" />
        <StatCard label={t('ops.automations.stats.failed7d')} value={formatNumber((counters?.last7d.failed ?? 0) + (counters?.last7d.deadLetter ?? 0))} icon={<TriangleAlert />} tone={(counters?.last7d.failed ?? 0) + (counters?.last7d.deadLetter ?? 0) > 0 ? 'warning' : 'neutral'} loading={summary.isPending} href="/automations/executions?status=FAILED" />
        <StatCard label={t('ops.automations.stats.deadLetters')} value={formatNumber(summary.data?.deadLetters.open ?? 0)} hint={t('ops.automations.stats.deadLettersHint')} icon={<CircleAlert />} tone={(summary.data?.deadLetters.open ?? 0) > 0 ? 'danger' : 'neutral'} loading={summary.isPending} href="/automations/executions?status=DEAD_LETTER" />
      </div>

      <Card>
        <div className="border-b px-5 py-3.5">
          <h2 className="text-md font-semibold">{t('ops.automations.yours')}</h2>
        </div>
        <Loadable query={rules} skeleton={<div className="p-5"><ListSkeleton rows={3} /></div>}>
          {(page) =>
            page.data.length === 0 ? (
              <EmptyState icon={<Zap />} title={t('ops.automations.emptyTitle')} description={t(locked ? 'ops.automations.planText' : 'ops.automations.emptyText')} action={newButton} />
            ) : (
              <ul className="divide-y">
                {page.data.map((rule) => (
                  <li key={rule.id} className="grid grid-cols-1 gap-x-6 gap-y-3 px-5 py-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] lg:items-center">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <Link href={`/automations/${rule.id}`} className={cn('rounded-sm font-medium text-secondary-text hover:underline', focusRing)} dir="auto">
                          {rule.name}
                        </Link>
                        <Badge tone={rule.isEnabled ? 'success' : 'neutral'}>{t(rule.isEnabled ? 'ops.common.enabled' : 'ops.common.disabled')}</Badge>
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">{t('ops.automations.whenLine', { trigger: labels.trigger(rule.triggerEvent, rule.triggerLabel) })}</p>
                      <ActionChips actions={rule.actions} className="mt-2" />
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {rule.stats && rule.stats.total > 0 ? (
                        <>
                          <p className="font-medium text-foreground">{tn('ops.automations.runs', rule.stats.total)}</p>
                          <p>
                            {rule.stats.lastExecutionAt ? t('ops.automations.lastRun', { when: formatRelative(rule.stats.lastExecutionAt) }) : null}
                            {rule.stats.failed + rule.stats.deadLetter > 0 ? ` · ${t('ops.automations.failedCount', { count: formatNumber(rule.stats.failed + rule.stats.deadLetter) })}` : ''}
                          </p>
                        </>
                      ) : (
                        <p>{t('ops.automations.neverRan')}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 lg:justify-end">
                      <Switch
                        checked={rule.isEnabled}
                        disabled={busy !== null || (locked && !rule.isEnabled)}
                        aria-label={t('ops.automations.switchLabel', { name: rule.name })}
                        onCheckedChange={(on) => void toggle(rule, on)}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`${t('common.moreActions')}: ${rule.name}`}>
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem asChild>
                            <Link href={`/automations/${rule.id}`}>
                              <ExternalLink aria-hidden="true" />
                              {t('common.open')}
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href={`/automations/executions?ruleId=${rule.id}`}>
                              <History aria-hidden="true" />
                              {t('ops.automations.log.title')}
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem destructive onSelect={() => setDeleting(rule)}>
                            <Trash2 aria-hidden="true" />
                            {t('common.delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
        </Loadable>
      </Card>

      <section aria-labelledby="auto-templates" className="mt-8">
        <h2 id="auto-templates" className="text-lg font-semibold">
          {t('ops.automations.templatesTitle')}
        </h2>
        <p className="mt-1 text-base text-muted-foreground">{t('ops.automations.templatesText')}</p>
        <div className="mt-4">
          <Loadable query={templates} skeleton={<Skeleton className="h-48 w-full" />}>
            {(data) => (
              <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {data.templates.map((template) => (
                  <li key={template.key}>
                    <Card className="flex h-full flex-col p-5">
                      <p>
                        <Badge tone="neutral">{labels.category(template.category)}</Badge>
                      </p>
                      <h3 className="mt-2 text-md font-semibold">{labels.templateName(template.key, template.name)}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">{labels.templateText(template.key, template.description)}</p>
                      <p className="mt-3 text-sm">{t('ops.automations.whenLine', { trigger: labels.trigger(template.triggerEvent, template.triggerLabel) })}</p>
                      <ActionChips actions={template.actions} className="mt-2 flex-1 content-start" />
                      {template.requires ? (
                        <p className="mt-3 rounded-md bg-warning-soft px-3 py-2 text-sm text-foreground">{template.key === 'send-new-requests-to-n8n' ? t('ops.automations.requiresN8n') : template.requires}</p>
                      ) : null}
                      <Button variant="outline" className="mt-4 self-start" disabled={locked || busy !== null} loading={busy === `template-${template.key}`} loadingText={t('common.loading')} onClick={() => void startFrom(template)}>
                        {t('ops.automations.useTemplate')}
                      </Button>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </Loadable>
        </div>
      </section>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('ops.automations.deleteTitle', { name: deleting?.name ?? '' })}
        description={t('ops.automations.deleteText')}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          await run('delete', () => api.client.delete(`/automations/${deleting!.id}`), { success: t('ops.automations.deleted'), invalidate, rethrow: true });
        }}
      />
    </>
  );
}
