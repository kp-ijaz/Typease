import type { AppKey, LoginResult, SessionInfo, SupportGrant } from '@typease/types';
import { createApiClient, type ApiClient, type ApiClientOptions } from './client';
import { type ApiError, isApiError } from './errors';

/**
 * Browser session handling shared by the four web apps.
 *
 *  - The access token lives in memory only (never in storage).
 *  - The refresh token is an HttpOnly cookie scoped to /api/v1/auth; this code
 *    never sees it. `POST /auth/refresh` is sent with credentials and the
 *    custom header `X-Requested-With: typease` (the API's CSRF check).
 *  - Refresh tokens ROTATE, and presenting an old one ends the whole session
 *    family. Two tabs must therefore never refresh at the same time:
 *      1. inside a tab, concurrent callers share one promise (single flight);
 *      2. across tabs, a Web Lock serialises refreshes, and the winner
 *         broadcasts the new access token on a BroadcastChannel so that the
 *         tabs waiting for the lock use it instead of refreshing again.
 *    Browsers without Web Locks fall back to a BroadcastChannel announcement
 *    ("refreshing" / "token") with a short wait.
 */

export type SessionStatus =
  /** Not known yet: the silent refresh on page load is still running. */
  | 'loading'
  | 'authenticated'
  /** Nobody is signed in. */
  | 'anonymous'
  /** Somebody was signed in and the session ended (expired, revoked, signed out elsewhere). */
  | 'expired';

export interface SessionState {
  status: SessionStatus;
  session: SessionInfo | null;
  /** Why the session ended, when status is "expired" (API error code). */
  endedReason: string | null;
  /**
   * Set when the session that just ended was a TypEase support session (for whatever reason: the grant
   * ran out, the centre revoked it, the agent ended it). The app then says "this support session has
   * ended" instead of offering a sign-in. Cleared by the next sign-in.
   */
  endedSupportGrant?: SupportGrant | null;
}

export type LoginOk = Extract<LoginResult, { status: 'OK' }>;

/** What tabs tell each other. Access tokens only travel between same-origin tabs, in memory. */
type ChannelMessage =
  | { type: 'token'; accessToken: string; expiresAt: number; session: SessionInfo; from: string }
  | { type: 'refreshing'; from: string }
  | { type: 'signed-out'; reason: string; from: string };

export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}
export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface SessionManagerOptions extends Omit<ApiClientOptions, 'getAccessToken' | 'onUnauthorized'> {
  /** Inject for tests. Defaults to BroadcastChannel / navigator.locks when the browser has them. */
  channel?: ChannelLike | null;
  locks?: LockManagerLike | null;
  /** Refresh this long before the access token expires (default 60 s). 0 disables the timer. */
  refreshAheadMs?: number;
  now?: () => number;
}

export interface SessionManager {
  /** The API client of this app: sends the token and refreshes on 401. */
  readonly client: ApiClient;
  getState(): SessionState;
  subscribe(listener: (state: SessionState) => void): () => void;
  getAccessToken(): string | null;
  /** Silent sign-in on page load through the refresh cookie. Safe to call more than once. */
  bootstrap(): Promise<SessionInfo | null>;
  /** Single-flight refresh. Resolves with the new access token, or null when the session is over. */
  refresh(): Promise<string | null>;
  /** Store the result of a successful login / MFA / tenant selection / invitation. */
  acceptLogin(result: LoginOk): SessionInfo;
  /**
   * Second half of the support session hand-off: exchanges the one-time code the platform console put in
   * the address (`/support-session#code=...`) for a session of this app, and installs it like a sign-in.
   * The code works once and for 60 seconds; remove it from the address bar before calling.
   */
  exchangeSupportSession(code: string): Promise<LoginOk>;
  /** Re-read /auth/me after the profile, MFA or the active centre changed. */
  reload(): Promise<SessionInfo | null>;
  signOut(): Promise<void>;
  hasPermission(permission: string): boolean;
  hasAnyPermission(permissions: readonly string[]): boolean;
  destroy(): void;
}

/** 401 codes a refresh can cure. Everything else means the session itself is over or blocked. */
const REFRESHABLE = new Set(['TOKEN_INVALID', 'UNAUTHENTICATED']);
/** 401 codes that must not end the session: the user simply has to do something else first. */
const NOT_A_SESSION_END = new Set(['MFA_REQUIRED', 'INVALID_CREDENTIALS']);

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const app: AppKey = options.app;
  const now = options.now ?? (() => Date.now());
  const id = Math.random().toString(36).slice(2);
  const refreshAheadMs = options.refreshAheadMs ?? 60_000;

  let state: SessionState = { status: 'loading', session: null, endedReason: null };
  let accessToken: string | null = null;
  let expiresAt = 0;
  /** Counts the tokens this tab has received (own refresh or broadcast). */
  let tokenSeq = 0;
  let inFlight: Promise<string | null> | null = null;
  let bootstrapped: Promise<SessionInfo | null> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let otherTabRefreshingUntil = 0;
  const listeners = new Set<(s: SessionState) => void>();

  const channel: ChannelLike | null =
    options.channel !== undefined ? options.channel : typeof BroadcastChannel !== 'undefined' ? (new BroadcastChannel(`typease-session-${app}`) as unknown as ChannelLike) : null;
  const locks: LockManagerLike | null =
    options.locks !== undefined
      ? options.locks
      : typeof navigator !== 'undefined' && (navigator as { locks?: LockManagerLike }).locks
        ? ((navigator as unknown as { locks: LockManagerLike }).locks as LockManagerLike)
        : null;

  const setState = (next: SessionState) => {
    state = next;
    for (const l of [...listeners]) l(state);
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!refreshAheadMs || !accessToken) return;
    const delay = Math.max(5_000, expiresAt - now() - refreshAheadMs);
    timer = setTimeout(() => {
      // Hidden tabs wait until they are used again: fewer rotations, and the 401 path covers them.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refresh();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  };

  const store = (token: string, expiresInSeconds: number, session: SessionInfo) => {
    accessToken = token;
    expiresAt = now() + expiresInSeconds * 1000;
    tokenSeq++;
    setState({ status: 'authenticated', session, endedReason: null });
    schedule();
  };

  const end = (reason: string, broadcast: boolean) => {
    const wasSignedIn = state.status === 'authenticated';
    accessToken = null;
    expiresAt = 0;
    if (timer) clearTimeout(timer);
    timer = null;
    const signedOutByUser = reason === 'SIGNED_OUT';
    setState({
      status: wasSignedIn && !signedOutByUser ? 'expired' : 'anonymous',
      session: null,
      endedReason: wasSignedIn && !signedOutByUser ? reason : null,
      endedSupportGrant: state.session?.supportGrant ?? state.endedSupportGrant ?? null,
    });
    if (broadcast) channel?.postMessage({ type: 'signed-out', reason, from: id } satisfies ChannelMessage);
  };

  channel?.addEventListener('message', (event) => {
    const msg = event.data as ChannelMessage | undefined;
    if (!msg || typeof msg !== 'object' || msg.from === id) return;
    if (msg.type === 'token') {
      otherTabRefreshingUntil = 0;
      accessToken = msg.accessToken;
      expiresAt = msg.expiresAt;
      tokenSeq++;
      setState({ status: 'authenticated', session: msg.session, endedReason: null });
      schedule();
    } else if (msg.type === 'refreshing') {
      otherTabRefreshingUntil = now() + 8_000;
    } else if (msg.type === 'signed-out') {
      otherTabRefreshingUntil = 0;
      if (state.status === 'authenticated' || state.status === 'loading') end(msg.reason === 'SIGNED_OUT' ? 'SIGNED_OUT_ELSEWHERE' : msg.reason, false);
    }
  });

  // The raw client is used for the refresh call itself: no token, no refresh-on-401 recursion.
  const raw = createApiClient({ ...options, getAccessToken: undefined, onUnauthorized: undefined });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function refreshOnce(seqAtStart: number): Promise<string | null> {
    // Another tab (or an earlier holder of the lock) delivered a token while we were waiting: use it.
    if (accessToken && tokenSeq !== seqAtStart) return accessToken;
    channel?.postMessage({ type: 'refreshing', from: id } satisfies ChannelMessage);
    try {
      const result = await raw.post<LoginOk>('/auth/refresh', { app }, { auth: false });
      store(result.accessToken, result.expiresIn, result.session);
      channel?.postMessage({ type: 'token', accessToken: result.accessToken, expiresAt, session: result.session, from: id } satisfies ChannelMessage);
      return result.accessToken;
    } catch (e) {
      if (isApiError(e) && (e.status === 401 || e.status === 403)) {
        end(e.code, true);
        return null;
      }
      // Network trouble or a server error is not the end of the session: keep what we have.
      if (state.status === 'loading') setState({ status: 'anonymous', session: null, endedReason: null });
      throw e;
    }
  }

  function refresh(): Promise<string | null> {
    if (inFlight) return inFlight;
    const seqAtStart = tokenSeq;
    const run = async () => {
      if (locks) return locks.request(`typease-refresh-${app}`, () => refreshOnce(seqAtStart));
      // No Web Locks: if another tab announced a refresh, give it a moment to share the result.
      const deadline = now() + 4_000;
      while (otherTabRefreshingUntil > now() && now() < deadline && tokenSeq === seqAtStart) await sleep(50);
      return refreshOnce(seqAtStart);
    };
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  const client = createApiClient({
    ...options,
    getAccessToken: () => accessToken,
    onUnauthorized: async (error: ApiError) => {
      if (NOT_A_SESSION_END.has(error.code)) return null;
      if (!REFRESHABLE.has(error.code)) {
        end(error.code, true);
        return null;
      }
      try {
        return await refresh();
      } catch {
        return null;
      }
    },
  });

  function bootstrap(): Promise<SessionInfo | null> {
    if (!bootstrapped) {
      bootstrapped = refresh()
        .then(() => state.session)
        .catch(() => null);
    }
    return bootstrapped;
  }

  const hasPermission = (permission: string) => !!state.session?.permissions.includes(permission);

  function acceptLogin(result: LoginOk): SessionInfo {
    store(result.accessToken, result.expiresIn, result.session);
    bootstrapped = Promise.resolve(result.session);
    channel?.postMessage({ type: 'token', accessToken: result.accessToken, expiresAt, session: result.session, from: id } satisfies ChannelMessage);
    return result.session;
  }

  return {
    client,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAccessToken: () => accessToken,
    bootstrap,
    refresh,
    acceptLogin,
    async exchangeSupportSession(code) {
      // Public call (there is no session yet); the refresh cookie arrives with the answer.
      const result = await raw.post<LoginOk>('/auth/support-session/exchange', { code }, { auth: false });
      acceptLogin(result);
      return result;
    },
    async reload() {
      if (!accessToken) return null;
      const session = await client.get<SessionInfo>('/auth/me');
      setState({ status: 'authenticated', session, endedReason: null });
      channel?.postMessage({ type: 'token', accessToken: accessToken!, expiresAt, session, from: id } satisfies ChannelMessage);
      return session;
    },
    async signOut() {
      try {
        await raw.post('/auth/logout', { app }, { auth: false });
      } catch {
        /* the cookie may already be gone; the local sign-out below still happens */
      }
      end('SIGNED_OUT', true);
      bootstrapped = Promise.resolve(null);
    },
    hasPermission,
    hasAnyPermission: (permissions) => permissions.length === 0 || permissions.some(hasPermission),
    destroy() {
      if (timer) clearTimeout(timer);
      listeners.clear();
      channel?.close();
    },
  };
}
