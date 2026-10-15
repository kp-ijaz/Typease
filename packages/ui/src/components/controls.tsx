'use client';

import * as React from 'react';
import { Languages, Monitor, Moon, Sun } from 'lucide-react';
import { useI18n } from '../i18n/provider';
import { useSession } from '../providers/auth';
import { useTheme } from '../providers/theme';
import { Button, type ButtonProps } from './button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from './menus';

export interface LanguageSwitcherProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  /** "toggle": one button that switches to the other language (two languages only). "menu": a list. */
  mode?: 'toggle' | 'menu';
  /** Runs after the language changed (e.g. save the preference to the profile). */
  onChanged?: (locale: 'en' | 'ar') => void;
}

/**
 * Switches between English and Arabic. The button is labelled in the language
 * it switches TO, so someone who cannot read the current language finds it.
 */
export function LanguageSwitcher({ mode = 'toggle', onChanged, variant = 'ghost', size = 'sm', ...props }: LanguageSwitcherProps) {
  const { locale, setLocale, t } = useI18n();
  const change = (next: 'en' | 'ar') => {
    if (next === locale) return;
    setLocale(next);
    onChanged?.(next);
  };
  if (mode === 'toggle') {
    const next = locale === 'en' ? 'ar' : 'en';
    return (
      <Button variant={variant} size={size} onClick={() => change(next)} lang={next} aria-label={next === 'ar' ? t('common.switchToArabic') : t('common.switchToEnglish')} {...props}>
        <Languages aria-hidden="true" />
        <span className={next === 'ar' ? 'font-[IBM_Plex_Sans_Arabic,inherit]' : undefined}>{next === 'ar' ? t('common.arabic') : t('common.english')}</span>
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} aria-label={t('common.language')} {...props}>
          <Languages aria-hidden="true" />
          <span>{locale === 'ar' ? t('common.arabic') : t('common.english')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuCheckboxItem checked={locale === 'en'} onCheckedChange={() => change('en')} lang="en">
          English
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={locale === 'ar'} onCheckedChange={() => change('ar')} lang="ar">
          العربية
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Light / dark / match-device. Shows the icon of the theme in use. */
export function ThemeToggle({ variant = 'ghost', size = 'icon-sm', ...props }: Omit<ButtonProps, 'onClick' | 'children'>) {
  const { theme, resolved, setTheme } = useTheme();
  const { t } = useI18n();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const Icon = !mounted ? Sun : resolved === 'dark' ? Moon : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} aria-label={t('theme.toggle')} title={t('theme.toggle')} {...props}>
          <Icon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuCheckboxItem checked={theme === 'light'} onCheckedChange={() => setTheme('light')}>
          <Sun aria-hidden="true" />
          {t('theme.light')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={theme === 'dark'} onCheckedChange={() => setTheme('dark')}>
          <Moon aria-hidden="true" />
          {t('theme.dark')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={theme === 'system'} onCheckedChange={() => setTheme('system')}>
          <Monitor aria-hidden="true" />
          {t('theme.system')}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface PermissionGateProps {
  /** Render when the session holds this permission ... */
  permission?: string;
  /** ... or at least one of these. */
  anyOf?: readonly string[];
  /** ... and all of these. */
  allOf?: readonly string[];
  /** Shown instead when the permission is missing (default: nothing). */
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Renders its children only when the signed-in session has the permission.
 * This hides what a person cannot use; it is not security. The API enforces
 * every permission again on each call.
 */
export function PermissionGate({ permission, anyOf, allOf, fallback = null, children }: PermissionGateProps) {
  const { hasPermission, hasAnyPermission, isAuthenticated } = useSession();
  const allowed = isAuthenticated && (!permission || hasPermission(permission)) && (!anyOf || hasAnyPermission(anyOf)) && (!allOf || allOf.every(hasPermission));
  return <>{allowed ? children : fallback}</>;
}
