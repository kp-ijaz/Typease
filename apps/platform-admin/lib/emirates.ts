/** The seven emirates as the API stores them (English names are data). */
export const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'] as const;

/** Dictionary path of an emirate name: "Abu Dhabi" -> pc.emirates.abu_dhabi. */
export const emirateKey = (name: string) => `pc.emirates.${name.toLowerCase().replace(/[^a-z]+/g, '_')}`;
