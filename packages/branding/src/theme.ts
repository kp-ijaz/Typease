import type { PublicTenantConfig } from '@typease/types';
import { NEAR_BLACK, WHITE, contrastRatio, ensureContrast, hslChannels, isHexColor, mix, readableOn, solidPair } from './color';
import { SEMANTIC, SURFACES, TYPEASE_COLORS, type BrandColors, type ThemeMode } from './tokens';

/** CSS custom property name (without the leading "--") -> value. */
export type CssVars = Record<string, string>;
export interface ThemedCssVars {
  light: CssVars;
  dark: CssVars;
}

/** Minimum contrast of a filled control against the surface it sits on. */
const FILL_VS_SURFACE: Record<ThemeMode, number> = { light: 1.6, dark: 3 };
/** How much of the colour goes into its "soft" tinted background. */
const SOFT_AMOUNT: Record<ThemeMode, number> = { light: 0.1, dark: 0.22 };

interface Tone {
  fill: string;
  foreground: string;
  soft: string;
  text: string;
}

/** Fill + on-fill text, a soft tint, and a text shade readable on the tint, the card and the page. */
function tone(color: string, mode: ThemeMode): Tone {
  const s = SURFACES[mode];
  const { fill, foreground } = solidPair(color, s.card, FILL_VS_SURFACE[mode]);
  const soft = mix(s.card, color, SOFT_AMOUNT[mode]);
  let text = color;
  // The adjustments all move in the same direction, so the last result satisfies every surface.
  for (let pass = 0; pass < 2; pass++) for (const surface of [soft, s.background, s.card, s.muted]) text = ensureContrast(text, surface, 4.5);
  return { fill, foreground, soft, text };
}

function toneVars(name: string, t: Tone): CssVars {
  return {
    [name]: hslChannels(t.fill),
    [`${name}-foreground`]: hslChannels(t.foreground),
    [`${name}-soft`]: hslChannels(t.soft),
    [`${name}-text`]: hslChannels(t.text),
  };
}

function sidebarVars(colors: BrandColors, mode: ThemeMode): CssVars {
  const s = SURFACES[mode];
  // Light theme: the sidebar is the brand colour itself. Dark theme: a deep surface carrying a hint of it.
  const base = mode === 'light' ? solidPair(colors.primary, s.background, 1) : { fill: mix('#0A111C', colors.primary, 0.3), foreground: WHITE };
  const fg = contrastRatio(base.foreground, base.fill) >= 4.5 ? base.foreground : readableOn(base.fill);
  // Headroom: the hover and active backgrounds sit between the sidebar and its text colour.
  const bg = ensureContrast(base.fill, fg, 6);
  const hover = ensureContrast(mix(bg, fg, 0.09), fg, 4.5);
  const muted = ensureContrast(mix(fg, bg, 0.32), bg, 4.5);
  let active = solidPair(colors.secondary, bg, 1.5);
  // A secondary colour too close to the sidebar would make the active item vanish: fall back to a neutral highlight.
  if (contrastRatio(active.fill, bg) < 1.5) active = { fill: mix(bg, fg, 0.2), foreground: fg };
  if (contrastRatio(active.foreground, active.fill) < 4.5) active = { ...active, foreground: readableOn(active.fill) };
  return {
    sidebar: hslChannels(bg),
    'sidebar-foreground': hslChannels(fg),
    'sidebar-muted': hslChannels(muted),
    'sidebar-accent': hslChannels(hover),
    'sidebar-border': hslChannels(mix(bg, fg, 0.13)),
    'sidebar-active': hslChannels(active.fill),
    'sidebar-active-foreground': hslChannels(active.foreground),
  };
}

/** The variables that depend on the three brand colours, for one theme. */
export function brandVars(colors: BrandColors, mode: ThemeMode): CssVars {
  const s = SURFACES[mode];
  return {
    ...toneVars('primary', tone(colors.primary, mode)),
    ...toneVars('secondary', tone(colors.secondary, mode)),
    ...toneVars('accent', tone(colors.accent, mode)),
    ring: hslChannels(ensureContrast(colors.secondary, s.background, 3)),
    ...sidebarVars(colors, mode),
    'brand-primary': hslChannels(colors.primary),
    'brand-secondary': hslChannels(colors.secondary),
    'brand-accent': hslChannels(colors.accent),
  };
}

/** The variables that never change with the tenant: surfaces and semantic colours. */
export function baseVars(mode: ThemeMode): CssVars {
  const s = SURFACES[mode];
  // Control borders must reach 3:1 against what they sit on (WCAG 1.4.11); quiet text 4.5:1 on every surface.
  let input = s.input;
  for (const surface of [s.card, s.background]) input = ensureContrast(input, surface, 3);
  let mutedForeground = s.mutedForeground;
  for (const surface of [s.muted, s.background, s.card]) mutedForeground = ensureContrast(mutedForeground, surface, 4.5);
  return {
    background: hslChannels(s.background),
    foreground: hslChannels(s.foreground),
    card: hslChannels(s.card),
    'card-foreground': hslChannels(s.foreground),
    popover: hslChannels(s.popover),
    'popover-foreground': hslChannels(s.foreground),
    muted: hslChannels(s.muted),
    'muted-foreground': hslChannels(mutedForeground),
    border: hslChannels(s.border),
    input: hslChannels(input),
    ...toneVars('destructive', tone(SEMANTIC.danger, mode)),
    ...toneVars('success', tone(SEMANTIC.success, mode)),
    ...toneVars('warning', tone(SEMANTIC.warning, mode)),
    ...toneVars('info', tone(SEMANTIC.info, mode)),
  };
}

/** Falls back to the TypEase colour for anything that is not a 3- or 6-digit hex value. */
export function sanitiseColors(colors: Partial<BrandColors> | null | undefined): BrandColors {
  const pick = (v: unknown, fallback: string) => (isHexColor(v) ? (v.startsWith('#') ? v : `#${v}`) : fallback);
  return {
    primary: pick(colors?.primary, TYPEASE_COLORS.primary),
    secondary: pick(colors?.secondary, TYPEASE_COLORS.secondary),
    accent: pick(colors?.accent, TYPEASE_COLORS.accent),
  };
}

/**
 * Converts a centre's colours into the CSS custom properties used by the theme
 * (HSL channels, e.g. "214 71% 15%"), for the light and the dark theme.
 *
 * Whatever a tenant chooses, every pair the UI uses stays readable:
 *  - text on a brand fill (`--primary-foreground` on `--primary` ...): >= 4.5
 *  - brand-coloured text (`--primary-text` ...) on page, card, muted and tinted surfaces: >= 4.5
 *  - sidebar text on the sidebar, and on the active item: >= 4.5
 *  - focus ring against the page: >= 3
 * The raw colours stay available as `--brand-*` for decoration (logo tiles, illustrations).
 */
export function brandingToCssVars(config: Pick<PublicTenantConfig, 'colors'> | { colors?: Partial<BrandColors> | null } | null | undefined): ThemedCssVars {
  const colors = sanitiseColors(config?.colors);
  return { light: brandVars(colors, 'light'), dark: brandVars(colors, 'dark') };
}

const declarations = (vars: CssVars) =>
  Object.entries(vars)
    .map(([k, v]) => `--${k}:${v};`)
    .join('');

/**
 * The same as `brandingToCssVars`, as a CSS string ready for a `<style>` tag.
 * Inline it from a server component so tenant domains never flash TypEase colours.
 */
export function brandingToCss(config: Parameters<typeof brandingToCssVars>[0]): string {
  const vars = brandingToCssVars(config);
  const logoLight = `--te-logo-typ:${ensureContrast(sanitiseColors(config?.colors).primary, WHITE, 4.5)};`;
  // The last block: printing from dark mode uses the centre's light colours (paper is white).
  return `:root{${declarations(vars.light)}${logoLight}}.dark{${declarations(vars.dark)}--te-logo-typ:${WHITE};}@media print{:root.dark{${declarations(vars.light)}${logoLight}}}`;
}

/** The complete default TypEase theme (base + brand variables) for both modes. */
export function typeaseTheme(): ThemedCssVars {
  return {
    light: { ...baseVars('light'), ...brandVars(TYPEASE_COLORS, 'light') },
    dark: { ...baseVars('dark'), ...brandVars(TYPEASE_COLORS, 'dark') },
  };
}

/** `theme.css` of @typease/ui is generated from this (pnpm --filter @typease/branding assets). */
export function typeaseThemeCss(): string {
  const t = typeaseTheme();
  const block = (vars: CssVars, extra: string) =>
    Object.entries(vars)
      .map(([k, v]) => `  --${k}: ${v};`)
      .concat(extra)
      .join('\n');
  return [
    '/* GENERATED by packages/branding/scripts/write-assets.ts from src/tokens.ts. Do not edit by hand. */',
    ':root {',
    block(t.light, `  --te-logo-typ: ${TYPEASE_COLORS.primary};`),
    '}',
    '.dark {',
    block(t.dark, `  --te-logo-typ: ${WHITE};`),
    '}',
    '/* Paper is white: someone working in dark mode prints with the light theme. */',
    '@media print {',
    '.dark {',
    block(t.light, `  --te-logo-typ: ${TYPEASE_COLORS.primary};`),
    '}',
    '}',
    '',
  ].join('\n');
}

export { NEAR_BLACK };
