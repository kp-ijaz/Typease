import * as React from 'react';
import type { PublicTenantConfig } from '@typease/types';
import { Logo, LogoMark, brandingToCss, type LogoTone } from '@typease/branding';
import { cn } from '../lib/cn';

export const BRAND_STYLE_ID = 'te-brand';

/**
 * Inlines the centre's colours as CSS custom properties. Render it in <head>
 * from the root layout (server) so that a white-label domain is painted in the
 * centre's colours from the first byte: no flash of TypEase branding.
 * Renders nothing for TypEase-branded centres (the stylesheet already has the defaults).
 */
export function BrandStyle({ config, nonce }: { config: PublicTenantConfig | null | undefined; nonce?: string }) {
  if (!config || config.mode !== 'WHITE_LABEL') return null;
  // Browsers hide the nonce attribute once the element is parsed, so React would
  // report a difference on hydration: the warning is suppressed for this element only.
  return <style id={BRAND_STYLE_ID} nonce={nonce} dangerouslySetInnerHTML={{ __html: brandingToCss(config) }} suppressHydrationWarning />;
}

export interface BrandLogoProps {
  config?: PublicTenantConfig | null;
  /** Height in pixels. */
  size?: number;
  /** "onDark" on the sidebar and other brand-coloured surfaces. */
  tone?: LogoTone;
  /** The active language: Arabic shows the centre's Arabic name when it has one. */
  locale?: string;
  /** Only the mark / initial, for a collapsed sidebar. */
  compact?: boolean;
  className?: string;
}

/**
 * The logo of whoever the screen belongs to: the centre's own logo (or its name
 * set in type when it has not uploaded one) for white-label centres, the
 * TypEase logo otherwise.
 */
export function BrandLogo({ config, size = 32, tone = 'auto', locale, compact, className }: BrandLogoProps) {
  if (!config || config.mode !== 'WHITE_LABEL') {
    return compact ? <LogoMark size={size} tone={tone} className={className} /> : <Logo size={size} tone={tone} className={className} />;
  }
  const name = (locale === 'ar' && config.nameAr) || config.name;
  if (config.logoUrl && !compact) {
    // Plain <img>: the logo is a tenant-uploaded URL on an arbitrary host, outside next/image's loader allow-list.
    return <img src={config.logoUrl} alt={name} height={size} style={{ height: size, width: 'auto', maxWidth: size * 6 }} className={cn('object-contain', className)} />;
  }
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '•';
  const onDark = tone === 'onDark';
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2.5', className)} style={{ height: size }}>
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-md font-semibold',
          onDark ? 'bg-sidebar-foreground/15 text-sidebar-foreground' : 'bg-primary text-primary-foreground',
        )}
        style={{ height: size, width: size, fontSize: size * 0.5 }}
      >
        {initial}
      </span>
      {compact ? (
        <span className="sr-only">{name}</span>
      ) : (
        // dir="auto": a centre name written in the other direction is cut at its end, not at its beginning.
        <span dir="auto" className={cn('truncate font-semibold leading-tight', onDark ? 'text-sidebar-foreground' : 'text-foreground')} style={{ fontSize: Math.max(14, size * 0.5) }}>
          {name}
        </span>
      )}
    </span>
  );
}
