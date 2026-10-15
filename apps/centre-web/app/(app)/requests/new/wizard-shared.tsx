'use client';

import * as React from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button, useI18n } from '@typease/ui';

export const WIZARD_STEPS = ['customer', 'service', 'details', 'documents', 'review'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Back on the start side, the step's one primary action on the end side. */
export function StepButtons({ onBack, onNext, nextLabel, busy, nextDisabled }: { onBack?: () => void; onNext?: () => void; nextLabel?: string; busy?: boolean; nextDisabled?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
      {onBack ? (
        <Button variant="outline" onClick={onBack} disabled={busy}>
          <ArrowLeft className="rtl-mirror" aria-hidden="true" />
          {t('common.back')}
        </Button>
      ) : (
        <span />
      )}
      {onNext ? (
        <Button onClick={onNext} loading={busy} loadingText={t('common.saving')} disabled={nextDisabled} data-wizard-next>
          {nextLabel ?? t('common.continue')}
          <ArrowRight className="rtl-mirror" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
