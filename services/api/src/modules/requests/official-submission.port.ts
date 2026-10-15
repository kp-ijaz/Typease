/**
 * Port for a REAL, authorised integration with an authority's official API.
 *
 * TypEase ships NO implementation of this class. Nothing in this code base
 * talks to a government system, and the OFFICIAL_API channel answers
 * OFFICIAL_INTEGRATION_NOT_AVAILABLE until a deployment registers an adapter.
 *
 * How an adapter would be added (see docs/api/modules/requests.md):
 *  1. The centre holds documented API access and provider-issued credentials.
 *     They are stored as an Integration row (category GOVERNMENT) by the
 *     integrations module, activated, and its authorisation is verified by a
 *     person (`authorisationVerifiedAt`).
 *  2. A module of that deployment implements this class against the official,
 *     documented API (approved authentication, rate limits, sandbox first) and
 *     provides it in a @Global() Nest module:
 *         { provide: OfficialSubmissionPort, useClass: MohreApiAdapter }
 *  3. The adapter never scrapes a portal, never solves a CAPTCHA, never
 *     intercepts an OTP and never invents a reference or a status. If the
 *     authority does not confirm, it throws.
 *
 * Only values returned by an adapter are stored with the status source
 * VERIFIED_OFFICIAL. Staff-typed values can never receive that label.
 */
export interface OfficialSubmissionInput {
  /** The verified, ACTIVE Integration row (category GOVERNMENT) of the tenant. */
  integrationId: string;
  provider: string;
  requestId: string;
  requestNo: string;
  /** Reference issued by the authority, as entered by staff after submitting through the official channel. */
  referenceNo: string;
  authorityName: string | null;
}
export interface OfficialSubmissionConfirmation {
  /** The reference as the authority knows it. */
  referenceNo: string;
  /** The authority's own status text, verbatim. */
  status: string;
}

export abstract class OfficialSubmissionPort {
  /** Integration providers (Integration.provider) this adapter serves. */
  abstract readonly providers: readonly string[];
  /** Asks the authority to confirm that the submission exists. Throws when it cannot be confirmed. */
  abstract confirmSubmission(input: OfficialSubmissionInput): Promise<OfficialSubmissionConfirmation>;
  /** Reads the current official status of an earlier submission. Throws when it cannot be read. */
  abstract fetchStatus(input: OfficialSubmissionInput): Promise<OfficialSubmissionConfirmation>;
}
