import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentSecurityPolicy, newNonce, originOf, parseOrigins, staticSecurityHeaders } from './security.mjs';

test('the policy allows only self, the API and data images', () => {
  const csp = contentSecurityPolicy({ nonce: 'abc', apiUrl: 'https://api.typease.ae/api/v1', storageOrigins: 'https://files.typease.ae' });
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'nonce-abc' 'strict-dynamic'(;|$)/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.typease\.ae https:\/\/files\.typease\.ae(;|$)/);
  assert.match(csp, /img-src 'self' data: blob: https:\/\/api\.typease\.ae https:\/\/files\.typease\.ae/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.ok(!csp.includes('unsafe-eval'), 'no eval in production');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no inline scripts');
});

test('development adds only what the dev server needs', () => {
  const csp = contentSecurityPolicy({ nonce: 'n', apiUrl: 'http://localhost:4000', isDev: true });
  assert.match(csp, /script-src[^;]*'unsafe-eval'/);
  assert.match(csp, /connect-src 'self' http:\/\/localhost:4000 ws: wss:/);
});

test('static headers: camera only where asked, HSTS only outside development', () => {
  const find = (headers, key) => headers.find((h) => h.key === key)?.value;
  const portal = staticSecurityHeaders({ camera: true });
  const admin = staticSecurityHeaders();
  assert.match(find(portal, 'Permissions-Policy'), /camera=\(self\)/);
  assert.match(find(admin, 'Permissions-Policy'), /camera=\(\)/);
  assert.equal(find(admin, 'X-Content-Type-Options'), 'nosniff');
  assert.equal(find(admin, 'Referrer-Policy'), 'strict-origin-when-cross-origin');
  assert.match(find(admin, 'Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.ok(find(admin, 'Strict-Transport-Security'));
  assert.equal(find(staticSecurityHeaders({ isDev: true }), 'Strict-Transport-Security'), undefined);
});

test('helpers', () => {
  assert.equal(originOf('http://localhost:4000/api/v1'), 'http://localhost:4000');
  assert.equal(originOf('nonsense'), null);
  assert.deepEqual(parseOrigins('https://a.example, https://b.example/x  bad'), ['https://a.example', 'https://b.example']);
  assert.notEqual(newNonce(), newNonce());
  assert.match(newNonce(), /^[A-Za-z0-9+/]{22}==$/);
});
