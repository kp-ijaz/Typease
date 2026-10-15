import type { ApiClient } from '../client';
import { authApi, type ApiSessionHooks } from './auth';
import { customersApi } from './customers';
import { corporatePortalApi, organisationApi } from './organisation';
import { publicApi } from './public';
import { requestsApi } from './requests';

export { authApi, customersApi, corporatePortalApi, organisationApi, publicApi, requestsApi };
export type { CustomerListFilters } from './customers';
export type { ApiSessionHooks, SessionListQuery } from './auth';

/**
 * All typed endpoint groups of one client. Adding an endpoint is one line in
 * the group's file: path + response type from @typease/types (or ../types) +
 * input type from @typease/validation.
 *
 * Pass the app's session manager as `session` so that calls which END in a signed-in state
 * (`auth.exchangeSupportSession`) install the session themselves.
 */
export const createApi = (client: ApiClient, options: { session?: ApiSessionHooks } = {}) => ({
  client,
  auth: authApi(client, options.session),
  public: publicApi(client),
  requests: requestsApi(client),
  customers: customersApi(client),
  organisation: organisationApi(client),
  corporatePortal: corporatePortalApi(client),
});
export type Api = ReturnType<typeof createApi>;
