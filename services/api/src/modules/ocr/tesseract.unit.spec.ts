import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractDocument } from './extractors';
import { ICAO_TD3 } from './fixtures';
import { TesseractOcrProvider } from './providers';

/**
 * ONE end-to-end check of the real local OCR engine: the ICAO specimen MRZ is
 * rendered to a PNG and read by tesseract.js with the bundled English model
 * (no network). It proves the adapter starts offline and that its output feeds
 * the parser; it says nothing about accuracy on photographs of real documents.
 */
const installed = GlobalFonts.families.map((f) => f.family);
const font = ['Liberation Mono', 'DejaVu Sans Mono', 'FreeMono'].find((f) => installed.includes(f));
if (!font) {
  console.warn('SKIPPED: the real Tesseract test needs one of the fonts "Liberation Mono", "DejaVu Sans Mono" or "FreeMono" to render the specimen image.');
}

function renderMrz(lines: string[], fontFamily: string): Buffer {
  const size = 28;
  const canvas = createCanvas(Math.ceil(size * 0.62 * 44) + 120, size * 5);
  const c = canvas.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = '#000000';
  c.font = `${size}px "${fontFamily}"`;
  c.fillText(lines[0], 50, size * 2);
  c.fillText(lines[1], 50, size * 3.6);
  return canvas.toBuffer('image/png');
}

describe('Tesseract provider (real engine, offline)', () => {
  const provider = new TesseractOcrProvider();
  afterAll(() => provider.close());

  (font ? it : it.skip)(
    'reads the document number of a rendered ICAO specimen passport MRZ',
    async () => {
      const image = renderMrz(ICAO_TD3, font!);
      const recognised = await provider.recognise(image, 'image/png');
      expect(recognised.pages).toBe(1);
      expect(recognised.confidence).toBeGreaterThanOrEqual(0);
      expect(recognised.confidence).toBeLessThanOrEqual(1);
      expect(recognised.text).toContain('L898902C3');

      const extraction = extractDocument(recognised.text, { ocrConfidence: recognised.confidence, today: new Date('2026-06-15T00:00:00Z') });
      expect(extraction.classification).toBe('PASSPORT');
      const number = extraction.fields.find((f) => f.key === 'passportNumber')!;
      expect(number.value).toBe('L898902C3');
      expect(number.source).toBe('MRZ');
      expect(number.confidence).toBeGreaterThanOrEqual(0.8); // its check digit validated
      expect(extraction.fields.find((f) => f.key === 'dateOfBirth')?.value).toBe('1974-08-12');
      // The model is read from the installed package: nothing is cached in the working directory.
      expect(existsSync(join(process.cwd(), 'eng.traineddata'))).toBe(false);
    },
    180_000,
  );

  it('refuses file types it cannot read instead of producing garbage', async () => {
    expect(provider.supports('application/pdf')).toBe(false);
    expect(provider.supports('image/png')).toBe(true);
    await expect(provider.recognise(Buffer.from('%PDF-1.4'), 'application/pdf')).rejects.toMatchObject({ code: 'OCR_UNSUPPORTED_FILE' });
  });
});
