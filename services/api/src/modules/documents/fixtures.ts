import { randomBytes } from 'node:crypto';
import { createServer, Server } from 'node:net';
import type { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { PASSWORD, uniq } from '../../../test/helpers';
import { eicarTestContent } from './malware';

/** Test data for the vault. Everything here is synthetic. */

export const pdfBytes = (marker: string = uniq(), size = 700) => Buffer.concat([Buffer.from(`%PDF-1.4\n% ${marker}\n`), randomBytes(size), Buffer.from('\n%%EOF\n')]);
export const pngBytes = (size = 500) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(size)]);
export const jpegBytes = (size = 500) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(size)]);
/** A PDF-looking file that carries the EICAR anti-malware TEST string (harmless by design). */
export const infectedPdfBytes = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), eicarTestContent(), Buffer.from('\n%%EOF\n')]);
export const windowsExeBytes = () => Buffer.concat([Buffer.from('MZ'), randomBytes(300)]);

export async function createCustomer(t: TestApp, tenant: TenantFixture, data: Record<string, unknown> = {}) {
  return t.sys.customer.create({ data: { tenantId: tenant.id, customerNo: `CUS-${uniq()}`, fullName: `Test Person ${uniq()}`, ...data } as any });
}

export async function createService(t: TestApp, tenant: TenantFixture) {
  const category = await t.sys.serviceCategory.findFirstOrThrow({ where: { tenantId: tenant.id } });
  return t.sys.service.create({ data: { tenantId: tenant.id, categoryId: category.id, code: `SVC-${uniq()}`, name: 'Visa typing' } });
}

export async function createRequest(
  t: TestApp,
  tenant: TenantFixture,
  customerId: string,
  opts: { branchId?: string; status?: string; assignedToId?: string | null; corporateAccountId?: string | null; completedAt?: Date | null; cancelledAt?: Date | null } = {},
) {
  const service = await createService(t, tenant);
  return t.sys.serviceRequest.create({
    data: {
      tenantId: tenant.id,
      branchId: opts.branchId ?? tenant.headOfficeId,
      requestNo: `TE-${uniq()}`,
      customerId,
      serviceId: service.id,
      status: (opts.status as any) ?? 'UNDER_REVIEW',
      assignedToId: opts.assignedToId ?? null,
      corporateAccountId: opts.corporateAccountId ?? null,
      completedAt: opts.completedAt ?? null,
      cancelledAt: opts.cancelledAt ?? null,
    },
  });
}

export async function addChecklistItem(t: TestApp, tenant: TenantFixture, requestId: string, documentTypeKey: string, data: Record<string, unknown> = {}) {
  return t.sys.requestDocument.create({ data: { tenantId: tenant.id, requestId, documentTypeKey, label: `Copy of ${documentTypeKey}`, ...data } as any });
}

export async function createBranch(t: TestApp, tenant: TenantFixture) {
  return t.sys.branch.create({ data: { tenantId: tenant.id, code: `B${uniq().slice(-5)}`, name: 'Second branch' } });
}

/** A corporate account with a signed-in corporate administrator. */
export async function createCorporateAdmin(t: TestApp, tenant: TenantFixture): Promise<{ accountId: string; admin: Actor }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose: auth.service pulls in the whole auth module graph; loading it only when the fixture runs keeps spec-file load order unchanged
  const { hashPassword } = require('../auth/auth.service');
  const account = await t.sys.corporateAccount.create({ data: { tenantId: tenant.id, accountNo: `CORP-${uniq()}`, companyName: `Test Trading ${uniq()} LLC`, status: 'ACTIVE' } });
  const email = `corp-${uniq()}@example.test`;
  const user = await t.sys.user.create({ data: { email, fullName: 'Corporate Admin', passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() } });
  const role = await t.sys.role.findFirstOrThrow({ where: { tenantId: tenant.id, key: 'corporate_admin' } });
  await t.sys.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id, kind: 'CORPORATE', status: 'ACTIVE', corporateAccountId: account.id, allBranches: true, joinedAt: new Date() } });
  await t.sys.corporateMember.create({ data: { tenantId: tenant.id, corporateAccountId: account.id, userId: user.id, fullName: 'Corporate Admin', email, status: 'ACTIVE' } });
  return { accountId: account.id, admin: await t.login(email, PASSWORD, 'corporate', tenant.slug) };
}

export async function addEmployee(t: TestApp, tenant: TenantFixture, accountId: string) {
  const customer = await createCustomer(t, tenant, { corporateAccountId: accountId });
  await t.sys.corporateEmployee.create({ data: { tenantId: tenant.id, corporateAccountId: accountId, customerId: customer.id } });
  return customer;
}

/** A platform support agent inside the tenant under an approved access grant with the given scopes. */
export async function supportSession(t: TestApp, tenant: TenantFixture, scopes: string[]): Promise<{ actor: Actor; grantId: string }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy on purpose: auth.service pulls in the whole auth module graph; loading it only when the fixture runs keeps spec-file load order unchanged
  const { AuthService } = require('../auth/auth.service');
  const agent = await t.createPlatformAdmin('SUPPORT_AGENT');
  const grant = await t.sys.accessGrant.create({
    data: { tenantId: tenant.id, requestedById: agent.userId, reason: 'Investigating a customer-reported upload problem', scopes, status: 'APPROVED', durationMinutes: 60, startsAt: new Date(), expiresAt: new Date(Date.now() + 3600_000), decidedAt: new Date() },
  });
  const issued = await t.get<any>(AuthService).issueSupportSession(agent.userId, grant.id, tenant.id);
  return { actor: { ...agent, token: issued.accessToken }, grantId: grant.id };
}

export const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

/** PUT the bytes to the URL of an upload intent, exactly as a browser or the mobile app would. */
export async function putToUploadUrl(t: TestApp, upload: { url: string; method: string; headers: Record<string, string> }, content: Buffer) {
  let req = t.http.put(pathOf(upload.url));
  for (const [k, v] of Object.entries(upload.headers)) req = req.set(k, v);
  return req.send(content);
}

/** Download the bytes behind a short-lived link. */
export async function fetchBytes(t: TestApp, url: string) {
  return t.http
    .get(pathOf(url))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

export interface UploadedDoc {
  documentId: string;
  versionId: string;
  content: Buffer;
}
/** The full three-step upload. Throws with the failing response when a step is refused. */
export async function uploadDocument(
  t: TestApp,
  actor: Actor,
  fields: Record<string, unknown>,
  opts: { content?: Buffer; mime?: string; filename?: string; settle?: boolean } = {},
): Promise<UploadedDoc> {
  const content = opts.content ?? pdfBytes();
  const mime = opts.mime ?? 'application/pdf';
  const intent = await t.as(actor).post('/documents/upload-intents', { documentTypeKey: 'passport', filename: opts.filename ?? 'scan.pdf', mime, sizeBytes: content.length, ...fields });
  if (intent.status !== 201) throw new Error(`intent failed: ${intent.status} ${JSON.stringify(intent.body)}`);
  const put = await putToUploadUrl(t, intent.body.upload, content);
  if (put.status !== 200) throw new Error(`upload failed: ${put.status} ${JSON.stringify(put.body)}`);
  const done = await t.as(actor).post(`/documents/${intent.body.documentId}/versions/${intent.body.versionId}/complete`);
  if (done.status !== 200) throw new Error(`complete failed: ${done.status} ${JSON.stringify(done.body)}`);
  if (opts.settle !== false) await t.settle();
  return { documentId: intent.body.documentId, versionId: intent.body.versionId, content };
}

/**
 * Minimal clamd stand-in speaking INSTREAM: collects the streamed chunks and
 * answers with whatever `verdict` returns for the received bytes.
 */
export async function startFakeClamd(verdict: (received: Buffer) => string): Promise<{ port: number; received: Buffer[]; close: () => Promise<void>; server: Server }> {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let commandSeen = false;
    const chunks: Buffer[] = [];
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!commandSeen) {
        const end = buffer.indexOf(0);
        if (end === -1) return;
        if (buffer.subarray(0, end).toString() !== 'zINSTREAM') {
          socket.end('UNKNOWN COMMAND\0');
          return;
        }
        commandSeen = true;
        buffer = buffer.subarray(end + 1);
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          const body = Buffer.concat(chunks);
          received.push(body);
          socket.end(`${verdict(body)}\0`);
          return;
        }
        if (buffer.length < 4 + size) return;
        chunks.push(buffer.subarray(4, 4 + size));
        buffer = buffer.subarray(4 + size);
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port as number;
  return { port, received, server, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
