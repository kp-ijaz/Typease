import type { ApiErrorBody } from '@typease/types';

/**
 * Every failed call throws an ApiError: HTTP errors carry the API's stable
 * `code`; transport problems use the synthetic codes below with status 0.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;
  /**
   * true when `message` is the sentence the API wrote for this situation; false when this client had to
   * supply a general one (no usable body, network trouble). The UI prefers its own translated wording then.
   */
  readonly hasServerMessage: boolean;

  constructor(init: { status: number; code: string; message: string; details?: unknown; requestId?: string; cause?: unknown; hasServerMessage?: boolean }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId;
    this.hasServerMessage = init.hasServerMessage ?? true;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }

  /** The request never reached the API (offline, DNS, CORS, aborted by the network). */
  get isNetworkError(): boolean {
    return this.status === 0 && this.code === 'NETWORK_ERROR';
  }
  get isAborted(): boolean {
    return this.code === 'ABORTED';
  }
  /** Worth offering "Try again": network trouble, timeouts and 5xx. */
  get isRetryable(): boolean {
    return this.isNetworkError || this.code === 'TIMEOUT' || this.status >= 500 || this.status === 429;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ApiError');

const FALLBACK: Record<number, [string, string]> = {
  400: ['BAD_REQUEST', 'The request could not be understood.'],
  401: ['UNAUTHENTICATED', 'Please sign in to continue.'],
  403: ['FORBIDDEN', 'You do not have permission to do this.'],
  404: ['NOT_FOUND', 'This was not found.'],
  409: ['CONFLICT', 'This conflicts with the current state. Refresh and try again.'],
  413: ['PAYLOAD_TOO_LARGE', 'The upload is too large.'],
  422: ['UNPROCESSABLE', 'The data could not be processed.'],
  429: ['RATE_LIMITED', 'Too many attempts. Please wait and try again.'],
};

/** Builds an ApiError from a non-2xx response, whatever the body looks like. */
export async function errorFromResponse(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  let text = '';
  try {
    text = await res.text();
    body = text ? (JSON.parse(text) as Partial<ApiErrorBody>) : null;
  } catch {
    body = null;
  }
  const fallback = FALLBACK[res.status] ?? (res.status >= 500 ? ['SERVER_ERROR', 'Something went wrong on our side. Please try again.'] : ['HTTP_ERROR', `Request failed (${res.status}).`]);
  const valid = body && typeof body === 'object' && typeof body.code === 'string';
  const serverMessage = valid && typeof body!.message === 'string' && body!.message.trim() ? body!.message : undefined;
  return new ApiError({
    status: res.status,
    code: valid ? (body!.code as string) : fallback[0],
    message: serverMessage ?? fallback[1],
    hasServerMessage: serverMessage !== undefined,
    details: valid ? body!.details : undefined,
    requestId: (valid ? body!.requestId : undefined) ?? res.headers.get('x-request-id') ?? undefined,
  });
}

export function networkError(cause: unknown): ApiError {
  const aborted = typeof cause === 'object' && cause !== null && (cause as { name?: string }).name === 'AbortError';
  return new ApiError({
    status: 0,
    code: aborted ? 'ABORTED' : 'NETWORK_ERROR',
    message: aborted ? 'The request was cancelled.' : 'Could not reach the server. Check your connection and try again.',
    hasServerMessage: false,
    cause,
  });
}

/**
 * Field errors of a failed save, keyed by dotted field path ("address.city"), from
 *  - 400 VALIDATION_FAILED: details = [{ path, message }]
 *  - 422 FORM_INVALID (dynamic service forms): details = [{ field, code, message }]
 * Errors without a path are returned under "" (show them next to the submit button).
 */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  if (!isApiError(error) || !Array.isArray(error.details)) return {};
  const out: Record<string, string> = {};
  for (const item of error.details as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue;
    const path = typeof item.path === 'string' ? item.path : Array.isArray(item.path) ? item.path.join('.') : typeof item.field === 'string' ? item.field : '';
    const message = typeof item.message === 'string' ? item.message : '';
    if (message && !(path in out)) out[path] = message;
  }
  return out;
}
