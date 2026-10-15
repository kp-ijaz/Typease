'use client';

import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Download, PenLine } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { Alert, Button, Card, CardContent, Checkbox, Input, Label, SignaturePad, Skeleton, Tabs, TabsList, TabsTrigger, useApiClient, useErrorMessage, useI18n } from '@typease/ui';
import { PublicPage } from '@/components/public-shell';

interface Doc {
  centreName: string;
  documentNo: string;
  status: 'ISSUED' | 'SIGNED' | 'HANDED_OVER' | 'VOID' | 'DRAFT';
  titleEn: string;
  titleAr: string | null;
  bodyEn: string;
  bodyAr: string | null;
  requiresSignature: boolean;
  signerName: string | null;
  signedAt: string | null;
  suggestedSigner: string | null;
}

/** The page behind a signing link: read the whole document, then sign it with a finger. No sign-in: the signed link is the key. */
export function SignDocument({ token }: { token: string }) {
  const { t, locale, formatDateTime } = useI18n();
  const client = useApiClient();
  const describe = useErrorMessage();
  const path = `/public/sign/${encodeURIComponent(token)}`;
  const doc = useQuery({ queryKey: ['sign', token], queryFn: () => client.get<Doc>(path), enabled: !!token, retry: false });
  const [lang, setLang] = React.useState<'en' | 'ar'>(locale === 'ar' ? 'ar' : 'en');
  const [name, setName] = React.useState<string | null>(null);
  const [signature, setSignature] = React.useState<string | null>(null);
  const [agree, setAgree] = React.useState(false);
  const sign = useMutation({ mutationFn: () => client.post(path, { signerName: (name ?? doc.data?.suggestedSigner ?? '').trim(), signatureImage: signature, agree: true }), onSuccess: () => void doc.refetch() });
  const download = async () => {
    const file = await client.download(`${path}/pdf`, { fallbackFilename: `${doc.data?.documentNo ?? 'document'}.pdf` });
    const url = URL.createObjectURL(new Blob([file.blob], { type: 'application/pdf' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  if (!token || (doc.error && isApiError(doc.error) && doc.error.status === 404)) {
    return (
      <PublicPage narrow title={t('sign.title')}>
        <Alert tone="warning">{t('sign.invalid')}</Alert>
      </PublicPage>
    );
  }
  const d = doc.data;
  if (!d) {
    return (
      <PublicPage narrow title={t('sign.title')}>
        <Skeleton className="h-96 w-full" />
      </PublicPage>
    );
  }
  const signerName = name ?? d.suggestedSigner ?? '';
  const signed = d.status === 'SIGNED' || d.status === 'HANDED_OVER';
  return (
    <PublicPage narrow title={signed ? t('sign.signedTitle') : t('sign.heading')} description={signed ? t('sign.signedDescription', { centre: d.centreName, no: d.documentNo }) : t('sign.description', { centre: d.centreName, no: d.documentNo })}>
      <Card>
        <CardContent className="space-y-5">
          {d.bodyAr ? (
            <Tabs value={lang} onValueChange={(v) => setLang(v as 'en' | 'ar')}>
              <TabsList>
                <TabsTrigger value="en">English</TabsTrigger>
                <TabsTrigger value="ar">العربية</TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}
          <article dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang} className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap rounded-lg border bg-white p-5 text-[0.95rem] leading-relaxed text-gray-900 shadow-inner">
            <h2 className="mb-4 text-center text-lg font-semibold">{lang === 'ar' && d.titleAr ? d.titleAr : d.titleEn}</h2>
            {lang === 'ar' && d.bodyAr ? d.bodyAr : d.bodyEn}
          </article>

          {d.status === 'VOID' ? (
            <Alert tone="warning">{t('sign.void', { centre: d.centreName })}</Alert>
          ) : signed ? (
            <div className="space-y-3">
              <Alert tone="success" title={t('sign.doneTitle')}>
                {t('sign.done', { name: d.signerName ?? '', at: d.signedAt ? formatDateTime(d.signedAt) : '' })}
              </Alert>
              <Button variant="outline" className="w-full" onClick={() => void download()}>
                <Download aria-hidden="true" />
                {t('sign.download')}
              </Button>
            </div>
          ) : d.status === 'ISSUED' && d.requiresSignature ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="sign-name">{t('sign.name')}</Label>
                <Input id="sign-name" value={signerName} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" />
              </div>
              <SignaturePad label={t('sign.signature')} clearLabel={t('sign.clear')} hint={t('sign.hint')} onChange={setSignature} />
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={agree} onCheckedChange={(v) => setAgree(v === true)} className="mt-0.5" />
                {t('sign.agree')}
              </label>
              <Button size="lg" className="w-full" disabled={signerName.trim().length < 2 || !signature || !agree} loading={sign.isPending} onClick={() => sign.mutate()}>
                <PenLine aria-hidden="true" />
                {t('sign.submit')}
              </Button>
              {sign.error ? <Alert tone="danger">{describe(sign.error)}</Alert> : null}
              <p className="text-xs text-muted-foreground">{t('sign.wrong', { centre: d.centreName })}</p>
            </div>
          ) : (
            <Alert tone="info">{t('sign.notReady')}</Alert>
          )}
        </CardContent>
      </Card>
      {signed ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 aria-hidden="true" className="size-4 text-success-text" />
          {t('sign.collect', { centre: d.centreName })}
        </p>
      ) : null}
    </PublicPage>
  );
}
