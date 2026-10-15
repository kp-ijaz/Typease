'use client';

import * as React from 'react';
import type { PasswordPolicy } from '@typease/types';
import { useI18n } from '../i18n/provider';
import { passwordHint, passwordSchema, resolvePasswordPolicy } from '../lib/password-policy';
import { useBranding } from '../providers/branding';

/**
 * The rules for a NEW password on this screen: the policy the API published for the centre
 * (`passwordPolicy` of the tenant config in the branding context), or the one passed in (the invitation
 * preview carries its own), or the built-in rules. Gives the Zod field for the form's schema and the
 * hint to show under the field, so that what the browser checks is what the API will accept.
 */
export function useNewPasswordRules(override?: Partial<PasswordPolicy> | null) {
  const i18n = useI18n();
  const { config } = useBranding();
  const policy = resolvePasswordPolicy(override ?? config?.passwordPolicy);
  const signature = `${policy.minLength}/${policy.maxLength}/${policy.requires.join(',')}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const field = React.useMemo(() => passwordSchema(policy), [signature]);
  return { policy, field, hint: passwordHint(policy, i18n) };
}
