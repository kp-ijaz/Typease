import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, hslToHex } from './color';
import { baseVars, brandingToCss, brandingToCssVars, sanitiseColors, typeaseTheme, typeaseThemeCss, type CssVars } from './theme';
import { TYPEASE_COLORS } from './tokens';

const hex = (channels: string) => {
  const [h, s, l] = channels.replace(/%/g, '').split(' ').map(Number);
  return hslToHex({ h, s, l });
};
const ratio = (vars: CssVars, a: string, b: string) => contrastRatio(hex(vars[a]), hex(vars[b]));

/** Every text / background pair the components rely on, with the ratio it must reach. */
const PAIRS: Array<[string, string, number]> = [
  ['foreground', 'background', 7],
  ['foreground', 'card', 7],
  ['muted-foreground', 'background', 4.5],
  ['muted-foreground', 'card', 4.5],
  ['muted-foreground', 'muted', 4.5],
  ['input', 'card', 3],
  ...['primary', 'secondary', 'accent', 'destructive', 'success', 'warning', 'info'].flatMap(
    (n): Array<[string, string, number]> => [
      [`${n}-foreground`, n, 4.5],
      [`${n}-text`, `${n}-soft`, 4.5],
      [`${n}-text`, 'background', 4.5],
      [`${n}-text`, 'card', 4.5],
      [`${n}-text`, 'muted', 4.5],
    ],
  ),
  ['sidebar-foreground', 'sidebar', 4.5],
  ['sidebar-muted', 'sidebar', 4.5],
  ['sidebar-active-foreground', 'sidebar-active', 4.5],
  ['sidebar-foreground', 'sidebar-accent', 4.5],
  ['ring', 'background', 3],
];
/** Rounding HSL to one decimal can cost a few hundredths; the browser sees the same rounded values. */
const SLACK = 0.06;

function check(vars: CssVars, label: string) {
  for (const [fg, bg, min] of PAIRS) {
    expect(ratio(vars, fg, bg), `${label}: --${fg} on --${bg}`).toBeGreaterThanOrEqual(min - SLACK);
  }
}

describe('TypEase default theme', () => {
  const theme = typeaseTheme();
  it('meets WCAG AA in the light theme', () => check(theme.light, 'light'));
  it('meets WCAG AA in the dark theme', () => check(theme.dark, 'dark'));
  it('uses the navy brand colour for the sidebar and primary fills in the light theme', () => {
    expect(hex(theme.light.sidebar)).toBe(hex(theme.light['brand-primary']));
    expect(theme.light['primary-foreground']).toBe('0 0% 100%');
    expect(theme.light['accent-foreground']).toBe('0 0% 100%');
  });
  it('matches the generated stylesheet shipped by @typease/ui', () => {
    const css = readFileSync(resolve(__dirname, '../../ui/src/styles/theme.css'), 'utf8');
    expect(css).toBe(typeaseThemeCss());
  });
});

describe('brandingToCssVars', () => {
  const TENANTS: Record<string, { primary: string; secondary: string; accent: string }> = {
    typease: TYPEASE_COLORS,
    burgundyGold: { primary: '#5B1A3C', secondary: '#B4532A', accent: '#C8962E' },
    allWhite: { primary: '#FFFFFF', secondary: '#FFFFFF', accent: '#FFFFFF' },
    allBlack: { primary: '#000000', secondary: '#000000', accent: '#000000' },
    neonYellow: { primary: '#FFF200', secondary: '#FFE600', accent: '#F9FF00' },
    pastel: { primary: '#C2F0E1', secondary: '#FDE2E4', accent: '#E2ECFD' },
    midGrey: { primary: '#808080', secondary: '#7A7A7A', accent: '#858585' },
    sameAsSidebar: { primary: '#123456', secondary: '#123456', accent: '#123456' },
    hotPink: { primary: '#FF2D95', secondary: '#00E5FF', accent: '#7CFF00' },
  };
  for (const [name, colors] of Object.entries(TENANTS)) {
    it(`keeps every pair readable for "${name}"`, () => {
      const vars = brandingToCssVars({ colors });
      check({ ...baseVars('light'), ...vars.light }, `${name} light`);
      check({ ...baseVars('dark'), ...vars.dark }, `${name} dark`);
    });
  }
  it('keeps every pair readable for 300 arbitrary colour triples', () => {
    let s = 4711;
    const next = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return `#${(s >>> 8).toString(16).padStart(6, '0')}`;
    };
    for (let i = 0; i < 300; i++) {
      const colors = { primary: next(), secondary: next(), accent: next() };
      const vars = brandingToCssVars({ colors });
      check({ ...baseVars('light'), ...vars.light }, `${JSON.stringify(colors)} light`);
      check({ ...baseVars('dark'), ...vars.dark }, `${JSON.stringify(colors)} dark`);
    }
  });
  it('keeps the active navigation item visible when secondary equals primary', () => {
    const vars = brandingToCssVars({ colors: TENANTS.sameAsSidebar }).light;
    expect(ratio(vars, 'sidebar-active', 'sidebar')).toBeGreaterThanOrEqual(1.45);
  });
  it('exposes the raw colours for decoration', () => {
    const vars = brandingToCssVars({ colors: TENANTS.burgundyGold }).light;
    expect(hex(vars['brand-primary'])).toBe('#5B1A3C');
    expect(hex(vars['brand-accent'])).toBe('#C8962E');
  });
  it('falls back to TypEase colours for missing or invalid values', () => {
    expect(sanitiseColors({ primary: 'javascript:alert(1)', secondary: '', accent: undefined })).toEqual(TYPEASE_COLORS);
    expect(sanitiseColors(null)).toEqual(TYPEASE_COLORS);
    expect(brandingToCssVars(undefined)).toEqual(brandingToCssVars({ colors: TYPEASE_COLORS }));
  });
  it('produces a style block that cannot be broken out of', () => {
    const css = brandingToCss({ colors: { primary: '</style><script>', secondary: '#B4532A', accent: '#C8962E' } });
    expect(css).not.toContain('<');
    expect(css).toMatch(/^:root\{--primary:[\d. %]+;/);
    expect(css).toContain('.dark{');
  });
});
