import * as jwt from 'jsonwebtoken';
import { env } from '../../config/env';

export interface AccessClaims {
  /** user id */
  sub: string;
  /** session id */
  sid: string;
  app: string;
  /** tenant id + membership id the session is bound to */
  tid?: string;
  mid?: string;
  /** support access grant id (platform staff inside a tenant) */
  sg?: string;
}

const ISSUER = 'typease';

export function signAccessToken(claims: AccessClaims): { token: string; expiresIn: number } {
  const expiresIn = env().JWT_ACCESS_TTL_SECONDS;
  const token = jwt.sign(claims, env().JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn, issuer: ISSUER, audience: 'typease-api' });
  return { token, expiresIn };
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    return jwt.verify(token, env().JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: 'typease-api' }) as AccessClaims;
  } catch {
    return null;
  }
}
