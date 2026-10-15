import { randomBytes } from 'node:crypto';

/** Sample files. Everything here is synthetic: random bytes behind a real file signature. */
export interface SampleFile {
  content: Buffer;
  filename: string;
  mime: string;
}

export const pdf = (marker = 'sample', filename = 'document.pdf', size = 600): SampleFile => ({
  content: Buffer.concat([Buffer.from(`%PDF-1.4\n% ${marker}\n`), randomBytes(size), Buffer.from('\n%%EOF\n')]),
  filename,
  mime: 'application/pdf',
});

export const png = (filename = 'photo.png', size = 400): SampleFile => ({
  content: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(size)]),
  filename,
  mime: 'image/png',
});

/** A Windows executable that claims to be a PDF: the content check must refuse it. */
export const disguisedExecutable = (): SampleFile => ({ content: Buffer.concat([Buffer.from('MZ'), randomBytes(300)]), filename: 'passport.pdf', mime: 'application/pdf' });
