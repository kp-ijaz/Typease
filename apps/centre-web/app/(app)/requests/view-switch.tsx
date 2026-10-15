'use client';

import Link from 'next/link';
import { KanbanSquare, List } from 'lucide-react';
import { cn, useI18n } from '@typease/ui';

/** "List | Board" switch shown on both request views. */
export function RequestsViewSwitch({ active }: { active: 'list' | 'board' }) {
  const { t } = useI18n();
  const item = (view: 'list' | 'board', href: string, icon: React.ReactNode) => (
    <Link
      href={href}
      aria-current={active === view ? 'page' : undefined}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors [&_svg]:size-4',
        active === view ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {t(`requests.views.${view}`)}
    </Link>
  );
  return (
    <nav aria-label={t('requests.views.label')} className="inline-flex rounded-lg border bg-muted p-0.5">
      {item('list', '/requests', <List aria-hidden="true" />)}
      {item('board', '/requests/board', <KanbanSquare aria-hidden="true" />)}
    </nav>
  );
}
