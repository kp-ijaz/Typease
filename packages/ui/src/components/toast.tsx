'use client';

import * as React from 'react';
import { Toaster as SonnerToaster, toast } from 'sonner';
import { useI18n } from '../i18n/provider';
import { useTheme } from '../providers/theme';
import { describeError } from '../lib/errors';

/**
 * The toast host: bottom corner at the end side (right in English, left in
 * Arabic), above the mobile tab bar. Rendered once by <AppProviders>.
 */
export function Toaster() {
  const { dir, t } = useI18n();
  const { resolved } = useTheme();
  return (
    <SonnerToaster
      theme={resolved}
      dir={dir}
      position={dir === 'rtl' ? 'bottom-left' : 'bottom-right'}
      closeButton
      richColors={false}
      duration={5000}
      visibleToasts={3}
      containerAriaLabel={t('shell.notifications')}
      toastOptions={{
        classNames: {
          toast: '!rounded-lg !border !border-border !bg-popover !text-popover-foreground !shadow-lg !font-sans !text-base',
          description: '!text-muted-foreground',
          success: '[&_[data-icon]]:!text-success-text',
          error: '[&_[data-icon]]:!text-destructive-text',
          warning: '[&_[data-icon]]:!text-warning-text',
          info: '[&_[data-icon]]:!text-info-text',
          actionButton: '!bg-primary !text-primary-foreground',
          closeButton: '!border-border !bg-popover !text-muted-foreground',
        },
      }}
    />
  );
}

export interface Toasts {
  /** "Customer added": past tense of the button that was pressed. */
  success: (message: string, description?: string) => void;
  /**
   * A failed action. Pass the caught error: the sentence comes from the API's
   * code / message (see describeError). Errors stay on screen longer.
   */
  error: (error: unknown, fallbackMessage?: string) => void;
  info: (message: string, description?: string) => void;
  warning: (message: string, description?: string) => void;
}

/** `const toasts = useToast(); toasts.success(t('form.saved'));` */
export function useToast(): Toasts {
  const i18n = useI18n();
  return React.useMemo<Toasts>(
    () => ({
      success: (message, description) => void toast.success(message, { description }),
      error: (error, fallback) => {
        const message = typeof error === 'string' ? error : describeError(error, i18n);
        void toast.error(typeof error !== 'string' && fallback && message === i18n.t('errors.generic') ? fallback : message, { duration: 8000 });
      },
      info: (message, description) => void toast.info(message, { description }),
      warning: (message, description) => void toast.warning(message, { description, duration: 8000 }),
    }),
    [i18n],
  );
}

/** The sentence for a caught error, for inline display: `const describe = useErrorMessage(); <Alert>{describe(error)}</Alert>`. */
export function useErrorMessage(): (error: unknown) => string {
  const i18n = useI18n();
  return React.useCallback((error: unknown) => describeError(error, i18n), [i18n]);
}
