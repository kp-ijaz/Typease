/**
 * Data fields of a push message: what the mobile app needs to open the right screen when the
 * notification is tapped. `relatedType` / `relatedId` come from the notification row itself (the
 * same values the inbox returns), so they are present whenever the record has them - also for
 * rows whose stored rendering carries no copy. FCM requires every data value to be a string.
 */
export function pushPayload(n: { id: string; eventKey: string; relatedType: string | null; relatedId: string | null; data?: Record<string, any> | null }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((n.data?.push ?? {}) as Record<string, unknown>)) if (v !== null && v !== undefined) out[k] = String(v);
  out.eventKey = n.eventKey;
  if (n.relatedType) out.relatedType = n.relatedType;
  else delete out.relatedType;
  if (n.relatedId) out.relatedId = n.relatedId;
  else delete out.relatedId;
  out.notificationId = n.id;
  return out;
}
