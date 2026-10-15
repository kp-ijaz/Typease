/**
 * @typease/ui: the TypEase design system and app infrastructure.
 * Consumed from source by the Next.js apps (`transpilePackages`).
 * Server components, route handlers and middleware import from '@typease/ui/src/server'
 * (aliased as '@typease/ui/server'): that entry has no client code.
 */

// ---- library
export * from './lib/cn';
export * from './lib/format';
export * from './lib/money';
export * from './lib/phone';
export * from './lib/countries';
export * from './lib/errors';
export * from './lib/status-meta';
export * from './lib/validation-messages';
export * from './lib/qr';
export * from './lib/tenant';
export * from './lib/press';
export * from './lib/roles';
export * from './lib/password-policy';

// ---- i18n
export * from './i18n';

// ---- providers
export * from './providers/theme';
export * from './providers/theme-script';
export * from './providers/query';
export * from './providers/branding';
export * from './providers/brand-style';
export * from './providers/auth';
export * from './providers/app-providers';

// ---- components
export * from './components/button';
export * from './components/spinner';
export * from './components/skeleton';
export * from './components/label';
export * from './components/input';
export * from './components/fields';
export * from './components/select';
export * from './components/combobox';
export * from './components/checkbox';
export * from './components/form';
export * from './components/file-upload';
export * from './components/file-viewer';
export * from './components/dialog';
export * from './components/confirm-dialog';
export * from './components/menus';
export * from './components/card';
export * from './components/badge';
export * from './components/avatar';
export * from './components/alert';
export * from './components/signature-pad';
export * from './components/empty-state';
export * from './components/toast';
export * from './components/table';
export * from './components/pagination';
export * from './components/display';
export * from './components/controls';
export * from './components/qr-code';
export * from './data-table/data-table';

// ---- shell and auth screens
export * from './shell/nav';
export * from './shell/app-shell';
export * from './shell/require-auth';
export * from './shell/support-session';
export * from './shell/pages';
export * from './auth/layout';
export * from './auth/sign-in';
export * from './auth/password';
export * from './auth/password-rules';
export * from './auth/verify-email';
export * from './auth/invitation';
export * from './auth/register';
export * from './auth/mfa-setup';
export * from './auth/sessions';
export * from './auth/use-after-sign-in';

// ---- brand (re-exported so apps need one import for the logo)
export { Logo, LogoIcon, LogoMark, BRAND, BRAND_NAME, BRAND_TAGLINE, brandingToCss, brandingToCssVars } from '@typease/branding';
