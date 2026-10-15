'use client';

import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn';
import { useDirection } from '../i18n/provider';
import { fieldClasses } from './input';

/**
 * A dropdown for a SHORT, fixed list (up to about ten options: status, type,
 * language). For long or searchable lists use <Combobox>.
 *
 *   <Select value={v} onValueChange={setV} options={[{ value: 'en', label: 'English' }]} placeholder={t('common.selectPlaceholder')} />
 */
export interface SelectOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
}
export interface SelectProps {
  value?: string | null;
  onValueChange?: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-describedby'?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  size?: 'sm' | 'md';
  onBlur?: () => void;
}

/**
 * Radix mirrors the value into a hidden native <select> (for forms). When the
 * value is set from outside (form.reset, setValue) before that select has the
 * matching option, the browser falls back to "" and Radix reports it as a
 * change. No option can have the value "" (Radix forbids it), so "" is never
 * a choice a person made: it is ignored here and forms need no workaround.
 */
const isEcho = (next: string) => next === '';

export const Select = React.forwardRef<HTMLButtonElement, SelectProps>(function Select(
  { value, onValueChange, options, placeholder, disabled, id, name, className, size = 'md', onBlur, ...aria },
  ref,
) {
  const dir = useDirection();
  const selected = value ? options.find((o) => o.value === value) : undefined;
  const handleChange = React.useCallback(
    (next: string) => {
      if (!isEcho(next)) onValueChange?.(next);
    },
    [onValueChange],
  );
  return (
    <SelectPrimitive.Root value={value ?? ''} onValueChange={handleChange} disabled={disabled} name={name} dir={dir}>
      <SelectPrimitive.Trigger
        ref={ref}
        id={id}
        onBlur={onBlur}
        className={cn(fieldClasses, 'items-center justify-between gap-2 text-start', size === 'sm' ? 'h-8 px-2.5 text-sm sm:text-sm' : 'h-10', 'data-[placeholder]:text-muted-foreground', className)}
        {...aria}
      >
        {/*
          The label is rendered here, by us, and NOT through <SelectPrimitive.Value>.
          Radix's Value is a node that the selected item portals its text into; giving it
          children as well (needed for the server-rendered HTML) makes two owners of one
          node for a render, which React reports ("Cannot use a ref on a React element as
          a container to createPortal ..."). Without a Value node there is nothing to
          portal into: one owner, and the label is in the first HTML.
        */}
        <span data-slot="select-value" className={cn('pointer-events-none truncate', !selected && 'text-muted-foreground')}>
          {selected ? selected.label : placeholder}
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className={cn(
            'z-50 max-h-[min(20rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          )}
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="relative flex min-h-9 cursor-default select-none items-center rounded-sm py-1.5 pe-8 ps-2.5 text-base outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-muted data-[disabled]:opacity-50"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute end-2 flex items-center">
                  <Check className="size-4 text-secondary-text" aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
});
