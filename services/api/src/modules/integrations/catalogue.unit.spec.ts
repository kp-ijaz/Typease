import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_PROVIDER_CODES, AUTHORISATION_KEY, CATEGORIES, cleanConfig, ConfigProblem, describeProvider, findProvider, keyFieldsChanged, mergeSecrets, missingConfig, missingSecrets,
  PROVIDERS, splitProvider, storedProvider,
} from './catalogue';
import { parseApproved } from './platform-integrations.service';

const def = (category: string, provider: string) => {
  const found = findProvider(category, provider);
  if (!found) throw new Error(`${category}/${provider} missing`);
  return found;
};

describe('integration catalogue', () => {
  it('has unique provider codes and covers every category', () => {
    expect(new Set(ALL_PROVIDER_CODES).size).toBe(ALL_PROVIDER_CODES.length);
    for (const category of CATEGORIES) expect(PROVIDERS.some((p) => p.category === category)).toBe(true);
    for (const p of PROVIDERS) {
      const keys = [...p.configFields, ...p.secretFields].map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).not.toContain(AUTHORISATION_KEY);
      expect(p.modes.length).toBeGreaterThan(0);
    }
  });

  it('uses exactly the key names the consuming modules read', () => {
    const keys = (category: string, provider: string) => ({ config: def(category, provider).configFields.map((f) => f.key), secrets: def(category, provider).secretFields.map((f) => f.key) });
    // notifications/providers/registry.ts
    expect(keys('EMAIL', 'smtp')).toEqual({ config: ['host', 'port', 'secure', 'requireTls', 'fromAddress', 'fromName'], secrets: ['user', 'password'] });
    expect(keys('SMS', 'twilio')).toEqual({ config: ['accountSid', 'from'], secrets: ['authToken'] });
    expect(keys('SMS', 'http')).toEqual({ config: ['url'], secrets: ['token'] });
    expect(keys('WHATSAPP', 'meta')).toEqual({ config: ['phoneNumberId', 'apiVersion', 'languageCodes', 'verifyToken'], secrets: ['accessToken', 'appSecret'] });
    expect(keys('PUSH', 'fcm')).toEqual({ config: ['projectId'], secrets: ['serviceAccountJson'] });
    // finance/gateways/payment-gateways.ts
    expect(keys('PAYMENT', 'stripe')).toEqual({ config: [], secrets: ['secretKey', 'webhookSecret'] });
    expect(keys('PAYMENT', 'sandbox')).toEqual({ config: [], secrets: [] });

    // Guard against drift: the consumers still read these names from the row.
    const src = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8');
    const registry = src('notifications/providers/registry.ts');
    for (const name of ['config.host', 'config.port', 'config.secure', 'config.requireTls', 'secrets.user', 'secrets.password', 'config.accountSid', 'config.from', 'secrets.authToken', 'config.url', 'secrets.token', 'config.phoneNumberId', 'config.apiVersion', 'secrets.accessToken', 'config.projectId', 'secrets.serviceAccountJson']) {
      expect(registry).toContain(name);
    }
    const gateways = src('finance/gateways/payment-gateways.ts');
    expect(gateways).toContain('secrets.secretKey');
    expect(gateways).toContain('secrets.webhookSecret');
    expect(gateways).toContain("category: 'PAYMENT', status: 'ACTIVE'");
  });

  it('government and partner entries are records without any credential field', () => {
    for (const p of PROVIDERS.filter((x) => ['GOVERNMENT', 'PARTNER'].includes(x.category))) {
      expect(p.kind).toBe('AUTHORISATION_RECORD');
      expect(p.secretFields).toEqual([]);
      expect(p.test).toBeNull();
      expect(p.multiple).toBe(true);
      expect(p.configFields.some((f) => f.keyField)).toBe(true);
      expect(() => mergeSecrets(p, {}, { password: 'x' })).toThrow(/never holds credentials/);
    }
    expect(def('GOVERNMENT', 'official-portal-access').configFields.map((f) => f.key)).toEqual(['authorityName', 'authorisationReference', 'validFrom', 'validUntil', 'credentialHolder', 'notes']);
    expect(def('PARTNER', 'authorised-partner').configFields.filter((f) => f.required).map((f) => f.key)).toEqual(['partnerLegalName', 'serviceScope', 'agreementReference']);
  });

  it('the public description never includes validation internals', () => {
    const d = describeProvider(def('PUSH', 'fcm'));
    expect(d).toMatchObject({ category: 'PUSH', provider: 'fcm', testable: false, requiresVerification: false });
    expect(d.secretFields).toEqual([{ key: 'serviceAccountJson', label: 'Service-account key (JSON)', help: null, type: 'json', required: true, maxLength: 20000, example: null }]);
    expect(JSON.stringify(d)).not.toContain('validateSecrets');
  });

  describe('cleanConfig', () => {
    const smtp = def('EMAIL', 'smtp');
    it('coerces values, drops empty ones and refuses unknown settings', () => {
      expect(cleanConfig(smtp, { host: ' smtp.example.ae ', port: '465', secure: 'true', fromAddress: 'Info@Example.AE', fromName: '', requireTls: null }, { complete: true })).toEqual({ host: 'smtp.example.ae', port: 465, secure: true, fromAddress: 'info@example.ae' });
      expect(() => cleanConfig(smtp, { host: 'smtp.example.ae', apiKey: 'x' }, { complete: true })).toThrow(ConfigProblem);
      expect(() => cleanConfig(smtp, { host: 'http://smtp.example.ae' }, { complete: true })).toThrow(/server name/);
      expect(() => cleanConfig(smtp, { host: 'smtp.example.ae', port: 1.5 }, { complete: true })).toThrow(/whole number/);
      expect(() => cleanConfig(smtp, { host: 'smtp.example.ae', port: 0 }, { complete: true })).toThrow(/at least 1/);
      expect(() => cleanConfig(smtp, { host: 'smtp.example.ae', secure: 'yes' }, { complete: true })).toThrow(/yes or no/);
      expect(() => cleanConfig(smtp, { host: 'smtp.example.ae', fromAddress: 'not-an-email' }, { complete: true })).toThrow(/valid email/);
    });
    it('requires the required fields only when asked for a complete configuration', () => {
      expect(() => cleanConfig(smtp, {}, { complete: true })).toThrow(/Please fill in: Server/);
      expect(cleanConfig(smtp, {}, { complete: false })).toEqual({});
      expect(missingConfig(smtp, {})).toEqual(['host']);
      expect(missingSecrets(def('PAYMENT', 'stripe'), ['secretKey'])).toEqual(['webhookSecret']);
    });
    it('checks URLs, dates, phone numbers and WhatsApp language codes', () => {
      const http = def('SMS', 'http');
      expect(cleanConfig(http, { url: 'https://gw.example.ae/send' }, { complete: true })).toEqual({ url: 'https://gw.example.ae/send' });
      expect(() => cleanConfig(http, { url: 'gw.example.ae/send' }, { complete: true })).toThrow(/full address/);
      expect(() => cleanConfig(http, { url: 'https://user:secret@gw.example.ae/send' }, { complete: true })).toThrow(/do not put a user name or password/);
      const wa = def('WHATSAPP', 'meta');
      expect(cleanConfig(wa, { phoneNumberId: '123', languageCodes: { en: 'en_US', ar: 'ar' } }, { complete: true })).toEqual({ phoneNumberId: '123', languageCodes: { en: 'en_US', ar: 'ar' } });
      expect(() => cleanConfig(wa, { phoneNumberId: '123', languageCodes: { fr: 'fr' } }, { complete: true })).toThrow(/only "en" and "ar"/);
      expect(() => cleanConfig(wa, { phoneNumberId: '123', languageCodes: 'en' }, { complete: true })).toThrow(/send an object/);
      const partner = def('PARTNER', 'authorised-partner');
      const base = { partnerLegalName: 'Gulf Amer LLC', serviceScope: 'Visa stamping', agreementReference: 'AGR-1' };
      expect(cleanConfig(partner, { ...base, contactPhone: '+971 50 123-4567', agreementValidUntil: '2027-03-31' }, { complete: true })).toMatchObject({ contactPhone: '+971501234567', agreementValidUntil: '2027-03-31' });
      expect(() => cleanConfig(partner, { ...base, contactPhone: '050 1234567' }, { complete: true })).toThrow(/international format/);
      expect(() => cleanConfig(partner, { ...base, agreementValidUntil: '31/03/2027' }, { complete: true })).toThrow(/YYYY-MM-DD/);
    });
    it('never accepts something that looks like a portal password in an authorisation record', () => {
      const gov = def('GOVERNMENT', 'official-portal-access');
      const base = { authorityName: 'MOHRE', authorisationReference: 'TAS-1', credentialHolder: 'Centre manager' };
      expect(cleanConfig(gov, base, { complete: true })).toEqual(base);
      for (const notes of ['login tasheel1 password: Abc#123', 'pwd=hunter2', 'OTP: 445566', 'PIN = 9911']) {
        expect(() => cleanConfig(gov, { ...base, notes }, { complete: true })).toThrow(/Never store portal credentials/);
      }
      expect(cleanConfig(gov, { ...base, notes: 'The password is kept by the manager only.' }, { complete: true }).notes).toMatch(/kept by the manager/);
      expect(() => cleanConfig(gov, { ...base, validFrom: '2026-06-01', validUntil: '2026-05-31' }, { complete: true })).toThrow(/cannot be before/);
      // The reserved review key can never be written through the configuration.
      expect(cleanConfig(gov, { ...base, [AUTHORISATION_KEY]: { state: 'VERIFIED' } }, { complete: true })).toEqual(base);
    });
  });

  describe('mergeSecrets', () => {
    const stripe = def('PAYMENT', 'stripe');
    it('merges, trims and removes values; unknown names are refused', () => {
      const first = mergeSecrets(stripe, {}, { secretKey: ' sk_test_1\n' });
      expect(first).toEqual({ secretKey: 'sk_test_1' });
      const second = mergeSecrets(stripe, first, { webhookSecret: 'whsec_1' });
      expect(second).toEqual({ secretKey: 'sk_test_1', webhookSecret: 'whsec_1' });
      expect(mergeSecrets(stripe, second, { secretKey: null })).toEqual({ webhookSecret: 'whsec_1' });
      expect(() => mergeSecrets(stripe, {}, { publishableKey: 'pk' })).toThrow(/not a credential of Stripe/);
      expect(() => mergeSecrets(def('PAYMENT', 'sandbox'), {}, { anything: 'x' })).toThrow(/has no credentials/);
      expect(() => mergeSecrets(stripe, {}, { secretKey: 'x'.repeat(301) })).toThrow(/at most 300/);
    });
    it('checks the shape of a Firebase service-account key', () => {
      const fcm = def('PUSH', 'fcm');
      const key = JSON.stringify({ client_email: 'svc@p.iam.example', private_key: 'k' });
      expect(mergeSecrets(fcm, {}, { serviceAccountJson: key })).toEqual({ serviceAccountJson: key });
      expect(mergeSecrets(fcm, {}, { serviceAccountJson: Buffer.from(key).toString('base64') }).serviceAccountJson).toBeTruthy();
      expect(() => mergeSecrets(fcm, {}, { serviceAccountJson: '{"client_email":"x"}' })).toThrow(/client_email and private_key/);
      expect(() => mergeSecrets(fcm, {}, { serviceAccountJson: 'not json at all' })).toThrow(/not valid JSON/);
    });
  });

  it('keyFieldsChanged only reacts to the fields a verification was based on', () => {
    const gov = def('GOVERNMENT', 'official-portal-access');
    const before = { authorityName: 'MOHRE', authorisationReference: 'TAS-1', credentialHolder: 'A', validUntil: '2027-01-01' };
    expect(keyFieldsChanged(gov, before, { ...before, credentialHolder: 'B', notes: 'new note' })).toBe(false);
    expect(keyFieldsChanged(gov, before, { ...before, authorisationReference: 'TAS-2' })).toBe(true);
    expect(keyFieldsChanged(gov, before, { ...before, validUntil: '2028-01-01' })).toBe(true);
    const { validUntil: _removed, ...without } = before;
    expect(keyFieldsChanged(gov, before, without)).toBe(true);
  });

  it('stores several records of one kind under provider:instanceKey', () => {
    expect(storedProvider('official-portal-access', 'mohre')).toBe('official-portal-access:mohre');
    expect(storedProvider('smtp', null)).toBe('smtp');
    expect(splitProvider('official-portal-access:mohre')).toEqual({ base: 'official-portal-access', instanceKey: 'mohre' });
    expect(splitProvider('stripe')).toEqual({ base: 'stripe', instanceKey: null });
    expect(findProvider('GOVERNMENT', 'official-portal-access:mohre')?.provider).toBe('official-portal-access');
    expect(findProvider('EMAIL', 'stripe')).toBeUndefined();
  });

  it('parseApproved keeps known codes and treats anything else as "no restriction"', () => {
    expect(parseApproved(null)).toBeNull();
    expect(parseApproved({ providers: [] })).toBeNull();
    expect([...parseApproved(['EMAIL/smtp', 'MADE/up', 42])!]).toEqual(['EMAIL/smtp']);
    expect(parseApproved([])!.size).toBe(0);
  });
});
