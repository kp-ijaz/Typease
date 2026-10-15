'use client';

import * as React from 'react';
import Link from 'next/link';
import { Braces } from 'lucide-react';
import {
  Alert, Button, Checkbox, ChoiceLabel, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Input, Label, RadioGroup, RadioGroupItem, Select, Textarea, useI18n, useSession,
} from '@typease/ui';
import { DocumentTypePicker, StaffPicker, useRoles } from '@/components/pickers';
import { useAutomationLabels } from '@/components/ops/automation';
import { Field, SwitchRow } from '@/components/ops/common';
import type { AutomationMeta, AutomationTrigger } from '@/components/ops/types';

type Config = Record<string, unknown>;
const NONE = '__none__';
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

/** The fields each action type shows: an error on any other path of the action is listed above its form. */
export const ACTION_FIELDS: Record<string, string[]> = {
  create_task: ['title', 'description', 'priority', 'type', 'roleKey', 'dueInHours'],
  create_follow_up: ['title', 'description', 'priority', 'roleKey', 'dueInDays'],
  assign_staff: ['mode', 'membershipId', 'role'],
  send_notification: ['to', 'roleKey', 'channels', 'subject', 'body', 'purpose', 'whatsappTemplateName'],
  schedule_reminder: ['documentTypeKey', 'expiryInDays', 'offsetsDays', 'subjectLabel'],
  generate_document: ['title', 'documentTypeKey', 'customerVisible'],
  update_workflow_state: ['to', 'reason', 'customerMessage'],
  request_approval: ['note'],
  escalate: ['roleKey', 'title', 'message', 'priority', 'dueInHours'],
  call_webhook: ['path', 'url'],
};

/** What a newly added action starts with. */
export function defaultActionConfig(type: string, meta: AutomationMeta, trigger: AutomationTrigger | undefined): Config {
  switch (type) {
    case 'create_task':
      return { title: '', priority: 'NORMAL', type: 'GENERAL' };
    case 'create_follow_up':
      return { title: '', priority: 'NORMAL', dueInDays: 2 };
    case 'assign_staff':
      return { mode: 'AUTO' };
    case 'send_notification':
      return trigger?.hasCustomer === 'NEVER' ? { to: 'ROLE', roleKey: 'manager', channels: ['IN_APP'], subject: '', body: '', purpose: 'SERVICE' } : { to: 'CUSTOMER', channels: ['IN_APP'], subject: '', body: '', purpose: 'SERVICE' };
    case 'generate_document':
      return { documentTypeKey: 'other', customerVisible: false };
    case 'update_workflow_state':
      return { to: meta.automaticStatuses[0]?.status ?? 'UNDER_REVIEW' };
    case 'escalate':
      return { roleKey: 'manager', priority: 'HIGH' };
    case 'call_webhook':
      return { path: '' };
    default:
      return {};
  }
}

/** What is sent to the API: empty optional fields are left out, and fields that do not apply to the chosen mode are dropped. */
export function cleanActionConfig(type: string, config: Config): Config {
  const out: Config = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = typeof value === 'string' ? value.trim() : value;
  }
  if (type === 'assign_staff' && out.mode !== 'MEMBER') return { mode: 'AUTO' };
  if (type === 'send_notification') {
    if (out.to !== 'ROLE') delete out.roleKey;
    if (out.to !== 'CUSTOMER') out.purpose = 'SERVICE';
    if (!Array.isArray(out.channels) || !out.channels.includes('WHATSAPP')) delete out.whatsappTemplateName;
  }
  if (type === 'schedule_reminder' && Array.isArray(out.offsetsDays) && out.offsetsDays.length === 0) delete out.offsetsDays;
  return out;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const numberText = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : '');
const toNumber = (value: string) => (value === '' ? undefined : Math.trunc(Number(value)));

interface Variable {
  key: string;
  description: string;
}

/**
 * A text field that can contain `{{values}}` of the event. "Insert a value" lists
 * the values this trigger provides and puts the chosen one where the cursor was.
 */
function TemplateField({ label, value, onChange, variables, multiline, rows = 3, required, optional, hint, error, maxLength, disabled }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  variables: Variable[];
  multiline?: boolean;
  rows?: number;
  required?: boolean;
  optional?: boolean;
  hint?: string;
  error?: string;
  maxLength?: number;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const labels = useAutomationLabels();
  const caret = React.useRef<number | null>(null);
  const remember = (e: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    caret.current = e.currentTarget.selectionStart;
  };
  const insert = (key: string) => {
    const at = caret.current ?? value.length;
    const token = `{{${key}}}`;
    onChange(`${value.slice(0, at)}${token}${value.slice(at)}`);
    caret.current = at + token.length;
  };
  const id = React.useId();
  const noteId = `${id}-note`;
  const p = { id, 'aria-invalid': !!error, 'aria-describedby': error || hint ? noteId : undefined };
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} required={required} optionalText={optional ? t('common.optional') : undefined}>
        {label}
      </Label>
      {multiline ? (
        <Textarea {...p} rows={rows} dir="auto" value={value} maxLength={maxLength} disabled={disabled} onChange={(e) => onChange(e.target.value)} onSelect={remember} onBlur={remember} />
      ) : (
        <Input {...p} dir="auto" value={value} maxLength={maxLength} disabled={disabled} onChange={(e) => onChange(e.target.value)} onSelect={remember} onBlur={remember} />
      )}
      {/* The note of the field on one side, "Insert a value" on the other: the error stays right under its field. */}
      <div className="flex items-start justify-between gap-3">
        {error ? (
          <p id={noteId} role="alert" className="pt-1 text-sm text-destructive-text">
            {error}
          </p>
        ) : (
          <p id={noteId} className="pt-1 text-sm text-muted-foreground">
            {hint}
          </p>
        )}
        {variables.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" disabled={disabled} className="-me-2 shrink-0">
                <Braces aria-hidden="true" />
                {t('ops.automations.editor.insertValue')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              {variables.map((v) => (
                <DropdownMenuItem key={v.key} onSelect={() => insert(v.key)}>
                  <span className="min-w-0">
                    <span className="block">{labels.variable(v.key, v.description) || v.key}</span>
                    <span className="ltr-value block font-mono text-xs text-muted-foreground">{`{{${v.key}}}`}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

/** One of the centre's staff roles (by key). `optional` adds "No particular role". */
function RoleField({ label, value, onChange, optional, hint, error, disabled }: { label: string; value: string | undefined; onChange: (key: string | undefined) => void; optional?: boolean; hint?: string; error?: string; disabled?: boolean }) {
  const { t } = useI18n();
  const roles = useRoles();
  const list = (roles.data ?? []).filter((r) => r.kind === 'STAFF');
  const options = [
    ...(optional ? [{ value: NONE, label: t('ops.automations.fields.anyRole') }] : []),
    ...list.map((r) => ({ value: r.key, label: r.name })),
    // A role that was removed since the rule was written is still shown, so the person can see what to replace.
    ...(value && !list.some((r) => r.key === value) ? [{ value, label: value }] : []),
  ];
  return (
    <Field label={label} hint={hint} error={error} required={!optional}>
      {(p) => <Select {...p} disabled={disabled || roles.isLoading} value={value ?? (optional ? NONE : null)} onValueChange={(v) => onChange(v === NONE ? undefined : v)} options={options} />}
    </Field>
  );
}

function NumberField({ label, value, onChange, min, max, hint, error, optional, disabled }: { label: string; value: unknown; onChange: (value: number | undefined) => void; min: number; max: number; hint?: string; error?: string; optional?: boolean; disabled?: boolean }) {
  return (
    <Field label={label} hint={hint} error={error} optional={optional}>
      {(p) => <Input {...p} type="number" inputMode="numeric" dir="ltr" className="tabular" min={min} max={max} disabled={disabled} value={numberText(value)} onChange={(e) => onChange(toNumber(e.target.value))} />}
    </Field>
  );
}

export interface ActionConfigProps {
  type: string;
  config: Config;
  onChange: (config: Config) => void;
  /** The message for one field of this action, already in the reader's language. */
  error: (field: string) => string | undefined;
  meta: AutomationMeta;
  trigger: AutomationTrigger | undefined;
  disabled?: boolean;
}

/** The settings of one action. Which fields appear depends on the action type; they mirror the API's schema for that type. */
export function ActionConfig({ type, config, onChange, error, meta, trigger, disabled }: ActionConfigProps) {
  const { t, has } = useI18n();
  const session = useSession();
  const id = React.useId();
  const variables = trigger?.variables ?? [];
  const set = (patch: Config) => {
    const next = { ...config, ...patch };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    onChange(next);
  };
  const priorityOptions = (list: string[]) => list.map((p) => ({ value: p, label: t(`ops.rules.values.${p}`) }));

  switch (type) {
    case 'create_task':
    case 'create_follow_up':
      return (
        <div className="space-y-4">
          <TemplateField label={t('ops.automations.fields.title')} required value={text(config.title)} onChange={(title) => set({ title })} variables={variables} error={error('title')} maxLength={160} disabled={disabled} />
          <TemplateField label={t('ops.automations.fields.description')} optional multiline value={text(config.description)} onChange={(description) => set({ description })} variables={variables} error={error('description')} maxLength={1000} disabled={disabled} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('ops.automations.fields.priority')} error={error('priority')}>
              {(p) => <Select {...p} disabled={disabled} value={text(config.priority) || 'NORMAL'} onValueChange={(priority) => set({ priority })} options={priorityOptions(PRIORITIES)} />}
            </Field>
            {type === 'create_task' ? (
              <Field label={t('ops.automations.fields.taskType')} error={error('type')}>
                {(p) => (
                  <Select
                    {...p}
                    disabled={disabled}
                    value={text(config.type) || 'GENERAL'}
                    onValueChange={(v) => set({ type: v })}
                    options={['GENERAL', 'DOCUMENT_REVIEW', 'APPROVAL'].map((v) => ({ value: v, label: t(`ops.automations.taskTypes.${v}`) }))}
                  />
                )}
              </Field>
            ) : null}
            <RoleField label={t('ops.automations.fields.taskRole')} optional hint={t('ops.automations.fields.taskRoleHint')} value={text(config.roleKey) || undefined} onChange={(roleKey) => set({ roleKey })} error={error('roleKey')} disabled={disabled} />
            {type === 'create_task' ? (
              <NumberField label={t('ops.automations.fields.dueInHours')} optional hint={t('ops.automations.fields.dueInHoursHint')} min={1} max={2160} value={config.dueInHours} onChange={(dueInHours) => set({ dueInHours })} error={error('dueInHours')} disabled={disabled} />
            ) : (
              <NumberField label={t('ops.automations.fields.dueInDays')} hint={t('ops.automations.fields.dueInDaysHint')} min={0} max={365} value={config.dueInDays} onChange={(dueInDays) => set({ dueInDays })} error={error('dueInDays')} disabled={disabled} />
            )}
          </div>
        </div>
      );

    case 'assign_staff': {
      const mode = config.mode === 'MEMBER' ? 'MEMBER' : 'AUTO';
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label id={`${id}-mode`}>{t('ops.automations.fields.assignMode')}</Label>
            <RadioGroup value={mode} disabled={disabled} onValueChange={(v) => onChange(v === 'MEMBER' ? { mode: 'MEMBER', membershipId: text(config.membershipId), role: text(config.role) || 'OPERATOR' } : { mode: 'AUTO' })} aria-labelledby={`${id}-mode`} className="space-y-2">
              <ChoiceLabel htmlFor={`${id}-auto`} control={<RadioGroupItem id={`${id}-auto`} value="AUTO" />} label={t('ops.automations.fields.assignAuto')} description={t('ops.automations.fields.assignAutoHint')} />
              <ChoiceLabel htmlFor={`${id}-member`} control={<RadioGroupItem id={`${id}-member`} value="MEMBER" />} label={t('ops.automations.fields.assignMember')} />
            </RadioGroup>
          </div>
          {mode === 'MEMBER' ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('ops.automations.fields.member')} required error={error('membershipId')}>
                {(p) => <StaffPicker {...p} disabled={disabled} value={text(config.membershipId)} onChange={(membershipId) => set({ membershipId })} />}
              </Field>
              <Field label={t('ops.automations.fields.assignRole')} error={error('role')}>
                {(p) => <Select {...p} disabled={disabled} value={text(config.role) || 'OPERATOR'} onValueChange={(role) => set({ role })} options={['OPERATOR', 'REVIEWER'].map((v) => ({ value: v, label: t(`ops.rules.values.${v}`) }))} />}
              </Field>
            </div>
          ) : null}
        </div>
      );
    }

    case 'send_notification': {
      const to = text(config.to) || 'CUSTOMER';
      const channels = Array.isArray(config.channels) ? (config.channels as string[]) : [];
      const recipients = ['CUSTOMER', 'ASSIGNEE', 'ROLE'].filter((r) => (r === 'CUSTOMER' ? trigger?.hasCustomer !== 'NEVER' : r === 'ASSIGNEE' ? trigger?.hasRequest !== 'NEVER' : true) || r === to);
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('ops.automations.fields.to')} required error={error('to')}>
              {(p) => (
                <Select
                  {...p}
                  disabled={disabled}
                  value={to}
                  onValueChange={(v) => set({ to: v, roleKey: v === 'ROLE' ? text(config.roleKey) || 'manager' : undefined, purpose: v === 'CUSTOMER' ? config.purpose : 'SERVICE' })}
                  options={recipients.map((r) => ({ value: r, label: t(`ops.automations.recipients.${r}`) }))}
                />
              )}
            </Field>
            {to === 'ROLE' ? <RoleField label={t('ops.automations.fields.notifyRole')} hint={t('ops.automations.fields.notifyRoleHint')} value={text(config.roleKey) || undefined} onChange={(roleKey) => set({ roleKey })} error={error('roleKey')} disabled={disabled} /> : null}
          </div>
          <fieldset className="space-y-2" disabled={disabled}>
            <legend className="text-sm font-medium text-foreground">{t('ops.automations.fields.channels')}</legend>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {meta.channels.map((channel) => (
                <ChoiceLabel
                  key={channel}
                  htmlFor={`${id}-${channel}`}
                  control={<Checkbox id={`${id}-${channel}`} checked={channels.includes(channel)} onCheckedChange={(on) => set({ channels: on === true ? [...channels, channel] : channels.filter((c) => c !== channel) })} />}
                  label={t(`ops.notify.channelNames.${channel}`)}
                />
              ))}
            </div>
            {error('channels') ? (
              <p role="alert" className="text-sm text-destructive-text">
                {error('channels')}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{t('ops.automations.fields.channelsHint')}</p>
            )}
          </fieldset>
          <TemplateField label={t('ops.automations.fields.subject')} hint={t('ops.automations.fields.subjectHint')} value={text(config.subject)} onChange={(subject) => set({ subject })} variables={variables} error={error('subject')} maxLength={200} disabled={disabled} />
          <TemplateField label={t('ops.automations.fields.body')} required multiline rows={5} hint={t('ops.automations.fields.bodyHint')} value={text(config.body)} onChange={(body) => set({ body })} variables={variables} error={error('body')} maxLength={2000} disabled={disabled} />
          {channels.includes('WHATSAPP') ? (
            <Field label={t('ops.notify.templates.whatsappName')} hint={t('ops.notify.templates.whatsappHint')} error={error('whatsappTemplateName')}>
              {(p) => <Input {...p} dir="ltr" className="font-mono text-sm" spellCheck={false} disabled={disabled} value={text(config.whatsappTemplateName)} onChange={(e) => set({ whatsappTemplateName: e.target.value })} />}
            </Field>
          ) : null}
          {to === 'CUSTOMER' ? (
            <div>
              <SwitchRow label={t('ops.automations.fields.marketing')} description={t('ops.automations.fields.marketingHint')} disabled={disabled} checked={config.purpose === 'MARKETING'} onCheckedChange={(on) => set({ purpose: on ? 'MARKETING' : 'SERVICE' })} />
              {error('purpose') ? (
                <p role="alert" className="mt-1 text-sm text-destructive-text">
                  {error('purpose')}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    }

    case 'schedule_reminder': {
      const offsets = Array.isArray(config.offsetsDays) ? (config.offsetsDays as number[]).join(', ') : '';
      return (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('ops.automations.notes.reminder')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('ops.automations.fields.documentType')} optional hint={t('ops.automations.fields.documentTypeHint')} error={error('documentTypeKey')}>
              {(p) => <DocumentTypePicker {...p} clearable disabled={disabled} value={text(config.documentTypeKey)} onChange={(key) => set({ documentTypeKey: key || undefined })} />}
            </Field>
            <NumberField label={t('ops.automations.fields.expiryInDays')} optional hint={t('ops.automations.fields.expiryInDaysHint')} min={1} max={3650} value={config.expiryInDays} onChange={(expiryInDays) => set({ expiryInDays })} error={error('expiryInDays')} disabled={disabled} />
            <Field label={t('ops.automations.fields.offsets')} optional hint={t('ops.automations.fields.offsetsHint')} error={error('offsetsDays')}>
              {(p) => (
                <Input
                  {...p}
                  dir="ltr"
                  inputMode="numeric"
                  className="tabular"
                  placeholder="90, 60, 30, 7"
                  disabled={disabled}
                  defaultValue={offsets}
                  onChange={(e) => {
                    const list = e.target.value
                      .split(/[\s,;]+/)
                      .filter(Boolean)
                      .map((v) => Number(v))
                      .filter((n) => Number.isInteger(n) && n >= 0);
                    set({ offsetsDays: list.length ? [...new Set(list)] : undefined });
                  }}
                />
              )}
            </Field>
            <Field label={t('ops.automations.fields.subjectLabel')} optional hint={t('ops.automations.fields.subjectLabelHint')} error={error('subjectLabel')}>
              {(p) => <Input {...p} dir="auto" maxLength={120} disabled={disabled} value={text(config.subjectLabel)} onChange={(e) => set({ subjectLabel: e.target.value })} />}
            </Field>
          </div>
        </div>
      );
    }

    case 'generate_document':
      return (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('ops.automations.notes.document')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TemplateField label={t('ops.automations.fields.documentTitle')} optional value={text(config.title)} onChange={(title) => set({ title })} variables={variables} error={error('title')} maxLength={160} disabled={disabled} />
            <Field label={t('ops.automations.fields.storeAs')} error={error('documentTypeKey')}>
              {(p) => <DocumentTypePicker {...p} disabled={disabled} value={text(config.documentTypeKey) || 'other'} onChange={(key) => set({ documentTypeKey: key || 'other' })} />}
            </Field>
          </div>
          <SwitchRow label={t('ops.automations.fields.customerVisible')} description={t('ops.automations.fields.customerVisibleHint')} disabled={disabled} checked={config.customerVisible === true} onCheckedChange={(customerVisible) => set({ customerVisible })} />
        </div>
      );

    case 'update_workflow_state': {
      const current = text(config.to);
      const statuses = [...meta.automaticStatuses, ...(current && !meta.automaticStatuses.some((s) => s.status === current) ? [{ status: current, label: current }] : [])];
      return (
        <div className="space-y-4">
          <Alert tone="info">{t('ops.automations.notes.status')}</Alert>
          <Field label={t('ops.automations.fields.moveTo')} required error={error('to')}>
            {(p) => (
              <Select
                {...p}
                disabled={disabled}
                value={current || null}
                onValueChange={(v) => set({ to: v })}
                options={statuses.map((s) => ({ value: s.status, label: has(`ops.rules.values.${s.status}`) ? t(`ops.rules.values.${s.status}`) : s.label }))}
              />
            )}
          </Field>
          <Field label={t('ops.automations.fields.reason')} optional hint={t('ops.automations.fields.reasonHint')} error={error('reason')}>
            {(p) => <Input {...p} dir="auto" maxLength={500} disabled={disabled} value={text(config.reason)} onChange={(e) => set({ reason: e.target.value })} />}
          </Field>
          <Field label={t('ops.automations.fields.customerMessage')} optional hint={t('ops.automations.fields.customerMessageHint')} error={error('customerMessage')}>
            {(p) => <Textarea {...p} rows={2} dir="auto" maxLength={500} disabled={disabled} value={text(config.customerMessage)} onChange={(e) => set({ customerMessage: e.target.value })} />}
          </Field>
        </div>
      );
    }

    case 'request_approval':
      return (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('ops.automations.notes.approval')}</p>
          <Field label={t('ops.automations.fields.note')} optional error={error('note')}>
            {(p) => <Textarea {...p} rows={2} dir="auto" maxLength={500} disabled={disabled} value={text(config.note)} onChange={(e) => set({ note: e.target.value })} />}
          </Field>
        </div>
      );

    case 'escalate':
      return (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('ops.automations.notes.escalate')}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <RoleField label={t('ops.automations.fields.escalateTo')} value={text(config.roleKey) || 'manager'} onChange={(roleKey) => set({ roleKey })} error={error('roleKey')} disabled={disabled} />
            <Field label={t('ops.automations.fields.priority')} error={error('priority')}>
              {(p) => <Select {...p} disabled={disabled} value={text(config.priority) || 'HIGH'} onValueChange={(priority) => set({ priority })} options={priorityOptions(['HIGH', 'URGENT'])} />}
            </Field>
            <NumberField label={t('ops.automations.fields.dueInHours')} optional min={1} max={720} value={config.dueInHours} onChange={(dueInHours) => set({ dueInHours })} error={error('dueInHours')} disabled={disabled} />
          </div>
          <TemplateField label={t('ops.automations.fields.title')} optional hint={t('ops.automations.fields.escalateTitleHint')} value={text(config.title)} onChange={(title) => set({ title })} variables={variables} error={error('title')} maxLength={160} disabled={disabled} />
          <TemplateField label={t('ops.automations.fields.message')} optional multiline value={text(config.message)} onChange={(message) => set({ message })} variables={variables} error={error('message')} maxLength={1000} disabled={disabled} />
        </div>
      );

    case 'call_webhook': {
      const mode = 'url' in config ? 'url' : 'path';
      return (
        <div className="space-y-4">
          {meta.webhook.configured ? null : (
            <Alert
              tone="warning"
              action={
                session.hasPermission('integration.manage') ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href="/integrations">{t('ops.notify.channels.integrations')}</Link>
                  </Button>
                ) : undefined
              }
            >
              {t('ops.automations.notes.webhookMissing')}
            </Alert>
          )}
          <div className="space-y-2">
            <Label id={`${id}-where`}>{t('ops.automations.fields.webhookWhere')}</Label>
            <RadioGroup value={mode} disabled={disabled} onValueChange={(v) => onChange(v === 'url' ? { url: '' } : { path: '' })} aria-labelledby={`${id}-where`} className="space-y-2">
              <ChoiceLabel htmlFor={`${id}-path`} control={<RadioGroupItem id={`${id}-path`} value="path" />} label={t('ops.automations.fields.webhookPath')} description={t('ops.automations.fields.webhookPathHint')} />
              <ChoiceLabel htmlFor={`${id}-url`} control={<RadioGroupItem id={`${id}-url`} value="url" />} label={t('ops.automations.fields.webhookUrl')} description={meta.webhook.approvedHosts.length ? t('ops.automations.fields.webhookUrlHosts', { hosts: meta.webhook.approvedHosts.join(', ') }) : t('ops.automations.fields.webhookUrlNoHosts')} />
            </RadioGroup>
          </div>
          {mode === 'path' ? (
            <Field label={t('ops.automations.fields.path')} required error={error('path')}>
              {(p) => <Input {...p} dir="ltr" className="font-mono text-sm" spellCheck={false} placeholder="/typease/new-request" disabled={disabled} value={text(config.path)} onChange={(e) => onChange({ path: e.target.value })} />}
            </Field>
          ) : (
            <Field label={t('ops.automations.fields.url')} required error={error('url') ?? error('path')}>
              {(p) => <Input {...p} type="url" dir="ltr" className="font-mono text-sm" spellCheck={false} placeholder="https://" disabled={disabled} value={text(config.url)} onChange={(e) => onChange({ url: e.target.value })} />}
            </Field>
          )}
          <p className="text-sm text-muted-foreground">{t('ops.automations.notes.webhookPrivacy')}</p>
          <p className="text-sm text-muted-foreground">
            {t('ops.automations.notes.webhookSignature')} <code className="ltr-value break-all rounded bg-muted px-1 py-0.5 font-mono text-xs">{meta.webhook.signature}</code>
          </p>
        </div>
      );
    }

    default:
      return <p className="text-sm text-muted-foreground">{t('ops.automations.notes.noSettings')}</p>;
  }
}
