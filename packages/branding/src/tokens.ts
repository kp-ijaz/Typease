/**
 * TypEase design tokens.
 *
 * Brand colours were measured from the supplied logo and palette strip
 * (docs/brand/typease-brand-reference.png) and adjusted by eye against it.
 * Everything else in the theme is derived from these values in `theme.ts`,
 * so contrast is guaranteed by construction rather than by review.
 */

export const BRAND = {
  /** Deep navy: wordmark "Typ", sidebar, headings. */
  navy: '#0B2240',
  /** Bright blue: links, active navigation, focus. */
  blue: '#0B7AD1',
  /** Emerald: wordmark "Ease", "start something" actions, success. */
  emerald: '#00A166',
  /** Mint: soft highlights and illustrations. */
  mint: '#C2F0E1',
  /** Light grey: hairlines and quiet surfaces. */
  grey: '#E4E9ED',
} as const;

/** The three colours a tenant may override (PublicTenantConfig.colors). */
export interface BrandColors {
  primary: string;
  secondary: string;
  accent: string;
}

export const TYPEASE_COLORS: BrandColors = {
  primary: BRAND.navy,
  secondary: BRAND.blue,
  accent: BRAND.emerald,
};

/** Logo-only colours (gradient stops of the mark). */
export const LOGO = {
  deepBlue: '#0A3A8F',
  blue: '#0B7AD1',
  brightBlue: '#1487E3',
  emerald: '#12A866',
  teal: '#0C9A86',
  onDarkEmerald: '#2ED198',
} as const;

/** Cool neutral scale, tinted slightly towards the brand navy. */
export const NEUTRAL = {
  0: '#FFFFFF',
  25: '#FAFBFC',
  50: '#F5F7FA',
  100: '#EDF0F4',
  200: '#E1E6EC',
  300: '#CBD3DC',
  400: '#8D99AA',
  500: '#6B7889',
  600: '#4F5D70',
  700: '#364253',
  800: '#1F2A3A',
  850: '#172131',
  900: '#111A27',
  950: '#0A111C',
} as const;

/** Base hues of the semantic colours. Fills and text shades are derived per theme. */
export const SEMANTIC = {
  success: '#0E9F6E',
  warning: '#F2A31B',
  danger: '#D92D20',
  info: '#0B7AD1',
} as const;

export type ThemeMode = 'light' | 'dark';

/** Static surfaces of each theme. */
export const SURFACES: Record<
  ThemeMode,
  { background: string; foreground: string; card: string; popover: string; muted: string; mutedForeground: string; border: string; input: string }
> = {
  light: {
    background: NEUTRAL[50],
    foreground: '#0F1B2D',
    card: NEUTRAL[0],
    popover: NEUTRAL[0],
    muted: NEUTRAL[100],
    mutedForeground: '#566377',
    border: NEUTRAL[200],
    input: NEUTRAL[400],
  },
  dark: {
    background: NEUTRAL[950],
    foreground: '#E8EDF3',
    card: NEUTRAL[900],
    popover: NEUTRAL[850],
    muted: NEUTRAL[800],
    mutedForeground: '#A3AFBF',
    border: '#263345',
    input: '#5C6B80',
  },
};

export const FONT_FAMILY = {
  latin: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  arabic: "'IBM Plex Sans Arabic', 'Inter Variable', 'Segoe UI', Tahoma, Arial, sans-serif",
} as const;

export const BRAND_NAME = 'TypEase';
export const BRAND_TAGLINE = 'Typing Made Easy.';
