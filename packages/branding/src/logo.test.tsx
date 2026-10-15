import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Logo, LogoIcon, LogoMark } from './logo';
import { FAVICON_SVG_DATA_URI } from './favicon';

describe('logo', () => {
  it('renders the mark with an accessible name', () => {
    const html = renderToStaticMarkup(<LogoMark size={46} />);
    expect(html).toContain('aria-label="TypEase"');
    expect(html).toContain('height="46"');
    expect(html).toContain('viewBox="0 0 112 92"');
  });
  it('uses the theme variable for "Typ" in auto tone and white on dark surfaces', () => {
    expect(renderToStaticMarkup(<Logo />)).toContain('var(--te-logo-typ, #0B2240)');
    expect(renderToStaticMarkup(<Logo tone="onDark" />)).toContain('fill:#FFFFFF');
    expect(renderToStaticMarkup(<Logo tone="onLight" />)).toContain('fill:#0B2240');
  });
  it('adds the tagline on request', () => {
    expect(renderToStaticMarkup(<Logo />)).not.toContain('Typing Made Easy');
    expect(renderToStaticMarkup(<Logo tagline />)).toContain('Typing Made Easy.');
  });
  it('gives every instance its own gradient ids', () => {
    const html = renderToStaticMarkup(
      <div>
        <Logo />
        <Logo />
        <LogoIcon />
      </div>,
    );
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const ref of html.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(ref[1]);
  });
  it('ships a favicon data URI', () => {
    expect(FAVICON_SVG_DATA_URI.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(FAVICON_SVG_DATA_URI)).toContain('</svg>');
  });
});
