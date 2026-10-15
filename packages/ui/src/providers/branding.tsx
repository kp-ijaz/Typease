'use client';

import * as React from 'react';
import type { PublicTenantConfig } from '@typease/types';
import { BRAND_NAME, FAVICON_SVG_DATA_URI, brandingToCss } from '@typease/branding';
import { useI18n } from '../i18n/provider';
import { BRAND_STYLE_ID } from './brand-style';

export interface BrandingValue {
  /** The centre this screen is presented for, or null for plain TypEase. */
  config: PublicTenantConfig | null;
  isWhiteLabel: boolean;
  /** The centre's name in the active language, or "TypEase". */
  name: string;
  /**
   * What the product is called on this screen: the centre's name in a white-label app, "TypEase"
   * otherwise (the platform console, a TypEase-branded centre, no centre). Use it wherever a text names
   * the product ("the code for {brand}"); never write "TypEase" into a text a centre's users can see.
   */
  brandName: string;
  /** Replace the centre at run time (staff app after sign-in). */
  setConfig: (config: PublicTenantConfig | null) => void;
}

const BrandingContext = React.createContext<BrandingValue | null>(null);

function applyToDocument(config: PublicTenantConfig | null) {
  const head = document.head;
  let style = document.getElementById(BRAND_STYLE_ID) as HTMLStyleElement | null;
  if (config && config.mode === 'WHITE_LABEL') {
    if (!style) {
      style = document.createElement('style');
      style.id = BRAND_STYLE_ID;
      // Reuse the page's CSP nonce so the stylesheet is accepted under a strict policy.
      const nonce = (document.querySelector('script[nonce]') as HTMLScriptElement | null)?.nonce;
      if (nonce) style.nonce = nonce;
      head.appendChild(style);
    }
    const css = brandingToCss(config);
    if (style.textContent !== css) style.textContent = css;
  } else if (style) {
    style.remove();
  }
  const href = (config?.mode === 'WHITE_LABEL' && config.faviconUrl) || null;
  let icon = head.querySelector<HTMLLinkElement>('link[rel="icon"][data-te-brand]');
  if (href) {
    if (!icon) {
      icon = document.createElement('link');
      icon.rel = 'icon';
      icon.setAttribute('data-te-brand', '');
      head.appendChild(icon);
    }
    icon.href = href;
  } else if (icon) {
    icon.href = FAVICON_SVG_DATA_URI;
  }
}

/**
 * Holds the resolved centre and keeps the document in step with it: colours
 * (through `brandingToCssVars`), favicon, and the time zone / currency used for
 * formatting. On tenant domains pass the config resolved on the server and
 * render `<BrandStyle>` in <head>, so nothing has to change after hydration.
 */
export function BrandingProvider({ config: initial = null, children }: { config?: PublicTenantConfig | null; children: React.ReactNode }) {
  const [config, setConfigState] = React.useState<PublicTenantConfig | null>(initial);
  const { locale, setRegional } = useI18n();
  const first = React.useRef(true);

  React.useEffect(() => {
    // The server already rendered the initial state; only later changes touch the document.
    if (first.current) {
      first.current = false;
      if (initial === config) {
        if (config) setRegional({ timeZone: config.timezone, currency: config.currency });
        return;
      }
    }
    applyToDocument(config);
    if (config) setRegional({ timeZone: config.timezone, currency: config.currency });
  }, [config, initial, setRegional]);

  const setConfig = React.useCallback((next: PublicTenantConfig | null) => {
    setConfigState((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);

  const value = React.useMemo<BrandingValue>(() => {
    const isWhiteLabel = config?.mode === 'WHITE_LABEL';
    const name = config ? (locale === 'ar' && config.nameAr) || config.name : BRAND_NAME;
    return { config, isWhiteLabel, name, brandName: isWhiteLabel ? name : BRAND_NAME, setConfig };
  }, [config, locale, setConfig]);

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): BrandingValue {
  const value = React.useContext(BrandingContext);
  if (!value) throw new Error('useBranding must be used inside <BrandingProvider>.');
  return value;
}
