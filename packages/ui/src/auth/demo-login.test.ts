import { afterEach, describe, expect, it, vi } from 'vitest';

// The demo password is read once at import, so each case imports a fresh copy of the module.
async function demoEmailFor(search: string, password?: string) {
  vi.resetModules();
  if (password) vi.stubEnv('NEXT_PUBLIC_DEMO_PASSWORD', password);
  window.history.replaceState(null, '', `/sign-in${search}`);
  const { demoLoginEmail } = await import('./sign-in');
  return demoLoginEmail();
}

describe('one-click demo login', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is off unless the build sets the demo password', async () => {
    expect(await demoEmailFor('?demo=owner@al-noor.test')).toBeNull();
  });

  it('accepts only seeded .test accounts', async () => {
    expect(await demoEmailFor('?demo=Owner@Al-Noor.test', 'TypEase-Demo-2026')).toBe('owner@al-noor.test');
    expect(await demoEmailFor('?demo=someone@gmail.com', 'TypEase-Demo-2026')).toBeNull();
    expect(await demoEmailFor('?demo=not-an-email', 'TypEase-Demo-2026')).toBeNull();
    expect(await demoEmailFor('', 'TypEase-Demo-2026')).toBeNull();
  });
});
