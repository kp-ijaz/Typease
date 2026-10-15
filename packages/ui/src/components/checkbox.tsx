'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { Check, Minus } from 'lucide-react';
import { cn, focusRing } from '../lib/cn';
import { useDirection } from '../i18n/provider';

export const Checkbox = React.forwardRef<React.ElementRef<typeof CheckboxPrimitive.Root>, React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>>(function Checkbox(
  { className, ...props },
  ref,
) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        'peer inline-flex size-5 shrink-0 items-center justify-center rounded-sm border border-input bg-card shadow-xs transition-colors',
        'data-[state=checked]:border-secondary data-[state=checked]:bg-secondary data-[state=checked]:text-secondary-foreground',
        'data-[state=indeterminate]:border-secondary data-[state=indeterminate]:bg-secondary data-[state=indeterminate]:text-secondary-foreground',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive',
        focusRing,
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        {props.checked === 'indeterminate' ? <Minus className="size-3.5" strokeWidth={3} aria-hidden="true" /> : <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});

/** A checkbox, radio or switch with its label and optional description, clickable as one target. */
export function ChoiceLabel({
  control,
  htmlFor,
  label,
  description,
  className,
}: {
  control: React.ReactNode;
  htmlFor: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <span className="flex h-6 items-center">{control}</span>
      <label htmlFor={htmlFor} className="min-w-0 cursor-pointer text-base leading-6 text-foreground">
        {label}
        {description ? <span className="mt-0.5 block text-sm text-muted-foreground">{description}</span> : null}
      </label>
    </div>
  );
}

export const RadioGroup = React.forwardRef<React.ElementRef<typeof RadioGroupPrimitive.Root>, React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>>(function RadioGroup(
  { className, ...props },
  ref,
) {
  const dir = useDirection();
  return <RadioGroupPrimitive.Root ref={ref} dir={dir} className={cn('grid gap-2.5', className)} {...props} />;
});

export const RadioGroupItem = React.forwardRef<React.ElementRef<typeof RadioGroupPrimitive.Item>, React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>>(function RadioGroupItem(
  { className, ...props },
  ref,
) {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-input bg-card shadow-xs transition-colors',
        'data-[state=checked]:border-secondary disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive',
        focusRing,
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="size-2.5 rounded-full bg-secondary" />
    </RadioGroupPrimitive.Item>
  );
});

export const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>>(function Switch(
  { className, ...props },
  ref,
) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-input transition-colors',
        'data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
        focusRing,
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0 rtl:data-[state=checked]:-translate-x-5" />
    </SwitchPrimitive.Root>
  );
});
