import { LOGO } from './tokens';

/**
 * A compact copy of the app icon for <link rel="icon">, as a data URI, used when
 * a page has to set the favicon at run time (BrandingProvider falling back from
 * a tenant favicon). The static file lives in assets/favicon.svg.
 */
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="a" x1="20" y1="32" x2="76" y2="94" gradientUnits="userSpaceOnUse"><stop stop-color="${LOGO.deepBlue}"/><stop offset="1" stop-color="${LOGO.brightBlue}"/></linearGradient><linearGradient id="b" x1="104" y1="55" x2="65" y2="100" gradientUnits="userSpaceOnUse"><stop stop-color="${LOGO.emerald}"/><stop offset=".5" stop-color="${LOGO.teal}"/><stop offset="1" stop-color="${LOGO.blue}"/></linearGradient></defs><rect width="128" height="128" rx="28" fill="#fff"/><g transform="translate(10.5 21) scale(.94)"><path d="M15 9h63v10H60a6 6 0 0 0-6 6v52.5a5 5 0 0 1-5 5h-5.5a5 5 0 0 1-5-5V26.5H15a5 5 0 0 1-5-5V14a5 5 0 0 1 5-5Z" fill="url(#a)"/><path d="M78 9.8 100.2 33c.9 1 .3 2-.9 2H82.5A4.5 4.5 0 0 1 78 30.5V9.8Z" fill="${LOGO.emerald}"/><path d="M94 35h6.3c2.3 4 3.7 8.8 3.7 14 0 19-14.5 33.5-36 33.5H55.3c-1.7 0-2.1-1.3-.8-2.1C60 77 65.6 75.4 71.5 73.6 85.4 69.2 94 60.8 94 50V35Z" fill="url(#b)"/><g stroke="${LOGO.brightBlue}" stroke-width="2.8" stroke-linecap="round"><path d="M64.5 45h19M64.5 54h19M64.5 63h9"/></g><rect x="16.5" y="37.5" width="17" height="6.2" rx="3.1" fill="#0B2A6B"/><circle cx="10.3" cy="53.3" r="3.3" fill="${LOGO.emerald}"/></g></svg>`;

export const FAVICON_SVG_DATA_URI = `data:image/svg+xml,${encodeURIComponent(svg)}`;
