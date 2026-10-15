/** File name from a Content-Disposition header (RFC 6266: `filename*` wins over `filename`). */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return sanitise(decodeURIComponent(star[2].trim().replace(/^"|"$/g, '')));
    } catch {
      /* fall through to the plain form */
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return sanitise(quoted[1].replace(/\\(.)/g, '$1'));
  const plain = /filename\s*=\s*([^;]+)/i.exec(header);
  return plain ? sanitise(plain[1].trim()) : null;
}

/** Never trust a server-supplied name as a path. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is being stripped
const sanitise = (name: string) => name.replace(/[/\\\u0000-\u001f]/g, '_').trim() || null;

export interface DownloadedFile {
  blob: Blob;
  filename: string;
  contentType: string;
}

/** Hands a downloaded blob to the browser as a file save. No-op outside a browser. */
export function saveBlob(file: Pick<DownloadedFile, 'blob' | 'filename'>): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
