/**
 * TypEase Tailwind preset: semantic colour tokens bound to CSS custom
 * properties (packages/ui/src/styles/theme.css, overridable per tenant through
 * @typease/branding), radii, shadows and a restrained type scale.
 *
 * Colours come in up to four shades per token:
 *   bg-primary / text-primary-foreground   a filled control and the text on it (>= 4.5:1)
 *   bg-primary-soft / text-primary-text    a tinted surface and brand-coloured text on it (>= 4.5:1)
 * `text-primary-text` is also the shade to use for brand-coloured text on the page or a card.
 */
const withAlpha = (name) => `hsl(var(--${name}) / <alpha-value>)`;
const tone = (name) => ({
  DEFAULT: withAlpha(name),
  foreground: withAlpha(`${name}-foreground`),
  soft: withAlpha(`${name}-soft`),
  text: withAlpha(`${name}-text`),
});

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  theme: {
    container: { center: true, padding: { DEFAULT: '1rem', sm: '1.5rem', lg: '2rem' }, screens: { '2xl': '1280px' } },
    extend: {
      colors: {
        background: withAlpha('background'),
        foreground: withAlpha('foreground'),
        card: { DEFAULT: withAlpha('card'), foreground: withAlpha('card-foreground') },
        popover: { DEFAULT: withAlpha('popover'), foreground: withAlpha('popover-foreground') },
        muted: { DEFAULT: withAlpha('muted'), foreground: withAlpha('muted-foreground') },
        border: withAlpha('border'),
        input: withAlpha('input'),
        ring: withAlpha('ring'),
        primary: tone('primary'),
        secondary: tone('secondary'),
        accent: tone('accent'),
        destructive: tone('destructive'),
        success: tone('success'),
        warning: tone('warning'),
        info: tone('info'),
        sidebar: {
          DEFAULT: withAlpha('sidebar'),
          foreground: withAlpha('sidebar-foreground'),
          muted: withAlpha('sidebar-muted'),
          accent: withAlpha('sidebar-accent'),
          border: withAlpha('sidebar-border'),
          active: withAlpha('sidebar-active'),
          'active-foreground': withAlpha('sidebar-active-foreground'),
        },
        brand: { primary: withAlpha('brand-primary'), secondary: withAlpha('brand-secondary'), accent: withAlpha('brand-accent') },
      },
      // Preflight paints every border with borderColor.DEFAULT: make that the theme's hairline colour.
      borderColor: { DEFAULT: 'hsl(var(--border))' },
      ringColor: { DEFAULT: 'hsl(var(--ring))' },
      ringOffsetColor: { DEFAULT: 'hsl(var(--background))' },
      fontFamily: { sans: ['var(--font-sans)'], mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'] },
      // A deliberately short scale. `base` (14px) is the body size of the staff apps; `md` (16px) of the portals.
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        xs: ['0.75rem', { lineHeight: '1.125rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        md: ['1rem', { lineHeight: '1.5rem' }],
        lg: ['1.125rem', { lineHeight: '1.625rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.01em' }],
        '2xl': ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.015em' }],
        '3xl': ['1.875rem', { lineHeight: '2.375rem', letterSpacing: '-0.02em' }],
        '4xl': ['2.375rem', { lineHeight: '2.75rem', letterSpacing: '-0.022em' }],
        '5xl': ['3rem', { lineHeight: '3.25rem', letterSpacing: '-0.025em' }],
      },
      // Radius grows with the size of the surface: controls < cards < dialogs.
      borderRadius: { sm: '0.375rem', DEFAULT: '0.5rem', md: '0.5rem', lg: '0.75rem', xl: '1rem', '2xl': '1.25rem' },
      boxShadow: {
        xs: '0 1px 2px 0 hsl(216 50% 12% / 0.05)',
        sm: '0 1px 2px 0 hsl(216 50% 12% / 0.06), 0 1px 3px 0 hsl(216 50% 12% / 0.04)',
        md: '0 2px 4px -1px hsl(216 50% 12% / 0.06), 0 6px 16px -4px hsl(216 50% 12% / 0.10)',
        lg: '0 4px 8px -2px hsl(216 50% 12% / 0.08), 0 16px 40px -8px hsl(216 50% 12% / 0.18)',
      },
      spacing: { 4.5: '1.125rem', 13: '3.25rem', 15: '3.75rem', 18: '4.5rem' },
      keyframes: {
        'progress-indeterminate': { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(250%)' } },
      },
      animation: { 'progress-indeterminate': 'progress-indeterminate 1.2s ease-in-out infinite' },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
