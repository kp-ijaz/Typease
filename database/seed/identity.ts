import type { IdentityFx } from '../../services/api/src/cli/seed/fixture-types';

/**
 * Identity numbers, phone numbers and reference numbers of the demo data set.
 * Every pattern is chosen so that a value can be recognised as fake at a glance
 * and can never belong to a real person, while still passing the API's format
 * validation.
 *
 *  Emirates ID   784-1900-0000NNN-C
 *                Real numbers carry the holder's year of birth in the second group; 1900 is
 *                impossible for a living person. The serial is 0000NNN. The last digit C is
 *                deliberately NOT the valid check digit (it is the Luhn digit plus one), so the
 *                number fails the checksum every genuine Emirates ID passes.
 *  Passport      TEST0NNNN
 *  Phone         +971 59 000 0NNN
 *                The UAE has no number range reserved for fiction. To our knowledge the mobile
 *                prefixes in use are 050, 052, 054, 055, 056 and 058; 059 is not allocated to an
 *                operator, so these numbers should have no subscriber, while still looking like
 *                UAE mobile numbers and passing the E.164 check. This was NOT verified against
 *                the regulator's current numbering plan: check it before using the data set
 *                anywhere messages could really be sent, and change PHONE_PREFIX if needed.
 *                (The seed forces the "log" message drivers, so it never sends anything.)
 *  Trade licence SAMPLE-TL-00NN
 *  Other refs    SAMPLE-<prefix>-NNNN  (application / submission / cheque / transfer references)
 */
const PHONE_PREFIX = '+97159000';

function luhnCheckDigit(digits: string): number {
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return (10 - (total % 10)) % 10;
}

export const identity: IdentityFx = {
  emiratesId(n: number): string {
    const body = `7841900${String(n).padStart(7, '0')}`;
    const wrong = (luhnCheckDigit(body) + 1) % 10;
    return `784-1900-${String(n).padStart(7, '0')}-${wrong}`;
  },
  passportNo(n: number): string {
    return `TEST${String(n).padStart(5, '0')}`;
  },
  phone(n: number): string {
    return `${PHONE_PREFIX}${String(n).padStart(4, '0')}`;
  },
  tradeLicenceNo(n: number): string {
    return `SAMPLE-TL-${String(n).padStart(4, '0')}`;
  },
  sampleReference(prefix: string, n: number): string {
    return `SAMPLE-${prefix.toUpperCase()}-${String(n).padStart(4, '0')}`;
  },
};
