import * as React from 'react';
import { BRAND, BRAND_NAME, BRAND_TAGLINE, LOGO } from './tokens';
import { WORDMARK_EASE, WORDMARK_TAGLINE, WORDMARK_TYP } from './wordmark-paths';

/**
 * The TypEase logo, hand-drawn as SVG after docs/brand/typease-brand-reference.png.
 *
 * The mark is a capital "T" whose stem turns into a document page with a
 * folded corner; the page's edge sweeps round into a "D"-shaped bowl, and
 * three speed lines trail to the left. Blue runs into emerald across the mark.
 *
 * `tone`:
 *  - "auto"   follows the theme: "Typ" is navy on light and white on dark (CSS variable --te-logo-typ).
 *  - "onDark" for brand-coloured or dark surfaces such as the sidebar: light strokes, white "Typ".
 *  - "onLight" forces the full-colour version.
 */
export type LogoTone = 'auto' | 'onLight' | 'onDark';

export const MARK_VIEWBOX = { width: 112, height: 92 } as const;
export const LOCKUP_VIEWBOX = { width: 352, height: 92 } as const;

interface Palette {
  tFrom: string;
  tTo: string;
  bowlFrom: string;
  bowlMid: string;
  bowlTo: string;
  fold: string;
  page: string;
  lines: string;
  speedBar: string;
  speedAccent: string;
  shade: string;
}

const ON_LIGHT: Palette = {
  tFrom: LOGO.deepBlue,
  tTo: LOGO.brightBlue,
  bowlFrom: LOGO.emerald,
  bowlMid: LOGO.teal,
  bowlTo: LOGO.blue,
  fold: LOGO.emerald,
  page: '#FFFFFF',
  lines: LOGO.brightBlue,
  speedBar: '#0B2A6B',
  speedAccent: LOGO.emerald,
  shade: '#06245F',
};
const ON_DARK: Palette = {
  tFrom: '#FFFFFF',
  tTo: '#CFE6FB',
  bowlFrom: LOGO.onDarkEmerald,
  bowlMid: '#3CCFB0',
  bowlTo: '#7CC4F5',
  fold: LOGO.onDarkEmerald,
  page: 'rgba(255,255,255,0.14)',
  lines: '#FFFFFF',
  speedBar: '#FFFFFF',
  speedAccent: LOGO.onDarkEmerald,
  shade: '#7FA9D6',
};

/** Shapes of the mark in its own 112 x 92 coordinate space. Shared by the mark, the lockup and the favicon. */
function MarkShapes({ id, p }: { id: string; p: Palette }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-t`} x1="10" y1="12" x2="70" y2="78" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={p.tFrom} />
          <stop offset="1" stopColor={p.tTo} />
        </linearGradient>
        <linearGradient id={`${id}-b`} x1="100" y1="36" x2="58" y2="84" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={p.bowlFrom} />
          <stop offset="0.5" stopColor={p.bowlMid} />
          <stop offset="1" stopColor={p.bowlTo} />
        </linearGradient>
        <linearGradient id={`${id}-s`} x1="18" y1="53" x2="54" y2="66" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={p.speedAccent} />
          <stop offset="0.55" stopColor={p.speedAccent} />
          <stop offset="1" stopColor={p.speedAccent} stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-d`} x1="55" y1="22" x2="44" y2="52" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={p.shade} stopOpacity="0.55" />
          <stop offset="1" stopColor={p.shade} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* page */}
      <path d="M60 19h18v11.5a4.5 4.5 0 0 0 4.5 4.5H94V50c0 10.8-8.6 19.2-22.5 23.6C65.4 75.5 59.6 77.2 54 80.8V25a6 6 0 0 1 6-6Z" fill={p.page} />
      {/* T: crossbar and stem */}
      <path
        d="M15 9h63v10H60a6 6 0 0 0-6 6v52.5a5 5 0 0 1-5 5h-5.5a5 5 0 0 1-5-5V26.5H15a5 5 0 0 1-5-5V14a5 5 0 0 1 5-5Z"
        fill={`url(#${id}-t)`}
      />
      {/* soft shadow where the page curls out of the stem */}
      <path d="M54 25a6 6 0 0 1 6-6h-6.5C47 19 44 24 44 31v24c3-3 6.5-5 10-5.8V25Z" fill={`url(#${id}-d)`} />
      {/* lowest speed line flows into the stem */}
      <path d="M20.3 50H38.5c8.5 0 14.5 6 15.5 15v9.5C51.5 63.5 46 56.6 37 56.6H20.3a3.3 3.3 0 0 1 0-6.6Z" fill={`url(#${id}-s)`} />
      {/* folded corner */}
      <path d="M78 9.8 100.2 33c.9 1 .3 2-.9 2H82.5A4.5 4.5 0 0 1 78 30.5V9.8Z" fill={p.fold} />
      {/* bowl of the D */}
      <path
        d="M94 35h6.3c2.3 4 3.7 8.8 3.7 14 0 19-14.5 33.5-36 33.5H55.3c-1.7 0-2.1-1.3-.8-2.1C60 77 65.6 75.4 71.5 73.6 85.4 69.2 94 60.8 94 50V35Z"
        fill={`url(#${id}-b)`}
      />
      {/* lines of text */}
      <g stroke={p.lines} strokeWidth="2.8" strokeLinecap="round">
        <path d="M64.5 45h19" />
        <path d="M64.5 54h19" />
        <path d="M64.5 63h9" />
      </g>
      {/* speed lines */}
      <rect x="16.5" y="37.5" width="17" height="6.2" rx="3.1" fill={p.speedBar} />
      <circle cx="10.3" cy="53.3" r="3.3" fill={p.speedAccent} />
    </>
  );
}

export interface LogoMarkProps extends Omit<React.SVGProps<SVGSVGElement>, 'children'> {
  /** Height in pixels (width follows the aspect ratio). */
  size?: number;
  tone?: LogoTone;
  title?: string;
}

/** The mark on its own: favicon-style uses, collapsed sidebar, loading screens. */
export function LogoMark({ size = 32, tone = 'auto', title = BRAND_NAME, ...rest }: LogoMarkProps) {
  const id = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const p = tone === 'onDark' ? ON_DARK : ON_LIGHT;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${MARK_VIEWBOX.width} ${MARK_VIEWBOX.height}`}
      height={size}
      width={(size * MARK_VIEWBOX.width) / MARK_VIEWBOX.height}
      role="img"
      aria-label={title}
      {...rest}
    >
      <title>{title}</title>
      <MarkShapes id={`tm${id}`} p={p} />
    </svg>
  );
}

export interface LogoProps extends Omit<React.SVGProps<SVGSVGElement>, 'children'> {
  /** Height in pixels (width follows the aspect ratio). */
  size?: number;
  tone?: LogoTone;
  /** Show "TYPING MADE EASY." under the wordmark. Leave it off below about 40px of height. */
  tagline?: boolean;
  title?: string;
}

/** Horizontal lockup: mark + "TypEase" wordmark, optionally with the tagline. */
export function Logo({ size = 36, tone = 'auto', tagline = false, title, style, ...rest }: LogoProps) {
  const id = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  const p = tone === 'onDark' ? ON_DARK : ON_LIGHT;
  const typFill = tone === 'onDark' ? '#FFFFFF' : tone === 'onLight' ? BRAND.navy : `var(--te-logo-typ, ${BRAND.navy})`;
  const easeFrom = tone === 'onDark' ? LOGO.onDarkEmerald : LOGO.emerald;
  const easeTo = tone === 'onDark' ? '#3CCFB0' : '#0B8F78';
  const label = title ?? (tagline ? `${BRAND_NAME} - ${BRAND_TAGLINE}` : BRAND_NAME);
  // Without the tagline the wordmark is centred on the mark; with it, the pair sits a little higher.
  const baseline = tagline ? 58.5 : 64.5;
  const wordX = 118;
  const easeX = wordX + WORDMARK_TYP.width + 1.2;
  const height = LOCKUP_VIEWBOX.height;
  const width = LOCKUP_VIEWBOX.width;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${height}`}
      height={size}
      width={(size * width) / height}
      role="img"
      aria-label={label}
      style={style}
      {...rest}
    >
      <title>{label}</title>
      <defs>
        <linearGradient id={`tw${id}`} x1={easeX} y1="0" x2={easeX + WORDMARK_EASE.width} y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={easeFrom} />
          <stop offset="1" stopColor={easeTo} />
        </linearGradient>
      </defs>
      <MarkShapes id={`tl${id}`} p={p} />
      <path d={WORDMARK_TYP.d} transform={`translate(${wordX} ${baseline})`} style={{ fill: typFill }} />
      <path d={WORDMARK_EASE.d} transform={`translate(${easeX} ${baseline})`} fill={`url(#tw${id})`} />
      {tagline ? (
        <g transform="translate(131 83.5)">
          <path d={WORDMARK_TAGLINE.d} style={{ fill: typFill }} opacity={tone === 'onDark' ? 0.86 : 0.9} />
          <circle cx={WORDMARK_TAGLINE.width + 3.4} cy="-1.1" r="1.25" fill={easeFrom} />
        </g>
      ) : null}
    </svg>
  );
}

/** Square app icon: the mark on a white rounded tile (favicon, PWA icon, avatar fallback). */
export function LogoIcon({ size = 32, title = BRAND_NAME, ...rest }: LogoMarkProps) {
  const id = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width={size} height={size} role="img" aria-label={title} {...rest}>
      <title>{title}</title>
      <rect width="128" height="128" rx="28" fill="#FFFFFF" />
      <g transform="translate(10.5 21) scale(0.94)">
        <MarkShapes id={`ti${id}`} p={ON_LIGHT} />
      </g>
    </svg>
  );
}
