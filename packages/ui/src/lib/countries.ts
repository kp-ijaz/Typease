/**
 * ISO 3166-1 alpha-2 codes with their international dialling codes. Names are
 * not stored: `countryName()` asks Intl.DisplayNames, so they are always in the
 * active language (English and Arabic) without a translation table.
 */
// prettier-ignore
const DIAL: Record<string, string> = {
  AE: '971', SA: '966', OM: '968', QA: '974', BH: '973', KW: '965', EG: '20', JO: '962', LB: '961', SY: '963', IQ: '964', YE: '967', PS: '970',
  IN: '91', PK: '92', BD: '880', LK: '94', NP: '977', PH: '63', ID: '62', MY: '60', TH: '66', VN: '84', CN: '86', JP: '81', KR: '82', SG: '65', HK: '852', TW: '886', MM: '95', KH: '855', AF: '93', IR: '98', TR: '90',
  GB: '44', IE: '353', FR: '33', DE: '49', IT: '39', ES: '34', PT: '351', NL: '31', BE: '32', CH: '41', AT: '43', SE: '46', NO: '47', DK: '45', FI: '358', PL: '48', CZ: '420', SK: '421', HU: '36', RO: '40', BG: '359', GR: '30', CY: '357', MT: '356', RS: '381', HR: '385', SI: '386', BA: '387', AL: '355', MK: '389', UA: '380', BY: '375', RU: '7', KZ: '7', UZ: '998', KG: '996', TJ: '992', TM: '993', AZ: '994', GE: '995', AM: '374', LT: '370', LV: '371', EE: '372', IS: '354', LU: '352', MD: '373', ME: '382', XK: '383',
  US: '1', CA: '1', MX: '52', BR: '55', AR: '54', CL: '56', CO: '57', PE: '51', VE: '58', EC: '593', UY: '598', PY: '595', BO: '591', CU: '53', DO: '1', JM: '1', TT: '1', PA: '507', CR: '506', GT: '502',
  ZA: '27', NG: '234', KE: '254', ET: '251', GH: '233', UG: '256', TZ: '255', SD: '249', SS: '211', SO: '252', ER: '291', DJ: '253', MA: '212', DZ: '213', TN: '216', LY: '218', MR: '222', SN: '221', CI: '225', CM: '237', ZW: '263', ZM: '260', RW: '250', MU: '230', SC: '248', KM: '269', MG: '261', MZ: '258', AO: '244', NA: '264', BW: '267', ML: '223', NE: '227', TD: '235', BF: '226', GN: '224', SL: '232', LR: '231', TG: '228', BJ: '229', GA: '241', CG: '242', CD: '243', GM: '220', MW: '265',
  AU: '61', NZ: '64', FJ: '679', PG: '675', MV: '960', BT: '975', BN: '673', LA: '856', MN: '976', KP: '850', IL: '972',
};

export interface Country {
  code: string;
  dial: string;
}

/** Nationalities seen most often at UAE typing centres come first in pickers. */
export const COMMON_COUNTRY_CODES = ['AE', 'IN', 'PK', 'BD', 'PH', 'EG', 'NP', 'LK', 'JO', 'SY', 'SA', 'GB'] as const;

export const COUNTRIES: Country[] = Object.entries(DIAL).map(([code, dial]) => ({ code, dial }));

const names = new Map<string, Intl.DisplayNames | null>();
export function countryName(code: string | null | undefined, locale: string): string {
  if (!code) return '';
  const upper = code.toUpperCase();
  let dn = names.get(locale);
  if (dn === undefined) {
    try {
      dn = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      dn = null;
    }
    names.set(locale, dn);
  }
  try {
    return dn?.of(upper) ?? upper;
  } catch {
    return upper;
  }
}

/** Countries sorted for a picker: the common ones first, then alphabetically in the active language. */
export function sortedCountries(locale: string): Array<Country & { name: string }> {
  const withNames = COUNTRIES.map((c) => ({ ...c, name: countryName(c.code, locale) }));
  const common = COMMON_COUNTRY_CODES.map((code) => withNames.find((c) => c.code === code)!).filter(Boolean);
  const rest = withNames.filter((c) => !(COMMON_COUNTRY_CODES as readonly string[]).includes(c.code)).sort((a, b) => a.name.localeCompare(b.name, locale));
  return [...common, ...rest];
}

export const dialCodeOf = (countryCode: string): string | undefined => DIAL[countryCode.toUpperCase()];
