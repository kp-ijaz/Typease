'use client';

import * as React from 'react';
import { AlertCircle, Camera, CheckCircle2, FileText, ImageIcon, RotateCw, UploadCloud, X } from 'lucide-react';
import { cn, focusRing } from '../lib/cn';
import { useI18n } from '../i18n/provider';
import { describeError } from '../lib/errors';
import { Button } from './button';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error';
export interface UploadItem<Result = unknown> {
  id: string;
  file: File;
  status: UploadStatus;
  /** 0..1 */
  progress: number;
  error?: string;
  result?: Result;
}

export interface FileUploadProps<Result = unknown> {
  /**
   * Uploads one file. Report progress (0..1) and honour the abort signal.
   * With @typease/api-client: `(file, o) => uploadDocument(client, { file, ...owner, ...o })`.
   * Without it the component only collects files (see `onFilesChange`).
   */
  upload?: (file: File, options: { onProgress: (fraction: number) => void; signal: AbortSignal }) => Promise<Result>;
  /** Every change of the list: added, progressed, finished, removed. */
  onFilesChange?: (items: UploadItem<Result>[]) => void;
  /** Called once per file that finished uploading. */
  onUploaded?: (item: UploadItem<Result>) => void;
  /** MIME types and / or extensions: ['application/pdf', 'image/*', '.docx']. Empty = anything. */
  accept?: string[];
  /** Default 15 MB (the API's UPLOAD_MAX_BYTES default). */
  maxSizeBytes?: number;
  multiple?: boolean;
  maxFiles?: number;
  /** Adds a "Take a photo" button that opens the camera on phones (document capture). */
  capture?: 'environment' | 'user';
  disabled?: boolean;
  /** Words for the accepted types in the hint, e.g. "PDF, JPG, PNG". */
  acceptLabel?: string;
  id?: string;
  className?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
}

export function matchesAccept(file: Pick<File, 'name' | 'type'>, accept: string[] | undefined): boolean {
  if (!accept || accept.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  return accept.some((rule) => {
    const r = rule.trim().toLowerCase();
    if (r.startsWith('.')) return name.endsWith(r);
    if (r.endsWith('/*')) return type.startsWith(r.slice(0, -1));
    return type === r;
  });
}

let counter = 0;
const nextId = () => `f${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * Drag-and-drop / click / camera file picker with per-file progress.
 * Files are checked for type and size before anything is sent; each problem is
 * explained by file name. A failed upload keeps its row with "Try again".
 */
export function FileUpload<Result = unknown>({
  upload, onFilesChange, onUploaded, accept, maxSizeBytes = 15 * 1024 * 1024, multiple = true, maxFiles, capture, disabled, acceptLabel, id, className, ...aria
}: FileUploadProps<Result>) {
  const i18n = useI18n();
  const { t, tn, formatFileSize } = i18n;
  const [items, setItems] = React.useState<UploadItem<Result>[]>([]);
  const [problems, setProblems] = React.useState<string[]>([]);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const cameraRef = React.useRef<HTMLInputElement>(null);
  const controllers = React.useRef(new Map<string, AbortController>());
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const limit = multiple ? maxFiles ?? Infinity : 1;

  const notify = React.useRef(onFilesChange);
  notify.current = onFilesChange;
  React.useEffect(() => {
    notify.current?.(items);
  }, [items]);
  React.useEffect(() => {
    const map = controllers.current;
    return () => {
      for (const c of map.values()) c.abort();
    };
  }, []);

  const patch = (itemId: string, change: Partial<UploadItem<Result>>) => setItems((list) => list.map((it) => (it.id === itemId ? { ...it, ...change } : it)));

  const start = React.useCallback(
    (item: UploadItem<Result>) => {
      if (!upload) return;
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      patch(item.id, { status: 'uploading', progress: 0, error: undefined });
      upload(item.file, { signal: controller.signal, onProgress: (fraction) => patch(item.id, { progress: Math.max(0, Math.min(1, fraction)) }) })
        .then((result) => {
          const done = { ...item, status: 'done' as const, progress: 1, result };
          patch(item.id, done);
          onUploaded?.(done);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          patch(item.id, { status: 'error', error: describeError(error, i18n) });
        })
        .finally(() => controllers.current.delete(item.id));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [upload, onUploaded, i18n],
  );

  const add = (files: FileList | File[] | null) => {
    if (!files || disabled) return;
    const incoming = Array.from(files);
    const found: string[] = [];
    const accepted: UploadItem<Result>[] = [];
    const room = Math.max(0, limit - (multiple ? items.length : 0));
    for (const file of incoming) {
      if (!matchesAccept(file, accept)) found.push(t('file.wrongType', { name: file.name }));
      else if (file.size > maxSizeBytes) found.push(t('file.tooLarge', { name: file.name, size: formatFileSize(maxSizeBytes) }));
      else if (accepted.length >= room) {
        if (!found.includes(tn('file.tooMany', limit))) found.push(tn('file.tooMany', limit));
      } else accepted.push({ id: nextId(), file, status: upload ? 'queued' : 'done', progress: upload ? 0 : 1 });
    }
    setProblems(found);
    if (!accepted.length) return;
    setItems((list) => (multiple ? [...list, ...accepted] : accepted));
    for (const item of accepted) start(item);
  };

  const remove = (item: UploadItem<Result>) => {
    controllers.current.get(item.id)?.abort();
    setItems((list) => list.filter((it) => it.id !== item.id));
  };

  const hint = t('file.accepted', { types: acceptLabel ?? (accept?.length ? accept.map((a) => a.replace(/^\./, '').replace(/^.*\//, '').replace('*', '')).filter(Boolean).join(', ').toUpperCase() : '*'), size: formatFileSize(maxSizeBytes) });
  const full = items.length >= limit && multiple;

  return (
    <div className={cn('space-y-3', className)}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
        className={cn(
          'flex flex-col items-center gap-3 rounded-lg border border-dashed border-input bg-card px-4 py-6 text-center transition-colors',
          dragging && 'border-secondary bg-secondary-soft',
          disabled && 'opacity-60',
          aria['aria-invalid'] === true || aria['aria-invalid'] === 'true' ? 'border-destructive' : null,
        )}
      >
        <UploadCloud className="size-7 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="text-base font-medium text-foreground">{dragging ? t('file.dropActive') : multiple ? t('file.dropTitle') : t('file.dropTitleSingle')}</p>
          <p className="mt-1 text-sm text-muted-foreground" id={`${inputId}-hint`}>
            {hint}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" size="sm" disabled={disabled || full} onClick={() => inputRef.current?.click()}>
            {multiple ? t('file.choose') : t('file.chooseSingle')}
          </Button>
          {capture ? (
            <Button variant="outline" size="sm" disabled={disabled || full} onClick={() => cameraRef.current?.click()}>
              <Camera aria-hidden="true" />
              {t('file.takePhoto')}
            </Button>
          ) : null}
        </div>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          className="sr-only"
          tabIndex={-1}
          multiple={multiple}
          accept={accept?.join(',')}
          disabled={disabled}
          aria-describedby={[`${inputId}-hint`, aria['aria-describedby']].filter(Boolean).join(' ')}
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
        {capture ? (
          <input
            ref={cameraRef}
            type="file"
            className="sr-only"
            tabIndex={-1}
            accept="image/*"
            capture={capture}
            disabled={disabled}
            aria-hidden="true"
            onChange={(e) => {
              add(e.target.files);
              e.target.value = '';
            }}
          />
        ) : null}
      </div>

      {problems.length ? (
        <ul role="alert" className="space-y-1 rounded-md border border-destructive/25 bg-destructive-soft px-3 py-2 text-sm text-destructive-text">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}

      {items.length ? (
        <ul className="space-y-2">
          {items.map((item) => {
            const Icon = item.file.type.startsWith('image/') ? ImageIcon : FileText;
            return (
              <li key={item.id} className="flex items-center gap-3 rounded-md border bg-card px-3 py-2.5">
                <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-base font-medium text-foreground" dir="auto">
                      {item.file.name}
                    </p>
                    <p className="tabular shrink-0 text-xs text-muted-foreground">{formatFileSize(item.file.size)}</p>
                  </div>
                  {item.status === 'uploading' || item.status === 'queued' ? (
                    <div className="mt-1.5 flex items-center gap-2">
                      <div
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(item.progress * 100)}
                        aria-label={`${t('file.uploading')} ${item.file.name}`}
                        className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                      >
                        <div className="h-full rounded-full bg-secondary transition-[width] duration-200" style={{ width: `${Math.round(item.progress * 100)}%` }} />
                      </div>
                      <span className="tabular w-9 text-end text-xs text-muted-foreground">{Math.round(item.progress * 100)}%</span>
                    </div>
                  ) : item.status === 'error' ? (
                    <p role="alert" className="mt-0.5 flex items-center gap-1.5 text-sm text-destructive-text">
                      <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
                      {item.error ?? t('file.failed')}
                    </p>
                  ) : upload ? (
                    <p className="mt-0.5 flex items-center gap-1.5 text-sm text-success-text">
                      <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" />
                      {t('file.uploaded')}
                    </p>
                  ) : null}
                </div>
                {item.status === 'error' && upload ? (
                  <Button variant="ghost" size="icon-sm" aria-label={`${t('file.retryUpload')}: ${item.file.name}`} onClick={() => start(item)}>
                    <RotateCw aria-hidden="true" />
                  </Button>
                ) : null}
                <button
                  type="button"
                  aria-label={t('file.removeFile', { name: item.file.name })}
                  onClick={() => remove(item)}
                  className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground', focusRing)}
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
