'use client';

import * as React from 'react';
import { Download, FileQuestion } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { useI18n } from '../i18n/provider';
import { describeError } from '../lib/errors';
import { Alert } from './alert';
import { Button } from './button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { LoadingBlock } from './spinner';

export interface FileSource {
  /** A short-lived signed URL (POST /documents/:id/preview-link). */
  url: string;
  mime: string;
  filename: string;
}

export interface FileViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called every time the viewer opens: signed URLs expire within minutes, so never cache them. */
  getSource: () => Promise<FileSource>;
  title?: string;
  /** Optional separate link for saving (attachment disposition). */
  onDownload?: () => void;
}

const PREVIEWABLE_IMAGE = /^image\/(png|jpe?g|webp|gif)$/i;

/**
 * Previews a PDF or image from the document vault in a dialog.
 * The bytes are fetched once and shown from an in-memory blob URL: the signed
 * link is used a single time, never ends up in the DOM or the history, and the
 * preview works under a strict CSP (frame-src blob:). The blob is released on close.
 */
export function FileViewer({ open, onOpenChange, getSource, title, onDownload }: FileViewerProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const [state, setState] = React.useState<{ status: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error'; blobUrl?: string; source?: FileSource; error?: string }>({ status: 'idle' });
  const [attempt, setAttempt] = React.useState(0);
  const source = React.useRef(getSource);
  source.current = getSource;

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let created: string | undefined;
    setState({ status: 'loading' });
    (async () => {
      try {
        const src = await source.current();
        if (cancelled) return;
        const isPdf = src.mime === 'application/pdf';
        if (!isPdf && !PREVIEWABLE_IMAGE.test(src.mime)) {
          setState({ status: 'unsupported', source: src });
          return;
        }
        const res = await fetch(src.url, { credentials: 'omit' });
        if (!res.ok) throw Object.assign(new Error('preview failed'), { expired: res.status === 403 || res.status === 410 });
        const blob = await res.blob();
        if (cancelled) return;
        // Force the declared type so that a mislabelled response can not be rendered as HTML.
        created = URL.createObjectURL(new Blob([blob], { type: src.mime }));
        setState({ status: 'ready', blobUrl: created, source: src });
      } catch (e) {
        if (cancelled) return;
        const expired = (e as { expired?: boolean }).expired || (isApiError(e) && e.code === 'LINK_EXPIRED');
        setState({ status: 'error', error: expired ? t('file.linkExpired') : isApiError(e) ? describeError(e, i18n) : t('file.previewFailed') });
      }
    })();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, attempt]);

  const name = state.source?.filename ?? title ?? '';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="sm:h-[88dvh]">
        <DialogHeader>
          <DialogTitle className="truncate" dir="auto">
            {title ?? name ?? t('file.preview')}
          </DialogTitle>
          <DialogDescription className="sr-only">{t('file.previewOf', { name })}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex min-h-[50dvh] flex-col bg-muted/40 p-0 sm:p-0">
          {state.status === 'loading' || state.status === 'idle' ? <LoadingBlock label={t('common.loading')} className="flex-1" /> : null}
          {state.status === 'error' ? (
            <div className="m-auto max-w-md p-6">
              <Alert tone="danger" live action={<Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>{t('common.retry')}</Button>}>
                {state.error}
              </Alert>
            </div>
          ) : null}
          {state.status === 'unsupported' ? (
            <div className="m-auto flex max-w-sm flex-col items-center gap-3 p-6 text-center text-muted-foreground">
              <FileQuestion className="size-8" aria-hidden="true" />
              <p className="text-base">{t('file.previewUnavailable')}</p>
            </div>
          ) : null}
          {state.status === 'ready' && state.source?.mime === 'application/pdf' ? (
            <iframe title={t('file.previewOf', { name })} src={state.blobUrl} className="min-h-[60dvh] w-full flex-1 border-0 bg-white" />
          ) : null}
          {state.status === 'ready' && state.source && state.source.mime !== 'application/pdf' ? (
            <div className="flex flex-1 items-center justify-center overflow-auto p-4">
              {/* Plain <img>: the source is an in-memory blob URL, which next/image cannot optimise. */}
              <img src={state.blobUrl} alt={t('file.previewOf', { name })} className="max-h-full max-w-full rounded-md object-contain shadow-sm" />
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
          {onDownload ? (
            <Button onClick={onDownload}>
              <Download aria-hidden="true" />
              {t('common.download')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
