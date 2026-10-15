/** A scripted fetch for unit tests: every call is recorded and answered by the handler. */
export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  credentials?: RequestCredentials;
}
export type Handler = (call: RecordedCall, index: number) => Response | Promise<Response>;

export function mockFetch(handler: Handler) {
  const calls: RecordedCall[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    let body: unknown = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep the text */
      }
    }
    const call: RecordedCall = { url: String(input), method: init.method ?? 'GET', headers, body, credentials: init.credentials };
    calls.push(call);
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
export const apiError = (status: number, code: string, message = code, details?: unknown) => json(status, { statusCode: status, code, message, details, requestId: 'req-12345678' });

/** In-memory BroadcastChannel: every channel created by the hub hears the others, never itself. */
export function channelHub() {
  const members: Array<{ listeners: Array<(e: { data: unknown }) => void>; closed: boolean }> = [];
  return {
    create() {
      const me = { listeners: [] as Array<(e: { data: unknown }) => void>, closed: false };
      members.push(me);
      return {
        postMessage(message: unknown) {
          const copy = JSON.parse(JSON.stringify(message));
          for (const m of members) if (m !== me && !m.closed) for (const l of m.listeners) l({ data: copy });
        },
        addEventListener(_type: 'message', listener: (e: { data: unknown }) => void) {
          me.listeners.push(listener);
        },
        close() {
          me.closed = true;
        },
      };
    },
  };
}

/** A mutex with the shape of navigator.locks, shared by the "tabs" of a test. */
export function lockManager() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      const run = (tails.get(name) ?? Promise.resolve()).then(callback, callback);
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}
