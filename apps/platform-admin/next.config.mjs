import { createNextConfig } from '@typease/config/next.mjs';

// TypEase platform console (internal staff). No camera, no tenant proxy: it only ever talks to the API directly.
export default createNextConfig({ appDir: import.meta.dirname });
