import type { FormSchema } from '@typease/types';
import { formFieldsOf, prefillValues, validateFormValues, visibleFieldKeys } from './form-validator';

const schema: FormSchema = {
  steps: [
    {
      key: 'applicant',
      title: 'Applicant',
      fields: [
        { key: 'fullName', label: 'Full name', type: 'text', required: true, min: 3, maxLength: 60, prefillFrom: 'customer.fullName' },
        { key: 'email', label: 'Email', type: 'email', prefillFrom: 'customer.email' },
        { key: 'phone', label: 'Mobile', type: 'phone' },
        { key: 'dob', label: 'Date of birth', type: 'date', required: true, prefillFrom: 'customer.dateOfBirth' },
        { key: 'nationality', label: 'Nationality', type: 'country', prefillFrom: 'customer.nationality' },
        { key: 'idNumber', label: 'ID number', type: 'text', prefillFrom: 'customer.emiratesIdEnc' },
      ],
    },
    {
      key: 'visa',
      title: 'Visa',
      fields: [
        { key: 'visaType', label: 'Visa type', type: 'select', required: true, options: [{ value: 'tourist', label: 'Tourist' }, { value: 'work', label: 'Work' }] },
        { key: 'sponsor', label: 'Sponsor name', type: 'text', required: true, showIf: { field: 'visaType', in: ['work'] } },
        { key: 'sponsorFile', label: 'Sponsor file no.', type: 'text', required: true, pattern: '[0-9]{3}/[0-9]{4}', showIf: { field: 'sponsor', in: ['ACME'] } },
        { key: 'entries', label: 'Entries', type: 'radio', options: [{ value: 'single', label: 'Single' }, { value: 'multiple', label: 'Multiple' }] },
        { key: 'days', label: 'Days', type: 'number', min: 1, max: 90 },
        { key: 'extras', label: 'Extras', type: 'multiselect', max: 2, options: [{ value: 'insurance', label: 'Insurance' }, { value: 'express', label: 'Express' }, { value: 'pickup', label: 'Pickup' }] },
        { key: 'notes', label: 'Notes', type: 'textarea' },
        { key: 'declaration', label: 'Declaration', type: 'checkbox', required: true },
        { key: 'newsletter', label: 'Newsletter', type: 'checkbox' },
      ],
    },
  ],
};
const valid = { fullName: 'Aisha Khan', dob: '1990-02-28', visaType: 'tourist', declaration: true };
const errorsOf = (values: Record<string, unknown>, partial = false) => validateFormValues(schema, values, { partial }).errors.map((e) => `${e.field}:${e.code}`);

describe('dynamic form validator', () => {
  it('accepts a complete form and normalises the values', () => {
    const result = validateFormValues(schema, { ...valid, fullName: '  Aisha Khan ', email: 'Aisha@Example.COM', phone: '+971 50 123-4567', nationality: 'ae', days: '30', extras: ['express', 'express'], newsletter: false });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.values).toEqual({
      fullName: 'Aisha Khan', email: 'aisha@example.com', phone: '+971501234567', dob: '1990-02-28', nationality: 'AE',
      visaType: 'tourist', days: 30, extras: ['express'], declaration: true, newsletter: false,
    });
  });

  it('requires mandatory fields on submission, including a ticked declaration', () => {
    expect(errorsOf({})).toEqual(['fullName:REQUIRED', 'dob:REQUIRED', 'visaType:REQUIRED', 'declaration:REQUIRED']);
    expect(errorsOf({ ...valid, fullName: '   ' })).toEqual(['fullName:REQUIRED']);
    expect(errorsOf({ ...valid, declaration: false })).toEqual(['declaration:REQUIRED']);
    expect(errorsOf({ ...valid, fullName: null })).toEqual(['fullName:REQUIRED']);
  });

  it('a draft may be incomplete, but what is there must be valid', () => {
    expect(errorsOf({}, true)).toEqual([]);
    expect(errorsOf({ fullName: 'Aisha Khan' }, true)).toEqual([]);
    expect(errorsOf({ declaration: false }, true)).toEqual([]);
    expect(errorsOf({ email: 'not-an-email', days: 500 }, true)).toEqual(['email:INVALID_FORMAT', 'days:TOO_LARGE']);
    expect(validateFormValues(schema, { fullName: 'Aisha Khan', email: '' }, { partial: true }).values).toEqual({ fullName: 'Aisha Khan' });
  });

  it('checks types', () => {
    expect(errorsOf({ ...valid, fullName: { first: 'A' } })).toEqual(['fullName:INVALID_TYPE']);
    expect(errorsOf({ ...valid, days: 'many' })).toEqual(['days:INVALID_TYPE']);
    expect(errorsOf({ ...valid, declaration: 'yes' })).toEqual(['declaration:INVALID_TYPE']);
    expect(errorsOf({ ...valid, extras: 'express' })).toEqual(['extras:INVALID_TYPE']);
    expect(errorsOf({ ...valid, extras: [1, 2] })).toEqual(['extras:INVALID_TYPE']);
  });

  it('checks formats: email, phone, date, country', () => {
    expect(errorsOf({ ...valid, email: 'a@b' })).toEqual(['email:INVALID_FORMAT']);
    expect(errorsOf({ ...valid, phone: '0501234567' })).toEqual(['phone:INVALID_FORMAT']);
    expect(errorsOf({ ...valid, dob: '28/02/1990' })).toEqual(['dob:INVALID_FORMAT']);
    expect(errorsOf({ ...valid, dob: '1990-02-30' })).toEqual(['dob:INVALID_FORMAT']);
    expect(errorsOf({ ...valid, nationality: 'Emirati' })).toEqual(['nationality:INVALID_FORMAT']);
  });

  it('checks options of select, radio and multiselect', () => {
    expect(errorsOf({ ...valid, visaType: 'student' })).toEqual(['visaType:INVALID_OPTION']);
    expect(errorsOf({ ...valid, entries: 'triple' })).toEqual(['entries:INVALID_OPTION']);
    expect(errorsOf({ ...valid, extras: ['express', 'limo'] })).toEqual(['extras:INVALID_OPTION']);
  });

  it('checks min / max: length for text, value for numbers, count for multiselect', () => {
    expect(errorsOf({ ...valid, fullName: 'Al' })).toEqual(['fullName:TOO_SHORT']);
    expect(errorsOf({ ...valid, fullName: 'x'.repeat(61) })).toEqual(['fullName:TOO_LONG']);
    expect(errorsOf({ ...valid, notes: 'x'.repeat(5001) })).toEqual(['notes:TOO_LONG']);
    expect(errorsOf({ ...valid, days: 0 })).toEqual(['days:TOO_SMALL']);
    expect(errorsOf({ ...valid, days: 91 })).toEqual(['days:TOO_LARGE']);
    expect(errorsOf({ ...valid, days: 90 })).toEqual([]);
    expect(errorsOf({ ...valid, extras: ['insurance', 'express', 'pickup'] })).toEqual(['extras:TOO_LARGE']);
  });

  it('applies patterns to the whole value and ignores a broken pattern', () => {
    const work = { ...valid, visaType: 'work', sponsor: 'ACME' };
    expect(errorsOf({ ...work, sponsorFile: '123/2024' })).toEqual([]);
    expect(errorsOf({ ...work, sponsorFile: 'x123/2024x' })).toEqual(['sponsorFile:INVALID_FORMAT']);
    const broken: FormSchema = { steps: [{ key: 's', title: 's', fields: [{ key: 'a', label: 'A', type: 'text', pattern: '([' }] }] };
    expect(validateFormValues(broken, { a: 'anything' }).valid).toBe(true);
  });

  it('fields hidden by showIf are not required and their values are dropped', () => {
    expect(errorsOf({ ...valid, visaType: 'work' })).toEqual(['sponsor:REQUIRED']);
    // sponsorFile depends on sponsor, which depends on visaType: the chain is followed.
    expect(errorsOf({ ...valid, visaType: 'work', sponsor: 'ACME' })).toEqual(['sponsorFile:REQUIRED']);
    expect(errorsOf({ ...valid, visaType: 'work', sponsor: 'Other LLC' })).toEqual([]);
    const hidden = validateFormValues(schema, { ...valid, sponsor: 'ACME', sponsorFile: 'garbage' });
    expect(hidden.valid).toBe(true);
    expect(hidden.values).not.toHaveProperty('sponsor');
    expect(hidden.values).not.toHaveProperty('sponsorFile');
    expect([...visibleFieldKeys(schema, { visaType: 'work', sponsor: 'ACME' })]).toEqual(expect.arrayContaining(['sponsor', 'sponsorFile']));
    expect(visibleFieldKeys(schema, { visaType: 'tourist', sponsor: 'ACME' }).has('sponsorFile')).toBe(false);
  });

  it('a showIf cycle hides the fields instead of looping forever', () => {
    const cyclic: FormSchema = {
      steps: [{ key: 's', title: 's', fields: [
        { key: 'a', label: 'A', type: 'text', required: true, showIf: { field: 'b', in: ['x'] } },
        { key: 'b', label: 'B', type: 'text', required: true, showIf: { field: 'a', in: ['x'] } },
      ] }],
    };
    expect(validateFormValues(cyclic, { a: 'x', b: 'x' }).valid).toBe(true);
  });

  it('rejects values for fields that are not part of the form', () => {
    expect(errorsOf({ ...valid, isAdmin: true })).toEqual(['isAdmin:UNKNOWN_FIELD']);
    expect(errorsOf({ hack: 1 }, true)).toEqual(['hack:UNKNOWN_FIELD']);
  });

  it('a service without a form accepts no values', () => {
    expect(validateFormValues(null, {}).valid).toBe(true);
    expect(validateFormValues(null, { a: 1 }).errors[0].code).toBe('UNKNOWN_FIELD');
    expect(formFieldsOf(undefined)).toEqual([]);
  });

  it('prefills only documented profile attributes, in the format of the field', () => {
    const customer = { fullName: 'Aisha Khan', email: 'aisha@example.com', dateOfBirth: new Date('1990-02-28T00:00:00Z'), nationality: 'ae', emiratesIdEnc: 'k1.secret', phone: null };
    expect(prefillValues(schema, customer)).toEqual({ fullName: 'Aisha Khan', email: 'aisha@example.com', dob: '1990-02-28', nationality: 'AE' });
    // A stored value the field would reject is not copied.
    expect(prefillValues(schema, { fullName: 'Al', nationality: 'Emirati' })).toEqual({});
  });
});
