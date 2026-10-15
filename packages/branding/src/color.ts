/**
 * Colour maths for the theme: sRGB <-> HSL, WCAG 2.x relative luminance and
 * contrast, and helpers that move a colour until it is readable.
 * Pure functions, no DOM: used on the server (inlined CSS) and in the browser.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export interface Hsl {
  /** 0-360 */
  h: number;
  /** 0-100 */
  s: number;
  /** 0-100 */
  l: number;
}

export const WHITE = '#FFFFFF';
/** The darkest text colour of the neutral scale (not pure black, which looks harsh on brand fills). */
export const NEAR_BLACK = '#0A111C';

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value.trim());
}

export function parseHex(hex: string): Rgb {
  const m = HEX.exec(hex.trim());
  if (!m) throw new Error(`Not a hex colour: ${hex}`);
  let v = m[1];
  if (v.length === 3) v = v.split('').map((c) => c + c).join('');
  const n = parseInt(v, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function toHex({ r, g, b }: Rgb): string {
  const p = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`.toUpperCase();
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const sn = clamp(s, 0, 100) / 100;
  const ln = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number] = [0, 0, 0];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = ln - c / 2;
  return { r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255 };
}

export const hexToHsl = (hex: string): Hsl => rgbToHsl(parseHex(hex));
export const hslToHex = (hsl: Hsl): string => toHex(hslToRgb(hsl));

/** "214 71% 15%": the form Tailwind expects inside hsl(var(--x) / <alpha>). */
export function hslChannels(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  const r = (v: number) => (Math.round(v * 10) / 10).toString();
  return `${r(h)} ${r(s)}% ${r(l)}%`;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Linear mix in sRGB: 0 = a, 1 = b. */
export function mix(a: string, b: string, amount: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  const t = clamp(amount, 0, 1);
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

/**
 * Moves `color` along the lightness axis (keeping hue and saturation) until it
 * has at least `min` contrast against `against`. The direction is away from
 * `against`: darker on light surfaces, lighter on dark ones. If that end of
 * the scale is reached first, pure black / white is returned (which always
 * has the highest contrast available in that direction).
 */
export function ensureContrast(color: string, against: string, min: number): string {
  if (contrastRatio(color, against) >= min) return toHex(parseHex(color));
  const darker = relativeLuminance(against) > 0.18;
  const hsl = hexToHsl(color);
  let lo = darker ? 0 : hsl.l;
  let hi = darker ? hsl.l : 100;
  const end = darker ? '#000000' : '#FFFFFF';
  if (contrastRatio(end, against) < min) return end;
  // Binary search for the lightness closest to the original that satisfies the ratio.
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const ok = contrastRatio(hslToHex({ ...hsl, l: mid }), against) >= min;
    if (darker) {
      if (ok) lo = mid;
      else hi = mid;
    } else if (ok) hi = mid;
    else lo = mid;
  }
  const candidate = hslToHex({ ...hsl, l: darker ? lo : hi });
  // Rounding to 8-bit channels can land a hair below the target: step once more if needed.
  if (contrastRatio(candidate, against) >= min) return candidate;
  const nudged = hslToHex({ ...hsl, l: clamp((darker ? lo : hi) + (darker ? -1 : 1), 0, 100) });
  return contrastRatio(nudged, against) >= min ? nudged : end;
}

/** White or near-black, whichever reads better on `background`. */
export function readableOn(background: string): string {
  return contrastRatio(WHITE, background) >= contrastRatio(NEAR_BLACK, background) ? WHITE : NEAR_BLACK;
}

export interface SolidPair {
  /** The fill, possibly adjusted from the brand colour. */
  fill: string;
  /** Text / icon colour on the fill, contrast >= 4.5. */
  foreground: string;
}

/**
 * A button-style fill for a brand colour plus the text colour that goes on it.
 *
 *  - If white text already reads well (>= 4.5), the colour is used as is.
 *  - If the colour is dark-ish (white >= 3 but < 4.5) it is darkened just enough
 *    for white text. This keeps the "white on brand colour" look of the brand.
 *  - Light colours (yellow, mint ...) keep their value and get near-black text.
 *
 * `surface` is the page background the fill sits on: the fill is moved away
 * from it until it is distinguishable (>= `minAgainstSurface`), so a white brand
 * colour on a white page or a navy one on a dark page still gives a visible button.
 */
export function solidPair(color: string, surface: string, minAgainstSurface = 1.6): SolidPair {
  let fill = ensureContrast(color, surface, minAgainstSurface);
  const white = contrastRatio(WHITE, fill);
  if (white >= 4.5) return { fill, foreground: WHITE };
  if (white >= 3) {
    const darkened = ensureContrast(fill, WHITE, 4.5);
    if (contrastRatio(darkened, surface) >= minAgainstSurface) return { fill: darkened, foreground: WHITE };
  }
  if (contrastRatio(NEAR_BLACK, fill) < 4.5) fill = ensureContrast(fill, NEAR_BLACK, 4.5);
  return { fill, foreground: NEAR_BLACK };
}
