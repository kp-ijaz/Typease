'use client';

import Link from 'next/link';
import { Mail, Phone } from 'lucide-react';
import { Alert, Button, Card, CardContent, formatPhone, useBranding, useI18n, useSession } from '@typease/ui';
import { PublicPage } from './public-shell';

const FAQ = ['account', 'documents', 'fees', 'time', 'pay', 'privacy', 'status'] as const;

export function FaqPage() {
  const { t } = useI18n();
  return (
    <PublicPage narrow title={t('faq.title')} description={t('faq.description')}>
      <div className="divide-y rounded-lg border bg-card">
        {FAQ.map((key) => (
          <details key={key} className="group p-5 [&_summary::-webkit-details-marker]:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-sm text-md font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
              {t(`faq.items.${key}.q`)}
              <span aria-hidden="true" className="text-xl font-normal text-muted-foreground transition-transform group-open:rotate-45">
                +
              </span>
            </summary>
            <p className="mt-3 max-w-2xl text-base text-foreground/85">{t(`faq.items.${key}.a`)}</p>
          </details>
        ))}
      </div>
    </PublicPage>
  );
}

export function AboutPage() {
  const { t } = useI18n();
  const { name, isWhiteLabel } = useBranding();
  return (
    <PublicPage narrow title={t('about.title', { name })} description={t('about.description')}>
      <div className="max-w-2xl space-y-4 text-md text-foreground/90">
        <p>{t('about.body1', { name })}</p>
        <p>{t('about.body2')}</p>
        <p>{t('about.body3')}</p>
        {isWhiteLabel ? null : <p className="text-base text-muted-foreground">{t('about.poweredBy')}</p>}
      </div>
    </PublicPage>
  );
}

export function ContactPage() {
  const { t } = useI18n();
  const { config } = useBranding();
  const session = useSession();
  const hasContact = !!(config?.supportPhone || config?.supportEmail);
  return (
    <PublicPage narrow title={t('contact.title')} description={t('contact.description')}>
      {hasContact ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {config?.supportPhone ? (
            <Card>
              <CardContent className="space-y-3">
                <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Phone className="size-4" aria-hidden="true" />
                  {t('contact.phone')}
                </p>
                <p className="ltr-value text-xl font-semibold">{formatPhone(config.supportPhone)}</p>
                <Button asChild variant="outline">
                  <a href={`tel:${config.supportPhone}`}>{t('home.call', { phone: formatPhone(config.supportPhone) })}</a>
                </Button>
              </CardContent>
            </Card>
          ) : null}
          {config?.supportEmail ? (
            <Card>
              <CardContent className="space-y-3">
                <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Mail className="size-4" aria-hidden="true" />
                  {t('contact.email')}
                </p>
                <p className="ltr-value break-all text-xl font-semibold">{config.supportEmail}</p>
                <Button asChild variant="outline">
                  <a href={`mailto:${config.supportEmail}`}>{t('home.email', { email: config.supportEmail })}</a>
                </Button>
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : (
        <Alert tone="info">{t('contact.none')}</Alert>
      )}
      <Alert tone="info" className="mt-6" action={session.isAuthenticated ? <Button asChild size="sm" variant="outline"><Link href="/support">{t('contact.openSupport')}</Link></Button> : undefined}>
        {t('contact.signedIn')}
      </Alert>
    </PublicPage>
  );
}

const PRIVACY = ['who', 'what', 'why', 'share', 'keep', 'secure', 'rights', 'contact'] as const;
const TERMS = ['service', 'account', 'documents', 'fees', 'refunds', 'liability', 'changes', 'law'] as const;

/** Neutral template text. The notice at the top says that the centre's advisers must review it. */
export function LegalPage({ kind }: { kind: 'privacy' | 'terms' }) {
  const { t } = useI18n();
  const { name } = useBranding();
  const sections = kind === 'privacy' ? PRIVACY : TERMS;
  return (
    <PublicPage narrow title={t(`legal.${kind}.title`)} description={t(`legal.${kind}.description`, { name })}>
      <Alert tone="warning" className="mb-8">
        {t('legal.reviewNotice')}
      </Alert>
      <div className="max-w-2xl space-y-7">
        {sections.map((key, index) => (
          <section key={key} aria-labelledby={`${kind}-${key}`}>
            <h2 id={`${kind}-${key}`} className="text-lg font-semibold">
              <span className="tabular text-muted-foreground">{index + 1}.</span> {t(`legal.${kind}.sections.${key}.title`)}
            </h2>
            <p className="mt-2 text-md text-foreground/90">{t(`legal.${kind}.sections.${key}.text`, { name })}</p>
          </section>
        ))}
        <p className="text-sm text-muted-foreground">{t('legal.lastUpdated')}</p>
      </div>
    </PublicPage>
  );
}
