import { createServer, IncomingMessage, Server } from 'node:http';
import { DisabledOcrProvider, ExternalHttpOcrProvider, OcrProviders } from './providers';

/** A local HTTP server standing in for an operator-approved OCR service. */
async function startOcrService(handler: (req: IncomingMessage, body: Buffer) => { status: number; headers?: Record<string, string>; body: string }) {
  const seen: Array<{ method?: string; url?: string; authorization?: string; contentType?: string; body: Buffer }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, contentType: req.headers['content-type'], body });
      const out = handler(req, body);
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(out.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1/ocr`;
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('OCR providers', () => {
  it('disabled: every call is INTEGRATION_NOT_CONFIGURED (503)', async () => {
    const disabled = new DisabledOcrProvider();
    expect(disabled.supports('image/png')).toBe(false);
    await expect(disabled.recognise()).rejects.toMatchObject({ code: 'INTEGRATION_NOT_CONFIGURED' });
    await expect(disabled.recognise()).rejects.toHaveProperty('status', 503);
    // OCR_PROVIDER=disabled in the test environment.
    const providers = new OcrProviders();
    expect(providers.configured).toBe(false);
    expect(() => providers.require()).toThrow(/not configured/i);
  });

  describe('external-http', () => {
    it('posts the file with the bearer token and maps the documented JSON response', async () => {
      const service = await startOcrService(() => ({ status: 200, body: JSON.stringify({ text: 'LINE ONE\nLINE TWO', pages: 2, confidence: 0.87 }) }));
      try {
        const file = Buffer.from('%PDF-1.4 fake scan');
        const out = await new ExternalHttpOcrProvider(service.url, 'secret-token').recognise(file, 'application/pdf');
        expect(out).toEqual({ text: 'LINE ONE\nLINE TWO', pages: 2, confidence: 0.87 });
        expect(service.seen).toHaveLength(1);
        expect(service.seen[0]).toMatchObject({ method: 'POST', url: '/v1/ocr', authorization: 'Bearer secret-token' });
        expect(service.seen[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
        expect(service.seen[0].body.includes(file)).toBe(true);
        expect(service.seen[0].body.toString('latin1')).toContain('name="mime"');
      } finally {
        await service.close();
      }
    });

    it('fills in defaults for optional fields and rejects malformed answers', async () => {
      let reply: any = { text: 'only text' };
      const service = await startOcrService(() => ({ status: 200, body: typeof reply === 'string' ? reply : JSON.stringify(reply) }));
      try {
        const provider = new ExternalHttpOcrProvider(service.url, 't');
        expect(await provider.recognise(Buffer.from('x'), 'image/png')).toEqual({ text: 'only text', pages: 1, confidence: 0.5 });
        reply = { text: 'x', pages: -3, confidence: 7 };
        expect(await provider.recognise(Buffer.from('x'), 'image/png')).toEqual({ text: 'x', pages: 1, confidence: 0.5 });
        reply = { pages: 1 };
        await expect(provider.recognise(Buffer.from('x'), 'image/png')).rejects.toThrow(/no "text"/);
        reply = '<html>not json</html>';
        await expect(provider.recognise(Buffer.from('x'), 'image/png')).rejects.toThrow(/did not return JSON/);
      } finally {
        await service.close();
      }
    });

    it('fails on HTTP errors, never follows a redirect, and reports an unreachable service', async () => {
      const elsewhere = await startOcrService(() => ({ status: 200, body: JSON.stringify({ text: 'leaked' }) }));
      let status = 500;
      const service = await startOcrService(() => (status === 302 ? { status: 302, headers: { location: elsewhere.url }, body: '' } : { status, body: '{}' }));
      try {
        const provider = new ExternalHttpOcrProvider(service.url, 't');
        await expect(provider.recognise(Buffer.from('x'), 'image/png')).rejects.toThrow(/HTTP 500/);
        status = 401;
        await expect(provider.recognise(Buffer.from('x'), 'image/png')).rejects.toThrow(/HTTP 401/);
        status = 302;
        await expect(provider.recognise(Buffer.from('document bytes'), 'image/png')).rejects.toThrow(/could not be reached/);
        expect(elsewhere.seen).toHaveLength(0); // the document was not re-sent to another host
      } finally {
        await service.close();
        await elsewhere.close();
      }
      await expect(new ExternalHttpOcrProvider(service.url, 't').recognise(Buffer.from('x'), 'image/png')).rejects.toThrow(/could not be reached/);
    });

    it('is NOT_CONFIGURED without URL or token, and only accepts http(s) URLs', async () => {
      await expect(new ExternalHttpOcrProvider(undefined, 't').recognise(Buffer.from('x'), 'image/png')).rejects.toMatchObject({ code: 'INTEGRATION_NOT_CONFIGURED' });
      await expect(new ExternalHttpOcrProvider('https://ocr.example.test/v1', undefined).recognise(Buffer.from('x'), 'image/png')).rejects.toMatchObject({ code: 'INTEGRATION_NOT_CONFIGURED' });
      await expect(new ExternalHttpOcrProvider('not a url', 't').recognise(Buffer.from('x'), 'image/png')).rejects.toMatchObject({ code: 'INTEGRATION_NOT_CONFIGURED' });
      await expect(new ExternalHttpOcrProvider('file:///etc/passwd', 't').recognise(Buffer.from('x'), 'image/png')).rejects.toMatchObject({ code: 'INTEGRATION_NOT_CONFIGURED' });
    });
  });
});
