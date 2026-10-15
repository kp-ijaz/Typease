'use client';

import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '../lib/cn';

export interface LabelProps extends React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> {
  /** Adds the visual required marker (the input still needs `required` / aria-required). */
  required?: boolean;
  /** Text for the "(optional)" note, e.g. t('common.optional'). */
  optionalText?: string;
}

export const Label = React.forwardRef<React.ElementRef<typeof LabelPrimitive.Root>, LabelProps>(function Label({ className, children, required, optionalText, ...props }, ref) {
  return (
    <LabelPrimitive.Root ref={ref} className={cn('text-sm font-medium leading-5 text-foreground peer-disabled:opacity-60', className)} {...props}>
      {children}
      {required ? (
        <span aria-hidden="true" className="ms-0.5 text-destructive-text">
          *
        </span>
      ) : null}
      {optionalText ? <span className="ms-1.5 font-normal text-muted-foreground">({optionalText})</span> : null}
    </LabelPrimitive.Root>
  );
});
