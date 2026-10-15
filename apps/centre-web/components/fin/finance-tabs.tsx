'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronDown, Wrench } from 'lucide-react';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, cn, useI18n, useSession } from '@typease/ui';

export type FinanceTab = 'expenses' | 'liabilities' | 'reconciliation' | 'settings';

const TABS: Array<{ id: FinanceTab; href: string; anyOf: string[] }> = [
  { id: 'expenses', href: '/finance/expenses', anyOf: ['expense.manage'] },
  { id: 'liabilities', href: '/finance/liabilities', anyOf: ['report.financial', 'payment.reconcile'] },
  { id: 'reconciliation', href: '/finance/reconciliation', anyOf: ['payment.reconcile'] },
  { id: 'settings', href: '/finance/settings', anyOf: ['finance.settings', 'report.financial', 'payment.reconcile'] },
];

/** The finance tools the signed-in role may open (used for links from payments and reports). */
export function useFinanceTools() {
  const session = useSession();
  return TABS.filter((tab) => session.hasAnyPermission(tab.anyOf));
}

/** Sub-navigation shared by expenses, liabilities, reconciliation and fee settings. Tabs the role cannot use are left out. */
export function FinanceTabs({ current }: { current: FinanceTab }) {
  const { t } = useI18n();
  const tabs = useFinanceTools();
  const nav = React.useRef<HTMLElement>(null);
  // On a phone the four tabs do not fit: the strip scrolls, and the current tab is brought into view.
  React.useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current, tabs.length]);
  if (tabs.length < 2) return null;
  return (
    <nav ref={nav} aria-label={t('fin.tools.nav')} className="scroll-quiet -mt-2 mb-6 flex gap-1 overflow-x-auto border-b">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          aria-current={tab.id === current ? 'page' : undefined}
          className={cn(
            '-mb-px inline-flex h-10 shrink-0 items-center whitespace-nowrap rounded-t-sm border-b-2 px-2 text-sm font-medium transition-colors sm:px-3 sm:text-base',
            'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            tab.id === current ? 'border-secondary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t(`fin.tools.tabs.${tab.id}`)}
        </Link>
      ))}
    </nav>
  );
}

/** "Finance tools" menu for the header of the payments and reports pages. Renders nothing for roles without any of the tools. */
export function FinanceToolsMenu() {
  const { t } = useI18n();
  const tabs = useFinanceTools();
  if (!tabs.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <Wrench aria-hidden="true" />
          {t('fin.tools.menu')}
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {tabs.map((tab) => (
          <DropdownMenuItem key={tab.id} asChild>
            <Link href={tab.href}>{t(`fin.tools.tabs.${tab.id}`)}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
