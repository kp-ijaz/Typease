'use client';

import * as React from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { AlertTriangle } from 'lucide-react';
import { cn } from '../lib/cn';
import { useT } from '../i18n/provider';
import { Button } from './button';
import { Input } from './input';
import { Label } from './label';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What will happen, in one or two plain sentences. Say what cannot be undone. */
  description: React.ReactNode;
  /** The verb of the action, repeated from the button that opened the dialog ("Delete customer"). */
  confirmLabel: string;
  cancelLabel?: string;
  /** "destructive" (default) for deleting / cancelling / voiding; "default" for a neutral confirmation. */
  tone?: 'destructive' | 'default';
  /**
   * For actions that are hard to reverse: the person must type this text
   * (for example the customer number) before the confirm button unlocks.
   */
  typedConfirmation?: string;
  /** May return a promise: the dialog shows progress and stays open until it settles. Throw to keep it open. */
  onConfirm: () => void | Promise<void>;
  children?: React.ReactNode;
}

/**
 * Confirmation for destructive or irreversible actions (spec section 36).
 * Built on an alert dialog: focus starts on Cancel, Escape cancels, and a
 * click outside does NOT dismiss it.
 */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, cancelLabel, tone = 'destructive', typedConfirmation, onConfirm, children }: ConfirmDialogProps) {
  const t = useT();
  const [typed, setTyped] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const inputId = React.useId();

  React.useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const matches = !typedConfirmation || typed.trim().toLowerCase() === typedConfirmation.trim().toLowerCase();

  const confirm = async (event: React.MouseEvent) => {
    event.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      /* the caller reports the error (toast); the dialog stays open so the person can retry or cancel */
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[hsl(216_50%_8%/0.55)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <AlertDialogPrimitive.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 w-full rounded-t-xl border bg-card p-5 text-card-foreground shadow-lg outline-none',
            // Hangs from a fixed top edge like every dialog (see DialogContent): growing content never moves the buttons upwards.
            'sm:bottom-auto sm:top-[18dvh] sm:mx-auto sm:max-w-md sm:rounded-xl sm:p-6',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 sm:data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          )}
        >
          <div className="flex gap-4">
            {tone === 'destructive' ? (
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive-soft text-destructive-text">
                <AlertTriangle className="size-5" aria-hidden="true" />
              </span>
            ) : null}
            <div className="min-w-0 flex-1 space-y-2">
              <AlertDialogPrimitive.Title className="text-lg font-semibold leading-6">{title}</AlertDialogPrimitive.Title>
              <AlertDialogPrimitive.Description asChild>
                <div className="text-base text-muted-foreground">{description}</div>
              </AlertDialogPrimitive.Description>
            </div>
          </div>
          {children ? <div className="mt-4">{children}</div> : null}
          {typedConfirmation ? (
            <div className="mt-4 space-y-1.5">
              <Label htmlFor={inputId}>{t('form.typeToConfirm', { text: typedConfirmation })}</Label>
              <Input id={inputId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} dir="ltr" aria-invalid={typed.length > 0 && !matches} />
            </div>
          ) : null}
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="outline" disabled={busy}>
                {cancelLabel ?? t('common.cancel')}
              </Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button variant={tone === 'destructive' ? 'destructive' : 'default'} onClick={confirm} disabled={!matches} loading={busy} loadingText={t('common.loading')}>
                {confirmLabel}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
