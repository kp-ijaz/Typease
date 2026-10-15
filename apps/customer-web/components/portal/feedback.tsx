'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { Button, Label, Textarea, cn, focusRing, useI18n, useToast } from '@typease/ui';
import { usePortalApi } from '@/lib/api';
import { keys } from '@/lib/query-keys';
import type { FeedbackEntry } from '@/lib/types';

function Stars({ value, onChange, label }: { value: number; onChange?: (value: number) => void; label: string }) {
  const { tn } = useI18n();
  if (!onChange) {
    return (
      <span className="inline-flex gap-0.5" role="img" aria-label={tn('my.feedback.stars', value)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Star key={n} className={cn('size-5', n <= value ? 'fill-warning text-warning' : 'text-muted-foreground/40')} aria-hidden="true" />
        ))}
      </span>
    );
  }
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={tn('my.feedback.stars', n)}
          onClick={() => onChange(n)}
          className={cn('flex size-11 items-center justify-center rounded-md hover:bg-muted', focusRing)}
        >
          <Star className={cn('size-7', n <= value ? 'fill-warning text-warning' : 'text-muted-foreground/50')} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

/**
 * "How did we do?" for a completed request or a resolved support conversation.
 * One rating per request / conversation; once given it is shown, not asked again.
 */
export function FeedbackCard({ target, existing, canRate }: {
  target: { requestId: string } | { ticketId: string };
  /** The rating already given, when the page knows it (a ticket carries it). Requests look it up. */
  existing?: FeedbackEntry | null;
  canRate: boolean;
}) {
  const { t } = useI18n();
  const api = usePortalApi();
  const toasts = useToast();
  const queryClient = useQueryClient();
  const requestId = 'requestId' in target ? target.requestId : null;
  const mine = useQuery({ queryKey: keys.feedback, queryFn: () => api.feedback(), enabled: !!requestId && existing === undefined, staleTime: 60_000 });
  const given = existing ?? (requestId ? mine.data?.data.find((f) => f.requestId === requestId) : undefined) ?? null;
  const [rating, setRating] = React.useState(0);
  const [comment, setComment] = React.useState('');
  const commentId = React.useId();

  const send = useMutation({
    mutationFn: () => api.sendFeedback({ ...target, rating, comment: comment.trim() || undefined }),
    onSuccess: async () => {
      toasts.success(t('my.feedback.sent'));
      await Promise.all([queryClient.invalidateQueries({ queryKey: keys.feedback }), queryClient.invalidateQueries({ queryKey: keys.tickets.all })]);
    },
    onError: (error) => toasts.error(error),
  });

  if (given) {
    return (
      <div className="space-y-1.5">
        <p className="text-base font-medium text-foreground">{t('my.feedback.yours')}</p>
        <Stars value={given.rating} label={t('my.feedback.title')} />
        {given.comment ? (
          <p className="text-base text-foreground/85" dir="auto">
            {given.comment}
          </p>
        ) : null}
      </div>
    );
  }
  if (!canRate || (requestId && mine.isPending)) return null;
  return (
    <div className="space-y-3">
      <div>
        <p className="text-base font-medium text-foreground">{t('my.feedback.title')}</p>
        <p className="text-sm text-muted-foreground">{t('my.feedback.text')}</p>
      </div>
      <Stars value={rating} onChange={setRating} label={t('my.feedback.title')} />
      {rating > 0 ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={commentId} optionalText={t('common.optional')}>
              {t('my.feedback.comment')}
            </Label>
            <Textarea id={commentId} rows={2} dir="auto" maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
          <Button loading={send.isPending} loadingText={t('common.saving')} onClick={() => send.mutate()}>
            {t('my.feedback.send')}
          </Button>
        </>
      ) : null}
    </div>
  );
}
