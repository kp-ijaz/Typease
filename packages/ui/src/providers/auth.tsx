'use client';

import * as React from 'react';
import type { AppKey, SessionInfo, SupportGrant } from '@typease/types';
import { createApi, createSessionManager, type Api, type ApiClient, type LoginOk, type SessionManager, type SessionState, type SessionStatus } from '@typease/api-client';
import { useI18n } from '../i18n/provider';

interface AuthContextValue {
  manager: SessionManager;
  api: Api;
  app: AppKey;
  loginPath: string;
  homePath: string;
}
const AuthContext = React.createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  /** Which application this is: decides the refresh cookie and what kind of account may sign in. */
  app: AppKey;
  /** API origin from the app's config module ("" = same-origin proxy). */
  apiBaseUrl: string;
  /** Where signed-out visitors are sent. */
  loginPath?: string;
  /** Where signed-in visitors land when no other page was asked for. */
  homePath?: string;
  /** Explicit portal host for white-label resolution (defaults to the browser's host). */
  tenantHost?: string;
  children: React.ReactNode;
}

const SERVER_STATE: SessionState = { status: 'loading', session: null, endedReason: null };

/**
 * Session handling for an app (see @typease/api-client `createSessionManager`):
 * access token in memory only, silent sign-in on load through the HttpOnly
 * refresh cookie, refresh on 401, one refresh at a time across tabs.
 */
export function AuthProvider({ app, apiBaseUrl, loginPath = '/sign-in', homePath = '/', tenantHost, children }: AuthProviderProps) {
  const { setRegional } = useI18n();
  const ref = React.useRef<AuthContextValue | null>(null);
  if (!ref.current) {
    const manager = createSessionManager({
      baseUrl: apiBaseUrl,
      app,
      tenantHost,
      locale: () => (typeof document !== 'undefined' ? document.documentElement.lang || 'en' : 'en'),
    });
    // The manager is attached so that `api.auth.exchangeSupportSession(code)` installs the session it gets.
    ref.current = { manager, api: createApi(manager.client, { session: manager }), app, loginPath, homePath };
  }
  const value = ref.current;

  React.useEffect(() => {
    void value.manager.bootstrap();
    const applyRegional = (state: SessionState) => {
      if (state.session?.tenant) setRegional({ timeZone: state.session.tenant.timezone, currency: state.session.tenant.currency });
    };
    applyRegional(value.manager.getState());
    return value.manager.subscribe(applyRegional);
  }, [value, setRegional]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuthContext(): AuthContextValue {
  const value = React.useContext(AuthContext);
  if (!value) throw new Error('useSession / useApi must be used inside <AuthProvider>.');
  return value;
}

export interface SessionValue {
  status: SessionStatus;
  isAuthenticated: boolean;
  isLoading: boolean;
  session: SessionInfo | null;
  user: SessionInfo['user'] | null;
  tenant: SessionInfo['tenant'];
  membership: SessionInfo['membership'];
  permissions: string[];
  /** API error code that ended the session, when status is "expired". */
  endedReason: string | null;
  /** The access grant of a running TypEase support session (see <SupportSessionBanner>); null for everybody else. */
  supportGrant: SupportGrant | null;
  /** Set once a support session is over (expired, revoked or ended by the agent): there is nothing to sign in to. */
  endedSupportGrant: SupportGrant | null;
  hasPermission: (permission: string) => boolean;
  /** True when `permissions` is empty or the session holds at least one of them. */
  hasAnyPermission: (permissions: readonly string[]) => boolean;
  acceptLogin: (result: LoginOk) => SessionInfo;
  reload: () => Promise<SessionInfo | null>;
  signOut: () => Promise<void>;
  app: AppKey;
  loginPath: string;
  homePath: string;
}

export function useSession(): SessionValue {
  const { manager, app, loginPath, homePath } = useAuthContext();
  const state = React.useSyncExternalStore(manager.subscribe, manager.getState, () => SERVER_STATE);
  return React.useMemo(() => {
    const permissions = state.session?.permissions ?? [];
    const set = new Set(permissions);
    return {
      status: state.status,
      isAuthenticated: state.status === 'authenticated',
      isLoading: state.status === 'loading',
      session: state.session,
      user: state.session?.user ?? null,
      tenant: state.session?.tenant ?? null,
      membership: state.session?.membership ?? null,
      permissions,
      endedReason: state.endedReason,
      supportGrant: state.session?.supportGrant ?? null,
      endedSupportGrant: state.endedSupportGrant ?? null,
      hasPermission: (p: string) => set.has(p),
      hasAnyPermission: (list: readonly string[]) => list.length === 0 || list.some((p) => set.has(p)),
      acceptLogin: manager.acceptLogin,
      reload: manager.reload,
      signOut: manager.signOut,
      app,
      loginPath,
      homePath,
    };
  }, [state, manager, app, loginPath, homePath]);
}

/** The typed endpoint groups: `const api = useApi(); api.requests.list(...)`. */
export function useApi(): Api {
  return useAuthContext().api;
}
/** The raw client for calls that have no typed group yet: `client.get<T>('/tasks/mine')`. */
export function useApiClient(): ApiClient {
  return useAuthContext().api.client;
}
