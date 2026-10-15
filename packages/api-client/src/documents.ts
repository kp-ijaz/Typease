import type { ApiClient } from './client';
import { ApiError, errorFromResponse, networkError } from './errors';

/** Body of POST /documents/upload-intents without the file facts, which are read from the File. */
export interface DocumentOwner {
  customerId?: string;
  corporateAccountId?: string;
  requestId?: string;
  /** request_documents.id: fills this checklist line. */
  checklistItemId?: string;
  documentTypeKey: string;
  title?: string;
  category?: string;
  /** Adds a new version to an existing document. */
  replacesDocumentId?: string;
  /** YYYY-MM-DD (unverified until staff confirm it). */
  expiryDate?: string;
  issuedDate?: string;
  customerVisible?: boolean;
}

export interface UploadIntent {
  documentId: string;
  versionId: string;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string };
}

export interface UploadSummary {
  documentId: string;
  versionId: string;
  versionNo: number;
  status: string;
  isCurrentVersion: boolean;
  filename: string;
  mime: string;
  sizeBytes: number;
  scanStatus: string;
}

export interface UploadDocumentOptions extends DocumentOwner {
  file: File | Blob;
  /** Needed when `file` is a Blob without a name. */
  filename?: string;
  /** 0..1 over the three steps; the byte transfer is 5%..95%. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** PUT of the raw bytes to a signed URL, with progress when XMLHttpRequest exists. */
export function putToSignedUrl(
  url: string,
  file: Blob,
  headers: Record<string, string>,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<void> {
  if (typeof XMLHttpRequest === 'undefined' || opts.fetch) {
    const doFetch = opts.fetch ?? globalThis.fetch;
    return doFetch(url, { method: 'PUT', headers, body: file, signal: opts.signal })
      .catch((e) => {
        throw networkError(e);
      })
      .then(async (res) => {
        if (!res.ok) throw await errorFromResponse(res);
        opts.onProgress?.(1);
      });
  }
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    // The signed URL is the capability: no cookies, no Authorization header.
    xhr.withCredentials = false;
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      void errorFromResponse(new Response(xhr.responseText || null, { status: xhr.status })).then(reject);
    };
    xhr.onerror = () => reject(networkError(new Error('upload failed')));
    xhr.onabort = () => reject(networkError(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    if (opts.signal) {
      if (opts.signal.aborted) return xhr.abort();
      opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}

/**
 * The three-step upload of the document vault (docs/api/modules/documents.md):
 *   1. POST /documents/upload-intents             -> ids + a one-time signed URL
 *   2. PUT  <upload.url> with exactly upload.headers and the raw bytes
 *   3. POST /documents/:id/versions/:versionId/complete
 * Several files = several calls (they may run in parallel).
 */
export async function uploadDocument(client: ApiClient, options: UploadDocumentOptions, deps: { fetch?: typeof fetch } = {}): Promise<UploadSummary> {
  const { file, filename, onProgress, signal, ...owner } = options;
  const name = filename ?? (file as File).name;
  if (!name) throw new ApiError({ status: 0, code: 'FILENAME_REQUIRED', message: 'The file needs a name.' });
  onProgress?.(0);
  const intent = await client.post<UploadIntent>(
    '/documents/upload-intents',
    { ...owner, filename: name, mime: file.type || 'application/octet-stream', sizeBytes: file.size },
    { signal },
  );
  onProgress?.(0.05);
  await putToSignedUrl(intent.upload.url, file, intent.upload.headers, {
    signal,
    fetch: deps.fetch,
    onProgress: (f) => onProgress?.(0.05 + f * 0.9),
  });
  const summary = await client.post<UploadSummary>(`/documents/${intent.documentId}/versions/${intent.versionId}/complete`, undefined, { signal });
  onProgress?.(1);
  return summary;
}

export interface DocumentLink {
  url: string;
  expiresAt: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  disposition: 'inline' | 'attachment';
}
/** Short-lived URL for the FileViewer (PDF / image preview). */
export const documentPreviewLink = (client: ApiClient, documentId: string) => client.post<DocumentLink>(`/documents/${documentId}/preview-link`);
/** Short-lived URL for saving the file. */
export const documentDownloadLink = (client: ApiClient, documentId: string, versionId?: string) =>
  client.post<DocumentLink>(`/documents/${documentId}/download-link`, { disposition: 'attachment', ...(versionId ? { versionId } : {}) });
