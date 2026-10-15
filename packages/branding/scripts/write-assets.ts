/**
 * Writes the static brand files from the React logo components and the tokens:
 *   packages/branding/assets/*.svg      logo files for documents, emails and app `public/` folders
 *   packages/ui/src/styles/theme.css    the default TypEase theme (CSS custom properties)
 *
 *   pnpm --filter @typease/branding assets
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Logo, LogoIcon, LogoMark } from '../src/logo';
import { typeaseThemeCss } from '../src/theme';

const root = resolve(__dirname, '..');
const write = (file: string, content: string) => {
  const path = resolve(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`wrote ${file} (${content.length} bytes)`);
};
/** Static files have no stylesheet: resolve the theme variable and drop React-only attributes. */
const svg = (el: React.ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/var\(--te-logo-typ, (#[0-9A-Fa-f]{6})\)/g, '$1')
    .replace(/ style="fill:(#[0-9A-Fa-f]{6}|[a-z]+)"/g, ' fill="$1"') + '\n';

write('assets/typease-mark.svg', svg(createElement(LogoMark, { size: 92, tone: 'onLight' })));
write('assets/typease-mark-on-dark.svg', svg(createElement(LogoMark, { size: 92, tone: 'onDark' })));
write('assets/typease-logo.svg', svg(createElement(Logo, { size: 92, tone: 'onLight' })));
write('assets/typease-logo-on-dark.svg', svg(createElement(Logo, { size: 92, tone: 'onDark' })));
write('assets/typease-logo-tagline.svg', svg(createElement(Logo, { size: 92, tone: 'onLight', tagline: true })));
write('assets/typease-logo-tagline-on-dark.svg', svg(createElement(Logo, { size: 92, tone: 'onDark', tagline: true })));
write('assets/favicon.svg', svg(createElement(LogoIcon, { size: 128 })));
write('../ui/src/styles/theme.css', typeaseThemeCss());
