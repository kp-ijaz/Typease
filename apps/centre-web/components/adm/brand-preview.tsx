'use client';

import * as React from 'react';
import { BRAND_TAGLINE, Logo, NEAR_BLACK, WHITE, baseVars, brandingToCssVars, contrastRatio, ensureContrast, isHexColor, readableOn, sanitiseColors, solidPair, type BrandColors, type ThemeMode } from '@typease/branding';
import { Badge, Button, cn, useI18n } from '@typease/ui';

export interface PreviewBrand {
  mode: 'TYPEASE' | 'WHITE_LABEL';
  name: string;
  nameAr: string | null;
  logoUrl: string | null;
  tagline: string | null;
  colors: Partial<BrandColors>;
  invoiceFooter: string | null;
}

const toStyle = (vars: Record<string, string>): React.CSSProperties => Object.fromEntries(Object.entries(vars).map(([k, v]) => [`--${k}`, v])) as React.CSSProperties;

/**
 * LIVE PREVIEW of the chosen brand: a mini portal header, buttons, a badge and an invoice header,
 * once on the light and once on the dark theme. The colours go through `brandingToCssVars`, the
 * same function that themes the real portal, so what is shown here is what customers get,
 * including the automatically chosen readable text colours.
 */
export function BrandPreview({ brand, className }: { brand: PreviewBrand; className?: string }) {
  const { t, locale } = useI18n();
  const whiteLabel = brand.mode === 'WHITE_LABEL';
  const colors = sanitiseColors(whiteLabel ? brand.colors : null);
  const themed = React.useMemo(() => brandingToCssVars({ colors }), [colors.primary, colors.secondary, colors.accent]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (locale === 'ar' && brand.nameAr) || brand.name || t('adm.branding.preview.yourCentre');
  const tagline = whiteLabel ? brand.tagline : BRAND_TAGLINE;

  const panel = (mode: ThemeMode) => {
    const style = { ...toStyle({ ...baseVars(mode), ...themed[mode] }), '--te-logo-typ': mode === 'dark' ? WHITE : ensureContrast(colors.primary, WHITE, 4.5) } as React.CSSProperties;
    const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '•';
    return (
      <div style={style} className={cn('overflow-hidden rounded-lg border bg-background text-foreground', mode === 'dark' && 'dark')} data-preview={mode}>
        <p className="border-b bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">{mode === 'light' ? t('theme.light') : t('theme.dark')}</p>
        {/* mini portal header */}
        <div className="flex items-center justify-between gap-3 border-b bg-card px-3 py-2.5">
          <span className="flex min-w-0 items-center gap-2">
            {!whiteLabel ? (
              <Logo size={22} />
            ) : brand.logoUrl ? (
              // Plain <img>: tenant-uploaded logo URL, outside next/image's loader allow-list.
              <img src={brand.logoUrl} alt="" className="h-7 w-auto max-w-28 object-contain" />
            ) : (
              <>
                <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
                  {initial}
                </span>
                <span className="truncate text-sm font-semibold">{name}</span>
              </>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-3 text-xs">
            <span className="font-medium text-secondary-text">{t('adm.branding.preview.track')}</span>
            <span className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground">{t('adm.branding.preview.signIn')}</span>
          </span>
        </div>
        <div className="space-y-3 p-3">
          {tagline ? (
            <p className="text-sm text-muted-foreground" dir="auto">
              {tagline}
            </p>
          ) : null}
          {/* buttons and a badge */}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="accent" tabIndex={-1}>
              {t('adm.branding.preview.newRequest')}
            </Button>
            <Button size="sm" tabIndex={-1}>
              {t('common.save')}
            </Button>
            <Button size="sm" variant="secondary" tabIndex={-1}>
              {t('adm.branding.preview.pay')}
            </Button>
            <Button size="sm" variant="outline" tabIndex={-1}>
              {t('common.cancel')}
            </Button>
            <Badge tone="brand">{t('adm.branding.preview.badge')}</Badge>
          </div>
          {/* invoice header */}
          <div className="overflow-hidden rounded-md border bg-card">
            <div className="h-1.5 bg-primary" />
            <div className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-primary-text">{name}</p>
                <p className="text-xs text-muted-foreground">{t('adm.branding.preview.invoiceTo')}</p>
              </div>
              <div className="text-end">
                <p className="text-sm font-semibold">{t('adm.branding.preview.invoice')}</p>
                <p className="ltr-value tabular text-xs text-muted-foreground">INV-000123</p>
              </div>
            </div>
            {brand.invoiceFooter ? (
              <p className="line-clamp-2 border-t px-3 py-1.5 text-xs text-muted-foreground" dir="auto">
                {brand.invoiceFooter}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={cn('space-y-3', className)} aria-label={t('adm.branding.preview.title')} role="group" inert>
      {panel('light')}
      {panel('dark')}
    </div>
  );
}

export interface ColourCheck {
  /** The text colour chosen automatically on a button of this colour. */
  foreground: string;
  /** The colour was too light or too dark to be used as it is: buttons use an adjusted shade. */
  adjusted: boolean;
  /** Contrast between the button and its text (always 4.5 or more). */
  ratio: number;
}

/** What the theme does with one brand colour on a light page: used for the notes under each colour field. */
export function checkColour(hex: string): ColourCheck | null {
  if (!isHexColor(hex)) return null;
  const pair = solidPair(hex, WHITE, 1.6);
  return { foreground: pair.foreground, adjusted: pair.fill.toLowerCase() !== hex.toLowerCase(), ratio: contrastRatio(pair.fill, pair.foreground) };
}

/** Two brand colours that are hard to tell apart (the active menu item would vanish on the sidebar). */
export const tooSimilar = (a: string, b: string): boolean => isHexColor(a) && isHexColor(b) && contrastRatio(a, b) < 1.5;
export const isDarkText = (foreground: string) => foreground.toLowerCase() === NEAR_BLACK.toLowerCase();
export { readableOn };
