'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { REQUEST_STATUS_META } from '@typease/types';
import { STATUS_META, countryName, formatPhone, useBranding, useI18n, useSession } from '@typease/ui';
import { displayFormValue } from '@/components/cases/dynamic-form';
import type { CaseView } from '@/components/cases/types';
import { externalStatusText } from '@/components/cases/shared';

/**
 * Print stylesheet of the case page. On paper everything of the app (navigation,
 * tabs, dialogs) is hidden and this summary, which lives directly under <body>,
 * is shown instead: "Print summary" is simply the browser's print.
 */
const PRINT_CSS = `
#case-print-root { display: none; }
@media print {
  @page { margin: 14mm; }
  body > *:not(#case-print-root) { display: none !important; }
  #case-print-root { display: block !important; color: #000; background: #fff; font-size: 11pt; line-height: 1.4; }
  #case-print-root h1 { font-size: 16pt; font-weight: 600; }
  #case-print-root h2 { font-size: 11.5pt; font-weight: 600; margin: 14pt 0 5pt; padding-bottom: 2pt; border-bottom: 0.5pt solid #999; break-after: avoid; }
  #case-print-root table { width: 100%; border-collapse: collapse; }
  #case-print-root th, #case-print-root td { text-align: start; vertical-align: top; padding: 2.5pt 8pt 2.5pt 0; }
  #case-print-root th { font-weight: 400; color: #444; width: 32%; }
  #case-print-root .list th { width: auto; font-weight: 600; color: #000; border-bottom: 0.5pt solid #bbb; }
  #case-print-root .list td { border-bottom: 0.25pt solid #ddd; }
  #case-print-root .muted { color: #555; font-size: 9.5pt; }
  #case-print-root tr { break-inside: avoid; }
}
`;

export function CasePrint({ view }: { view: CaseView }) {
  const i18n = useI18n();
  const { t, pick, locale, dir, formatDate, formatDateTime, formatMoney } = i18n;
  const session = useSession();
  const branding = useBranding();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const centre = branding.config ? branding.name : session.tenant?.name ?? '';
  const status = STATUS_META.request[view.status];
  const customerStatus = REQUEST_STATUS_META[view.status];
  const visible = new Set(view.form.visibleFields);
  const fields = (view.form.schema?.steps ?? []).flatMap((step) => step.fields.filter((f) => visible.has(f.key)));
  const row = (label: string, value: React.ReactNode) => (
    <tr>
      <th scope="row">{label}</th>
      <td>{value || '–'}</td>
    </tr>
  );

  return createPortal(
    <div id="case-print-root" dir={dir} lang={locale}>
      <style>{PRINT_CSS}</style>
      <p className="muted">{centre}</p>
      <h1>
        {t('cases.print.title', { number: view.requestNo })}
      </h1>
      <p className="muted">{t('cases.print.printedOn', { time: formatDateTime(new Date()), name: session.user?.fullName ?? '' })}</p>

      <h2>{t('cases.print.request')}</h2>
      <table>
        <tbody>
          {row(t('cases.fields.service'), pick(view.service.name, view.service.nameAr))}
          {row(t('cases.fields.status'), `${pick(status.en, status.ar)} (${t('cases.print.customerWording', { text: pick(customerStatus.customerEn, customerStatus.customerAr) })})`)}
          {row(t('cases.fields.priority'), pick(STATUS_META.priority[view.priority].en, STATUS_META.priority[view.priority].ar))}
          {row(t('cases.fields.branch'), pick(view.branch.name, view.branch.nameAr))}
          {row(t('cases.overview.submitted'), view.submittedAt ? formatDateTime(view.submittedAt) : t('requests.notSubmitted'))}
          {row(t('cases.fields.targetDate'), view.targetDate ? formatDate(view.targetDate) : '')}
          {row(t('cases.fields.assignee'), view.assignee?.name ?? t('requests.unassigned'))}
          {view.reviewer ? row(t('cases.team.roles.REVIEWER'), view.reviewer.name) : null}
          {row(t('cases.fields.payment'), pick(STATUS_META.requestPayment[view.paymentStatus].en, STATUS_META.requestPayment[view.paymentStatus].ar))}
          {row(t('cases.overview.capability'), t(`cases.capability.${view.service.complianceCapability}`))}
        </tbody>
      </table>

      <h2>{t('cases.fields.customer')}</h2>
      <table>
        <tbody>
          {row(t('cases.print.name'), view.customer.fullName)}
          {row(t('cases.print.customerNo'), view.customer.customerNo)}
          {view.customer.phone ? row(t('cases.print.phone'), <span dir="ltr">{formatPhone(view.customer.phone)}</span>) : null}
          {view.customer.email ? row(t('cases.print.email'), <span dir="ltr">{view.customer.email}</span>) : null}
          {view.corporateAccount ? row(t('cases.overview.billedTo'), pick(view.corporateAccount.companyName, view.corporateAccount.companyNameAr)) : null}
          {view.customerInstructions ? row(t('cases.fields.instructions'), view.customerInstructions) : null}
        </tbody>
      </table>

      {fields.length ? (
        <>
          <h2>{t('cases.tabs.details')}</h2>
          <table>
            <tbody>{fields.map((field) => <React.Fragment key={field.key}>{row(pick(field.label, field.labelAr), displayFormValue(field, view.form.values[field.key], i18n, (code) => countryName(code, locale) || code))}</React.Fragment>)}</tbody>
          </table>
        </>
      ) : null}

      {view.checklist.length ? (
        <>
          <h2>{t('cases.tabs.documents')}</h2>
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{t('cases.print.document')}</th>
                <th scope="col">{t('cases.fields.status')}</th>
                <th scope="col">{t('cases.print.file')}</th>
              </tr>
            </thead>
            <tbody>
              {view.checklist.map((line) => (
                <tr key={line.id}>
                  <td>
                    {pick(line.label, line.labelAr)}
                    {line.isMandatory ? '' : ` (${t('cases.docs.optional')})`}
                  </td>
                  <td>{pick(STATUS_META.checklist[line.status].en, STATUS_META.checklist[line.status].ar)}</td>
                  <td>
                    {line.document?.title ?? '–'}
                    {line.document?.expiryDate ? <span className="muted"> · {t('cases.docs.expires', { date: formatDate(line.document.expiryDate) })}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {view.externalReferences.length ? (
        <>
          <h2>{t('cases.tabs.external')}</h2>
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{t('cases.external.referenceNo')}</th>
                <th scope="col">{t('cases.external.channel')}</th>
                <th scope="col">{t('cases.external.statusField')}</th>
              </tr>
            </thead>
            <tbody>
              {view.externalReferences.map((reference) => (
                <tr key={reference.id}>
                  <td dir="ltr">{reference.referenceNo}</td>
                  <td>
                    {t(`cases.external.channels.${reference.channel}`)}
                    {reference.partnerName ? <span className="muted"> · {reference.partnerName}</span> : null}
                  </td>
                  <td>
                    {reference.status ? externalStatusText(reference.status, t) : '–'}
                    {/* Never without its source. */}
                    <span className="muted"> ({pick(reference.statusSourceLabel.en, reference.statusSourceLabel.ar)})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {view.finance?.totals && (view.finance.quotation || view.finance.invoices.length) ? (
        <>
          <h2>{t('cases.tabs.money')}</h2>
          <table>
            <tbody>
              {view.finance.quotation ? row(t('cases.money.quotations'), `${view.finance.quotation.quotationNo} · ${formatMoney(view.finance.quotation.total, view.finance.quotation.currency)}`) : null}
              {view.finance.invoices.map((inv) => (
                <React.Fragment key={inv.id}>{row(inv.invoiceNo, t('cases.money.paidOf', { paid: formatMoney(inv.amountPaid, inv.currency), total: formatMoney(inv.total, inv.currency) }))}</React.Fragment>
              ))}
              {row(t('cases.money.totals.balance'), formatMoney(view.finance.totals.balance, view.finance.invoices[0]?.currency ?? view.finance.quotation?.currency))}
            </tbody>
          </table>
        </>
      ) : null}

      <h2>{t('cases.tabs.history')}</h2>
      <table className="list">
        <thead>
          <tr>
            <th scope="col">{t('cases.print.when')}</th>
            <th scope="col">{t('cases.fields.status')}</th>
            <th scope="col">{t('cases.print.who')}</th>
          </tr>
        </thead>
        <tbody>
          {view.history.map((entry) => (
            <tr key={entry.id}>
              <td>{formatDateTime(entry.at)}</td>
              <td>
                {pick(entry.toLabel.en, entry.toLabel.ar)}
                {entry.reason ? <span className="muted"> · {entry.reason}</span> : null}
              </td>
              <td>{entry.actorName ?? '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>,
    document.body,
  );
}
