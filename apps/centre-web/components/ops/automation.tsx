'use client';

import * as React from 'react';
import { ArrowRightLeft, BellRing, CalendarClock, FileText, ListTodo, Send, ShieldCheck, TriangleAlert, UserCheck, Webhook, Zap } from 'lucide-react';
import { cn, useI18n } from '@typease/ui';
import type { AutomationActionRow } from './types';

/** Dictionary keys cannot contain dots or dashes: "request.completed" is looked up as "request_completed". */
export const autoKey = (value: string) => value.replace(/[^A-Za-z0-9]/g, '_');

const ICONS: Record<string, React.ReactNode> = {
  create_task: <ListTodo aria-hidden="true" />,
  create_follow_up: <CalendarClock aria-hidden="true" />,
  assign_staff: <UserCheck aria-hidden="true" />,
  send_notification: <Send aria-hidden="true" />,
  schedule_reminder: <BellRing aria-hidden="true" />,
  generate_document: <FileText aria-hidden="true" />,
  update_workflow_state: <ArrowRightLeft aria-hidden="true" />,
  request_approval: <ShieldCheck aria-hidden="true" />,
  escalate: <TriangleAlert aria-hidden="true" />,
  call_webhook: <Webhook aria-hidden="true" />,
};
export const actionIcon = (type: string) => ICONS[type] ?? <Zap aria-hidden="true" />;

/**
 * Names of triggers, actions, message values and ready-made templates in the
 * reader's language. The API sends English labels; they are the fallback for
 * anything the dictionary does not know yet.
 */
export function useAutomationLabels() {
  const { t, has } = useI18n();
  return React.useMemo(() => {
    const or = (key: string, fallback: string) => (has(key) ? t(key) : fallback);
    return {
      trigger: (key: string, fallback?: string) => or(`ops.rules.values.${autoKey(key)}`, fallback ?? key),
      action: (type: string, fallback?: string) => or(`ops.automations.actions.${type}`, fallback ?? type),
      variable: (key: string, fallback?: string) => or(`ops.automations.variables.${key}`, fallback ?? ''),
      templateName: (key: string, fallback: string) => or(`ops.automations.templateNames.${autoKey(key)}`, fallback),
      templateText: (key: string, fallback: string) => or(`ops.automations.templateTexts.${autoKey(key)}`, fallback),
      category: (name: string) => or(`ops.automations.categories.${autoKey(name)}`, name),
    };
  }, [t, has]);
}

/** The actions of a rule in the order they run: "1. Create task  2. Send notification". */
export function ActionChips({ actions, className }: { actions: AutomationActionRow[]; className?: string }) {
  const { formatNumber } = useI18n();
  const labels = useAutomationLabels();
  return (
    <ol className={cn('flex flex-wrap gap-1.5', className)}>
      {actions.map((action, i) => (
        <li key={i} className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-sm text-foreground [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
          {actionIcon(action.type)}
          <span>
            {actions.length > 1 ? `${formatNumber(i + 1)}. ` : ''}
            {labels.action(action.type, action.label)}
          </span>
        </li>
      ))}
    </ol>
  );
}
