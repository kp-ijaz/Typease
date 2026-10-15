import { isApiError } from '@typease/api-client';

interface Translator {
  t: (key: string) => string;
  has: (key: string) => boolean;
}

/**
 * Sentences the API (or the client) uses when it has nothing specific to say.
 * They are not worth showing in English to someone reading Arabic: the
 * translated fallback says the same.
 */
const GENERAL_SENTENCES = new Set(['You do not have permission to do this.', 'Something went wrong. Please try again.', 'This was not found.']);

/** Errors the JavaScript engine or the browser raises: their messages are for developers. */
const ENGINE_ERRORS = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError', 'InternalError', 'AbortError', 'ChunkLoadError']);

/**
 * The sentence to show for a failed call. In this order:
 *
 *  1. `apiErrors.<CODE>` from the dictionaries: translated wording for a code that has ONE meaning
 *     ("INVALID_CREDENTIALS", "VERSION_CONFLICT"). The API writes its messages in English only, so
 *     this is what keeps such errors in the reader's language. Apps and sections add their own
 *     codes by putting an `apiErrors` block in their dictionary (both languages).
 *  2. The API's own message. It is written for end users and names the specifics ("Your plan
 *     includes 3 staff users ...", "Only a team member who manages tasks can cancel a task.").
 *     Codes the API uses for many situations (FORBIDDEN, NOT_FOUND, PLAN_LIMIT_REACHED, CONFLICT ...)
 *     must therefore NOT be in `apiErrors`.
 *  3. `apiErrorFallbacks.<CODE>`: a general, translated sentence for such a code when the API had
 *     nothing specific to say.
 *  4. A sentence for the kind of failure (network, permission, not found), then the generic one.
 *
 * Errors that are not API errors: a plain `Error` thrown on purpose (`throw new Error(t('...'))`)
 * shows its message; errors raised by the engine (TypeError ...) never do.
 */
export function describeError(error: unknown, i18n: Translator): string {
  if (isApiError(error)) {
    const { code, status } = error;
    if (code && i18n.has(`apiErrors.${code}`)) return i18n.t(`apiErrors.${code}`);
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    // `hasServerMessage` is false when the client had to make the sentence up (no body, no connection).
    if (message && error.hasServerMessage !== false && !GENERAL_SENTENCES.has(message)) return message;
    if (code && i18n.has(`apiErrorFallbacks.${code}`)) return i18n.t(`apiErrorFallbacks.${code}`);
    if (status === 0) return i18n.t('errors.network');
    if (status === 403) return i18n.t('errors.forbidden');
    if (status === 404) return i18n.t('errors.notFound');
    // An untranslated sentence from the API still says more than "something went wrong".
    return message && error.hasServerMessage !== false ? message : i18n.t('errors.generic');
  }
  if (error instanceof Error) {
    const message = error.message?.trim();
    if (message && !ENGINE_ERRORS.has(error.name) && !ENGINE_ERRORS.has(error.constructor?.name)) return message;
    return i18n.t('errors.generic');
  }
  if (typeof error === 'string' && error.trim()) return error.trim();
  return i18n.t('errors.generic');
}

export { safeNextPath } from './safe-path';
