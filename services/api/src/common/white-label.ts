/**
 * When is a centre presented under its own brand? Only when its plan includes white label AND the
 * centre switched it on. One rule for the portals (public tenant configuration), for e-mails and for
 * the name an authenticator app shows.
 */
export function isWhiteLabel(brandingMode: string | null | undefined, planFeatures: unknown): boolean {
  return brandingMode === 'WHITE_LABEL' && !!planFeatures && typeof planFeatures === 'object' && (planFeatures as Record<string, unknown>).whiteLabel === true;
}
