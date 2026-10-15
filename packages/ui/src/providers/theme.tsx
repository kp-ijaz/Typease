'use client';

import * as React from 'react';
import { THEME_STORAGE_KEY, type ThemeChoice } from './theme-script';

export interface ThemeValue {
  /** What the person chose. */
  theme: ThemeChoice;
  /** What is shown right now ("system" resolved against the device setting). */
  resolved: 'light' | 'dark';
  setTheme: (theme: ThemeChoice) => void;
}

const ThemeContext = React.createContext<ThemeValue | null>(null);

const systemPrefersDark = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

function apply(resolved: 'light' | 'dark') {
  const root = document.documentElement;
  // Switching theme should not animate every colour on the page.
  root.classList.add('theme-switching');
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  window.setTimeout(() => root.classList.remove('theme-switching'), 0);
}

/**
 * Light / dark / match-device theme using the `dark` class on <html>.
 * Pair it with `<ThemeScript />` in <head>, which sets the class before the
 * first paint so the page never flashes the wrong theme.
 */
export function ThemeProvider({ defaultTheme = 'system', children }: { defaultTheme?: ThemeChoice; children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<ThemeChoice>(defaultTheme);
  const [resolved, setResolved] = React.useState<'light' | 'dark'>('light');

  React.useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    if (saved === 'light' || saved === 'dark' || saved === 'system') setThemeState(saved);
    setResolved(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  }, []);

  React.useEffect(() => {
    const compute = () => (theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme);
    const update = () => {
      const next = compute();
      setResolved(next);
      if (document.documentElement.classList.contains('dark') !== (next === 'dark')) apply(next);
    };
    update();
    if (theme !== 'system' || !window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, [theme]);

  const setTheme = React.useCallback((next: ThemeChoice) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const value = React.useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = React.useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>.');
  return value;
}
