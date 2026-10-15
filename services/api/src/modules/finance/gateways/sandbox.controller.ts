import { Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { sandboxFailSchema } from '@typease/validation';
import { env } from '../../../config/env';
import { Public } from '../../../common/auth/access';
import { hmac, safeEqual } from '../../../common/crypto';
import { Errors } from '../../../common/errors';
import { RateLimit } from '../../../common/rate-limit';
import { buildSandboxWebhook, decodeSandboxSession, SandboxSession } from './sandbox.gateway';

export const SANDBOX_NOTICE = 'TEST PAYMENT - no money is taken';
/**
 * Token inside the two forms of the HTML checkout page. It is bound to one checkout session and can only be
 * computed by this API, so a form on another website cannot complete or decline a session it merely knows
 * the address of: it would have to read our page first, which the browser does not allow across origins.
 */
export const sandboxFormToken = (sessionRef: string) => hmac(`sandbox-checkout-form|${sessionRef}`);

const escapeHtml = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const originOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
};

/** A complete, self-contained HTML document: inline style only, no script, no external resource. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #f3f5f8; color: #0b2240; }
  .banner { background: #b45309; color: #fff; text-align: center; padding: 12px 16px; font-weight: 700; letter-spacing: .04em; }
  main { max-width: 440px; margin: 32px auto; padding: 0 16px; }
  .card { background: #fff; border: 1px solid #d9dee6; border-radius: 12px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { line-height: 1.5; margin: 8px 0; }
  .muted { color: #5b6677; font-size: 14px; }
  .amount { font-size: 34px; font-weight: 700; margin: 16px 0 4px; }
  .actions { display: flex; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
  form { flex: 1 1 160px; margin: 0; }
  button { width: 100%; font: inherit; font-weight: 600; padding: 12px 16px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; }
  .pay { background: #00a166; color: #fff; }
  .decline { background: #fff; color: #0b2240; border-color: #b8c0cc; }
  button:focus-visible { outline: 3px solid #0b7ad1; outline-offset: 2px; }
</style>
</head>
<body>
<div class="banner" role="note">${escapeHtml(SANDBOX_NOTICE)}</div>
<main><div class="card">${body}</div></main>
</body>
</html>`;
}

const WEBHOOK_PATH: Record<SandboxSession['channel'], string> = {
  payments: '/api/v1/public/webhooks/payments/sandbox',
  subscriptions: '/api/v1/public/webhooks/subscriptions/sandbox',
};

/**
 * The "hosted checkout page" of the TEST gateway. It exists only when
 * PAYMENT_SANDBOX_ENABLED is true (never in production) and moves no money.
 * Completing or failing a session makes the sandbox deliver a signed webhook to
 * our real webhook endpoint over HTTP, exactly like an external gateway would.
 */
@ApiTags('Public')
@Controller('public/payments/sandbox/checkout')
export class SandboxCheckoutController {
  private session(sessionRef: string): SandboxSession {
    if (!env().PAYMENT_SANDBOX_ENABLED) throw Errors.notFound('Page');
    const session = decodeSandboxSession(sessionRef);
    if (!session) throw Errors.notFound('Checkout session');
    return session;
  }

  /**
   * Headers of an HTML answer. The API's global policy is for JSON and files; a page needs its inline style, and
   * its two forms must be allowed to post to this API and to be redirected to the portal the customer came from.
   */
  private html(res: Response, status: number, document: string, session?: SandboxSession) {
    const targets = session ? [...new Set([originOf(session.successUrl), originOf(session.cancelUrl)].filter((o): o is string => !!o))] : [];
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${targets.map((t) => ` ${t}`).join('')}; base-uri 'none'; frame-ancestors 'none'`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.send(document);
  }
  private wantsHtml(req: Request): boolean {
    // A browser that navigates to the address asks for text/html first; API clients (fetch, the portals, tests) get JSON as before.
    return req.accepts(['json', 'html']) === 'html';
  }

  @Public()
  @RateLimit({ name: 'sandbox-checkout', limit: 120, windowSeconds: 60 })
  @Get(':sessionRef')
  @ApiOperation({ summary: 'TEST gateway: the sandbox checkout. A browser gets a small HTML page with "complete" / "decline"; API clients (Accept: application/json) get the description as JSON.' })
  describe(@Param('sessionRef') sessionRef: string, @Req() req: Request, @Res() res: Response) {
    if (this.wantsHtml(req)) {
      if (!env().PAYMENT_SANDBOX_ENABLED) throw Errors.notFound('Page');
      const s = decodeSandboxSession(sessionRef);
      if (!s) {
        return void this.html(res, 404, page('Test payment page expired', `<h1>This test payment page has expired</h1><p>Go back to the portal and start the payment again.</p>`));
      }
      const action = (what: 'complete' | 'fail') => `/api/v1/public/payments/sandbox/checkout/${encodeURIComponent(sessionRef)}/${what}?form=${sandboxFormToken(sessionRef)}`;
      return void this.html(
        res,
        200,
        page(
          'Test payment',
          `<h1>${escapeHtml(s.description)}</h1>
<p class="muted">${escapeHtml(s.channel === 'subscriptions' ? 'TypEase subscription' : 'Customer payment')} &middot; TypEase sandbox gateway</p>
<p class="amount">${escapeHtml(s.currency)} ${escapeHtml(s.amount)}</p>
<p class="muted">This page stands in for the payment provider in a test environment. Nothing is charged, whatever you choose. The page stops working at ${escapeHtml(new Date(s.exp * 1000).toISOString().slice(0, 16).replace('T', ' '))} UTC.</p>
<div class="actions">
<form method="post" action="${escapeHtml(action('complete'))}"><button class="pay" type="submit">Complete test payment</button></form>
<form method="post" action="${escapeHtml(action('fail'))}"><button class="decline" type="submit">Decline</button></form>
</div>`,
        ),
        s,
      );
    }
    const s = this.session(sessionRef);
    const base = `${env().API_PUBLIC_URL}/api/v1/public/payments/sandbox/checkout/${sessionRef}`;
    res.json({
      gateway: 'sandbox',
      testMode: true,
      notice: 'TEST PAYMENT - this is the TypEase sandbox gateway. No money will be taken.',
      description: s.description,
      amount: s.amount,
      currency: s.currency,
      purpose: s.channel === 'subscriptions' ? 'TypEase subscription' : 'Customer payment',
      expiresAt: new Date(s.exp * 1000).toISOString(),
      actions: { complete: { method: 'POST', url: `${base}/complete` }, fail: { method: 'POST', url: `${base}/fail` } },
    });
  }

  /** Delivers the webhook to this very server on the port the request arrived on (loopback only, never a client-supplied host). */
  private async deliver(req: Request, sessionRef: string, outcome: 'succeeded' | 'failed', reason?: string | null) {
    const session = this.session(sessionRef);
    const hook = buildSandboxWebhook(sessionRef, outcome, { reason });
    const url = `http://127.0.0.1:${req.socket.localPort}${WEBHOOK_PATH[session.channel]}`;
    let status: number;
    let body: unknown;
    try {
      const res = await fetch(url, { method: 'POST', headers: hook.headers, body: hook.body, signal: AbortSignal.timeout(30_000) });
      status = res.status;
      const text = await res.text();
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
    } catch (e: any) {
      throw Errors.badRequest('SANDBOX_DELIVERY_FAILED', `The sandbox could not deliver its webhook: ${e?.message ?? e}`);
    }
    return {
      gateway: 'sandbox',
      testMode: true,
      outcome,
      webhook: { eventId: hook.eventId, delivered: status >= 200 && status < 300, status, response: body },
      returnUrl: outcome === 'succeeded' ? session.successUrl : session.cancelUrl,
    };
  }

  /**
   * The two buttons of the HTML page post here with `?form=<token>`. Like a real provider, the answer is a
   * redirect (303) back to the portal: to the success address after a completed payment, to the cancel address
   * after a decline. The payment itself is completed by the signed webhook, never by this redirect.
   */
  private async fromForm(req: Request, res: Response, sessionRef: string, token: string, outcome: 'succeeded' | 'failed') {
    if (!env().PAYMENT_SANDBOX_ENABLED) throw Errors.notFound('Page');
    const session = decodeSandboxSession(sessionRef);
    if (!session) return void this.html(res, 404, page('Test payment page expired', `<h1>This test payment page has expired</h1><p>Go back to the portal and start the payment again.</p>`));
    if (!safeEqual(token, sandboxFormToken(sessionRef))) {
      return void this.html(res, 403, page('Test payment', `<h1>This request was not accepted</h1><p>Open the payment page again from the portal and use its buttons.</p>`), session);
    }
    const result = await this.deliver(req, sessionRef, outcome, outcome === 'failed' ? 'The test payment was declined on the sandbox page.' : null);
    if (outcome === 'succeeded' && !result.webhook.delivered) {
      return void this.html(res, 502, page('Test payment', `<h1>The test payment could not be recorded</h1><p>The sandbox delivered its notification but it was not accepted (status ${escapeHtml(result.webhook.status)}). Nothing was charged.</p><p><a href="${escapeHtml(session.cancelUrl)}">Back to the portal</a></p>`), session);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(303, result.returnUrl);
  }

  @Public()
  @RateLimit({ name: 'sandbox-checkout', limit: 60, windowSeconds: 60 })
  @Post(':sessionRef/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'TEST gateway: pay the sandbox session (sends the signed success webhook). JSON answer; with ?form=<token> (the HTML page) a 303 redirect to the return address.' })
  async complete(@Param('sessionRef') sessionRef: string, @Query('form') form: string | undefined, @Req() req: Request, @Res() res: Response) {
    if (form !== undefined) return this.fromForm(req, res, sessionRef, String(form), 'succeeded');
    res.status(200).json(await this.deliver(req, sessionRef, 'succeeded'));
  }

  @Public()
  @RateLimit({ name: 'sandbox-checkout', limit: 60, windowSeconds: 60 })
  @Post(':sessionRef/fail')
  @HttpCode(200)
  @ApiOperation({ summary: 'TEST gateway: decline the sandbox session (sends the signed failure webhook). Body: { reason? }. With ?form=<token> (the HTML page) a 303 redirect to the cancel address.' })
  async fail(@Param('sessionRef') sessionRef: string, @Query('form') form: string | undefined, @Req() req: Request, @Res() res: Response) {
    if (form !== undefined) return this.fromForm(req, res, sessionRef, String(form), 'failed');
    // Validated here (not by a body pipe) because the HTML form posts to the same address without a JSON body.
    const body = sandboxFailSchema.parse(req.body && typeof req.body === 'object' ? req.body : {});
    res.status(200).json(await this.deliver(req, sessionRef, 'failed', body.reason));
  }
}
