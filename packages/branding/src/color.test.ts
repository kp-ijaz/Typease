import { describe, expect, it } from 'vitest';
import {
  NEAR_BLACK, WHITE, contrastRatio, ensureContrast, hexToHsl, hslChannels, hslToHex, isHexColor, mix, parseHex, readableOn, relativeLuminance,
  solidPair, toHex,
} from './color';

/** Deterministic pseudo-random colours so that failures are reproducible. */
function* colours(count: number, seed = 20261009) {
  let s = seed;
  for (let i = 0; i < count; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    yield `#${(s >>> 8).toString(16).padStart(6, '0').toUpperCase()}`;
  }
}
const EDGE = ['#FFFFFF', '#000000', '#FFFF00', '#00FF00', '#FF0000', '#0000FF', '#808080', '#777777', '#767676', '#FEFEFE', '#010101', '#C2F0E1', '#0B2240'];

describe('hex / hsl conversion', () => {
  it('parses 3- and 6-digit hex with or without #', () => {
    expect(parseHex('#0B7AD1')).toEqual({ r: 11, g: 122, b: 209 });
    expect(parseHex('fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(() => parseHex('blue')).toThrow();
    expect(isHexColor('#12345')).toBe(false);
    expect(isHexColor('#00A166')).toBe(true);
  });
  it('round-trips through HSL within one 8-bit step', () => {
    for (const c of [...colours(300), ...EDGE]) {
      const a = parseHex(c);
      const b = parseHex(hslToHex(hexToHsl(c)));
      expect(Math.abs(a.r - b.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(a.g - b.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(a.b - b.b)).toBeLessThanOrEqual(1);
    }
  });
  it('formats HSL channels for Tailwind', () => {
    expect(hslChannels('#FFFFFF')).toBe('0 0% 100%');
    expect(hslChannels('#0B2240')).toBe('214 70.7% 14.7%');
    expect(toHex({ r: 300, g: -4, b: 127.6 })).toBe('#FF0080');
  });
});

describe('WCAG contrast', () => {
  it('matches the reference values of the specification', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBe(0);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1);
    // #767676 is the well-known lightest grey that passes AA on white; #777777 just fails.
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeLessThan(4.5);
  });
  it('is symmetric', () => {
    expect(contrastRatio('#0B7AD1', '#00A166')).toBeCloseTo(contrastRatio('#00A166', '#0B7AD1'), 10);
  });
  it('knows that the raw brand emerald and blue are too light for white text', () => {
    expect(contrastRatio('#00A166', WHITE)).toBeLessThan(4.5);
    expect(contrastRatio('#0B7AD1', WHITE)).toBeLessThan(4.5);
    expect(contrastRatio('#0B2240', WHITE)).toBeGreaterThan(12);
  });
});

describe('ensureContrast', () => {
  it('returns the colour unchanged when it already passes', () => {
    expect(ensureContrast('#0b2240', WHITE, 4.5)).toBe('#0B2240');
  });
  it('darkens on light surfaces and lightens on dark ones, keeping the hue', () => {
    const onWhite = ensureContrast('#00A166', WHITE, 4.5);
    expect(relativeLuminance(onWhite)).toBeLessThan(relativeLuminance('#00A166'));
    expect(Math.abs(hexToHsl(onWhite).h - hexToHsl('#00A166').h)).toBeLessThan(2);
    const onDark = ensureContrast('#0B2240', NEAR_BLACK, 4.5);
    expect(relativeLuminance(onDark)).toBeGreaterThan(relativeLuminance('#0B2240'));
    expect(Math.abs(hexToHsl(onDark).h - hexToHsl('#0B2240').h)).toBeLessThan(3);
  });
  it('always reaches the requested ratio when the surface allows it', () => {
    for (const c of [...colours(400), ...EDGE]) {
      for (const surface of [WHITE, '#F5F7FA', NEAR_BLACK, '#111A27']) {
        for (const min of [3, 4.5, 7]) {
          expect(contrastRatio(ensureContrast(c, surface, min), surface), `${c} on ${surface} @${min}`).toBeGreaterThanOrEqual(min);
        }
      }
    }
  });
  it('changes the colour as little as needed', () => {
    const adjusted = ensureContrast('#00A166', WHITE, 4.5);
    expect(contrastRatio(adjusted, WHITE)).toBeLessThan(4.75);
  });
});

describe('readableOn / solidPair', () => {
  it('picks white on dark fills and near-black on light fills', () => {
    expect(readableOn('#0B2240')).toBe(WHITE);
    expect(readableOn('#C2F0E1')).toBe(NEAR_BLACK);
    expect(readableOn('#FFD400')).toBe(NEAR_BLACK);
  });
  it('gives text of at least 4.5:1 on every fill, for any colour', () => {
    for (const c of [...colours(600), ...EDGE]) {
      for (const [surface, min] of [[WHITE, 1.6], ['#111A27', 3]] as const) {
        const pair = solidPair(c, surface, min);
        expect(contrastRatio(pair.foreground, pair.fill), `${c} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(pair.fill, surface), `${c} fill vs ${surface}`).toBeGreaterThanOrEqual(min - 0.05);
      }
    }
  });
  it('keeps white text on the brand emerald by darkening it slightly', () => {
    const pair = solidPair('#00A166', WHITE);
    expect(pair.foreground).toBe(WHITE);
    expect(pair.fill).not.toBe('#00A166');
    expect(Math.abs(hexToHsl(pair.fill).h - hexToHsl('#00A166').h)).toBeLessThan(2);
  });
  it('leaves a compliant colour untouched', () => {
    expect(solidPair('#0B2240', WHITE)).toEqual({ fill: '#0B2240', foreground: WHITE });
  });
  it('mixes linearly', () => {
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(mix('#0B2240', '#FFFFFF', 0)).toBe('#0B2240');
  });
});
