import PDFDocument from 'pdfkit';
import { FONTS, hasArabic, type PdfBrand, rtlPrepare } from '../finance/pdf.renderer';

export interface PayslipModel {
  brand: PdfBrand;
  runNo: string;
  period: string;
  currency: string;
  status: string;
  staffName: string;
  jobTitle: string | null;
  daysWorked: number;
  daysInPeriod: number;
  /** [English, Arabic, amount] */
  earnings: Array<[string, string, string]>;
  deductions: string;
  deductionNote: string | null;
  gross: string;
  net: string;
  paidAt: string | null;
}

const fmt = (v: string) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** One staff member's payslip for a month, English with Arabic labels. */
export function renderPayslip(m: PayslipModel): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Payslip ${m.period} ${m.staffName}`, Author: m.brand.name, Creator: 'TypEase' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('R', FONTS.regular);
    doc.registerFont('B', FONTS.bold);
    const style = (size: number, bold = false, color = '#111827') => doc.font(bold ? 'B' : 'R').fontSize(size).fillColor(color);
    const put = (text: string, x: number, y: number, opts: PDFKit.Mixins.TextOptions = {}) =>
      hasArabic(text) ? doc.text(rtlPrepare(text), x, y, { ...opts, lineBreak: false, features: ['rtla'] } as PDFKit.Mixins.TextOptions) : doc.text(text, x, y, { ...opts, lineBreak: false });
    const month = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m.period}-01T00:00:00Z`));

    doc.rect(0, 0, 595.28, 76).fill(m.brand.colors.primary);
    style(15, true, '#FFFFFF');
    put(m.brand.name, 50, 20, { width: 300 });
    if (m.brand.nameAr) {
      style(10, false, '#FFFFFF');
      put(m.brand.nameAr, 50, 42, { width: 300 });
    }
    style(15, true, '#FFFFFF');
    put('Payslip', 345, 20, { width: 200, align: 'right' });
    style(11, false, '#FFFFFF');
    put('قسيمة الراتب', 345, 42, { width: 200, align: 'right' });

    let y = 100;
    style(12, true);
    put(m.staffName, 50, y);
    style(9, false, '#4B5563');
    if (m.jobTitle) put(m.jobTitle, 50, y + 17);
    style(10, true);
    put(month, 345, y, { width: 200, align: 'right' });
    style(9, false, '#4B5563');
    put(`${m.runNo}   ·   ${m.daysWorked} / ${m.daysInPeriod} days`, 345, y + 17, { width: 200, align: 'right' });

    y = 160;
    const row = (en: string, ar: string, value: string, opts: { bold?: boolean; shade?: boolean } = {}) => {
      if (opts.shade) doc.rect(50, y - 5, 495, 24).fill('#F3F4F6');
      style(10, !!opts.bold);
      put(en, 60, y);
      style(9, false, '#6B7280');
      put(ar, 230, y, { width: 150, align: 'right' });
      style(10, !!opts.bold);
      put(`${m.currency} ${fmt(value)}`, 395, y, { width: 140, align: 'right' });
      y += 24;
      doc.moveTo(50, y - 6).lineTo(545, y - 6).lineWidth(0.4).strokeColor('#E5E7EB').stroke();
    };
    style(9, true, '#6B7280');
    put('EARNINGS', 60, y - 18);
    for (const [en, ar, v] of m.earnings) if (Number(v) !== 0 || en === 'Basic salary') row(en, ar, v);
    row('Gross pay', 'إجمالي الراتب', m.gross, { bold: true, shade: true });
    y += 10;
    style(9, true, '#6B7280');
    put('DEDUCTIONS', 60, y - 6);
    y += 12;
    row(m.deductionNote ? `Deductions (${m.deductionNote})` : 'Deductions', 'الاستقطاعات', m.deductions);
    y += 6;
    doc.rect(50, y - 6, 495, 34).fill(m.brand.colors.primary);
    style(12, true, '#FFFFFF');
    put('Net pay', 60, y + 3);
    put('صافي الراتب', 230, y + 3, { width: 150, align: 'right' });
    put(`${m.currency} ${fmt(m.net)}`, 395, y + 3, { width: 140, align: 'right' });
    y += 50;
    style(8.5, false, '#6B7280');
    put(m.paidAt ? `Paid on ${m.paidAt}.` : m.status === 'APPROVED' ? 'Approved, payment pending.' : '', 50, y);
    put('This payslip is generated electronically and needs no signature.', 50, y + 14);
    style(7.5, false, '#9CA3AF');
    doc.text(m.brand.poweredBy ? 'Prepared with TypEase' : '', 50, 800, { width: 495, align: 'center', lineBreak: false, height: 20 });
    doc.end();
  });
}
