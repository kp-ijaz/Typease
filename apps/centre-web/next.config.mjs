import { createNextConfig } from '@typease/config/next.mjs';

// Staff app. The camera is allowed for document capture at the counter.
export default createNextConfig({ appDir: import.meta.dirname, camera: true });
