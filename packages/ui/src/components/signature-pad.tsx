'use client';

import * as React from 'react';
import { Eraser } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from './button';

export interface SignaturePadProps {
  /** Called with a PNG data URL after each stroke, or null when cleared. */
  onChange: (png: string | null) => void;
  label: string;
  clearLabel: string;
  hint?: string;
  className?: string;
}

/**
 * Draw a signature with a finger, pen or mouse. Exports a PNG with a white background, trimmed to a fixed
 * size so it stays a few kilobytes. Keyboard users get the typed name as their signature elsewhere on the form.
 */
export function SignaturePad({ onChange, label, clearLabel, hint, className }: SignaturePadProps) {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const drawing = React.useRef(false);
  const last = React.useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = React.useState(true);

  const reset = React.useCallback(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
  }, []);
  React.useEffect(reset, [reset]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * e.currentTarget.width, y: ((e.clientY - r.top) / r.height) * e.currentTarget.height };
  };
  const stroke = (to: { x: number; y: number }) => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || !last.current) return;
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    last.current = to;
  };

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={empty}
          onClick={() => {
            reset();
            setEmpty(true);
            onChange(null);
          }}
        >
          <Eraser aria-hidden="true" />
          {clearLabel}
        </Button>
      </div>
      <canvas
        ref={canvas}
        width={600}
        height={200}
        role="img"
        aria-label={label}
        className="h-40 w-full touch-none rounded-lg border-2 border-dashed border-input bg-white"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          last.current = point(e);
          stroke({ x: last.current.x + 0.1, y: last.current.y + 0.1 });
        }}
        onPointerMove={(e) => drawing.current && stroke(point(e))}
        onPointerUp={() => {
          if (!drawing.current) return;
          drawing.current = false;
          last.current = null;
          setEmpty(false);
          onChange(canvas.current?.toDataURL('image/png') ?? null);
        }}
      />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
