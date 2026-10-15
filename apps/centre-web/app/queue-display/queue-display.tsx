'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { MonitorOff, Wifi, WifiOff } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { cn, formatNumber, formatTime, translate, useApi, type Locale } from '@typease/ui';
import type { DisplayState } from '@/components/ops/types';
import { dictionaries } from '@/lib/dictionaries';
import { opsKeys } from '@/lib/keys/ops';

/**
 * Now serving / next up / how many are waiting, for everyone in the waiting area.
 * Token numbers and counters only: the API sends nothing else to this page.
 *
 * Updates arrive over the stream endpoint (server-sent events). While the stream is not
 * connected the page asks every five seconds instead, so a screen never shows a stale board
 * for long. The language is the centre's display language (or ?lang=), with a switch in the corner.
 */
export function QueueDisplay({ token, lang: fixedLang }: { token: string; lang?: Locale }) {
  const api = useApi();
  const [state, setState] = React.useState<DisplayState | null>(null);
  const [live, setLive] = React.useState(false);
  const [ended, setEnded] = React.useState<'expired' | 'invalid' | null>(token ? null : 'invalid');
  const [chosen, setChosen] = React.useState<Locale | undefined>(fixedLang);
  const [clock, setClock] = React.useState<Date | null>(null);

  // Polling: the first load, and the fallback whenever the stream is down.
  const poll = useQuery({
    queryKey: opsKeys.queue.display(token),
    queryFn: () => api.client.get<DisplayState>('/public/queue/display', { query: { token }, auth: false }),
    enabled: !!token && !ended && !live,
    refetchInterval: 5_000,
    retry: false,
  });
  React.useEffect(() => {
    if (poll.data) setState(poll.data);
  }, [poll.data]);
  React.useEffect(() => {
    // A link that was revoked or ran out answers 401 / 403: stop asking and say so.
    if (isApiError(poll.error) && (poll.error.status === 401 || poll.error.status === 403 || poll.error.status === 404)) setEnded(state ? 'expired' : 'invalid');
  }, [poll.error, state]);

  // Live updates. EventSource reconnects by itself; meanwhile `live` is false and polling takes over.
  React.useEffect(() => {
    if (!token || ended || typeof EventSource === 'undefined') return;
    const source = new EventSource(api.client.url('/public/queue/display/stream', { token }));
    source.addEventListener('open', () => setLive(true));
    source.addEventListener('queue', (event) => {
      try {
        setState(JSON.parse((event as MessageEvent<string>).data) as DisplayState);
        setLive(true);
      } catch {
        /* a broken frame is ignored; the next one replaces it */
      }
    });
    source.addEventListener('expired', () => {
      setEnded('expired');
      source.close();
    });
    source.addEventListener('error', () => setLive(false));
    return () => source.close();
  }, [api, token, ended]);

  React.useEffect(() => {
    setClock(new Date());
    const timer = window.setInterval(() => setClock(new Date()), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  const lang: Locale = chosen ?? (state?.language === 'ar' ? 'ar' : state?.language === 'en' ? 'en' : 'en');
  const t = (key: string, vars?: Record<string, string | number>) => translate(dictionaries, lang, key, vars);
  const number = (n: number) => formatNumber(n, { locale: lang });
  const branch = state ? (lang === 'ar' ? state.branch.nameAr || state.branch.name : state.branch.name) : '';
  // The clock of the screen itself (it hangs in the branch); rendered after mount only.
  const time = clock ? formatTime(clock, { locale: lang, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, currency: 'AED' }) : '';

  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang} className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b bg-card px-6 py-4 sm:px-10">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold sm:text-3xl">{branch || t('ops.queueDisplay.title')}</h1>
          <p className="text-md text-muted-foreground">{t('ops.queueDisplay.subtitle')}</p>
        </div>
        <p className="tabular text-3xl font-semibold sm:text-4xl" dir="ltr" aria-hidden="true">
          {time}
        </p>
      </header>

      {ended || (!state && poll.isError) ? (
        <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <span className="flex size-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground" aria-hidden="true">
            <MonitorOff className="size-8" />
          </span>
          <p className="text-2xl font-semibold">{t(ended === 'expired' ? 'ops.queueDisplay.expiredTitle' : ended === 'invalid' ? 'ops.queueDisplay.invalidTitle' : 'ops.queueDisplay.offlineTitle')}</p>
          <p className="max-w-xl text-lg text-muted-foreground">{t(ended ? 'ops.queueDisplay.endedText' : 'ops.queueDisplay.offlineText')}</p>
        </main>
      ) : !state ? (
        <main className="flex flex-1 items-center justify-center p-8" role="status">
          <p className="text-2xl text-muted-foreground">{t('ops.queueDisplay.loading')}</p>
        </main>
      ) : (
        <main className="grid grid-cols-1 flex-1 gap-6 p-6 sm:p-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <section aria-labelledby="now-serving" className="flex flex-col">
            <h2 id="now-serving" className="text-xl font-semibold text-muted-foreground sm:text-2xl">
              {t('ops.queueDisplay.nowServing')}
            </h2>
            {state.nowServing.length === 0 ? (
              <div className="mt-4 flex flex-1 items-center justify-center rounded-2xl border border-dashed bg-card p-10 text-center">
                <p className="text-2xl text-muted-foreground sm:text-3xl">{t('ops.queueDisplay.nobody')}</p>
              </div>
            ) : (
              <ul className="mt-4 grid gap-4 sm:grid-cols-2" aria-live="polite">
                {state.nowServing.map((item, index) => (
                  <li
                    key={item.tokenNo}
                    className={cn(
                      'flex items-center justify-between gap-4 rounded-2xl border p-6 sm:p-8',
                      index === 0 && 'sm:col-span-2',
                      item.status === 'CALLED' ? 'border-accent bg-accent text-accent-foreground' : 'bg-card',
                    )}
                  >
                    <div>
                      <p className={cn('tabular whitespace-nowrap font-bold leading-none', index === 0 ? 'text-6xl sm:text-8xl xl:text-9xl' : 'text-5xl sm:text-6xl')} dir="ltr">
                        {item.tokenNo}
                      </p>
                      <p className={cn('mt-3 text-lg font-medium sm:text-xl', item.status === 'CALLED' ? 'opacity-90' : 'text-muted-foreground')}>{t(item.status === 'CALLED' ? 'ops.queueDisplay.pleaseProceed' : 'ops.queueDisplay.beingServed')}</p>
                    </div>
                    {item.counter ? (
                      <div className="text-center">
                        <p className={cn('text-md font-medium sm:text-lg', item.status === 'CALLED' ? 'opacity-90' : 'text-muted-foreground')}>{t('ops.queueDisplay.counter')}</p>
                        <p className={cn('tabular font-bold leading-none', index === 0 ? 'text-5xl sm:text-7xl' : 'text-4xl sm:text-5xl')} dir="ltr">
                          {item.counter}
                        </p>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <aside className="flex flex-col gap-6">
            <section aria-labelledby="next-up" className="flex-1 rounded-2xl border bg-card p-6">
              <h2 id="next-up" className="text-xl font-semibold text-muted-foreground sm:text-2xl">
                {t('ops.queueDisplay.nextUp')}
              </h2>
              {state.nextUp.length === 0 ? (
                <p className="mt-4 text-xl text-muted-foreground">{t('ops.queueDisplay.nextEmpty')}</p>
              ) : (
                <ol className="mt-4 grid grid-cols-2 gap-3">
                  {state.nextUp.map((tokenNo) => (
                    <li key={tokenNo} className="tabular rounded-xl bg-muted px-4 py-3 text-center text-3xl font-semibold sm:text-4xl" dir="ltr">
                      {tokenNo}
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <section className="rounded-2xl border bg-card p-6" aria-live="polite">
              <p className="text-xl font-semibold text-muted-foreground sm:text-2xl">{t('ops.queueDisplay.waiting')}</p>
              <p className="tabular mt-2 text-6xl font-bold leading-none sm:text-7xl">{number(state.waitingCount)}</p>
            </section>
          </aside>
        </main>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t bg-card px-6 py-3 text-sm text-muted-foreground sm:px-10">
        <p className="flex items-center gap-2" role="status">
          {ended ? null : live ? <Wifi className="size-4 text-success-text" aria-hidden="true" /> : <WifiOff className="size-4" aria-hidden="true" />}
          {ended ? '' : t(live ? 'ops.queueDisplay.live' : 'ops.queueDisplay.refreshing')}
        </p>
        <div role="group" aria-label={t('ops.queueDisplay.language')} className="inline-flex rounded-md border p-0.5">
          {(['en', 'ar'] as const).map((l) => (
            <button
              key={l}
              type="button"
              lang={l}
              aria-pressed={lang === l}
              onClick={() => setChosen(l)}
              className={cn('rounded-sm px-3 py-1 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', lang === l ? 'bg-secondary text-secondary-foreground' : 'hover:text-foreground')}
            >
              {l === 'en' ? 'English' : 'العربية'}
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}
