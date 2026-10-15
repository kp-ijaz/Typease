import type { ApiClient } from '../client';
import type { BranchSummary, CorporatePortalAccount } from '../types';

export const organisationApi = (c: ApiClient) => ({
  branches: () => c.get<BranchSummary[]>('/branches'),
});

/** Corporate portal: the company bound to the signed-in membership. */
export const corporatePortalApi = (c: ApiClient) => ({
  account: () => c.get<CorporatePortalAccount>('/corporate/account'),
});
