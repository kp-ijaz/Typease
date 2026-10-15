import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareDictionaries, hasKey, interpolate, isPluralEntry, leafKeys, lookup, mergeDictionaries, pluralCategory, resetMissingKeyWarnings, resolveLocale, translate,
  translatePlural, uiDictionaries,
} from './index';
import { STATUS_META, statusMeta } from '../lib/status-meta';
import { localiseValidationMessage } from '../lib/validation-messages';
import * as types from '@typease/types';

const { en, ar } = uiDictionaries;

describe('shared dictionaries', () => {
  it('have every English key in Arabic and the other way round, with the same placeholders', () => {
    expect(compareDictionaries(en, ar)).toEqual([]);
  });
  it('do not leave English text in Arabic values (except brand names, examples and codes)', () => {
    const allowed = /TypEase|Google Authenticator|Microsoft Authenticator|1Password|QR|English|you@example\.com|name@example\.com|portal\.yourcentre\.ae|#0B7AD1/g;
    const suspicious = leafKeys(ar).filter((key) => /[A-Za-z]{4,}/.test((lookup(ar, key) as string).replace(allowed, '').replace(/\{\w+\}/g, '')));
    expect(suspicious).toEqual([]);
  });
  it('contain Arabic script in every Arabic value', () => {
    const exempt = new Set(['common.english', 'auth.emailPlaceholder']);
    const missing = leafKeys(ar).filter((key) => !exempt.has(key) && !/[؀-ۿ]/.test(lookup(ar, key) as string));
    expect(missing).toEqual([]);
  });
  it('define every key that the shared components use', () => {
    // Static scan of the sources: t('a.b'), tn('a.b', n) and labelKey: 'a.b'.
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !path.includes('dictionaries')) files.push(path);
      }
    };
    walk(root);
    const used = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/\b(?:t|tn|i18n\.t|i18n\.tn)\(\s*'([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
      for (const m of source.matchAll(/'((?:validation|apiErrors|errors|auth|common|form|table|file|shell|session|theme)\.[a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(150);
    const undefinedKeys = [...used].filter((key) => !key.endsWith('.') && lookup(en, key) === undefined);
    expect(undefinedKeys).toEqual([]);
  });
});

describe('translate', () => {
  afterEach(() => {
    resetMissingKeyWarnings();
    vi.restoreAllMocks();
  });
  it('reads nested keys and fills placeholders', () => {
    expect(translate(uiDictionaries, 'en', 'common.save')).toBe('Save');
    expect(translate(uiDictionaries, 'ar', 'common.save')).toBe('حفظ');
    expect(translate(uiDictionaries, 'en', 'table.showing', { from: 1, to: 20, total: 135 })).toBe('Showing 1–20 of 135');
    expect(interpolate('Hello {name}, {missing}', { name: 'Noor' })).toBe('Hello Noor, {missing}');
  });
  it('falls back to English, then to the key, and warns once in development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dictionaries = mergeDictionaries(uiDictionaries, { en: { demo: { onlyEnglish: 'Only English' } } });
    expect(translate(dictionaries, 'ar', 'demo.onlyEnglish')).toBe('Only English');
    expect(translate(dictionaries, 'ar', 'demo.onlyEnglish')).toBe('Only English');
    expect(translate(dictionaries, 'en', 'demo.nothing')).toBe('demo.nothing');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('demo.onlyEnglish');
  });
  it('chooses plural forms per language', () => {
    expect(translatePlural(uiDictionaries, 'en', 'table.results', 1)).toBe('1 result');
    expect(translatePlural(uiDictionaries, 'en', 'table.results', 12)).toBe('12 results');
    expect(pluralCategory('ar', 0)).toBe('zero');
    expect(pluralCategory('ar', 2)).toBe('two');
    expect(pluralCategory('ar', 5)).toBe('few');
    expect(pluralCategory('ar', 11)).toBe('many');
    expect(pluralCategory('ar', 100)).toBe('other');
    expect(translatePlural(uiDictionaries, 'ar', 'table.results', 2)).toBe('نتيجتان');
    expect(translatePlural(uiDictionaries, 'ar', 'table.results', 5)).toBe('5 نتائج');
    expect(translatePlural(uiDictionaries, 'ar', 'table.results', 11)).toBe('11 نتيجة');
    expect(translatePlural(uiDictionaries, 'en', 'table.results', 1234, undefined, (n) => n.toLocaleString('en'))).toBe('1,234 results');
  });
  it('merges app namespaces over the shared ones without losing keys', () => {
    const merged = mergeDictionaries(uiDictionaries, { en: { common: { save: 'Store' }, nav: { requests: 'Requests' } }, ar: { nav: { requests: 'الطلبات' } } });
    expect(translate(merged, 'en', 'common.save')).toBe('Store');
    expect(translate(merged, 'en', 'common.cancel')).toBe('Cancel');
    expect(translate(merged, 'ar', 'nav.requests')).toBe('الطلبات');
    expect(translate(uiDictionaries, 'en', 'common.save')).toBe('Save');
    expect(hasKey(merged, 'ar', 'nav.requests')).toBe(true);
    expect(hasKey(merged, 'ar', 'nav.unknown')).toBe(false);
  });
  it('reports gaps between two dictionaries', () => {
    const problems = compareDictionaries(
      { a: 'Hello {name}', b: { one: '{count} file', other: '{count} files' }, c: 'Only here' },
      { a: 'مرحبا', b: { one: 'ملف', other: 'ملفات' }, d: 'هناك فقط' },
    );
    expect(problems).toContain('placeholders differ: a');
    expect(problems).toContain('ar plural "b" lacks "few"');
    expect(problems).toContain('missing in ar: c');
    expect(problems).toContain('missing in en: d');
    expect(isPluralEntry({ one: 'x', other: 'y' })).toBe(true);
    expect(isPluralEntry({ title: 'x' })).toBe(false);
  });
  it('resolves the first-visit locale', () => {
    expect(resolveLocale({ cookie: 'ar', tenantDefault: 'en' })).toBe('ar');
    expect(resolveLocale({ cookie: 'fr', tenantDefault: 'ar' })).toBe('ar');
    expect(resolveLocale({ acceptLanguage: 'ar-AE,ar;q=0.9,en;q=0.8' })).toBe('ar');
    expect(resolveLocale({ acceptLanguage: 'de-DE,de;q=0.9' })).toBe('en');
    expect(resolveLocale({})).toBe('en');
  });
});

describe('status labels', () => {
  const families: Array<[keyof typeof STATUS_META, readonly string[]]> = [
    ['request', types.RequestStatusValues], ['requestCustomer', types.RequestStatusValues], ['invoice', types.InvoiceStatusValues], ['payment', types.PaymentStatusValues],
    ['requestPayment', types.RequestPaymentStatusValues], ['quotation', types.QuotationStatusValues], ['refund', types.RefundStatusValues], ['document', types.DocumentStatusValues],
    ['verification', types.VerificationStatusValues], ['checklist', types.ChecklistStatusValues], ['appointment', types.AppointmentStatusValues], ['task', types.TaskStatusValues],
    ['ticket', types.TicketStatusValues], ['customer', types.CustomerStatusValues], ['corporate', types.CorporateStatusValues], ['membership', types.MembershipStatusValues],
    ['subscription', types.SubscriptionStatusValues], ['tenant', types.TenantStatusValues], ['priority', types.RequestPriorityValues],
    ['queue', types.QueueStatusValues], ['reminder', types.ReminderStatusValues], ['notification', types.NotificationStatusValues], ['delivery', types.DeliveryStatusValues],
    ['automationExecution', types.AutomationExecutionStatusValues], ['publish', types.PublishStatusValues], ['approval', types.ApprovalStatusValues], ['domain', types.DomainStatusValues],
    ['integration', types.IntegrationStatusValues], ['subscriptionInvoice', types.SubscriptionInvoiceStatusValues],
    // Stored as plain strings by the API (reminder_dispatches.status): the values its reminders module writes.
    ['reminderDispatch', ['PENDING', 'SENT', 'FAILED', 'CANCELLED', 'SKIPPED_NO_CONSENT', 'SKIPPED_OPT_OUT']],
  ];
  it('have a family for every kind', () => {
    expect(Object.keys(STATUS_META).filter((kind) => kind !== 'portalAccess').sort()).toEqual(families.map(([kind]) => kind).sort());
  });
  it('cover every value of every status enum in both languages', () => {
    for (const [kind, values] of families) {
      for (const value of values) {
        const meta = (STATUS_META[kind] as Record<string, { en: string; ar: string; tone: string }>)[value];
        expect(meta, `${kind}.${value}`).toBeDefined();
        expect(meta.en.length, `${kind}.${value} en`).toBeGreaterThan(1);
        expect(meta.ar, `${kind}.${value} ar`).toMatch(/[؀-ۿ]/);
        expect(['neutral', 'info', 'warning', 'success', 'danger']).toContain(meta.tone);
      }
      expect(Object.keys(STATUS_META[kind]).sort(), kind).toEqual([...values].sort());
    }
  });
  it('degrade gracefully for a status the UI does not know yet', () => {
    expect(statusMeta('invoice', 'WRITTEN_OFF')).toEqual({ en: 'Written off', ar: 'Written off', tone: 'neutral' });
  });
});

describe('validation messages', () => {
  const t = (locale: 'en' | 'ar') => ({ t: (key: string, vars?: Record<string, string | number>) => translate(uiDictionaries, locale, key, vars) });
  it('translates the messages of the shared schemas and of Zod', () => {
    expect(localiseValidationMessage('Use international format, e.g. +971501234567', t('ar'))).toBe(lookup(ar, 'validation.phone'));
    expect(localiseValidationMessage('Required', t('en'))).toBe('This field is required');
    expect(localiseValidationMessage('String must contain at least 1 character(s)', t('en'))).toBe('This field is required');
    expect(localiseValidationMessage('String must contain at least 2 character(s)', t('en'))).toBe('Use at least 2 characters');
    expect(localiseValidationMessage('String must contain at most 120 character(s)', t('ar'))).toContain('120');
    expect(localiseValidationMessage('Expected string, received null', t('en'))).toBe('This field is required');
    expect(localiseValidationMessage("Invalid enum value. Expected 'INDIVIDUAL' | 'BUSINESS', received 'X'", t('en'))).toBe('Choose one of the options');
    expect(localiseValidationMessage('PASSWORDS_DIFFER', t('en'))).toBe('The two passwords are not the same.');
  });
  it('keeps unknown messages instead of hiding them', () => {
    expect(localiseValidationMessage('Each purpose may appear only once', t('ar'))).toBe('Each purpose may appear only once');
    expect(localiseValidationMessage(undefined, t('en'))).toBe('This value is not valid');
  });
  it('really matches what the shared schemas produce', async () => {
    const { customerSchema, tenantSignupSchema } = await import('@typease/validation');
    const messages = new Set<string>();
    for (const result of [
      customerSchema.safeParse({ fullName: 'A', phone: '050', email: 'nope', emiratesId: '123', passportNo: '!!', dateOfBirth: '1/2/3' }),
      tenantSignupSchema.safeParse({ businessName: '', slug: 'A B', ownerName: '', email: '', phone: '', password: 'short', acceptTerms: false }),
    ]) {
      if (!result.success) for (const issue of result.error.issues) messages.add(issue.message);
    }
    expect(messages.size).toBeGreaterThan(6);
    const untranslated = [...messages].filter((m) => localiseValidationMessage(m, t('ar')) === m);
    expect(untranslated).toEqual([]);
  });
});
