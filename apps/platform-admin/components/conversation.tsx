'use client';

import * as React from 'react';
import { Lock } from 'lucide-react';
import { Avatar, Badge, cn, useI18n } from '@typease/ui';

export interface ConversationMessage {
  id: string;
  /** "them" = the centre that asked; "us" = TypEase support. */
  side: 'them' | 'us';
  authorName: string | null;
  /** Internal notes stay inside the TypEase team and are drawn clearly apart. */
  internal?: boolean;
  body: string;
  createdAt: string;
}

/**
 * A ticket conversation, oldest first. Replies the centre can read and INTERNAL notes are
 * visibly different things: a note has its own colour, a lock and the words "Internal note".
 */
export function Conversation({ messages, usLabel, themLabel }: { messages: ConversationMessage[]; usLabel: string; themLabel: string }) {
  const { t, formatDateTime } = useI18n();
  return (
    <ol className="space-y-4">
      {messages.map((m) => (
        <li key={m.id} className={cn('flex gap-3', m.side === 'us' && 'flex-row-reverse')}>
          <Avatar name={m.authorName ?? (m.side === 'us' ? usLabel : themLabel)} size="sm" className="mt-1" />
          <div
            className={cn(
              'min-w-0 max-w-[min(42rem,100%)] flex-1 rounded-lg border px-4 py-3',
              m.internal ? 'border-warning/50 bg-warning-soft' : m.side === 'us' ? 'border-secondary/20 bg-secondary-soft/50' : 'bg-card',
            )}
          >
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-semibold text-foreground">
                <bdi>{m.authorName ?? (m.side === 'us' ? usLabel : themLabel)}</bdi>
              </span>
              <span className="tabular text-muted-foreground">{formatDateTime(m.createdAt)}</span>
              {m.internal ? (
                <Badge tone="warning" icon={<Lock />}>
                  {t('desk.internalNote')}
                </Badge>
              ) : null}
            </p>
            <p className="mt-1.5 whitespace-pre-wrap break-words text-base text-foreground" dir="auto">
              {m.body}
            </p>
            {m.internal ? <p className="mt-2 text-sm text-warning-text">{t('desk.internalNoteHint')}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
