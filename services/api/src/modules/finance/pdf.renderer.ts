import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';

/**
 * Layout of the customer-facing finance documents (quotation, tax invoice,
 * receipt, credit note) and the platform's subscription invoices. Pure: it
 * turns a plain model into PDF bytes and knows nothing about the database.
 *
 * Bilingual: every heading and label is printed in English and Arabic, and any
 * value may contain Arabic (names, addresses, descriptions). The embedded font
 * (IBM Plex Sans Arabic, SIL OFL, services/api/assets/fonts) covers both scripts.
 */
export interface PdfBrand {
  name: string;
  nameAr?: string | null;
  legalName?: string | null;
  /** Supplier address (the issuing branch), required on a tax invoice. */
  address?: string | null;
  taxRegistrationNo?: string | null;
  colors: { primary: string; secondary: string; accent: string };
  supportEmail?: string | null;
  supportPhone?: string | null;
  logo?: Buffer | null;
  footer?: string | null;
  /** Shown unless the centre uses its own (white-label) brand. */
  poweredBy: boolean;
}
export interface PdfRow {
  description: string;
  quantity: string;
  unitAmount: string;
  discount: string;
  tax: string;
  total: string;
}
export interface PdfSection {
  title: string;
  titleAr?: string;
  /** Small print under the section title. */
  note?: string | null;
  noteAr?: string | null;
  rows: PdfRow[];
  subtotalLabel: string;
  subtotalLabelAr?: string;
  subtotal: string;
}
/** [English label, value, Arabic label] */
export type PdfPair = [string, string] | [string, string, string | undefined];
export interface PdfModel {
  title: string;
  titleAr?: string;
  number: string;
  brand: PdfBrand;
  currency: string;
  /** Label / value pairs shown top right (dates, status, references). */
  meta: PdfPair[];
  party: { heading: string; headingAr?: string; lines: string[] };
  sections: PdfSection[];
  /** Simple two-column lines (used by receipts and credit notes). */
  facts?: PdfPair[];
  totals: Array<{ label: string; labelAr?: string; value: string; strong?: boolean }>;
  notes?: string | null;
  /** Large diagonal stamp: DRAFT, VOID, TEST ... */
  stamp?: string | null;
}

export const GOVERNMENT_FEE_NOTICE = 'Government fees are collected on behalf of the relevant authority.';
export const GOVERNMENT_FEE_NOTICE_AR = 'تُحصَّل الرسوم الحكومية نيابةً عن الجهة المختصة.';
export const THIRD_PARTY_NOTICE = 'Third-party charges are collected on behalf of the service provider.';
export const THIRD_PARTY_NOTICE_AR = 'تُحصَّل رسوم الأطراف الأخرى نيابةً عن مقدّم الخدمة.';

const PAGE = { width: 595.28, height: 841.89, margin: 40 };
const INK = '#1F2937';
const MUTED = '#6B7280';
const RULE = '#E5E7EB';
const BAND = 112;

/** The fonts ship with the API: src/modules/finance -> services/api/assets (dist/modules/finance in production). */
const FONT_DIR = [join(__dirname, '..', '..', '..', 'assets', 'fonts'), join(process.cwd(), 'assets', 'fonts'), join(process.cwd(), 'services', 'api', 'assets', 'fonts')].find((d) =>
  existsSync(join(d, 'IBMPlexSansArabic-Regular.ttf')),
);
if (!FONT_DIR) throw new Error('PDF fonts not found: services/api/assets/fonts/IBMPlexSansArabic-*.ttf must be deployed with the API.');
export const FONTS = { regular: join(FONT_DIR, 'IBMPlexSansArabic-Regular.ttf'), bold: join(FONT_DIR, 'IBMPlexSansArabic-Bold.ttf') };

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
/** Left-to-right runs inside Arabic text: Latin words, digits, amounts, codes, e-mail addresses. */
const LTR_RUN = /[A-Za-z0-9٠-٩](?:[A-Za-z0-9٠-٩.,:/\-+%#@&'_ ]*[A-Za-z0-9٠-٩%])?/g;
export const hasArabic = (text: string) => ARABIC.test(text);
/**
 * pdfkit lays out a right-to-left line by reversing all of it ("rtla"). Pre-reversing
 * the left-to-right runs makes them come out the right way round, in the right place.
 */
export const rtlPrepare = (text: string) => text.replace(LTR_RUN, (run) => [...run].reverse().join(''));

/** Kept for callers that still need a Latin-1 string (file names, HTTP headers). */
export const latin1 = (text: string | null | undefined): string =>
  (text ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    // eslint-disable-next-line no-control-regex -- tab and newline are deliberately kept in the Latin-1 whitelist
    .replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF]/g, '?');

const COLS = [
  { key: 'description', label: 'Description', ar: 'الوصف', x: 40, width: 215, align: 'left' as const },
  { key: 'quantity', label: 'Qty', ar: 'الكمية', x: 255, width: 40, align: 'right' as const },
  { key: 'unitAmount', label: 'Unit', ar: 'السعر', x: 295, width: 65, align: 'right' as const },
  { key: 'discount', label: 'Discount', ar: 'الخصم', x: 360, width: 60, align: 'right' as const },
  { key: 'tax', label: 'VAT', ar: 'الضريبة', x: 420, width: 55, align: 'right' as const },
  { key: 'total', label: 'Amount', ar: 'المبلغ', x: 475, width: 80, align: 'right' as const },
];

type TextOptions = PDFKit.Mixins.TextOptions;

export interface RenderOptions {
  compress?: boolean;
  /** Receives every string drawn, in drawing order (tests read the document through this). */
  onText?: (text: string) => void;
}

export function renderPdf(model: PdfModel, options: RenderOptions = {}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: PAGE.margin,
      compress: options.compress ?? true,
      bufferPages: true,
      info: { Title: `${model.title} ${model.number}`, Author: model.brand.name, Creator: 'TypEase', Producer: 'TypEase' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('R', FONTS.regular);
    doc.registerFont('B', FONTS.bold);

    /** Draws one string; Arabic (or mixed) text is laid out right to left. */
    const put = (text: string | null | undefined, x: number, y: number, opts: TextOptions & { bold?: boolean; size?: number; color?: string } = {}) => {
      const value = text ?? '';
      if (!value) return;
      options.onText?.(value);
      const { bold, size, color, ...rest } = opts;
      doc.font(bold ? 'B' : 'R');
      if (size) doc.fontSize(size);
      if (color) doc.fillColor(color);
      if (hasArabic(value)) doc.text(rtlPrepare(value), x, y, { ...rest, features: ['rtla'] } as TextOptions);
      else doc.text(value, x, y, rest);
    };
    const heightOf = (text: string, width: number, size: number, bold = false) => doc.font(bold ? 'B' : 'R').fontSize(size).heightOfString(hasArabic(text) ? rtlPrepare(text) : text, { width });

    /** Shortens a one-line string with "…" until it fits (pdfkit would otherwise wrap it). */
    const fit = (text: string | null | undefined, width: number, size: number, bold = false): string => {
      let value = text ?? '';
      doc.font(bold ? 'B' : 'R').fontSize(size);
      const measure = (t: string) => doc.widthOfString(hasArabic(t) ? rtlPrepare(t) : t);
      if (measure(value) <= width) return value;
      while (value.length > 1 && measure(`${value}…`) > width) value = value.slice(0, -1);
      return `${value.trimEnd()}…`;
    };

    const right = PAGE.width - PAGE.margin;
    const contentWidth = PAGE.width - PAGE.margin * 2;
    const bottom = PAGE.height - 70;
    let y = 0;
    const ensure = (height: number) => {
      if (y + height > bottom) {
        doc.addPage();
        y = PAGE.margin;
      }
    };

    // ---- header band: the centre (left) and the document (right)
    doc.rect(0, 0, PAGE.width, BAND).fill(model.brand.colors.primary);
    let nameX = PAGE.margin;
    if (model.brand.logo) {
      try {
        doc.image(model.brand.logo, PAGE.margin, 18, { fit: [100, 56] });
        nameX = PAGE.margin + 112;
      } catch {
        nameX = PAGE.margin; // an unreadable logo must never break an invoice
      }
    }
    const headWidth = 320 - (nameX - PAGE.margin);
    const white = { color: '#FFFFFF', lineBreak: false } as const;
    // One item per line, each shortened to fit: name, Arabic name, legal name, contact, address, TRN.
    put(fit(model.brand.name, headWidth, 16, true), nameX, 16, { ...white, bold: true, size: 16, width: headWidth });
    let hy = 37;
    if (model.brand.nameAr) {
      put(fit(model.brand.nameAr, headWidth, 10.5), nameX, hy, { ...white, size: 10.5, width: headWidth, align: 'left' });
      hy += 17;
    }
    const contact = [model.brand.supportPhone, model.brand.supportEmail].filter(Boolean).join('  |  ');
    for (const line of [model.brand.legalName, contact, model.brand.address]) {
      if (!line) continue;
      put(fit(line, headWidth, 8), nameX, hy, { ...white, size: 8, width: headWidth, align: hasArabic(line) ? 'right' : 'left' });
      hy += 11;
    }
    if (model.brand.taxRegistrationNo) {
      const trn = fit(`TRN ${model.brand.taxRegistrationNo}`, headWidth - 70, 8, true);
      put(trn, nameX, hy, { ...white, bold: true, size: 8, width: headWidth });
      // Separate strings: one line mixing both scripts would be reordered as a whole.
      put('الرقم الضريبي', nameX + doc.font('B').fontSize(8).widthOfString(trn) + 8, hy - 0.5, { ...white, size: 8, width: 70, align: 'left' });
    }
    put(fit(model.title.toUpperCase(), right - 360, 17, true), 360, 16, { ...white, bold: true, size: 17, width: right - 360, align: 'right' });
    if (model.titleAr) put(model.titleAr, 360, 40, { ...white, bold: true, size: 13, width: right - 360, align: 'right' });
    put(model.number, 360, 64, { ...white, size: 11, width: right - 360, align: 'right' });
    doc.rect(0, BAND, PAGE.width, 3).fill(model.brand.colors.accent);

    // ---- party (left) and meta (right)
    y = BAND + 20;
    put(model.party.heading.toUpperCase(), PAGE.margin, y, { color: MUTED, bold: true, size: 8, width: 120, lineBreak: false });
    if (model.party.headingAr) put(model.party.headingAr, PAGE.margin + 130, y - 1, { color: MUTED, bold: true, size: 8.5, width: 120, align: 'right', lineBreak: false });
    let leftY = y + 14;
    model.party.lines.filter(Boolean).forEach((line, i) => {
      const arabic = hasArabic(line);
      put(line, PAGE.margin, leftY, { color: INK, bold: i === 0, size: i === 0 ? 11 : 9, width: 250, align: arabic ? 'right' : 'left' });
      leftY = doc.y + 1.5;
    });
    let rightY = y;
    for (const [label, value, ar] of model.meta) {
      put(label, 330, rightY, { color: MUTED, size: 8.5, width: 62, lineBreak: false });
      if (ar) put(ar, 392, rightY - 0.5, { color: MUTED, size: 8.5, width: 58, align: 'right', lineBreak: false });
      put(fit(value, right - 455, 8.5, true), 455, rightY, { color: INK, bold: true, size: 8.5, width: right - 455, align: 'right', lineBreak: false });
      rightY += 15;
    }
    y = Math.max(leftY, rightY) + 14;

    // ---- simple facts (receipts, credit notes)
    if (model.facts?.length) {
      for (const [label, value, ar] of model.facts) {
        const h = Math.max(ar ? 24 : 14, heightOf(value, contentWidth - 160, 9.5) + 4);
        ensure(h);
        put(label, PAGE.margin, y, { color: MUTED, size: 9, width: 150 });
        if (ar) put(ar, PAGE.margin, y + 11, { color: MUTED, size: 8.5, width: 150, align: 'left' });
        put(value, PAGE.margin + 160, y, { color: INK, size: 9.5, width: contentWidth - 160, align: hasArabic(value) ? 'right' : 'left' });
        y += h + 2;
      }
      y += 10;
    }

    // ---- one clearly separated section per fee component
    const tableHeader = () => {
      doc.rect(PAGE.margin, y, contentWidth, 26).fill('#F3F4F6');
      for (const c of COLS) {
        put(c.label.toUpperCase(), c.x + 3, y + 4, { color: MUTED, bold: true, size: 7, width: c.width - 6, align: c.align, lineBreak: false });
        put(c.ar, c.x + 3, y + 13, { color: MUTED, size: 7.5, width: c.width - 6, align: c.align, lineBreak: false });
      }
      y += 29;
    };
    for (const section of model.sections) {
      ensure(80);
      put(section.title, PAGE.margin, y, { color: model.brand.colors.secondary, bold: true, size: 10.5, width: 300, lineBreak: false });
      if (section.titleAr) put(section.titleAr, PAGE.margin + 300, y - 1, { color: model.brand.colors.secondary, bold: true, size: 10.5, width: contentWidth - 300, align: 'right', lineBreak: false });
      y += 16;
      if (section.note) {
        put(fit(section.note, contentWidth * 0.55, 7.5), PAGE.margin, y, { color: MUTED, size: 7.5, width: contentWidth * 0.55, lineBreak: false });
        if (section.noteAr) put(fit(section.noteAr, contentWidth * 0.45, 7.5), PAGE.margin + contentWidth * 0.55, y - 0.5, { color: MUTED, size: 7.5, width: contentWidth * 0.45, align: 'right', lineBreak: false });
        y += 13;
      }
      tableHeader();
      for (const row of section.rows) {
        const arabic = hasArabic(row.description);
        const h = Math.max(13, heightOf(row.description, COLS[0].width - 6, 9) + 4);
        if (y + h > bottom) {
          doc.addPage();
          y = PAGE.margin;
          tableHeader();
        }
        put(row.description, COLS[0].x + 3, y, { color: INK, size: 9, width: COLS[0].width - 6, align: arabic ? 'right' : 'left' });
        for (const c of COLS.slice(1)) put((row as unknown as Record<string, string>)[c.key], c.x + 3, y, { color: INK, size: 9, width: c.width - 6, align: 'right', lineBreak: false });
        y += h;
        doc.moveTo(PAGE.margin, y - 1.5).lineTo(right, y - 1.5).lineWidth(0.5).strokeColor(RULE).stroke();
      }
      ensure(18);
      put(section.subtotalLabel, 200, y + 2, { color: INK, bold: true, size: 9, width: 170, align: 'right', lineBreak: false });
      if (section.subtotalLabelAr) put(section.subtotalLabelAr, 372, y + 1.5, { color: INK, bold: true, size: 9, width: 100, align: 'right', lineBreak: false });
      put(section.subtotal, 475 + 3, y + 2, { color: INK, bold: true, size: 9, width: 80 - 6, align: 'right', lineBreak: false });
      y += 26;
    }

    // ---- totals
    const totalsHeight = model.totals.length * 16 + 16;
    ensure(totalsHeight);
    const boxX = 290;
    doc.rect(boxX, y, right - boxX, totalsHeight).lineWidth(0.8).strokeColor(RULE).stroke();
    let ty = y + 8;
    for (const t of model.totals) {
      if (t.strong) doc.rect(boxX + 0.5, ty - 3, right - boxX - 1, 16).fill('#F3F4F6');
      const size = t.strong ? 9.5 : 8.5;
      put(fit(t.label, 92, size, t.strong), boxX + 8, ty, { color: INK, bold: t.strong, size, width: 92, lineBreak: false });
      if (t.labelAr) put(fit(t.labelAr, 88, size, t.strong), boxX + 100, ty - 0.5, { color: INK, bold: t.strong, size, width: 88, align: 'right', lineBreak: false });
      put(t.value, boxX + 192, ty, { color: INK, bold: t.strong, size, width: right - boxX - 200, align: 'right', lineBreak: false });
      ty += 16;
    }
    put(`All amounts in ${model.currency}`, PAGE.margin, y + 4, { color: MUTED, size: 8, width: 235 });
    put(model.currency === 'AED' ? 'جميع المبالغ بالدرهم الإماراتي' : `جميع المبالغ بعملة ${model.currency}`, PAGE.margin, y + 15, { color: MUTED, size: 8, width: 235, align: 'left' });
    let notesEnd = 0;
    if (model.notes) {
      put('NOTES', PAGE.margin, y + 32, { color: MUTED, bold: true, size: 8, width: 60, lineBreak: false });
      put('ملاحظات', PAGE.margin + 40, y + 31.5, { color: MUTED, bold: true, size: 8, width: 60, align: 'left', lineBreak: false });
      put(model.notes, PAGE.margin, y + 44, { color: INK, size: 9, width: 235 });
      notesEnd = doc.y;
    }
    y = Math.max(y + totalsHeight, notesEnd) + 10;

    // ---- stamp + footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      if (model.stamp) {
        doc.save();
        doc.rotate(-32, { origin: [PAGE.width / 2, PAGE.height / 2] });
        doc.fillOpacity(0.12);
        put(model.stamp, 0, PAGE.height / 2 - 48, { color: '#DC2626', bold: true, size: 96, width: PAGE.width, align: 'center', lineBreak: false });
        doc.restore();
        doc.fillOpacity(1);
      }
      doc.moveTo(PAGE.margin, PAGE.height - 58).lineTo(right, PAGE.height - 58).lineWidth(0.5).strokeColor(RULE).stroke();
      const footer = [model.brand.footer, model.brand.poweredBy ? 'Powered by TypEase - Typing Made Easy.' : null].filter(Boolean).join('   |   ');
      // Written inside the bottom margin: lineBreak false keeps pdfkit from starting a new page.
      put(fit(footer, contentWidth - 80, 7.5), PAGE.margin, PAGE.height - 50, { color: MUTED, size: 7.5, width: contentWidth - 80, height: 20, lineBreak: false });
      put(`Page ${i - range.start + 1} of ${range.count}`, right - 70, PAGE.height - 50, { color: MUTED, size: 7.5, width: 70, height: 20, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
