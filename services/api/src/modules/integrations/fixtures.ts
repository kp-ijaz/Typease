import { createServer, IncomingMessage, Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, Server as TcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import type { Actor, TestApp } from '../../../test/helpers';
import { env } from '../../config/env';

/** Test fixtures for the integrations module. Only used by specs. */

/**
 * Marks a host as an explicitly allowed development host (what an operator does
 * with OUTBOUND_WEBHOOK_ALLOWED_HOSTS). Returns a function that removes it again.
 */
export function allowDevHost(host: string): () => void {
  const list = env().OUTBOUND_WEBHOOK_ALLOWED_HOSTS;
  if (!list.includes(host)) list.push(host);
  return () => {
    const at = list.indexOf(host);
    if (at !== -1) list.splice(at, 1);
  };
}

/** A real SMTP server on a random local port that accepts exactly one user name / password. */
export class LocalSmtp {
  logins: Array<{ username?: string; ok: boolean }> = [];
  messages = 0;
  private server!: SMTPServer;
  port = 0;
  constructor(private readonly credentials: { user: string; password: string }) {}

  async start(): Promise<this> {
    this.server = new SMTPServer({
      authOptional: false,
      allowInsecureAuth: true,
      disabledCommands: ['STARTTLS'],
      logger: false,
      onAuth: (auth, _session, callback) => {
        const ok = auth.username === this.credentials.user && auth.password === this.credentials.password;
        this.logins.push({ username: auth.username, ok });
        if (!ok) return callback(new Error('Invalid username or password'));
        callback(null, { user: auth.username });
      },
      onData: (stream, _session, callback) => {
        stream.on('data', () => undefined);
        stream.on('end', () => {
          this.messages += 1;
          callback();
        });
      },
    });
    this.server.on('error', () => undefined);
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.server.address() as AddressInfo).port;
    return this;
  }
  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

export interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}
/** A local HTTP server standing in for a provider API. It records every request it receives. */
export class FakeApi {
  seen: SeenRequest[] = [];
  private server!: HttpServer;
  url = '';
  constructor(private readonly respond: (req: SeenRequest) => { status: number; body: unknown; headers?: Record<string, string> }) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers };
      this.seen.push(seen);
      const answer = this.respond(seen);
      res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** A TCP server that speaks just enough of the clamd protocol for PING. */
export class FakeClamd {
  received: string[] = [];
  private server!: TcpServer;
  port = 0;
  constructor(private readonly reply: string = 'PONG\0') {}
  async start(): Promise<this> {
    this.server = createTcpServer((socket) => {
      socket.on('data', (chunk) => {
        this.received.push(chunk.toString('utf8'));
        socket.end(this.reply);
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

export const governmentRecord = (over: Record<string, unknown> = {}) => ({
  category: 'GOVERNMENT',
  provider: 'official-portal-access',
  instanceKey: 'mohre',
  config: { authorityName: 'MOHRE', authorisationReference: 'TAS-2026-00417', validFrom: '2026-01-01', validUntil: '2099-12-31', credentialHolder: 'Fatima Al Marri, Centre Manager' },
  authorisationNote: 'Tasheel service centre licence issued by MOHRE; reference can be checked on the MOHRE service-centre register.',
  ...over,
});
export const partnerRecord = (over: Record<string, unknown> = {}) => ({
  category: 'PARTNER',
  provider: 'authorised-partner',
  config: { partnerLegalName: 'Gulf Amer Services LLC', serviceScope: 'Residence visa stamping and Emirates ID typing', agreementReference: 'AGR-77/2026', contactEmail: 'ops@gulf-amer.example' },
  authorisationNote: 'Signed service agreement AGR-77/2026 with an Amer-licensed centre.',
  ...over,
});

/** Creates an integration through the API and returns the response body. */
export async function createIntegration(t: TestApp, actor: Actor, body: Record<string, unknown>) {
  const res = await t.as(actor).post('/integrations', body);
  if (res.status !== 201) throw new Error(`integration create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; status: string; [k: string]: any };
}
