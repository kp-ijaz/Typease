import { Actor, TestApp } from '../../services/api/test/helpers';
import { api } from './centre';
import { SampleFile } from './files';
import { pathOf } from './http';

export interface UploadTarget {
  customerId?: string;
  corporateAccountId?: string;
  requestId?: string;
  checklistItemId?: string;
  replacesDocumentId?: string;
  documentTypeKey: string;
  title?: string;
  expiryDate?: string;
  customerVisible?: boolean;
}

export interface Uploaded {
  documentId: string;
  versionId: string;
  content: Buffer;
  /** The one-time upload URL that was used (to prove it cannot be used again). */
  uploadUrl: string;
}

/**
 * The three-step upload a browser or the mobile app performs: ask for an upload
 * intent, PUT the bytes to the one-time signed URL with exactly the headers the
 * API named, confirm. The malware scan is a job: it runs when the caller settles
 * (done here unless `settle: false`).
 */
export async function uploadDocument(t: TestApp, actor: Actor, target: UploadTarget, file: SampleFile, opts: { settle?: boolean } = {}): Promise<Uploaded> {
  const a = api(t, actor);
  const intent = await a.post('/documents/upload-intents', { ...target, filename: file.filename, mime: file.mime, sizeBytes: file.content.length }, 201);
  let put = t.http.put(pathOf(intent.upload.url));
  for (const [k, v] of Object.entries(intent.upload.headers ?? {})) put = put.set(k, v as string);
  const sent = await put.send(file.content);
  if (sent.status !== 200) throw new Error(`PUT <signed upload URL> -> ${sent.status} ${JSON.stringify(sent.body)}`);
  await a.post(`/documents/${intent.documentId}/versions/${intent.versionId}/complete`, {}, 200);
  if (opts.settle !== false) await t.settle();
  return { documentId: intent.documentId, versionId: intent.versionId, content: file.content, uploadUrl: intent.upload.url };
}

/** GET a short-lived signed link, as a browser would (no bearer token: the link is the capability). */
export function fetchLink(t: TestApp, url: string) {
  return t.http
    .get(pathOf(url))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

/** Ask for a download link and fetch the bytes behind it. */
export async function downloadDocument(t: TestApp, actor: Actor, documentId: string): Promise<{ link: any; bytes: Buffer }> {
  const link = await api(t, actor).post(`/documents/${documentId}/download-link`, {});
  const res = await fetchLink(t, link.url);
  if (res.status !== 200) throw new Error(`GET <signed download URL> -> ${res.status}`);
  return { link, bytes: res.body as Buffer };
}
