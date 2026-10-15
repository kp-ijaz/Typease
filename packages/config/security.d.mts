export function originOf(url: string | undefined | null): string | null;
export function parseOrigins(list: string | undefined | null): string[];
export function contentSecurityPolicy(options: { nonce: string; apiUrl?: string | null; storageOrigins?: string | null; isDev?: boolean }): string;
export function staticSecurityHeaders(options?: { camera?: boolean; isDev?: boolean }): Array<{ key: string; value: string }>;
export function newNonce(): string;
