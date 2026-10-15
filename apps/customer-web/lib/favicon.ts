import type { PublicTenantConfig } from '@typease/types';

/**
 * The favicon of the portal: the centre's own when it uploaded one; for a
 * white-label centre without one, its initial on its primary colour (so that a
 * centre's domain never shows the TypEase icon); the TypEase icon otherwise.
 */
export function faviconFor(config: PublicTenantConfig | null): string {
  if (!config || config.mode !== 'WHITE_LABEL') return '/favicon.svg';
  if (config.faviconUrl) return config.faviconUrl;
  const initial = (Array.from(config.name.trim())[0] ?? '•').toUpperCase().replace(/[<>&"']/g, '');
  const colour = /^#[0-9a-fA-F]{6}$/.test(config.colors.primary) ? config.colors.primary : '#0B2240';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${colour}"/><text x="32" y="44" font-family="Arial,Helvetica,sans-serif" font-size="36" font-weight="700" text-anchor="middle" fill="#fff">${initial}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
