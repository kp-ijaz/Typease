import { GOVERNMENT_FEE_NOTICE, GOVERNMENT_FEE_NOTICE_AR, hasArabic, latin1, PdfModel, renderPdf, rtlPrepare } from './pdf.renderer';

/** Every string the renderer drew, in order. (The embedded font stores glyph ids, so the bytes cannot be read back as text.) */
async function textOf(m: PdfModel): Promise<string> {
  const drawn: string[] = [];
  await renderPdf(m, { compress: false, onText: (t) => drawn.push(t) });
  return drawn.join('\n');
}
const squash = (s: string) => s.replace(/\s+/g, '');

const model = (overrides: Partial<PdfModel> = {}): PdfModel => ({
  title: 'Tax invoice',
  number: 'INV-000042',
  currency: 'AED',
  brand: { name: 'Al Noor Typing', legalName: 'Al Noor Typing LLC', taxRegistrationNo: '100123456700003', colors: { primary: '#7A1F5C', secondary: '#0B7AD1', accent: '#F59E0B' }, supportEmail: 'help@alnoor.example', supportPhone: '+97141234567', footer: 'Thank you for choosing Al Noor.', poweredBy: false },
  meta: [['Issued', '2026-06-10'], ['Due', '2026-06-10'], ['Status', 'PARTIALLY PAID']],
  party: { heading: 'Bill to', lines: ['Aisha Khan', 'Customer CUS-000007'] },
  sections: [
    { title: 'Service fees', rows: [{ description: 'Family visa typing', quantity: '1', unitAmount: '100.00', discount: '-10.00', tax: '4.50 (5%)', total: '94.50' }], subtotalLabel: 'Service fees subtotal', subtotal: '100.00' },
    { title: 'Government fees', note: GOVERNMENT_FEE_NOTICE, rows: [{ description: 'Entry permit fee', quantity: '1', unitAmount: '200.00', discount: '-', tax: '-', total: '200.00' }], subtotalLabel: 'Government fees subtotal', subtotal: '200.00' },
    { title: 'Third-party charges', rows: [{ description: 'Courier', quantity: '1', unitAmount: '35.00', discount: '-', tax: '-', total: '35.00' }], subtotalLabel: 'Third-party charges subtotal', subtotal: '35.00' },
  ],
  totals: [
    { label: 'Service fees', value: '100.00' },
    { label: 'Government fees', value: '200.00' },
    { label: 'Third-party charges', value: '35.00' },
    { label: 'Discount', value: '-10.00' },
    { label: 'Tax', value: '4.50' },
    { label: 'Total', value: '329.50', strong: true },
    { label: 'Paid', value: '129.50' },
    { label: 'Balance due', value: '200.00', strong: true },
  ],
  notes: 'Bring the original passport.',
  ...overrides,
});

describe('finance PDF renderer', () => {
  it('produces a valid PDF with the document title in its metadata', async () => {
    const pdf = await renderPdf(model());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.subarray(-6).toString()).toContain('%%EOF');
    expect(pdf.toString('latin1')).toContain('Tax invoice INV-000042');
  });

  it('shows separate sections for service fees, government fees and third-party charges, with totals, paid and balance', async () => {
    const text = await textOf(model());
    const flat = squash(text);
    for (const expected of [
      'Al Noor Typing', 'TAX INVOICE', 'INV-000042', 'TRN 100123456700003', 'Aisha Khan',
      'Service fees', 'Family visa typing', 'Government fees', 'Entry permit fee', 'Third-party charges', 'Courier',
      'Service fees subtotal', 'Government fees subtotal', 'Third-party charges subtotal',
      'Discount', '-10.00', 'Tax', '4.50', 'Total', '329.50', 'Paid', '129.50', 'Balance due', '200.00',
      'All amounts in AED', 'Bring the original passport.', 'Thank you for choosing Al Noor.', 'Page 1 of 1',
    ]) {
      expect(flat).toContain(squash(expected));
    }
    // The pass-through notice sits right under the government-fee heading, before its lines.
    const notice = flat.indexOf(squash(GOVERNMENT_FEE_NOTICE));
    expect(notice).toBeGreaterThan(flat.indexOf(squash('Government fees')));
    expect(notice).toBeLessThan(flat.indexOf(squash('Entry permit fee')));
    expect(flat.indexOf(squash('Service fees subtotal'))).toBeLessThan(notice);
    // White-label documents do not advertise the platform.
    expect(flat).not.toContain(squash('Powered by TypEase'));
  });

  it('adds the platform line for non-white-label centres and a stamp for drafts', async () => {
    const m = model({ stamp: 'DRAFT' });
    m.brand.poweredBy = true;
    const flat = squash(await textOf(m));
    expect(flat).toContain(squash('Powered by TypEase'));
    expect(flat).toContain('DRAFT');
  });

  it('flows long documents over several pages and repeats the footer', async () => {
    const rows = Array.from({ length: 90 }, (_, i) => ({ description: `Typing service line ${i + 1} with a description long enough to wrap onto a second line in the table`, quantity: '1', unitAmount: '10.00', discount: '-', tax: '0.50 (5%)', total: '10.50' }));
    const m = model({ sections: [{ title: 'Service fees', rows, subtotalLabel: 'Service fees subtotal', subtotal: '900.00' }] });
    const flat = squash(await textOf(m));
    expect(flat).toContain(squash('Typing service line 90'));
    const pages = Number(/Page1of(\d+)/.exec(flat)![1]);
    expect(pages).toBeGreaterThan(2);
    expect(flat).toContain(`Page${pages}of${pages}`);
    expect(flat).toContain(squash('Balance due'));
  });

  it('is bilingual: Arabic labels, names and notices are drawn, and Latin-1 is still available for file names', async () => {
    const m = model({ titleAr: 'فاتورة ضريبية' });
    m.brand.nameAr = 'مركز النور للطباعة';
    m.party = { heading: 'Bill to', headingAr: 'فاتورة إلى', lines: ['Aisha Khan', 'عائشة خان', 'TRN 100123456700003'] };
    m.sections[1]!.titleAr = 'الرسوم الحكومية';
    m.sections[1]!.noteAr = GOVERNMENT_FEE_NOTICE_AR;
    m.totals[5] = { label: 'Total', labelAr: 'الإجمالي', value: '329.50', strong: true };
    const text = await textOf(m);
    for (const expected of ['فاتورة ضريبية', 'مركز النور للطباعة', 'فاتورة إلى', 'عائشة خان', 'الرسوم الحكومية', GOVERNMENT_FEE_NOTICE_AR, 'الإجمالي', 'الرقم الضريبي', 'جميع المبالغ بالدرهم الإماراتي']) {
      expect(text).toContain(expected);
    }
    expect(latin1('Aisha عائشة – “quote” café')).toBe('Aisha ????? - "quote" café');
  });

  it('keeps numbers and Latin words readable inside right-to-left text', () => {
    expect(hasArabic('Aisha')).toBe(false);
    expect(hasArabic('رسوم')).toBe(true);
    // pdfkit reverses an RTL line as a whole, so embedded LTR runs are pre-reversed.
    expect(rtlPrepare('رسوم حكومية 1,250.00 درهم')).toBe('رسوم حكومية 00.052,1 درهم');
    expect(rtlPrepare('خدمة Emirates ID تجديد')).toBe('خدمة DI setarimE تجديد');
    expect(rtlPrepare('بدون أرقام')).toBe('بدون أرقام');
  });

  it('keeps a short document on one page: the footer never spills onto blank pages', async () => {
    const pdf = await renderPdf(model(), { compress: false });
    expect((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1);
  });

  it('never fails because of an unreadable logo', async () => {
    const m = model();
    m.brand.logo = Buffer.from('this is not an image');
    const pdf = await renderPdf(m);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
