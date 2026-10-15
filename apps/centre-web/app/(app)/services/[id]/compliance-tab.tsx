'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { FileText, Handshake, Info, Landmark } from 'lucide-react';
import { isApiError } from '@typease/api-client';
import { COMPLIANCE_CAPABILITIES } from '@typease/validation';
import { Alert, Button, RadioGroup, RadioGroupItem, cn, useApi, useErrorMessage, useI18n, useSession, useToast } from '@typease/ui';
import { Panel } from '@/components/ops/common';
import type { ComplianceCapability } from '@/components/ops/types';
import { opsKeys } from '@/lib/keys/ops';
import type { ServiceTabProps } from './service-editor';

const ICONS: Record<ComplianceCapability, React.ReactNode> = {
  DOCUMENT_PREPARATION_ONLY: <FileText aria-hidden="true" />,
  INFORMATIONAL_ONLY: <Info aria-hidden="true" />,
  PARTNER_COORDINATION: <Handshake aria-hidden="true" />,
  DIRECT_AUTHORISED: <Landmark aria-hidden="true" />,
};
/** Shown in this order: the two that need nothing first. */
const ORDER: ComplianceCapability[] = ['DOCUMENT_PREPARATION_ONLY', 'INFORMATIONAL_ONLY', 'PARTNER_COORDINATION', 'DIRECT_AUTHORISED'];

/**
 * What the centre itself does for this service. A business setting, never a
 * statement that the centre or TypEase is authorised by any authority. The two
 * capabilities that need a verified record are checked by the API when saving;
 * its requirement message is shown here with the way to resolve it.
 */
export function ComplianceTab({ service, editable }: ServiceTabProps) {
  const { t } = useI18n();
  const api = useApi();
  const session = useSession();
  const toasts = useToast();
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const id = React.useId();
  const [value, setValue] = React.useState<ComplianceCapability>(service.complianceCapability);
  const [saving, setSaving] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);

  React.useEffect(() => setValue(service.complianceCapability), [service.complianceCapability]);

  const save = async () => {
    setSaving(true);
    setRefusal(null);
    setFailure(null);
    try {
      await api.client.patch(`/services/${service.id}`, { complianceCapability: value, version: service.version });
      toasts.success(t('ops.services.compliance.saved'), t(`ops.services.capability.${value}.title`));
      await queryClient.invalidateQueries({ queryKey: opsKeys.services.all });
    } catch (error) {
      // The API explains what has to be configured first; the choice stays selected so it can be saved afterwards.
      if (isApiError(error) && error.code === 'CAPABILITY_NOT_PERMITTED') setRefusal(error.message);
      else setFailure(describe(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title={t('ops.services.compliance.title')} description={t('ops.services.compliance.description')}>
      <div className="space-y-5">
        <Alert tone="info">{t('ops.services.compliance.notice')}</Alert>
        <RadioGroup value={value} onValueChange={(v) => { setValue(v as ComplianceCapability); setRefusal(null); }} aria-label={t('ops.services.compliance.title')} disabled={!editable} className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {ORDER.filter((c) => (COMPLIANCE_CAPABILITIES as readonly string[]).includes(c)).map((capability) => {
            const selected = value === capability;
            return (
              <label
                key={capability}
                htmlFor={`${id}-${capability}`}
                className={cn('flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors', selected ? 'border-secondary bg-secondary-soft/40' : 'hover:bg-muted/40', !editable && 'cursor-default')}
              >
                <span className="flex h-6 items-center">
                  <RadioGroupItem id={`${id}-${capability}`} value={capability} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 font-medium text-foreground [&_svg]:size-4 [&_svg]:text-muted-foreground">
                    {ICONS[capability]}
                    {t(`ops.services.capability.${capability}.title`)}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">{t(`ops.services.capability.${capability}.text`)}</span>
                  <span className="mt-2 block text-sm text-foreground/80">{t(`ops.services.capability.${capability}.needs`)}</span>
                </span>
              </label>
            );
          })}
        </RadioGroup>

        {refusal ? (
          <Alert
            tone="warning"
            live
            title={t('ops.services.compliance.refusedTitle')}
            action={
              session.hasPermission('integration.manage') ? (
                <Button asChild size="sm" variant="outline">
                  <Link href="/integrations">{t('ops.services.compliance.openIntegrations')}</Link>
                </Button>
              ) : undefined
            }
          >
            <p dir="auto">{refusal}</p>
            {session.hasPermission('integration.manage') ? null : <p className="mt-1">{t('ops.services.compliance.askOwner')}</p>}
          </Alert>
        ) : null}
        {failure ? (
          <Alert tone="danger" live>
            {failure}
          </Alert>
        ) : null}

        {editable ? (
          <div className="flex justify-end">
            <Button onClick={() => void save()} loading={saving} loadingText={t('common.saving')} disabled={value === service.complianceCapability}>
              {t('common.saveChanges')}
            </Button>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
