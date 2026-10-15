import * as React from 'react';
import { encodeQr, qrPath, type QrErrorCorrection } from '../lib/qr';

export interface QrCodeProps extends Omit<React.SVGProps<SVGSVGElement>, 'children' | 'value'> {
  /** The text to encode (an otpauth:// link, a tracking URL). */
  value: string;
  /** Rendered size in pixels. */
  size?: number;
  errorCorrection?: QrErrorCorrection;
  /** Required: what the code is for, read by screen readers. */
  label: string;
}

/**
 * A QR code drawn as SVG by the built-in encoder (lib/qr.ts): nothing leaves
 * the browser. Always black on white with a quiet zone, also in the dark
 * theme, because scanners need that contrast.
 */
export function QrCode({ value, size = 200, errorCorrection = 'M', label, className, ...props }: QrCodeProps) {
  const { path, dim } = React.useMemo(() => {
    const code = encodeQr(value, { errorCorrection });
    return { path: qrPath(code, 4), dim: code.size + 8 };
  }, [value, errorCorrection]);
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${dim} ${dim}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges" className={className} {...props}>
      <rect width={dim} height={dim} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
