import PDFDocument from 'pdfkit';

export interface RequestSummaryInput {
  centreName: string;
  requestNo: string;
  serviceName: string;
  customerName: string;
  statusLabel: string;
  submittedAt: Date | null;
  targetDate: Date | null;
  generatedAt: Date;
  instructions: string | null;
  fields: Array<{ label: string; value: string }>;
  checklist: Array<{ label: string; status: string }>;
}

const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '-');

/** Cover sheet / summary of a request (workflow "document generation" step). */
export function buildRequestSummaryPdf(input: RequestSummaryInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Request ${input.requestNo}`, Author: input.centreName, CreationDate: input.generatedAt } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(10).fillColor('#555555').text(input.centreName);
    doc.moveDown(0.3).fontSize(20).fillColor('#000000').text(`Request ${input.requestNo}`);
    doc.moveDown(0.3).fontSize(12).text(input.serviceName);
    doc.moveDown();

    const row = (label: string, value: string) => {
      doc.fontSize(10).fillColor('#555555').text(`${label}: `, { continued: true }).fillColor('#000000').text(value || '-');
    };
    row('Customer', input.customerName);
    row('Status', input.statusLabel);
    row('Submitted', date(input.submittedAt));
    row('Target date', date(input.targetDate));
    if (input.instructions) row('Customer instructions', input.instructions);

    if (input.fields.length) {
      doc.moveDown().fontSize(13).fillColor('#000000').text('Application details');
      doc.moveDown(0.3);
      for (const f of input.fields) row(f.label, f.value);
    }
    if (input.checklist.length) {
      doc.moveDown().fontSize(13).fillColor('#000000').text('Document checklist');
      doc.moveDown(0.3);
      for (const c of input.checklist) row(c.label, c.status);
    }
    doc.moveDown(2).fontSize(8).fillColor('#777777').text(`Generated ${input.generatedAt.toISOString()} - internal summary prepared by ${input.centreName}. This is not a document issued by a government authority.`);
    doc.end();
  });
}
