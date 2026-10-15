import { NOTIFICATION_EVENTS } from '@typease/types';
import { allowedVariables, defaultTemplateRows, EVENT_DEFINITIONS, eventDefinition, sampleData } from './catalogue';
import { decide, explicitPreference, summarise, CustomerFacts } from './policy';
import { emailLayout, escapeHtml, maskSecrets, renderHtmlBody, renderSubject, renderText, variablesIn } from './render';
import { channelEnabled, parseSettings } from './settings';
import { effectiveTemplate, pickTemplate, TemplateRow } from './template.service';

describe('template rendering', () => {
  it('interpolates variables and renders unknown ones empty', () => {
    expect(renderText('Hello {{ name }}, your request {{requestNumber}}{{nope}} is ready.', { name: 'Sara', requestNumber: 'TE-1' })).toBe('Hello Sara, your request TE-1 is ready.');
    expect(renderText('A\n\n{{missing}}\n\nB', {})).toBe('A\n\nB');
    expect(renderSubject('Update\n{{x}}', { x: 'now' })).toBe('Update now');
  });

  it('escapes HTML in variable values and template text for email bodies', () => {
    const html = renderHtmlBody('Hello {{name}} <b>team</b>', { name: '<script>alert(1)</script> & "co"' });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;co&quot;');
    expect(html).toContain('&lt;b&gt;team&lt;/b&gt;');
    expect(html).not.toContain('<script>');
    expect(escapeHtml(`<a href='x'>`)).toBe('&lt;a href=&#39;x&#39;&gt;');
  });

  it('turns template links into buttons, but never links typed into a value', () => {
    const template = 'Hi {{name}}\n\n[Open your request]({{portalLink}})';
    const html = renderHtmlBody(template, { name: '[Click me](https://evil.example)', portalLink: 'https://portal.example/requests/1?a=1&b=2' });
    expect(html).toContain('<a href="https://portal.example/requests/1?a=1&amp;b=2"');
    expect(html).toContain('>Open your request</a>');
    expect(html).not.toContain('href="https://evil.example"');
    expect(renderText(template, { name: 'Sara', portalLink: 'https://portal.example/r/1' })).toBe('Hi Sara\n\nOpen your request: https://portal.example/r/1');
  });

  it('drops a link whose URL is empty or not http(s)', () => {
    expect(renderText('Bye\n\n[Manage]({{portalLink}})', { portalLink: '' })).toBe('Bye');
    expect(renderHtmlBody('[Manage]({{portalLink}})', { portalLink: 'javascript:alert(1)' })).toBe('');
  });

  it('substitutes values exactly once', () => {
    expect(renderText('{{a}}', { a: '{{b}}', b: 'secret' })).toBe('{{b}}');
  });

  it('lists variables in order of first appearance', () => {
    expect(variablesIn('{{b}} {{a}} [x]({{link}}) {{b}}')).toEqual(['b', 'a', 'link']);
  });

  it('wraps email content in the branded frame, right-to-left for Arabic', () => {
    const brand = { name: 'Al <Noor>', colors: { primary: '#112233', secondary: '#445566', accent: '#778899' }, supportEmail: 'help@alnoor.example', supportPhone: null, showPlatformCredit: false };
    const html = emailLayout({ innerHtml: '<p>x</p>', subject: 'S', language: 'ar', brand });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('background:#112233');
    expect(html).toContain('Al &lt;Noor&gt;');
    expect(html).toContain('help@alnoor.example');
    expect(html).not.toContain('TypEase');
    expect(emailLayout({ innerHtml: '', subject: 'S', language: 'en', brand: { ...brand, showPlatformCredit: true } })).toContain('Powered by TypEase');
  });

  it('hides secret values in anything that is stored', () => {
    expect(maskSecrets({ name: 'Sara', link: 'https://x/?token=abc', code: '123456' })).toEqual({ name: 'Sara', link: '[hidden]', code: '[hidden]' });
  });
});

describe('platform default templates', () => {
  const rows = defaultTemplateRows();

  it('exist for every notification event in English and Arabic, for email and in-app', () => {
    for (const key of Object.keys(NOTIFICATION_EVENTS)) {
      for (const channel of ['EMAIL', 'IN_APP']) {
        for (const language of ['en', 'ar']) {
          const row = rows.find((r) => r.eventKey === key && r.channel === channel && r.language === language);
          expect([key, channel, language, !!row]).toEqual([key, channel, language, true]);
          if (channel === 'EMAIL') expect(row!.subject).toBeTruthy();
        }
      }
    }
  });

  it('have concise SMS and WhatsApp variants for the customer-facing operational events', () => {
    for (const key of ['account.otp', 'request.documents_missing', 'quotation.ready', 'payment.requested', 'payment.received', 'request.status_changed', 'request.completed', 'appointment.confirmation', 'appointment.reminder', 'document.expiry']) {
      for (const channel of ['SMS', 'WHATSAPP']) {
        for (const language of ['en', 'ar']) {
          const row = rows.find((r) => r.eventKey === key && r.channel === channel && r.language === language);
          expect([key, channel, language, !!row]).toEqual([key, channel, language, true]);
          expect(row!.body.length).toBeLessThanOrEqual(320);
        }
      }
    }
  });

  it('only use documented variables', () => {
    for (const row of rows) {
      const used = [...variablesIn(row.subject), ...variablesIn(row.body)];
      const unknown = used.filter((v) => !allowedVariables(row.eventKey).includes(v));
      expect([row.eventKey, row.channel, row.language, unknown]).toEqual([row.eventKey, row.channel, row.language, []]);
    }
  });

  it('never carry a document file, storage or download URL: links go to sign-in protected pages only', () => {
    // consoleLink: the platform console (sign-in required), used only in messages to TypEase staff.
    // renewLink: the one exception without sign-in - a signed, expiring link to one renewal quotation (price, approve,
    // decline, pay). It shows no document, file or contact detail (renewals.spec.ts checks the page).
    // signLink: likewise a signed, expiring link to one document the person is asked to sign (they must read it first).
    const allowedLinkVariables = ['portalLink', 'renewalLink', 'renewLink', 'signLink', 'centreLink', 'consoleLink', 'link'];
    const forbidden = /download|storage|file|attachment|signed|s3|bucket|documenturl|documentlink|shareurl/i;
    for (const d of EVENT_DEFINITIONS) {
      for (const name of Object.keys(d.variables)) {
        expect([d.key, name, forbidden.test(name)]).toEqual([d.key, name, false]);
        if (/link|url/i.test(name)) expect(allowedLinkVariables).toContain(name);
      }
    }
    for (const row of rows) {
      const used = [...variablesIn(row.subject), ...variablesIn(row.body)];
      for (const name of used) expect([row.eventKey, name, forbidden.test(name)]).toEqual([row.eventKey, name, false]);
      // No hard-coded URLs either: every link comes from a variable.
      expect(row.body).not.toMatch(/https?:\/\//i);
      // The one-time link variable is reserved for account-security messages.
      if (used.includes('link')) expect(eventDefinition(row.eventKey)!.group).toBe('security');
    }
  });

  it('describe document expiry without claims about legal deadlines or penalties', () => {
    for (const row of rows.filter((r) => r.eventKey === 'document.expiry')) {
      const text = `${row.subject ?? ''} ${row.body}`;
      expect(text).not.toMatch(/penalt|fine[sd]?\b|illegal|deadline|overstay|غرامة|مخالفة|عقوبة/i);
      expect(text).toMatch(row.language === 'ar' ? /وفقاً لسجلاتنا/ : /according to our records/i);
    }
  });

  it('render with their sample data without leaving placeholders behind', () => {
    for (const row of rows) {
      const text = renderText(row.body, sampleData(row.eventKey));
      expect(text).not.toContain('{{');
      expect(text.length).toBeGreaterThan(10);
    }
  });
});

describe('template selection', () => {
  const row = (tenantId: string | null, channel: string, language: string, body: string, isActive = true): TemplateRow => ({ id: `${tenantId}-${channel}-${language}`, tenantId, eventKey: 'request.created', channel: channel as any, language, name: 'n', subject: null, body, whatsappTemplateName: null, isActive });

  it('prefers the tenant override, then the default, in the wanted language', () => {
    const rows = [row(null, 'EMAIL', 'en', 'default en'), row(null, 'EMAIL', 'ar', 'default ar'), row('t1', 'EMAIL', 'en', 'tenant en')];
    expect(pickTemplate(rows, 'EMAIL', 'en')).toMatchObject({ body: 'tenant en', source: 'TENANT' });
    // The right language beats the centre's English wording.
    expect(pickTemplate(rows, 'EMAIL', 'ar')).toMatchObject({ body: 'default ar', source: 'DEFAULT' });
    expect(pickTemplate([row('t1', 'EMAIL', 'en', 'tenant en')], 'EMAIL', 'ar')).toMatchObject({ body: 'tenant en', language: 'en' });
    expect(pickTemplate(rows, 'SMS', 'en')).toBeNull();
  });
  it('falls back to the built-in default only while the database has not been seeded', () => {
    // Nothing in the database for this event: the built-in wording keeps account messages flowing.
    expect(effectiveTemplate([], 'account.email_verification', 'EMAIL', 'ar')).toMatchObject({ source: 'DEFAULT', language: 'ar', id: 'builtin:account.email_verification:EMAIL:ar' });
    expect(effectiveTemplate([], 'request.created', 'PUSH', 'en')).toMatchObject({ channel: 'PUSH', body: 'We received your request for {{serviceName}}.' });
    expect(effectiveTemplate([], 'request.created', 'SMS', 'en')).toBeNull(); // no SMS default exists for this event
    // A platform row that was switched off stays off.
    expect(effectiveTemplate([row(null, 'EMAIL', 'en', 'x', false)], 'request.created', 'EMAIL', 'en')).toBeNull();
    expect(effectiveTemplate([row('t1', 'EMAIL', 'en', 'tenant en')], 'request.created', 'EMAIL', 'en')).toMatchObject({ body: 'tenant en', source: 'TENANT' });
  });
  it('ignores inactive rows and lets push fall back to the in-app text', () => {
    expect(pickTemplate([row(null, 'EMAIL', 'en', 'x', false)], 'EMAIL', 'en')).toBeNull();
    expect(pickTemplate([row(null, 'IN_APP', 'en', 'in-app')], 'PUSH', 'en')).toMatchObject({ body: 'in-app', channel: 'PUSH' });
  });
});

describe('consent and preference policy', () => {
  const customer = (over: Partial<CustomerFacts> = {}): CustomerFacts => ({ kind: 'CUSTOMER', communicationPrefs: { email: true, sms: true, whatsapp: false, push: true }, marketingOptIn: false, consents: {}, preferences: [], ...over });

  it('allows service messages by default and honours the general channel switch', () => {
    expect(decide('request.created', 'EMAIL', customer())).toEqual({ allowed: true });
    expect(decide('request.created', 'SMS', customer({ communicationPrefs: { sms: false } }))).toEqual({ allowed: false, reason: 'OPT_OUT' });
    expect(decide('request.created', 'IN_APP', customer({ communicationPrefs: { email: false, sms: false } }))).toEqual({ allowed: true });
  });
  it('lets an explicit preference win, the event group over "*"', () => {
    const prefs = [{ channel: 'EMAIL' as const, eventGroup: '*', enabled: false }, { channel: 'EMAIL' as const, eventGroup: 'payments', enabled: true }];
    expect(explicitPreference(prefs, 'EMAIL', 'payments')).toBe(true);
    expect(explicitPreference(prefs, 'EMAIL', 'requests')).toBe(false);
    expect(explicitPreference(prefs, 'SMS', 'requests')).toBeUndefined();
    expect(decide('payment.requested', 'EMAIL', customer({ preferences: prefs }))).toEqual({ allowed: true });
    expect(decide('request.created', 'EMAIL', customer({ preferences: prefs }))).toEqual({ allowed: false, reason: 'OPT_OUT' });
    // An explicit opt-in overrides the general switch.
    expect(decide('request.created', 'SMS', customer({ communicationPrefs: { sms: false }, preferences: [{ channel: 'SMS', eventGroup: 'requests', enabled: true }] }))).toEqual({ allowed: true });
  });
  it('requires WhatsApp consent to be GRANTED and the channel switched on', () => {
    expect(decide('request.completed', 'WHATSAPP', customer())).toEqual({ allowed: false, reason: 'NO_CONSENT_WHATSAPP' });
    expect(decide('request.completed', 'WHATSAPP', customer({ consents: { WHATSAPP: 'WITHDRAWN' } }))).toEqual({ allowed: false, reason: 'NO_CONSENT_WHATSAPP' });
    expect(decide('request.completed', 'WHATSAPP', customer({ consents: { WHATSAPP: 'GRANTED' } }))).toEqual({ allowed: false, reason: 'OPT_OUT' });
    expect(decide('request.completed', 'WHATSAPP', customer({ consents: { WHATSAPP: 'GRANTED' }, communicationPrefs: { whatsapp: true } }))).toEqual({ allowed: true });
    expect(decide('request.completed', 'WHATSAPP', { kind: 'USER', preferences: [] })).toEqual({ allowed: false, reason: 'NO_CONSENT_WHATSAPP' });
  });
  it('requires REMINDERS consent for expiry reminders and MARKETING consent for marketing', () => {
    expect(decide('document.expiry', 'EMAIL', customer())).toEqual({ allowed: false, reason: 'NO_CONSENT_REMINDERS' });
    expect(decide('document.expiry', 'EMAIL', customer({ consents: { REMINDERS: 'GRANTED' } }))).toEqual({ allowed: true });
    expect(decide('marketing.offer', 'EMAIL', customer({ consents: { MARKETING: 'GRANTED' } }))).toEqual({ allowed: false, reason: 'NO_CONSENT_MARKETING' });
    expect(decide('marketing.offer', 'EMAIL', customer({ consents: { MARKETING: 'GRANTED' }, marketingOptIn: true }))).toEqual({ allowed: true });
    // A company contact is reminded under the corporate agreement; a bare consumer address is not.
    expect(decide('document.expiry', 'EMAIL', { kind: 'ADDRESS', businessContact: true })).toEqual({ allowed: true });
    expect(decide('document.expiry', 'EMAIL', { kind: 'ADDRESS' })).toEqual({ allowed: false, reason: 'NO_CONSENT_REMINDERS' });
  });
  it('never blocks account-security messages', () => {
    const optedOut = customer({ communicationPrefs: { email: false, sms: false }, preferences: [{ channel: 'SMS', eventGroup: '*', enabled: false }] });
    expect(decide('account.otp', 'SMS', optedOut)).toEqual({ allowed: true });
    expect(decide('account.password_reset', 'EMAIL', optedOut)).toEqual({ allowed: true });
    expect(decide('staff.invitation', 'EMAIL', { kind: 'ADDRESS' })).toEqual({ allowed: true });
  });
  it('summarises the channels of one event for the reminder scan', () => {
    expect(summarise([{ allowed: false, reason: 'OPT_OUT' }, { allowed: true }])).toBe('ALLOWED');
    expect(summarise([{ allowed: false, reason: 'NO_CONSENT_REMINDERS' }, { allowed: false, reason: 'NO_CONSENT_REMINDERS' }])).toBe('NO_CONSENT');
    expect(summarise([{ allowed: false, reason: 'OPT_OUT' }, { allowed: false, reason: 'NO_CONSENT_WHATSAPP' }])).toBe('OPT_OUT');
  });
});

describe('notification settings', () => {
  it('fall back to the event defaults and accept explicit switches', () => {
    const settings = parseSettings({ notifications: { events: { 'request.created': { EMAIL: false, SMS: true } }, rateLimitPerHour: 5 } });
    expect(settings.rateLimitPerHour).toBe(5);
    expect(channelEnabled(settings, 'request.created', 'EMAIL')).toBe(false);
    expect(channelEnabled(settings, 'request.created', 'SMS')).toBe(true);
    expect(channelEnabled(settings, 'request.created', 'IN_APP')).toBe(true);
    expect(channelEnabled(settings, 'request.created', 'WHATSAPP')).toBe(false);
    expect(parseSettings(null).rateLimitPerHour).toBe(20);
    expect(parseSettings({ notifications: { rateLimitPerHour: 9999 } }).rateLimitPerHour).toBe(20);
  });
});
