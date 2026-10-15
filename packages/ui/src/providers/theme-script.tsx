import * as React from 'react';

/** Server-safe part of the theme: constants and the inline script that prevents a flash on load. */
export type ThemeChoice = 'light' | 'dark' | 'system';
export const THEME_STORAGE_KEY = 'te_theme';

/**
 * Runs before the first paint: reads the saved choice (or the device setting)
 * and sets the `dark` class. Kept tiny and dependency-free; it is the only
 * inline script the apps ship, and it carries the CSP nonce.
 */
export const themeInitScript = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');var d=t==='dark'||((!t||t==='system')&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;if(d)r.classList.add('dark');r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export function ThemeScript({ nonce }: { nonce?: string }) {
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript }} suppressHydrationWarning />;
}
