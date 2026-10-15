import { ConsoleLogger, LoggerService } from '@nestjs/common';
import pino, { Logger as Pino } from 'pino';
import { env } from '../config/env';
import { tryCtx } from './context';

/**
 * Structured logging. In production every line is one JSON object on stdout
 * (level, time, service, context, msg, plus requestId / tenantId / userId when
 * the line is written inside a request or job), ready for Loki, CloudWatch or
 * any collector. Secrets and personal identifiers are redacted defensively;
 * request and response bodies are never logged.
 */
const REDACT = [
  'password', 'passwordHash', 'token', 'accessToken', 'refreshToken', 'secret', 'authorization', 'cookie',
  '*.password', '*.passwordHash', '*.token', '*.accessToken', '*.refreshToken', '*.secret', '*.authorization', '*.cookie',
  'emiratesId', 'passportNo', '*.emiratesId', '*.passportNo', 'headers.authorization', 'headers.cookie',
];

let root: Pino | undefined;
export function rootLogger(): Pino {
  if (!root) {
    root = pino({
      level: env().LOG_LEVEL,
      base: { service: process.env.SERVICE_NAME ?? 'typease-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT, censor: '[redacted]' },
      mixin() {
        const c = tryCtx();
        if (!c) return {};
        return { requestId: c.requestId, ...(c.tenantId ? { tenantId: c.tenantId } : {}), ...(c.userId ? { userId: c.userId } : {}) };
      },
    });
  }
  return root;
}

class JsonNestLogger implements LoggerService {
  private write(level: 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal', message: unknown, params: unknown[]) {
    // Nest passes the context name as the last string argument; errors add a stack trace before it.
    const rest = [...params];
    const context = typeof rest[rest.length - 1] === 'string' ? (rest.pop() as string) : undefined;
    const stack = level === 'error' && typeof rest[0] === 'string' ? (rest.shift() as string) : undefined;
    const payload: Record<string, unknown> = { ...(context ? { context } : {}), ...(stack ? { stack } : {}) };
    if (message instanceof Error) rootLogger()[level]({ ...payload, err: { message: message.message, stack: message.stack } }, message.message);
    else if (typeof message === 'object' && message !== null) rootLogger()[level]({ ...payload, data: message }, context ?? 'log');
    else rootLogger()[level](payload, String(message));
  }
  log(message: unknown, ...params: unknown[]) {
    this.write('info', message, params);
  }
  error(message: unknown, ...params: unknown[]) {
    this.write('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.write('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.write('trace', message, params);
  }
  fatal(message: unknown, ...params: unknown[]) {
    this.write('fatal', message, params);
  }
}

/** JSON in production (or LOG_FORMAT=json); readable console output for local development. */
export function createAppLogger(): LoggerService {
  const e = env();
  if (e.LOG_FORMAT === 'json') return new JsonNestLogger();
  const levels: Array<'error' | 'warn' | 'log' | 'debug' | 'verbose'> =
    e.LOG_LEVEL === 'silent' ? [] : e.LOG_LEVEL === 'error' || e.LOG_LEVEL === 'fatal' ? ['error'] : e.LOG_LEVEL === 'warn' ? ['error', 'warn'] : e.LOG_LEVEL === 'info' ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug', 'verbose'];
  return new ConsoleLogger({ logLevels: levels });
}

/** One access-log line per request: no query string, no bodies, no personal data. */
export function logRequest(entry: { method: string; path: string; status: number; durationMs: number; ip?: string; app?: string }) {
  if (env().LOG_FORMAT !== 'json' || env().NODE_ENV === 'test') return;
  const level = entry.status >= 500 ? 'error' : entry.status >= 400 ? 'warn' : 'info';
  rootLogger()[level]({ context: 'Http', http: entry }, `${entry.method} ${entry.path} ${entry.status} ${entry.durationMs}ms`);
}
