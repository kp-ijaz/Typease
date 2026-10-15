import PDFDocument from 'pdfkit';
import { FONTS, hasArabic, type PdfBrand, rtlPrepare } from '../finance/pdf.renderer';

const PAGE = { width: 595.28, height: 841.89, margin: 50 };
const BAND = 86;

export interface LetterModel {
  brand: PdfBrand;
  documentNo: string;
  date: string;
  titleEn: string;
  titleAr: string | null;
  bodyEn: string;
  bodyAr: string | null;
  signature: { name: string; image: Buffer | null; at: string; via: string } | null;
  requiresSignature: boolean;
  /** Short form of the content hash, printed so a copy can be checked against the record. */
  reference: string | null;
  draft: boolean;
}

/** A certificate or letter on the centre's letterhead: English, then Arabic (right to left), then the signature. */
export function renderLetter(model: LetterModel, onText?: (text: string) => void): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin, bufferPages: true, info: { Title: `${model.titleEn} ${model.documentNo}`, Author: model.brand.name, Creator: 'TypEase' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('R', FONTS.regular);
    doc.registerFont('B', FONTS.bold);
    const width = PAGE.width - PAGE.margin * 2;
    const bottom = PAGE.height - 70;
    let y = 0;

    const style = (size: number, bold = false, color = '#111827') => doc.font(bold ? 'B' : 'R').fontSize(size).fillColor(color);
    const measure = (text: string) => doc.widthOfString(hasArabic(text) ? rtlPrepare(text) : text);
    const ensure = (h: number) => {
      if (y + h > bottom) {
        doc.addPage();
        y = PAGE.margin;
      }
    };
    /** Breaks a paragraph into lines that fit, keeping the words in reading order. */
    const lines = (text: string) => {
      const out: string[] = [];
      let line = '';
      for (const word of text.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (line && measure(next) > width) {
          out.push(line);
          line = word;
        } else line = next;
      }
      if (line) out.push(line);
      return out;
    };
    /**
     * A line with Arabic, laid out right to left run by run: pdfkit picks the direction of a whole string from its
     * first letter, so a line that starts with a Latin word would otherwise come out left to right.
     */
    const drawRtl = (line: string, right: number) => {
      let x = right;
      const runs = line.split(/([A-Za-z0-9٠-٩](?:[A-Za-z0-9٠-٩.,:/\-+%#@&'_ ]*[A-Za-z0-9٠-٩%])?)/).filter((r) => r !== '');
      for (const run of runs) {
        const latin = /^[A-Za-z0-9٠-٩]/.test(run);
        const arabic = hasArabic(run);
        // Spaces and punctuation between runs follow the right-to-left order of the line.
        const text = latin || arabic ? run : [...run].reverse().join('');
        const w = doc.widthOfString(text);
        x -= w;
        if (arabic) doc.text(text, x, y, { lineBreak: false, features: ['rtla'] } as PDFKit.Mixins.TextOptions);
        else doc.text(text, x, y, { lineBreak: false });
      }
    };
    const rtlWidth = (line: string) => doc.widthOfString(line);
    /** One paragraph; Arabic lines are drawn one by one, right-aligned. */
    const paragraph = (text: string, size: number, rtl: boolean, opts: { bold?: boolean; color?: string; align?: 'center' } = {}) => {
      style(size, opts.bold, opts.color);
      const lh = size * 1.55;
      if (!text.trim()) {
        y += lh * 0.6;
        return;
      }
      for (const line of lines(text)) {
        ensure(lh);
        onText?.(line);
        const align = opts.align ?? (rtl ? 'right' : 'left');
        if (hasArabic(line)) drawRtl(line, align === 'center' ? PAGE.margin + width / 2 + rtlWidth(line) / 2 : PAGE.margin + width);
        else doc.text(line, PAGE.margin, y, { width, align, lineBreak: false });
        y += lh;
      }
    };

    // ---- letterhead
    doc.rect(0, 0, PAGE.width, BAND).fill(model.brand.colors.primary);
    let x = PAGE.margin;
    if (model.brand.logo) {
      try {
        doc.image(model.brand.logo, PAGE.margin, 16, { fit: [90, 54] });
        x += 102;
      } catch {
        x = PAGE.margin;
      }
    }
    style(16, true, '#FFFFFF');
    doc.text(model.brand.name, x, 20, { width: 300, lineBreak: false });
    onText?.(model.brand.name);
    if (model.brand.nameAr) {
      style(10.5, false, '#FFFFFF');
      doc.text(rtlPrepare(model.brand.nameAr), x, 42, { width: 300, lineBreak: false, features: ['rtla'] } as PDFKit.Mixins.TextOptions);
    }
    const contact = [model.brand.supportPhone, model.brand.supportEmail, model.brand.address].filter(Boolean).join('  |  ');
    if (contact) {
      style(7.5, false, '#FFFFFF');
      doc.text(contact, x, 62, { width: PAGE.width - x - PAGE.margin, lineBreak: false, ellipsis: true });
    }
    y = BAND + 24;
    style(9, false, '#6B7280');
    doc.text(`${model.documentNo}   ·   ${model.date}`, PAGE.margin, y, { width, align: 'right', lineBreak: false });
    onText?.(model.documentNo);
    y += 26;
    if (model.draft) {
      doc.save().rotate(-30, { origin: [PAGE.width / 2, PAGE.height / 2] });
      style(90, true, '#F3F4F6');
      doc.text('DRAFT', 0, PAGE.height / 2 - 60, { width: PAGE.width, align: 'center', lineBreak: false });
      doc.restore();
    }

    // ---- title and the two texts
    paragraph(model.titleEn, 17, false, { bold: true, align: 'center' });
    if (model.titleAr) paragraph(model.titleAr, 15, true, { bold: true, align: 'center' });
    y += 12;
    for (const p of model.bodyEn.split('\n')) paragraph(p, 10.5, false);
    if (model.bodyAr) {
      y += 8;
      ensure(30);
      doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).lineWidth(0.6).strokeColor('#E5E7EB').stroke();
      y += 14;
      for (const p of model.bodyAr.split('\n')) paragraph(p, 10.5, true);
    }

    // ---- signature
    if (model.requiresSignature) {
      y += 18;
      ensure(120);
      style(9, true, '#374151');
      doc.text('Signature', PAGE.margin, y, { lineBreak: false });
      drawRtl('التوقيع', PAGE.width - PAGE.margin);
      y += 16;
      if (model.signature?.image) {
        try {
          doc.image(model.signature.image, PAGE.margin, y, { fit: [200, 70] });
        } catch {
          /* an unreadable image never breaks the document: the name, time and reference below still identify the signature */
        }
      }
      y += 74;
      doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + 220, y).lineWidth(0.6).strokeColor('#9CA3AF').stroke();
      y += 6;
      if (model.signature) {
        paragraph(model.signature.name, 10, hasArabic(model.signature.name), { bold: true });
        style(8, false, '#6B7280');
        doc.text(`Signed electronically ${model.signature.at} (${model.signature.via === 'LINK' ? 'by link' : 'at the counter'})`, PAGE.margin, y, { width, lineBreak: false });
        y += 14;
      } else {
        style(8, false, '#6B7280');
        doc.text('Name and signature', PAGE.margin, y, { lineBreak: false });
        y += 14;
      }
    }

    // ---- footer on every page
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      style(7.5, false, '#9CA3AF');
      const foot = [model.documentNo, model.reference ? `Ref. ${model.reference}` : null, `Page ${i + 1} of ${pages.count}`, model.brand.poweredBy ? 'Prepared with TypEase' : null].filter(Boolean).join('   ·   ');
      doc.text(foot, PAGE.margin, PAGE.height - 40, { width, align: 'center', lineBreak: false, height: 20 });
    }
    doc.end();
  });
}
