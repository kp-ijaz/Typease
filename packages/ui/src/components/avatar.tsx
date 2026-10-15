'use client';

import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { cn } from '../lib/cn';

const SIZES = { sm: 'size-8 text-xs', md: 'size-10 text-sm', lg: 'size-14 text-lg' } as const;

/** Up to two initials: first letters of the first and last word that start with a letter. Works for Arabic names too. */
export function initialsOf(name: string | null | undefined): string {
  const all = (name ?? '').trim().split(/\s+/).filter(Boolean);
  // "Sara Ali (HR)" -> SA, not S(. Falls back to every word when none starts with a letter.
  const letters = all.filter((word) => /^\p{L}/u.test(word));
  const words = letters.length ? letters : all;
  if (!words.length) return '?';
  const first = Array.from(words[0])[0] ?? '';
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? '' : '';
  return (first + last).toUpperCase();
}

export interface AvatarProps extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> {
  name: string | null | undefined;
  src?: string | null;
  size?: keyof typeof SIZES;
}

export function Avatar({ name, src, size = 'md', className, ...props }: AvatarProps) {
  return (
    <AvatarPrimitive.Root className={cn('relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-primary-soft font-semibold text-primary-text', SIZES[size], className)} {...props}>
      {src ? <AvatarPrimitive.Image src={src} alt="" className="size-full object-cover" /> : null}
      <AvatarPrimitive.Fallback delayMs={src ? 300 : undefined} aria-hidden="true">
        {initialsOf(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
