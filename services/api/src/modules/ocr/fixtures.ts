import { mrzCheckDigit } from './mrz';
import type { OcrProvider } from './providers';

/**
 * Synthetic OCR test data. The ICAO Doc 9303 specimens ("UTOPIA", Anna Maria
 * Eriksson) are public sample data; everything else is invented. No real
 * person's document is used anywhere.
 */

export const ICAO_TD3 = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];
export const ICAO_TD1 = ['I<UTOD231458907<<<<<<<<<<<<<<<', '7408122F1204159UTO<<<<<<<<<<<6', 'ERIKSSON<<ANNA<MARIA<<<<<<<<<<'];

const names = (surname: string, given: string) => `${surname.toUpperCase().replace(/ /g, '<')}<<${given.toUpperCase().replace(/ /g, '<')}`;

export interface Td3Input {
  issuing: string;
  surname: string;
  given: string;
  number: string;
  nationality: string;
  /** YYMMDD */
  dob: string;
  sex: 'M' | 'F' | '<';
  /** YYMMDD */
  expiry: string;
  personal?: string;
}
/** Builds a TD3 (passport) MRZ with correct check digits. */
export function buildTd3(i: Td3Input): [string, string] {
  const line1 = `P<${i.issuing.padEnd(3, '<')}${names(i.surname, i.given)}`.padEnd(44, '<').slice(0, 44);
  const number = i.number.padEnd(9, '<');
  const personal = (i.personal ?? '').padEnd(14, '<');
  const personalCheck = i.personal ? mrzCheckDigit(personal) : '<';
  const body = `${number}${mrzCheckDigit(number)}${i.nationality.padEnd(3, '<')}${i.dob}${mrzCheckDigit(i.dob)}${i.sex}${i.expiry}${mrzCheckDigit(i.expiry)}${personal}${personalCheck}`;
  const composite = mrzCheckDigit(body.slice(0, 10) + body.slice(13, 20) + body.slice(21, 43));
  return [line1, body + composite];
}

export interface Td1Input {
  docCode?: string;
  issuing: string;
  number: string;
  optional1?: string;
  dob: string;
  sex: 'M' | 'F' | '<';
  expiry: string;
  nationality: string;
  optional2?: string;
  surname: string;
  given: string;
}
/** Builds a TD1 (identity card) MRZ with correct check digits. */
export function buildTd1(i: Td1Input): [string, string, string] {
  const number = i.number.padEnd(9, '<');
  const line1 = `${(i.docCode ?? 'I<').padEnd(2, '<')}${i.issuing.padEnd(3, '<')}${number}${mrzCheckDigit(number)}${(i.optional1 ?? '').padEnd(15, '<')}`;
  const partial = `${i.dob}${mrzCheckDigit(i.dob)}${i.sex}${i.expiry}${mrzCheckDigit(i.expiry)}${i.nationality.padEnd(3, '<')}${(i.optional2 ?? '').padEnd(11, '<')}`;
  const composite = mrzCheckDigit(line1.slice(5, 30) + partial.slice(0, 7) + partial.slice(8, 15) + partial.slice(18, 29));
  return [line1, partial + composite, names(i.surname, i.given).padEnd(30, '<').slice(0, 30)];
}

/** Appends the Luhn check digit to the first 14 digits of an (invented) Emirates ID number. */
export function emiratesIdFrom(first14: string): string {
  let sum = 0;
  // Positions are counted from the right of the full 15-digit number; the check digit is position 1.
  for (let i = 0; i < 14; i++) {
    let n = Number(first14[13 - i]);
    if (i % 2 === 0) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return first14 + String((10 - (sum % 10)) % 10);
}

const yymmdd = (d: Date) => d.toISOString().slice(2, 10).replace(/-/g, '');
export const daysFromNow = (days: number) => new Date(Date.now() + days * 86400_000);
export const mrzDate = (d: Date) => yymmdd(d);
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** An invented passport data page as an OCR engine might return it. */
export function passportPageText(mrz: string[], extra = ''): string {
  return ['PASSPORT / PASSEPORT', 'Type P   Country code   Passport No.', 'Surname / Nom', 'Given names / Prenoms', 'Date of issue 16 APR 2022', extra, ...mrz].join('\n');
}

/** Deterministic stand-in for an OCR engine: returns the text queued for it. Registered in tests only. */
export class FakeOcrProvider implements OcrProvider {
  readonly name = 'fake-test-provider';
  readonly calls: Array<{ bytes: number; mime: string }> = [];
  private queue: Array<{ text: string; pages?: number; confidence?: number } | Error> = [];
  supports(mime: string): boolean {
    return ['application/pdf', 'image/png', 'image/jpeg'].includes(mime);
  }
  willReturn(text: string, pages = 1, confidence = 0.93) {
    this.queue.push({ text, pages, confidence });
    return this;
  }
  willFail(message: string) {
    this.queue.push(new Error(message));
    return this;
  }
  async recognise(image: Buffer, mime: string) {
    this.calls.push({ bytes: image.length, mime });
    const next = this.queue.shift();
    if (!next) throw new Error('FakeOcrProvider: no response queued.');
    if (next instanceof Error) throw next;
    return { text: next.text, pages: next.pages ?? 1, confidence: next.confidence ?? 0.93 };
  }
}
