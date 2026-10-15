import { TestApp } from '../../services/api/test/helpers';
import { LogProvider } from '../../services/api/src/modules/notifications/providers/log';

/**
 * Background work. In the test configuration the queue driver is "inline": jobs
 * are collected in memory and executed by `t.settle()`, which also delivers the
 * transactional outbox - together that is what services/worker does in production.
 */

/** Run a scheduled job once, like the worker's scheduler would, then deliver events and run follow-up jobs. */
export async function runScheduledJob(t: TestApp, name: string, payload: Record<string, unknown> = {}): Promise<void> {
  if (!t.jobs.names().includes(name)) throw new Error(`No job handler named "${name}" is registered. Registered: ${t.jobs.names().join(', ')}`);
  if (!t.jobs.schedules().some((s) => s.name === name)) throw new Error(`"${name}" is a job, but it is not on the scheduler's list.`);
  await t.jobs.execute(name, payload, { attempt: 1, maxAttempts: 1 });
  await t.settle(10);
}

/** What the development mail driver ("log") would have sent to an address: the rendered message, newest last. */
export function mailTo(address: string, channel: 'EMAIL' | 'SMS' | 'WHATSAPP' | 'PUSH' = 'EMAIL') {
  return LogProvider.outbox.filter((e) => e.channel === channel && e.message.to === address).map((e) => e.message);
}

/**
 * What an operator does with OUTBOUND_WEBHOOK_ALLOWED_HOSTS: name a host that
 * centres may connect to although it is private (development / test only; the
 * exception does not exist in production). Returns a function that removes it.
 */
export function allowOperatorHost(host: string): () => void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred on purpose: the env module reads process.env when it loads, after the test app has set it
  const { env } = require('../../services/api/src/config/env');
  const list: string[] = env().OUTBOUND_WEBHOOK_ALLOWED_HOSTS;
  if (!list.includes(host)) list.push(host);
  return () => {
    const at = list.indexOf(host);
    if (at !== -1) list.splice(at, 1);
  };
}

/** "YYYY-MM-DD" of a calendar day in the UAE (UTC+4, no daylight saving), relative to today. */
export function dubaiDay(offsetDays = 0, now = new Date()): string {
  const local = new Date(now.getTime() + 4 * 3_600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + offsetDays)).toISOString().slice(0, 10);
}

/**
 * Changes one operator setting (an environment variable of the API) for the
 * running application, e.g. the lifetime of signed links, so that a test can
 * wait for a real expiry in seconds instead of minutes. Returns the undo.
 */
export function withOperatorSetting(key: string, value: unknown): () => void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred on purpose: the env module reads process.env when it loads, after the test app has set it
  const { env } = require('../../services/api/src/config/env');
  const settings: Record<string, unknown> = env();
  if (!(key in settings)) throw new Error(`The API has no setting named ${key}.`);
  const before = settings[key];
  settings[key] = value;
  return () => {
    settings[key] = before;
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
