import PDFDocument from 'pdfkit';
import { FONTS, hasArabic, type PdfBrand, rtlPrepare } from './pdf.renderer';

export interface StatementPdf {
  brand: PdfBrand;
  customer: { name: string; nameAr: string | null; number: string; trn: string | null };
  from: string;
  to: string;
  currency: string;
  openingBalance: string;
  charged: string;
  received: string;
  closingBalance: string;
  lines: Array<{ date: string; reference: string; description: string; debit: string; credit: string; balance: string }>;
  ageing: Record<string, string>;
}

const PAGE = { width: 595.28, height: 841.89, margin: 40 };
const COLS = [
  { label: 'Date', ar: 'التاريخ', x: 40, w: 62, align: 'left' as const },
  { label: 'Reference', ar: 'المرجع', x: 102, w: 88, align: 'left' as const },
  { label: 'Description', ar: 'البيان', x: 190, w: 140, align: 'left' as const },
  { label: 'Debit', ar: 'مدين', x: 330, w: 75, align: 'right' as const },
  { label: 'Credit', ar: 'دائن', x: 405, w: 75, align: 'right' as const },
  { label: 'Balance', ar: 'الرصيد', x: 480, w: 75, align: 'right' as const },
];
const money = (v: string) => (Number(v) === 0 ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const balance = (v: string) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Statement of account: letterhead, the customer, period summary, every movement with a running balance, ageing. */
export function renderStatement(m: StatementPdf, onText?: (t: string) => void): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin, bufferPages: true, info: { Title: `Statement ${m.customer.number}`, Author: m.brand.name, Creator: 'TypEase' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('R', FONTS.regular);
    doc.registerFont('B', FONTS.bold);
    const style = (size: number, bold = false, color = '#111827') => doc.font(bold ? 'B' : 'R').fontSize(size).fillColor(color);
    /** Pure Arabic strings only (labels), drawn right to left. */
    const put = (text: string, x: number, y: number, opts: PDFKit.Mixins.TextOptions = {}) => {
      onText?.(text);
      if (hasArabic(text)) doc.text(rtlPrepare(text), x, y, { ...opts, lineBreak: false, features: ['rtla'] } as PDFKit.Mixins.TextOptions);
      else doc.text(text, x, y, { ...opts, lineBreak: false });
    };

    // ---- letterhead
    doc.rect(0, 0, PAGE.width, 80).fill(m.brand.colors.primary);
    let x = PAGE.margin;
    if (m.brand.logo) {
      try {
        doc.image(m.brand.logo, PAGE.margin, 14, { fit: [90, 52] });
        x += 102;
      } catch {
        x = PAGE.margin;
      }
    }
    style(15, true, '#FFFFFF');
    put(m.brand.name, x, 18, { width: 280, ellipsis: true });
    if (m.brand.nameAr) {
      style(10, false, '#FFFFFF');
      put(m.brand.nameAr, x, 40, { width: 280 });
    }
    style(15, true, '#FFFFFF');
    put('Statement of Account', 330, 18, { width: 225, align: 'right' });
    style(11, false, '#FFFFFF');
    put('كشف حساب', 330, 40, { width: 225, align: 'right' });

    // ---- customer and period
    let y = 100;
    style(8, true, '#6B7280');
    put('CUSTOMER', 40, y);
    style(11, true);
    put(m.customer.name, 40, y + 12, { width: 300, ellipsis: true });
    let cy = y + 28;
    style(9, false, '#374151');
    if (m.customer.nameAr && m.customer.nameAr !== m.customer.name) {
      put(m.customer.nameAr, 40, cy, { width: 300 });
      cy += 13;
    }
    put(`${m.customer.number}${m.customer.trn ? `   ·   TRN ${m.customer.trn}` : ''}`, 40, cy);
    style(8, true, '#6B7280');
    put('PERIOD', 380, y, { width: 175, align: 'right' });
    style(10, false);
    put(`${m.from}  to  ${m.to}`, 380, y + 12, { width: 175, align: 'right' });
    put(`Currency ${m.currency}`, 380, y + 26, { width: 175, align: 'right' });

    // ---- summary boxes
    y = 160;
    const boxes: Array<[string, string, string]> = [
      ['Opening balance', 'الرصيد الافتتاحي', m.openingBalance],
      ['Charged', 'المطالبات', m.charged],
      ['Received / credited', 'المقبوضات', m.received],
      ['Closing balance', 'الرصيد الختامي', m.closingBalance],
    ];
    boxes.forEach(([en, ar, v], i) => {
      const bx = 40 + i * 129;
      doc.roundedRect(bx, y, 121, 50, 4).fill(i === 3 ? '#F3F4F6' : '#FAFAFA');
      style(7.5, false, '#6B7280');
      put(en, bx + 8, y + 7);
      put(ar, bx + 8, y + 7, { width: 105, align: 'right' });
      style(12, true, i === 3 && Number(v) > 0 ? '#B91C1C' : '#111827');
      put(balance(v), bx + 8, y + 24, { width: 105, align: 'right' });
    });

    // ---- table
    y = 226;
    const header = () => {
      doc.rect(40, y, 515, 26).fill('#F3F4F6');
      for (const c of COLS) {
        style(8, true, '#374151');
        put(c.label, c.x + 4, y + 4, { width: c.w - 8, align: c.align });
        style(7.5, false, '#6B7280');
        put(c.ar, c.x + 4, y + 14, { width: c.w - 8, align: c.align === 'left' ? 'left' : 'right' });
      }
      y += 30;
    };
    header();
    const row = (cells: string[], bold = false) => {
      if (y > PAGE.height - 90) {
        doc.addPage();
        y = PAGE.margin;
        header();
      }
      COLS.forEach((c, i) => {
        style(8.5, bold || i === 5, '#111827');
        put(cells[i] ?? '', c.x + 4, y, { width: c.w - 8, align: c.align, ellipsis: true });
      });
      y += 15;
      doc.moveTo(40, y - 3).lineTo(555, y - 3).lineWidth(0.3).strokeColor('#E5E7EB').stroke();
    };
    row([m.from, '', 'Opening balance', '', '', balance(m.openingBalance)], true);
    for (const l of m.lines) row([l.date, l.reference, l.description, money(l.debit), money(l.credit), balance(l.balance)]);
    if (!m.lines.length) row(['', '', 'No movements in this period', '', '', '']);
    row([m.to, '', 'Closing balance', '', '', balance(m.closingBalance)], true);

    // ---- ageing of what is open
    y += 12;
    if (y > PAGE.height - 120) {
      doc.addPage();
      y = PAGE.margin;
    }
    style(9, true);
    put('Open invoices by age', 40, y);
    put('أعمار الفواتير المفتوحة', 40, y, { width: 515, align: 'right' });
    y += 16;
    const ages: Array<[string, string]> = [
      ['Not yet due', 'current'],
      ['1-30 days', 'days1to30'],
      ['31-60 days', 'days31to60'],
      ['61-90 days', 'days61to90'],
      ['Over 90 days', 'days90plus'],
    ];
    ages.forEach(([label, k], i) => {
      const bx = 40 + i * 103;
      doc.rect(bx, y, 99, 34).fill('#FAFAFA');
      style(7.5, false, '#6B7280');
      put(label, bx + 6, y + 5);
      style(10, true, k === 'days90plus' && Number(m.ageing[k]) > 0 ? '#B91C1C' : '#111827');
      put(balance(m.ageing[k] ?? '0'), bx + 6, y + 17, { width: 87, align: 'right' });
    });

    // ---- footer
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      style(7.5, false, '#9CA3AF');
      const foot = [`Statement ${m.customer.number}  ${m.from} – ${m.to}`, `Page ${i + 1} of ${pages.count}`, m.brand.poweredBy ? 'Prepared with TypEase' : null].filter(Boolean).join('   ·   ');
      doc.text(foot, 40, PAGE.height - 36, { width: 515, align: 'center', lineBreak: false, height: 20 });
    }
    doc.end();
  });
}
