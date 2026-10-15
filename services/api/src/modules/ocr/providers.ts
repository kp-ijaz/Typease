import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { dirname, join } from 'node:path';
import { env } from '../../config/env';
import { Errors } from '../../common/errors';

export interface OcrRecognition {
  /** Everything the engine read, lines separated by "\n". Held in memory only; never stored or logged. */
  text: string;
  pages: number;
  /** 0..1 as reported by the engine. */
  confidence: number;
}
/**
 * An OCR engine. Which one runs is decided by OCR_PROVIDER alone: a customer
 * document is never handed to an engine that the operator did not configure.
 */
export interface OcrProvider {
  readonly name: string;
  /** Can this engine read files of this type at all? Checked before a job is queued. */
  supports(mime: string): boolean;
  recognise(image: Buffer, mime: string): Promise<OcrRecognition>;
  close?(): Promise<void>;
}

const NOT_CONFIGURED = () =>
  Errors.notConfigured('The AI document assistant', 'Ask your administrator to set OCR_PROVIDER to "tesseract" (runs on this server) or "external-http" (an approved OCR service).');

/** OCR_PROVIDER=disabled: every call fails with 503 INTEGRATION_NOT_CONFIGURED. */
export class DisabledOcrProvider implements OcrProvider {
  readonly name = 'disabled';
  supports(_mime?: string): boolean {
    return false;
  }
  async recognise(): Promise<OcrRecognition> {
    throw NOT_CONFIGURED();
  }
}

/**
 * Local OCR with tesseract.js (WebAssembly). The English model ships in the
 * `@tesseract.js-data/eng` package, so nothing is downloaded and no document
 * leaves the server. Reads images only (no PDF rasteriser is bundled).
 */
export class TesseractOcrProvider implements OcrProvider {
  readonly name = 'tesseract';
  private worker?: Promise<any>;
  /** One recognition at a time: the engine is CPU bound and single threaded. */
  private chain: Promise<unknown> = Promise.resolve();

  supports(mime: string): boolean {
    return ['image/png', 'image/jpeg', 'image/webp'].includes(mime);
  }

  private getWorker(): Promise<any> {
    if (!this.worker) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createWorker } = require('tesseract.js');
      const langPath = join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
      // oem 1 = LSTM engine. cacheMethod "none": read the bundled model, write nothing to disk.
      const starting: Promise<any> = createWorker('eng', 1, { langPath, gzip: true, cacheMethod: 'none' });
      // A failed start must not poison every later call.
      starting.catch(() => {
        if (this.worker === starting) this.worker = undefined;
      });
      this.worker = starting;
    }
    return this.worker;
  }

  recognise(image: Buffer, mime: string): Promise<OcrRecognition> {
    if (!this.supports(mime)) {
      return Promise.reject(Errors.unprocessable('OCR_UNSUPPORTED_FILE', 'The built-in OCR engine reads images (JPG, PNG, WebP) only. Upload a photo or scan image of the document.'));
    }
    const run = async (): Promise<OcrRecognition> => {
      const worker = await this.getWorker();
      const { data } = await worker.recognize(image);
      return { text: String(data.text ?? ''), pages: 1, confidence: Math.max(0, Math.min(1, Number(data.confidence ?? 0) / 100)) };
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.then((w) => w.terminate()).catch(() => undefined);
  }
}

/**
 * Generic HTTP OCR service chosen by the operator (OCR_EXTERNAL_URL + OCR_EXTERNAL_TOKEN).
 *
 *   POST <OCR_EXTERNAL_URL>
 *   Authorization: Bearer <OCR_EXTERNAL_TOKEN>
 *   Content-Type: multipart/form-data      parts: file (binary), mime (text)
 *
 *   200 application/json   { "text": "line 1\nline 2", "pages": 1, "confidence": 0.93 }
 *
 * `text` is required. `pages` defaults to 1. `confidence` is 0..1; when the
 * service does not report one, 0.5 ("unknown") is recorded. Redirects are not
 * followed, so the file cannot end up at a host other than the configured one.
 */
export class ExternalHttpOcrProvider implements OcrProvider {
  readonly name = 'external-http';
  constructor(
    private readonly url: string | undefined = env().OCR_EXTERNAL_URL,
    private readonly token: string | undefined = env().OCR_EXTERNAL_TOKEN,
    private readonly timeoutMs = 90_000,
  ) {}

  supports(mime: string): boolean {
    return ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(mime);
  }

  async recognise(image: Buffer, mime: string): Promise<OcrRecognition> {
    if (!this.url || !this.token) throw Errors.notConfigured('The external OCR service', 'Set OCR_EXTERNAL_URL and OCR_EXTERNAL_TOKEN.');
    let target: URL;
    try {
      target = new URL(this.url);
    } catch {
      throw Errors.notConfigured('The external OCR service', 'OCR_EXTERNAL_URL is not a valid URL.');
    }
    if (target.protocol !== 'https:' && (env().NODE_ENV === 'production' || target.protocol !== 'http:')) {
      throw Errors.notConfigured('The external OCR service', 'OCR_EXTERNAL_URL must use https.');
    }
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(image)], { type: mime }), 'document');
    form.set('mime', mime);
    let response: Response;
    try {
      response = await fetch(target, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' }, body: form, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e: any) {
      throw new Error(`The OCR service could not be reached (${e?.name === 'TimeoutError' ? 'timeout' : (e?.cause?.code ?? e?.message ?? 'network error')}).`);
    }
    if (!response.ok) throw new Error(`The OCR service answered with HTTP ${response.status}.`);
    let body: any;
    try {
      body = await response.json();
    } catch {
      throw new Error('The OCR service did not return JSON.');
    }
    if (typeof body?.text !== 'string') throw new Error('The OCR service response has no "text".');
    const pages = Number.isInteger(body.pages) && body.pages > 0 ? Math.min(body.pages, 500) : 1;
    const confidence = typeof body.confidence === 'number' && body.confidence >= 0 && body.confidence <= 1 ? body.confidence : 0.5;
    return { text: body.text, pages, confidence };
  }
}

/** Holds the one engine selected by configuration. */
@Injectable()
export class OcrProviders implements OnModuleDestroy {
  private readonly logger = new Logger(OcrProviders.name);
  private active: OcrProvider = OcrProviders.fromEnv();

  static fromEnv(): OcrProvider {
    switch (env().OCR_PROVIDER) {
      case 'tesseract':
        return new TesseractOcrProvider();
      case 'external-http':
        return new ExternalHttpOcrProvider();
      default:
        return new DisabledOcrProvider();
    }
  }

  get current(): OcrProvider {
    return this.active;
  }
  get configured(): boolean {
    return !(this.active instanceof DisabledOcrProvider);
  }
  /** Throws 503 INTEGRATION_NOT_CONFIGURED when no engine is configured. */
  require(): OcrProvider {
    if (!this.configured) throw NOT_CONFIGURED();
    return this.active;
  }

  /** Automated tests swap in a deterministic engine. Refused outside NODE_ENV=test. */
  useForTesting(provider: OcrProvider): void {
    if (env().NODE_ENV !== 'test') throw new Error('OCR providers can only be replaced in tests.');
    this.active = provider;
  }

  async onModuleDestroy() {
    await this.active.close?.().catch((e) => this.logger.warn(`closing OCR provider failed: ${e?.message}`));
  }
}
