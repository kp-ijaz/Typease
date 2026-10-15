import { SUPPORT_GRANTABLE } from '@typease/permissions';

/**
 * The tenant permissions a support access request may ask for: read-level only
 * (SUPPORT_GRANTABLE of @typease/permissions; the API refuses anything else).
 */
export const ACCESS_SCOPES: readonly string[] = SUPPORT_GRANTABLE;

/** Scopes that open personal data or files: drawn with a warning in the request form. */
export const SENSITIVE_SCOPES: ReadonlySet<string> = new Set(['customer.read', 'document.read']);

/** Dictionary path of a scope: "request.read.all" -> access.scopes.request_read_all. */
export const scopeKey = (scope: string) => `access.scopes.${scope.replace(/\./g, '_')}`;
