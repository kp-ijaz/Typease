import { createNextConfig } from '@typease/config/next.mjs';

/**
 * Corporate portal. Like the customer portal it can live on a centre's own
 * domain, where the API is reached through this app's origin (`/api/v1/*`
 * rewrite) so that the session cookie is first-party.
 */
export default createNextConfig({ appDir: import.meta.dirname, apiProxy: true });
