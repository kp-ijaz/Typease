'use client';

import * as React from 'react';
import { useController, useFormContext } from 'react-hook-form';
import { Checkbox, ChoiceLabel, Switch } from '@typease/ui';

/** A checkbox (or switch) bound to a boolean field of the surrounding <Form>. */
export function BooleanField({ name, label, description, variant = 'checkbox', disabled, className }: { name: string; label: React.ReactNode; description?: React.ReactNode; variant?: 'checkbox' | 'switch'; disabled?: boolean; className?: string }) {
  const { control } = useFormContext();
  const { field } = useController({ name, control });
  const id = React.useId();
  const control_ =
    variant === 'switch' ? (
      <Switch id={id} ref={field.ref} checked={!!field.value} onCheckedChange={(v) => field.onChange(v)} onBlur={field.onBlur} disabled={disabled} />
    ) : (
      <Checkbox id={id} ref={field.ref} checked={!!field.value} onCheckedChange={(v) => field.onChange(v === true)} onBlur={field.onBlur} disabled={disabled} />
    );
  return <ChoiceLabel htmlFor={id} control={control_} label={label} description={description} className={className} />;
}
