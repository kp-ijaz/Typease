'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn, focusRing } from '../lib/cn';
import { useT } from '../i18n/provider';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const overlay =
  'fixed inset-0 z-50 bg-[hsl(216_50%_8%/0.55)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0';

const SIZES = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' } as const;

export interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  size?: keyof typeof SIZES;
  /** Hide the close button (for flows that must end with an explicit choice). */
  hideClose?: boolean;
}

/**
 * A modal dialog. On phones it is a sheet attached to the bottom edge with its
 * own scroll area; from `sm` up a panel hanging from a fixed top edge, horizontally
 * centred, at most 84% of the window high, with the body scrolling inside. Structure:
 *   <DialogContent><DialogHeader><DialogTitle/><DialogDescription/></DialogHeader><DialogBody/>…<DialogFooter/></DialogContent>
 */
export const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(function DialogContent(
  { className, children, size = 'md', hideClose, ...props },
  ref,
) {
  const t = useT();
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlay} />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed z-50 flex max-h-[92dvh] w-full flex-col border bg-card text-card-foreground shadow-lg outline-none',
          // From `sm` up the panel hangs from a fixed top edge and is centred with auto margins (no transforms).
          // It is NOT vertically centred on purpose: a centred panel moves up AND down whenever its content
          // grows (a validation message, a loaded list), which moves controls away from under the pointer.
          'inset-x-0 bottom-0 rounded-t-xl sm:bottom-auto sm:top-[8dvh] sm:mx-auto sm:max-h-[84dvh] sm:rounded-xl',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-4 sm:data-[state=open]:slide-in-from-bottom-0 sm:data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          SIZES[size],
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close className={cn('absolute end-3 top-3 inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground', focusRing)}>
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">{t('common.close')}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 border-b px-5 py-4 pe-14 sm:px-6', className)} {...props} />;
}
export function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6', className)} {...props} />;
}
export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col-reverse gap-2 border-t bg-muted/40 px-5 py-3.5 sm:flex-row sm:justify-end sm:px-6 [&>*]:w-full sm:[&>*]:w-auto', className)} {...props} />;
}
export const DialogTitle = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Title>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>(function DialogTitle(
  { className, ...props },
  ref,
) {
  return <DialogPrimitive.Title ref={ref} className={cn('text-lg font-semibold leading-6 text-foreground', className)} {...props} />;
});
export const DialogDescription = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Description>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>>(
  function DialogDescription({ className, ...props }, ref) {
    return <DialogPrimitive.Description ref={ref} className={cn('text-base text-muted-foreground', className)} {...props} />;
  },
);

// ---------------------------------------------------------------- Sheet (side drawer)

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** "start" is the left edge in English and the right edge in Arabic. */
  side?: 'start' | 'end' | 'bottom';
  hideClose?: boolean;
}

/** A panel that slides in from an edge: navigation on small screens, detail views, filters. */
export const SheetContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, SheetContentProps>(function SheetContent(
  { className, children, side = 'end', hideClose, ...props },
  ref,
) {
  const t = useT();
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlay} />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed z-50 flex flex-col bg-card text-card-foreground shadow-lg outline-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          side === 'start' && 'inset-y-0 start-0 w-[min(20rem,88vw)] border-e ltr:data-[state=open]:slide-in-from-left rtl:data-[state=open]:slide-in-from-right',
          side === 'end' && 'inset-y-0 end-0 w-[min(28rem,92vw)] border-s ltr:data-[state=open]:slide-in-from-right rtl:data-[state=open]:slide-in-from-left',
          side === 'bottom' && 'inset-x-0 bottom-0 max-h-[88dvh] rounded-t-xl border-t data-[state=open]:slide-in-from-bottom',
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close className={cn('absolute end-3 top-3 inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground', focusRing)}>
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">{t('common.close')}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
export const SheetHeader = DialogHeader;
export const SheetBody = DialogBody;
export const SheetFooter = DialogFooter;
export const SheetTitle = DialogTitle;
export const SheetDescription = DialogDescription;
