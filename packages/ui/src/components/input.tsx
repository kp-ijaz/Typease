import * as React from 'react';
import { cn } from '../lib/cn';

/**
 * Shared look of text controls. 16px text below the `sm` breakpoint stops iOS
 * from zooming into the field; `aria-invalid` paints the error state.
 */
export const fieldClasses = cn(
  'flex w-full min-w-0 rounded-md border border-input bg-card px-3 text-md text-foreground shadow-xs transition-colors sm:text-base',
  'placeholder:text-muted-foreground/80',
  'outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
  'disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground',
  'read-only:bg-muted/60',
  'aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/25',
);

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** An icon or short text inside the field at its start (left in English, right in Arabic). */
  startAdornment?: React.ReactNode;
  endAdornment?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input({ className, type = 'text', startAdornment, endAdornment, ...props }, ref) {
  if (!startAdornment && !endAdornment) {
    return <input ref={ref} type={type} className={cn(fieldClasses, 'h-10', className)} {...props} />;
  }
  return (
    // The adornments follow the direction of the field's CONTENT: an LTR field (email, amount, password)
    // inside an Arabic page keeps its icon / unit on the side where the text does not start.
    <div dir={props.dir} className="relative flex w-full items-center">
      {startAdornment ? <span className="pointer-events-none absolute start-3 flex items-center text-muted-foreground [&_svg]:size-4">{startAdornment}</span> : null}
      <input ref={ref} type={type} className={cn(fieldClasses, 'h-10', startAdornment && 'ps-9', endAdornment && 'pe-10', className)} {...props} />
      {endAdornment ? <span className="absolute end-1.5 flex items-center text-muted-foreground [&_svg]:size-4">{endAdornment}</span> : null}
    </div>
  );
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, rows = 3, ...props }, ref) {
  return <textarea ref={ref} rows={rows} className={cn(fieldClasses, 'min-h-20 resize-y py-2 leading-6', className)} {...props} />;
});
