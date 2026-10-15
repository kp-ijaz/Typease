import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn, focusRing } from '../lib/cn';
import { Spinner } from './spinner';

/**
 * Variants:
 *  - default      navy: confirm / save. The submit button of forms and dialogs.
 *  - accent       emerald: "start something" - the one primary action of a page (New request, Add customer, Search).
 *  - secondary    blue: an important alternative next to a default button.
 *  - outline      everything else that deserves a border (Cancel, Back, filters).
 *  - ghost / link low-emphasis actions inside rows and toolbars.
 *  - destructive  deleting, cancelling a request, voiding: always behind a ConfirmDialog.
 */
export const buttonVariants = cva(
  cn(
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
    focusRing,
  ),
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 active:bg-primary/85',
        accent: 'bg-accent text-accent-foreground shadow-xs hover:bg-accent/90 active:bg-accent/85',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/90 active:bg-secondary/85',
        outline: 'border border-input bg-card text-foreground shadow-xs hover:bg-muted active:bg-muted/80',
        subtle: 'bg-secondary-soft text-secondary-text hover:bg-secondary-soft/70',
        ghost: 'text-foreground hover:bg-muted active:bg-muted/80',
        link: 'h-auto px-0 text-secondary-text underline-offset-4 hover:underline',
        destructive: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 active:bg-destructive/85',
        'destructive-outline': 'border border-destructive/40 bg-card text-destructive-text hover:bg-destructive-soft',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-10 px-4 text-base',
        lg: 'h-12 px-6 text-md',
        icon: 'size-10',
        'icon-sm': 'size-8',
      },
    },
    compoundVariants: [{ variant: 'link', class: 'h-auto px-0' }],
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render the child element (for example a Next.js <Link>) with the button's look. */
  asChild?: boolean;
  /** Shows a spinner, keeps the width, and blocks further clicks. */
  loading?: boolean;
  /** Announced instead of the label while loading, e.g. t('common.saving'). */
  loadingText?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, loading = false, loadingText, disabled, children, type, ...props },
  ref,
) {
  if (asChild) {
    return (
      <Slot ref={ref} className={cn(buttonVariants({ variant, size }), className)} aria-disabled={disabled || undefined} {...props}>
        {children}
      </Slot>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), loading && 'relative cursor-progress disabled:opacity-100', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <span className="absolute inset-0 flex items-center justify-center">
            <Spinner size="sm" />
          </span>
          <span className="invisible inline-flex items-center gap-2">{children}</span>
          <span className="sr-only" role="status">
            {loadingText}
          </span>
        </>
      ) : (
        children
      )}
    </button>
  );
});
