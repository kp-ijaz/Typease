import { Channel, eventGroup, isSecurityEvent, requiredConsent } from './catalogue';

/**
 * Consent and preference rules. Pure: the notification service loads the facts
 * and this module decides, so the rules can be unit-tested exhaustively.
 */
export interface PreferenceRow {
  channel: Channel;
  /** "*" or an event group. */
  eventGroup: string;
  enabled: boolean;
}
export interface CustomerFacts {
  kind: 'CUSTOMER';
  /** customers.communicationPrefs: { email, sms, whatsapp, push } */
  communicationPrefs: Record<string, unknown>;
  marketingOptIn: boolean;
  /** customer_consents: purpose -> status */
  consents: Record<string, string>;
  preferences: PreferenceRow[];
}
export interface UserFacts {
  kind: 'USER';
  preferences: PreferenceRow[];
}
/** A bare address (guest phone number, account-security message): no stored preferences exist. */
export interface AddressFacts {
  kind: 'ADDRESS';
  /** A company contact reached under the corporate service agreement (not a consumer). */
  businessContact?: boolean;
}
export type RecipientFacts = CustomerFacts | UserFacts | AddressFacts;

export type SuppressionReason =
  | 'OPT_OUT'
  | 'NO_CONSENT_WHATSAPP'
  | 'NO_CONSENT_REMINDERS'
  | 'NO_CONSENT_MARKETING'
  | 'NO_ADDRESS'
  | 'CUSTOMER_INACTIVE'
  | 'WHATSAPP_TEMPLATE_REQUIRED'
  | 'RATE_LIMITED'
  | 'PLAN_LIMIT';

export type Decision = { allowed: true } | { allowed: false; reason: SuppressionReason };
const ALLOW: Decision = { allowed: true };
const deny = (reason: SuppressionReason): Decision => ({ allowed: false, reason });

const PREF_KEY: Record<Channel, string | null> = { EMAIL: 'email', SMS: 'sms', WHATSAPP: 'whatsapp', PUSH: 'push', IN_APP: null };

/** Explicit preference for the channel: the event group beats "*". undefined = the person never chose. */
export function explicitPreference(preferences: PreferenceRow[], channel: Channel, group: string): boolean | undefined {
  const specific = preferences.find((p) => p.channel === channel && p.eventGroup === group);
  if (specific) return specific.enabled;
  return preferences.find((p) => p.channel === channel && p.eventGroup === '*')?.enabled;
}

/**
 * May this event be sent to this recipient on this channel?
 *
 *  1. Account-security messages (verification, reset, OTP, invitations) are always allowed.
 *  2. Purpose consent: expiry reminders need REMINDERS = GRANTED, marketing needs MARKETING = GRANTED
 *     and the marketing opt-in flag; WhatsApp always needs WHATSAPP = GRANTED.
 *  3. An explicit notification preference (opt-in or opt-out) for the channel and event group decides.
 *  4. Otherwise the customer's general channel switch (communicationPrefs) decides; missing = allowed,
 *     except WhatsApp, which is off unless switched on.
 */
export function decide(eventKey: string, channel: Channel, facts: RecipientFacts): Decision {
  if (isSecurityEvent(eventKey)) return ALLOW;
  const group = eventGroup(eventKey);
  if (facts.kind === 'ADDRESS') {
    // Nobody can have consented on behalf of a bare address: only service messages on SMS / email.
    if (channel === 'WHATSAPP') return deny('NO_CONSENT_WHATSAPP');
    if (requiredConsent(eventKey) === 'MARKETING') return deny('NO_CONSENT_MARKETING');
    if (requiredConsent(eventKey) === 'REMINDERS' && !facts.businessContact) return deny('NO_CONSENT_REMINDERS');
    return ALLOW;
  }
  if (facts.kind === 'CUSTOMER') {
    const purpose = requiredConsent(eventKey);
    if (purpose === 'REMINDERS' && facts.consents.REMINDERS !== 'GRANTED') return deny('NO_CONSENT_REMINDERS');
    if (purpose === 'MARKETING' && (facts.consents.MARKETING !== 'GRANTED' || !facts.marketingOptIn)) return deny('NO_CONSENT_MARKETING');
    if (channel === 'WHATSAPP' && facts.consents.WHATSAPP !== 'GRANTED') return deny('NO_CONSENT_WHATSAPP');
  } else if (channel === 'WHATSAPP') {
    // Staff members have no recorded WhatsApp consent.
    return deny('NO_CONSENT_WHATSAPP');
  }
  const explicit = explicitPreference(facts.preferences, channel, group);
  if (explicit !== undefined) return explicit ? ALLOW : deny('OPT_OUT');
  if (facts.kind === 'CUSTOMER') {
    const key = PREF_KEY[channel];
    if (key) {
      const general = facts.communicationPrefs?.[key];
      if (general === false) return deny('OPT_OUT');
      if (channel === 'WHATSAPP' && general !== true) return deny('OPT_OUT');
    }
  }
  return ALLOW;
}

/** Outcome for a whole event across channels (used by the expiry reminder scan). */
export function summarise(decisions: Decision[]): 'ALLOWED' | 'NO_CONSENT' | 'OPT_OUT' {
  if (decisions.some((d) => d.allowed)) return 'ALLOWED';
  const reasons = decisions.map((d) => (d.allowed ? '' : d.reason));
  // "No consent" only when a purpose consent is what blocks every channel; a missing
  // WhatsApp consent next to opted-out channels still counts as an opt-out.
  if (reasons.some((r) => r === 'NO_CONSENT_REMINDERS' || r === 'NO_CONSENT_MARKETING')) return 'NO_CONSENT';
  return 'OPT_OUT';
}
