import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { env } from '../../config/env';
import { makeIntegration } from '../notifications/fixtures';

/** Test fixtures of the automation module. Only used by specs. */

export interface RuleInput {
  name?: string;
  triggerEvent: string;
  conditions?: Record<string, unknown>;
  actions: Array<{ type: string; config?: Record<string, unknown> }>;
  isEnabled?: boolean;
  maxRetries?: number;
}
let counter = 0;

/** Creates a rule through the API (so it is validated like a real one) and returns its body. */
export async function createRule(t: TestApp, actor: Actor, input: RuleInput) {
  const res = await t.as(actor).post('/automations', { name: input.name ?? `Rule ${++counter}`, isEnabled: true, ...input });
  if (res.status !== 201) throw new Error(`create rule failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string; isEnabled: boolean };
}

export const executionsOf = (t: TestApp, ruleId: string) => t.sys.automationExecution.findMany({ where: { ruleId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
export async function onlyExecution(t: TestApp, ruleId: string) {
  const rows = await executionsOf(t, ruleId);
  if (rows.length !== 1) throw new Error(`expected exactly one execution of rule ${ruleId}, found ${rows.length}`);
  return rows[0];
}
export const results = (execution: { actionResults: unknown }) => execution.actionResults as Array<{ index: number; type: string; status: string; attempts: number; output?: Record<string, any>; error?: { code: string; message: string; retryable: boolean } }>;

/** What an operator does with OUTBOUND_WEBHOOK_ALLOWED_HOSTS. Returns a function that removes the host again. */
export function allowHost(host: string): () => void {
  const list = env().OUTBOUND_WEBHOOK_ALLOWED_HOSTS;
  if (!list.includes(host)) list.push(host);
  return () => {
    const at = list.indexOf(host);
    if (at !== -1) list.splice(at, 1);
  };
}

/** The n8n connection of a centre, as the integrations module stores it. */
export const connectN8n = (t: TestApp, tenant: TenantFixture, webhookBaseUrl: string, signingSecret: string, status = 'ACTIVE') =>
  makeIntegration(t, tenant.id, 'AUTOMATION', 'n8n', { webhookBaseUrl }, { signingSecret }, status);

export interface ReceivedHook {
  path: string;
  headers: IncomingMessage['headers'];
  raw: string;
  json: any;
  /** Recomputed by the receiver from the shared secret, the timestamp header and the raw body. */
  signatureValid: (secret: string) => boolean;
}

/** A real HTTP server on a random local port that plays the role of n8n. */
export class HookServer {
  readonly received: ReceivedHook[] = [];
  /** Status codes for the next calls; empty = 200. */
  statuses: number[] = [];
  port = 0;
  private server!: Server;

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try {
          json = JSON.parse(raw);
        } catch {
          json = null;
        }
        const headers = req.headers;
        this.received.push({
          path: req.url ?? '',
          headers,
          raw,
          json,
          signatureValid: (secret) => headers['x-typease-signature'] === `sha256=${createHmac('sha256', secret).update(`${headers['x-typease-timestamp']}.${raw}`).digest('hex')}`,
        });
        const status = this.statuses.shift() ?? 200;
        res.writeHead(status, status >= 300 && status < 400 ? { Location: `http://127.0.0.1:${this.port}/redirected` } : {});
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  get base() {
    return `http://127.0.0.1:${this.port}/webhook`;
  }
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }
}
