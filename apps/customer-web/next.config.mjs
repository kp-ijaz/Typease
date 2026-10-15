import { createNextConfig } from '@typease/config/next.mjs';

/**
 * Customer portal. Customers photograph documents with their phone (camera),
 * and on a centre's own domain the API is reached through this app's origin
 * (`/api/v1/*` rewrite) so that the session cookie is first-party.
 */
export default createNextConfig({ appDir: import.meta.dirname, camera: true, apiProxy: true });
