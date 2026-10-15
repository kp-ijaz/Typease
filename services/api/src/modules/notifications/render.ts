import { SECRET_VARIABLES } from './catalogue';

/**
 * Template rendering. Pure functions, no I/O.
 *
 *   {{variable}}            replaced by the value (HTML-escaped in email bodies); unknown variables render empty
 *   [Label]({{linkVar}})    a link: a button in HTML email, "Label: url" in plain text. Dropped when the URL is empty.
 *
 * Links are recognised in the TEMPLATE only, never in variable values, and
 * values are substituted exactly once, so customer-supplied text can neither
 * inject markup nor smuggle a link into a message.
 */
export type TemplateData = Record<string, string | number | null | undefined>;

type Part = { t: 'text'; v: string } | { t: 'var'; name: string };
type Token = Part | { t: 'link'; label: Part[]; url: Part[] };

const VAR = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function parseParts(text: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(VAR)) {
    if (m.index! > last) parts.push({ t: 'text', v: text.slice(last, m.index) });
    parts.push({ t: 'var', name: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ t: 'text', v: text.slice(last) });
  return parts;
}
export function parseTemplate(template: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of template.matchAll(LINK)) {
    if (m.index! > last) tokens.push(...parseParts(template.slice(last, m.index)));
    tokens.push({ t: 'link', label: parseParts(m[1]), url: parseParts(m[2]) });
    last = m.index! + m[0].length;
  }
  if (last < template.length) tokens.push(...parseParts(template.slice(last)));
  return tokens;
}

/** Names of the variables a template uses, in order of first appearance. */
export function variablesIn(template: string | null | undefined): string[] {
  const names: string[] = [];
  const add = (p: Part) => {
    if (p.t === 'var' && !names.includes(p.name)) names.push(p.name);
  };
  for (const token of parseTemplate(template ?? '')) {
    if (token.t === 'link') [...token.label, ...token.url].forEach(add);
    else add(token);
  }
  return names;
}

const value = (data: TemplateData, name: string) => {
  const v = data[name];
  return v === null || v === undefined ? '' : String(v);
};
const plain = (parts: Part[], data: TemplateData) => parts.map((p) => (p.t === 'text' ? p.v : value(data, p.name))).join('');
const isHttpUrl = (url: string) => /^https?:\/\/[^\s<>"']+$/i.test(url);

/** Plain-text rendering (SMS, WhatsApp, in-app, push, and the text part of emails). */
export function renderText(template: string | null | undefined, data: TemplateData): string {
  const out = parseTemplate(template ?? '')
    .map((token) => {
      if (token.t === 'text') return token.v;
      if (token.t === 'var') return value(data, token.name);
      const url = plain(token.url, data).trim();
      return isHttpUrl(url) ? `${plain(token.label, data)}: ${url}` : '';
    })
    .join('');
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
/** Subjects are a single line. */
export const renderSubject = (template: string | null | undefined, data: TemplateData) => renderText(template, data).replace(/\s*\n\s*/g, ' ').slice(0, 250);

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * HTML rendering of an email body template. Returns the inner content
 * (paragraphs and buttons); `emailLayout` wraps it in the branded frame.
 */
export function renderHtmlBody(template: string | null | undefined, data: TemplateData, accentColor = '#0B7AD1'): string {
  const paragraphs = (template ?? '').split(/\n{2,}/);
  const html: string[] = [];
  for (const paragraph of paragraphs) {
    const tokens = parseTemplate(paragraph.trim());
    const onlyLink = tokens.length === 1 && tokens[0].t === 'link';
    const inner = tokens
      .map((token) => {
        if (token.t === 'text') return escapeHtml(token.v).replace(/\n/g, '<br>');
        if (token.t === 'var') return escapeHtml(value(data, token.name)).replace(/\n/g, '<br>');
        const url = plain(token.url, data).trim();
        if (!isHttpUrl(url)) return '';
        const label = escapeHtml(plain(token.label, data));
        return onlyLink
          ? `<a href="${escapeHtml(url)}" style="display:inline-block;background:${accentColor};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:6px">${label}</a>`
          : `<a href="${escapeHtml(url)}" style="color:${accentColor}">${label}</a>`;
      })
      .join('')
      .trim();
    if (!inner) continue;
    html.push(`<p style="margin:0 0 16px 0;line-height:1.6">${inner}</p>`);
  }
  return html.join('\n');
}

export interface EmailBrand {
  name: string;
  colors: { primary: string; secondary: string; accent: string };
  logoUrl?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  /** False for white-label centres: the footer then carries no TypEase mention. */
  showPlatformCredit: boolean;
}
const HEX = /^#[0-9A-Fa-f]{6}$/;
const colour = (c: string | undefined, fallback: string) => (c && HEX.test(c) ? c : fallback);

const FOOTER = {
  en: { contact: 'Questions? Contact us', sentBy: 'This message was sent by', credit: 'Powered by TypEase', secure: 'For your security we never send documents by email. Sign in to your portal to view them.' },
  ar: { contact: 'لديك استفسار؟ تواصل معنا', sentBy: 'أُرسلت هذه الرسالة من', credit: 'بدعم من TypEase', secure: 'حرصاً على أمانك، لا نرسل المستندات عبر البريد الإلكتروني. سجّل الدخول إلى البوابة للاطلاع عليها.' },
};

/** Wraps rendered email content in the centre's branded frame (inline CSS only, RTL for Arabic). */
export function emailLayout(input: { innerHtml: string; subject: string; language: string; brand: EmailBrand }): string {
  const { brand } = input;
  const lang = input.language === 'ar' ? 'ar' : 'en';
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const align = lang === 'ar' ? 'right' : 'left';
  const primary = colour(brand.colors.primary, '#0B2240');
  const text = FOOTER[lang];
  const contact = [brand.supportEmail, brand.supportPhone].filter(Boolean).map((c) => escapeHtml(String(c))).join(' &middot; ');
  const logo = brand.logoUrl && isHttpUrl(brand.logoUrl) ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" height="40" style="display:block;border:0;max-height:40px">` : '';
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f8;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:${primary};padding:20px 28px;text-align:${align}">${logo || `<span style="color:#ffffff;font-size:20px;font-weight:700">${escapeHtml(brand.name)}</span>`}</td></tr>
<tr><td style="padding:28px;font-size:15px;text-align:${align}" dir="${dir}">
${input.innerHtml}
</td></tr>
<tr><td style="padding:18px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-align:${align}" dir="${dir}">
<p style="margin:0 0 6px 0">${text.secure}</p>
${contact ? `<p style="margin:0 0 6px 0">${text.contact}: ${contact}</p>` : ''}
<p style="margin:0">${text.sentBy} ${escapeHtml(brand.name)}.${brand.showPlatformCredit ? ` ${text.credit}.` : ''}</p>
</td></tr>
</table>
</td></tr></table>
</body>
</html>`;
}

/** Copy of the data with secret values hidden, for anything that is stored or shown in a log. */
export function maskSecrets(data: TemplateData): TemplateData {
  const out: TemplateData = { ...data };
  for (const key of Object.keys(out)) if (SECRET_VARIABLES.includes(key) && out[key] !== null && out[key] !== undefined && out[key] !== '') out[key] = '[hidden]';
  return out;
}
export const hasSecrets = (data: TemplateData) => Object.keys(data).some((k) => SECRET_VARIABLES.includes(k) && data[k] !== null && data[k] !== undefined && data[k] !== '');
