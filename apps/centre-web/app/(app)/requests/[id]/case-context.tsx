'use client';

import * as React from 'react';
import type { RequestStatus } from '@typease/types';
import type { CaseApproval, CaseView, ExternalReference, OtherAction } from '@/components/cases/types';

export const CASE_TABS = ['overview', 'details', 'documents', 'money', 'team', 'external', 'messages', 'history'] as const;
export type CaseTab = (typeof CASE_TABS)[number];

export type ExternalOutcome = 'COMPLETED' | 'RETURNED' | 'REJECTED';

/** Every dialog of the case page. One is open at a time; the page owns the state. */
export type CaseDialog =
  | { type: 'reason'; to: RequestStatus; label: string; requiresReason: boolean }
  | { type: 'cancel' }
  | { type: 'reopen' }
  | { type: 'complete' }
  | { type: 'requestInfo'; label: string }
  | { type: 'resubmit' }
  | { type: 'completeStep' }
  | { type: 'duplicate' }
  | { type: 'details' }
  | { type: 'assign'; role: 'OPERATOR' | 'REVIEWER' }
  | { type: 'submission' }
  | { type: 'externalStatus'; reference: ExternalReference }
  | { type: 'externalResult'; outcome?: ExternalOutcome }
  | { type: 'approval'; approval: CaseApproval; decision?: 'APPROVED' | 'REJECTED' }
  | { type: 'migrate' };

export interface CaseContextValue {
  view: CaseView;
  /** Put the answer of an action on screen and refresh what it touched. */
  apply: (view?: CaseView | null) => void;
  open: (dialog: CaseDialog) => void;
  goTo: (tab: CaseTab) => void;
  /** The API lists this action for the current person and state. */
  can: (action: OtherAction) => boolean;
}

const CaseContext = React.createContext<CaseContextValue | null>(null);
export const CaseProvider = CaseContext.Provider;

export function useCaseContext(): CaseContextValue {
  const value = React.useContext(CaseContext);
  if (!value) throw new Error('useCaseContext must be used inside the case page.');
  return value;
}
