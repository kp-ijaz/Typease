import PDFDocument from 'pdfkit';
import { latin1 } from '../../finance/pdf.renderer';
import type { ReportColumn } from '../report.types';
import { displayText } from './sanitise';
import type { ExportModel } from './xlsx';

export interface PdfBrand {
  name: string;
  colors: { primary: string; secondary: string; accent: string };
  supportEmail?: string | null;
  supportPhone?: string | null;
  /** Shown unless the centre uses its own (white-label) brand. */
  poweredBy: boolean;
}

const INK = '#1F2937';
const MUTED = '#6B7280';
const RULE = '#E5E7EB';
const HEX = /^#[0-9A-Fa-f]{6}$/;
const NUMERIC: Array<ReportColumn['type']> = ['number', 'money', 'percent'];

/**
 * PDF of a report: branded header band, the table with a repeated header row
 * and page breaks, a totals row, the notes and page numbers.
 * English only (the built-in PDF fonts cover Latin-1; other characters print as "?").
 */
export function buildPdf(model: ExportModel, brand: PdfBrand, options: { compress?: boolean } = {}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const landscape = model.columns.length > 6;
    const doc = new PDFDocument({
      size: 'A4',
      layout: landscape ? 'landscape' : 'portrait',
      margin: 36,
      compress: options.compress ?? true,
      bufferPages: true,
      info: { Title: latin1(model.title), Author: latin1(brand.name), Creator: 'TypEase', Producer: 'TypEase', CreationDate: model.generatedAt },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const margin = 36;
    const width = doc.page.width - margin * 2;
    const bottom = doc.page.height - 50;
    const primary = HEX.test(brand.colors.primary) ? brand.colors.primary : '#0B2240';

    // ---- header band (first page)
    doc.rect(0, 0, doc.page.width, 64).fill(primary);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(15).text(latin1(brand.name), margin, 18, { width: width * 0.55, lineBreak: false, ellipsis: true });
    const contact = [brand.supportPhone, brand.supportEmail].filter(Boolean).join('  |  ');
    if (contact) doc.font('Helvetica').fontSize(8).text(latin1(contact), margin, 40, { width: width * 0.55, lineBreak: false, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(13).text(latin1(model.title), margin + width * 0.55, 18, { width: width * 0.45, align: 'right', lineBreak: false, ellipsis: true });
    doc.font('Helvetica').fontSize(8).text(latin1(`Generated ${model.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`), margin + width * 0.55, 40, { width: width * 0.45, align: 'right', lineBreak: false });

    let y = 78;
    doc.fillColor(MUTED).font('Helvetica').fontSize(8);
    const filters = [...model.parameters, ['Currency', model.currency] as [string, string]].map(([label, value]) => `${label}: ${value}`).join('    ');
    doc.text(latin1(filters), margin, y, { width });
    y = doc.y + 8;

    // ---- table geometry: text columns share the room that numeric columns leave
    const fontSize = model.columns.length > 9 ? 6.5 : model.columns.length > 6 ? 7.5 : 8.5;
    const numericWidth = Math.min(72, Math.max(46, width / Math.max(model.columns.length, 1)));
    const numericCount = model.columns.filter((c) => NUMERIC.includes(c.type) || c.type === 'date').length;
    const textCount = Math.max(model.columns.length - numericCount, 1);
    const textWidth = Math.max(50, (width - numericCount * numericWidth) / textCount);
    const scale = width / (numericCount * numericWidth + (model.columns.length - numericCount) * textWidth || 1);
    let x = margin;
    const layout = model.columns.map((c) => {
      const w = (NUMERIC.includes(c.type) || c.type === 'date' ? numericWidth : textWidth) * scale;
      const cell = { column: c, x, width: w, align: NUMERIC.includes(c.type) ? ('right' as const) : ('left' as const) };
      x += w;
      return cell;
    });
    const pad = 3;
    const heightOf = (texts: string[], bold: boolean) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
      return Math.max(...texts.map((t, i) => doc.heightOfString(t || ' ', { width: layout[i].width - pad * 2 })), fontSize) + pad * 2;
    };
    const drawRow = (texts: string[], style: { bold?: boolean; fill?: string; color?: string }) => {
      const h = heightOf(texts, !!style.bold);
      if (style.fill) doc.rect(margin, y, width, h).fill(style.fill);
      doc.fillColor(style.color ?? INK).font(style.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
      texts.forEach((t, i) => doc.text(t, layout[i].x + pad, y + pad, { width: layout[i].width - pad * 2, align: layout[i].align }));
      y += h;
      doc.moveTo(margin, y).lineTo(margin + width, y).lineWidth(0.5).strokeColor(RULE).stroke();
    };
    const headerTexts = model.columns.map((c) => latin1(c.label));
    const drawHeader = () => drawRow(headerTexts, { bold: true, fill: primary, color: '#FFFFFF' });
    const ensure = (h: number) => {
      if (y + h <= bottom) return;
      doc.addPage();
      y = margin;
      drawHeader();
    };

    drawHeader();
    if (!model.rows.length) {
      doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9).text('No data for the chosen filters.', margin, y + 8, { width });
      y = doc.y + 8;
    }
    for (const row of model.rows) {
      const texts = model.columns.map((c) => latin1(displayText(c, row[c.key])));
      ensure(heightOf(texts, false));
      drawRow(texts, {});
    }
    if (model.totals) {
      const texts = model.columns.map((c) => latin1(displayText(c, model.totals![c.key])));
      ensure(heightOf(texts, true));
      drawRow(texts, { bold: true, fill: '#F3F4F6' });
    }

    // ---- notes
    if (model.notes.length) {
      y += 12;
      doc.font('Helvetica-Bold').fontSize(9);
      if (y + 30 > bottom) {
        doc.addPage();
        y = margin;
      }
      doc.fillColor(INK).text('Notes', margin, y, { width });
      y = doc.y + 3;
      for (const note of model.notes) {
        doc.font('Helvetica').fontSize(8);
        const h = doc.heightOfString(latin1(`- ${note}`), { width });
        if (y + h > bottom) {
          doc.addPage();
          y = margin;
        }
        doc.fillColor(MUTED).text(latin1(`- ${note}`), margin, y, { width });
        y = doc.y + 3;
      }
    }

    // ---- footer on every page
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      // Writing inside the bottom margin would otherwise start a new page.
      doc.page.margins.bottom = 0;
      const footY = doc.page.height - 30;
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
      doc.text(latin1(`${brand.name} - ${model.title}${brand.poweredBy ? ' - Powered by TypEase' : ''}`), margin, footY, { width: width * 0.7, lineBreak: false, ellipsis: true });
      doc.text(`Page ${i + 1} of ${range.count}`, margin + width * 0.7, footY, { width: width * 0.3, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
