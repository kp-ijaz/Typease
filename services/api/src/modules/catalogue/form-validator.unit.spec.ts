import type { FormSchema } from '@typease/types';
import { buildFormValidator, formFields, serviceFormSchema, visibleFormFieldKeys } from '@typease/validation';

const form: FormSchema = {
  steps: [
    {
      key: 'applicant',
      title: 'Applicant',
      fields: [
        { key: 'fullName', label: 'Full name', type: 'text', required: true, maxLength: 20, prefillFrom: 'customer.fullName' },
        { key: 'email', label: 'Email', type: 'email' },
        { key: 'mobile', label: 'Mobile', type: 'phone' },
        { key: 'nationality', label: 'Nationality', type: 'country' },
        { key: 'birthDate', label: 'Date of birth', type: 'date' },
        { key: 'fileNo', label: 'File number', type: 'text', pattern: '[0-9]{3}/[0-9]{4}' },
        { key: 'notes', label: 'Notes', type: 'textarea', min: 5, max: 30 },
      ],
    },
    {
      key: 'visa',
      title: 'Visa',
      fields: [
        { key: 'visaType', label: 'Visa type', type: 'select', required: true, options: [{ value: 'visit', label: 'Visit' }, { value: 'residence', label: 'Residence' }] },
        { key: 'sponsorType', label: 'Sponsor', type: 'radio', required: true, showIf: { field: 'visaType', in: ['residence'] }, options: [{ value: 'company', label: 'Company' }, { value: 'family', label: 'Family' }] },
        { key: 'companyName', label: 'Company name', type: 'text', required: true, showIf: { field: 'sponsorType', in: ['company'] } },
        { key: 'dependants', label: 'Number of dependants', type: 'number', min: 0, max: 10 },
        { key: 'extras', label: 'Extras', type: 'multiselect', min: 1, max: 2, options: [{ value: 'photo', label: 'Photo' }, { value: 'copy', label: 'Copies' }, { value: 'scan', label: 'Scan' }] },
        { key: 'urgent', label: 'Urgent', type: 'checkbox' },
        { key: 'urgentReason', label: 'Reason for urgency', type: 'textarea', required: true, showIf: { field: 'urgent', in: [true] } },
        { key: 'terms', label: 'I confirm the details are correct', type: 'checkbox', required: true },
      ],
    },
  ],
};
const valid = { fullName: 'Aisha Khan', visaType: 'visit', terms: true };
const messages = (r: ReturnType<ReturnType<typeof buildFormValidator>['safeParse']>) => (r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message])));

describe('serviceFormSchema (form definitions)', () => {
  const field = (over: Record<string, unknown>) => ({ key: 'a', label: 'A', type: 'text', ...over });
  const check = (fields: unknown[]) => serviceFormSchema.safeParse({ steps: [{ key: 's1', title: 'Step', fields }] });
  const errors = (fields: unknown[]) => {
    const r = check(fields);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('accepts a well-formed definition and an empty one', () => {
    expect(serviceFormSchema.safeParse(form).success).toBe(true);
    expect(serviceFormSchema.safeParse({ steps: [] }).success).toBe(true);
    expect(formFields(form)).toHaveLength(15);
  });
  it('requires unique field keys across all steps and unique step keys', () => {
    const r = serviceFormSchema.safeParse({ steps: [{ key: 's', title: 'One', fields: [field({})] }, { key: 's', title: 'Two', fields: [field({})] }] });
    expect(r.success).toBe(false);
    const text = r.success ? '' : r.error.issues.map((i) => i.message).join(' | ');
    expect(text).toMatch(/Field key "a" is used more than once/);
    expect(text).toMatch(/Step key "s" is used more than once/);
  });
  it('requires options for select, multiselect and radio - and only for those', () => {
    for (const type of ['select', 'multiselect', 'radio']) {
      expect(errors([field({ type })])[0]).toMatch(/needs at least one option/);
      expect(errors([field({ type, options: [] })])[0]).toMatch(/needs at least one option/);
      expect(errors([field({ type, options: [{ value: 'x', label: 'X' }, { value: 'x', label: 'Again' }] })])[0]).toMatch(/duplicate option values/);
      expect(errors([field({ type, options: [{ value: 'x', label: 'X' }] })])).toEqual([]);
    }
    expect(errors([field({ type: 'text', options: [{ value: 'x', label: 'X' }] })])[0]).toMatch(/Options are only for/);
  });
  it('showIf must reference an earlier field and one of its options', () => {
    const select = field({ key: 'kind', type: 'select', options: [{ value: 'x', label: 'X' }] });
    expect(errors([field({ key: 'b', showIf: { field: 'kind', in: ['x'] } }), select])[0]).toMatch(/comes before it/);
    expect(errors([field({ key: 'b', showIf: { field: 'b', in: ['x'] } })])[0]).toMatch(/comes before it/);
    expect(errors([field({ key: 'b', showIf: { field: 'missing', in: ['x'] } })])[0]).toMatch(/comes before it/);
    expect(errors([select, field({ key: 'b', showIf: { field: 'kind', in: ['nope'] } })])[0]).toMatch(/not an option/);
    expect(errors([select, field({ key: 'b', showIf: { field: 'kind', in: ['x'] } })])).toEqual([]);
    expect(check([select, field({ key: 'b', showIf: { field: 'kind', in: [] } })]).success).toBe(false);
  });
  it('showIf may look back into an earlier step', () => {
    const r = serviceFormSchema.safeParse({
      steps: [{ key: 's1', title: 'One', fields: [field({ key: 'flag', type: 'checkbox' })] }, { key: 's2', title: 'Two', fields: [field({ key: 'b', showIf: { field: 'flag', in: [true] } })] }],
    });
    expect(r.success).toBe(true);
  });
  it('prefillFrom must be a known source', () => {
    expect(check([field({ prefillFrom: 'customer.fullName' })]).success).toBe(true);
    expect(check([field({ prefillFrom: 'customer.passportNo' })]).success).toBe(false);
    expect(check([field({ prefillFrom: 'user.passwordHash' })]).success).toBe(false);
  });
  it('validates field keys, types, bounds and patterns', () => {
    expect(check([field({ key: '1abc' })]).success).toBe(false);
    expect(check([field({ key: 'has space' })]).success).toBe(false);
    expect(check([field({ type: 'file' })]).success).toBe(false);
    expect(errors([field({ type: 'number', min: 5, max: 1 })])[0]).toMatch(/max must not be smaller/);
    expect(errors([field({ type: 'date', min: 1 })])[0]).toMatch(/min \/ max apply/);
    expect(errors([field({ type: 'number', maxLength: 5 })])[0]).toMatch(/maxLength applies to text/);
    expect(errors([field({ type: 'number', pattern: '\\d+' })])[0]).toMatch(/pattern applies to text/);
    expect(errors([field({ pattern: '([a-z' })])[0]).toMatch(/not a valid regular expression/);
    expect(errors([field({ pattern: '(a+)+' })])[0]).toMatch(/too complex/);
    expect(errors([field({ pattern: '[A-Z]{2}\\d{4}' })])).toEqual([]);
  });
  it('rejects unknown properties so stored definitions stay clean', () => {
    expect(check([field({ onChange: 'alert(1)' })]).success).toBe(false);
    expect(serviceFormSchema.safeParse({ steps: [], script: 'x' }).success).toBe(false);
  });
});

describe('buildFormValidator (submitted values)', () => {
  const v = buildFormValidator(form);

  it('accepts the minimum valid submission and returns only filled-in fields', () => {
    expect(v.parse(valid)).toEqual({ fullName: 'Aisha Khan', visaType: 'visit', terms: true });
  });
  it('reports every missing required field with a plain message', () => {
    expect(messages(v.safeParse({}))).toEqual({ fullName: 'Full name is required', visaType: 'Visa type is required', terms: 'I confirm the details are correct is required' });
  });
  it('treats "", whitespace, null and [] as not filled in', () => {
    expect(messages(v.safeParse({ ...valid, fullName: '   ' }))).toEqual({ fullName: 'Full name is required' });
    expect(messages(v.safeParse({ ...valid, fullName: null }))).toEqual({ fullName: 'Full name is required' });
    expect(v.parse({ ...valid, email: '', extras: [], notes: null })).toEqual({ fullName: 'Aisha Khan', visaType: 'visit', terms: true });
  });
  it('a required checkbox must be ticked; an optional one may be false', () => {
    expect(messages(v.safeParse({ ...valid, terms: false }))).toEqual({ terms: 'I confirm the details are correct is required' });
    expect(v.parse({ ...valid, urgent: false })).toMatchObject({ urgent: false });
    expect(messages(v.safeParse({ ...valid, urgent: 'yes' }))).toEqual({ urgent: 'Urgent must be ticked or unticked' });
  });
  it('rejects input that is not an object', () => {
    expect(v.safeParse(null).success).toBe(false);
    expect(v.safeParse('fullName=x').success).toBe(false);
    expect(v.safeParse([valid]).success).toBe(false);
  });

  describe('types', () => {
    it('text: trims, enforces maxLength and pattern (full match)', () => {
      expect(v.parse({ ...valid, fullName: '  Aisha Khan  ' }).fullName).toBe('Aisha Khan');
      expect(messages(v.safeParse({ ...valid, fullName: 'x'.repeat(21) }))).toEqual({ fullName: 'Full name can have at most 20 characters' });
      expect(messages(v.safeParse({ ...valid, fullName: 42 }))).toEqual({ fullName: 'Full name must be text' });
      expect(v.parse({ ...valid, fileNo: '123/2026' }).fileNo).toBe('123/2026');
      expect(messages(v.safeParse({ ...valid, fileNo: 'x123/2026' }))).toEqual({ fileNo: 'File number is not in the expected format' });
      expect(messages(v.safeParse({ ...valid, fileNo: '123/20261' }))).toEqual({ fileNo: 'File number is not in the expected format' });
    });
    it('textarea: min / max are length bounds', () => {
      expect(messages(v.safeParse({ ...valid, notes: 'abc' }))).toEqual({ notes: 'Notes needs at least 5 characters' });
      expect(messages(v.safeParse({ ...valid, notes: 'x'.repeat(31) }))).toEqual({ notes: 'Notes can have at most 30 characters' });
      expect(v.parse({ ...valid, notes: 'long enough' }).notes).toBe('long enough');
    });
    it('number: accepts numbers and numeric strings, enforces min / max', () => {
      expect(v.parse({ ...valid, dependants: 3 }).dependants).toBe(3);
      expect(v.parse({ ...valid, dependants: '4' }).dependants).toBe(4);
      expect(v.parse({ ...valid, dependants: 0 }).dependants).toBe(0);
      expect(messages(v.safeParse({ ...valid, dependants: 'three' }))).toEqual({ dependants: 'Number of dependants must be a number' });
      expect(messages(v.safeParse({ ...valid, dependants: '1e3' }))).toEqual({ dependants: 'Number of dependants must be a number' });
      expect(messages(v.safeParse({ ...valid, dependants: Infinity }))).toEqual({ dependants: 'Number of dependants must be a number' });
      expect(messages(v.safeParse({ ...valid, dependants: -1 }))).toEqual({ dependants: 'Number of dependants must be at least 0' });
      expect(messages(v.safeParse({ ...valid, dependants: 11 }))).toEqual({ dependants: 'Number of dependants must be at most 10' });
    });
    it('date: real calendar dates in YYYY-MM-DD only', () => {
      expect(v.parse({ ...valid, birthDate: '1990-02-28' }).birthDate).toBe('1990-02-28');
      for (const bad of ['1990-02-30', '28/02/1990', '1990-2-8', '2026-13-01', 19900228]) {
        expect(messages(v.safeParse({ ...valid, birthDate: bad }))).toEqual({ birthDate: 'Date of birth must be a date (YYYY-MM-DD)' });
      }
    });
    it('email, phone and country are normalised', () => {
      expect(v.parse({ ...valid, email: ' Aisha@Example.COM ', mobile: '+971 50 123-4567', nationality: 'ae' })).toMatchObject({ email: 'aisha@example.com', mobile: '+971501234567', nationality: 'AE' });
      expect(messages(v.safeParse({ ...valid, email: 'not-an-email', mobile: '0501234567', nationality: 'Emirates' }))).toEqual({
        email: 'Email must be a valid email address',
        mobile: 'Mobile must be in international format, e.g. +971501234567',
        nationality: 'Nationality must be a country code such as AE',
      });
    });
    it('select / radio: only listed options', () => {
      expect(messages(v.safeParse({ ...valid, visaType: 'tourist' }))).toEqual({ visaType: 'Visa type: choose one of the listed options' });
      expect(messages(v.safeParse({ ...valid, visaType: ['visit'] }))).toEqual({ visaType: 'Visa type: choose one of the listed options' });
    });
    it('multiselect: listed options, de-duplicated, min / max count', () => {
      expect(v.parse({ ...valid, extras: ['photo', 'photo', 'scan'] }).extras).toEqual(['photo', 'scan']);
      expect(messages(v.safeParse({ ...valid, extras: ['photo', 'copy', 'scan'] }))).toEqual({ extras: 'Extras: choose at most 2' });
      expect(messages(v.safeParse({ ...valid, extras: ['fax'] }))).toEqual({ extras: 'Extras: choose only from the listed options' });
      expect(messages(v.safeParse({ ...valid, extras: 'photo' }))).toEqual({ extras: 'Extras must be a list of options' });
    });
  });

  describe('showIf', () => {
    it('a hidden required field is not required and its value is dropped', () => {
      expect(v.parse({ ...valid, sponsorType: 'company', companyName: 'Hidden LLC' })).toEqual({ fullName: 'Aisha Khan', visaType: 'visit', terms: true });
      // Even a nonsense value in a hidden field cannot fail the submission.
      expect(v.safeParse({ ...valid, sponsorType: 'nonsense' }).success).toBe(true);
    });
    it('a shown required field becomes required', () => {
      expect(messages(v.safeParse({ ...valid, visaType: 'residence' }))).toEqual({ sponsorType: 'Sponsor is required' });
      expect(messages(v.safeParse({ ...valid, visaType: 'residence', sponsorType: 'company' }))).toEqual({ companyName: 'Company name is required' });
      expect(v.parse({ ...valid, visaType: 'residence', sponsorType: 'company', companyName: 'Falcon LLC' })).toMatchObject({ sponsorType: 'company', companyName: 'Falcon LLC' });
    });
    it('chains: a field depending on a hidden field is hidden too', () => {
      // companyName depends on sponsorType, which is hidden for a visit visa.
      expect(v.parse({ ...valid, visaType: 'visit', sponsorType: 'company', companyName: 'X' }).companyName).toBeUndefined();
      expect(v.parse({ ...valid, visaType: 'residence', sponsorType: 'family', companyName: 'X' }).companyName).toBeUndefined();
    });
    it('works with checkbox conditions', () => {
      expect(v.safeParse({ ...valid, urgent: false }).success).toBe(true);
      expect(messages(v.safeParse({ ...valid, urgent: true }))).toEqual({ urgentReason: 'Reason for urgency is required' });
      expect(v.parse({ ...valid, urgent: true, urgentReason: 'Flight tomorrow' })).toMatchObject({ urgentReason: 'Flight tomorrow' });
    });
    it('an invalid controlling field hides its dependants instead of cascading errors', () => {
      expect(messages(v.safeParse({ ...valid, visaType: 'bogus', sponsorType: 'company' }))).toEqual({ visaType: 'Visa type: choose one of the listed options' });
    });
    it('multiselect and number controllers', () => {
      const f: FormSchema = {
        steps: [{ key: 's', title: 'S', fields: [
          { key: 'changes', label: 'Changes', type: 'multiselect', options: [{ value: 'address', label: 'Address' }, { value: 'name', label: 'Name' }] },
          { key: 'newAddress', label: 'New address', type: 'text', required: true, showIf: { field: 'changes', in: ['address'] } },
          { key: 'copies', label: 'Copies', type: 'number' },
          { key: 'binding', label: 'Binding', type: 'checkbox', required: true, showIf: { field: 'copies', in: [10, 20] } },
        ] }],
      };
      expect(serviceFormSchema.safeParse(f).success).toBe(true);
      const fv = buildFormValidator(f);
      expect(fv.safeParse({ changes: ['name'] }).success).toBe(true);
      expect(messages(fv.safeParse({ changes: ['name', 'address'] }))).toEqual({ newAddress: 'New address is required' });
      expect(messages(fv.safeParse({ copies: '10' }))).toEqual({ binding: 'Binding is required' });
      expect(fv.safeParse({ copies: 5 }).success).toBe(true);
    });
    it('visibleFormFieldKeys mirrors the validator', () => {
      const always = ['fullName', 'email', 'mobile', 'nationality', 'birthDate', 'fileNo', 'notes', 'visaType', 'dependants', 'extras', 'urgent', 'terms'];
      expect(visibleFormFieldKeys(form, {}).sort()).toEqual([...always].sort());
      expect(visibleFormFieldKeys(form, { visaType: 'residence', sponsorType: 'company', urgent: true }).sort()).toEqual([...always, 'sponsorType', 'companyName', 'urgentReason'].sort());
    });
  });

  describe('options', () => {
    it('partial (draft saving): required is not enforced, everything filled in is still validated', () => {
      const draft = buildFormValidator(form, { partial: true });
      expect(draft.parse({})).toEqual({});
      expect(draft.parse({ fullName: 'Aisha', terms: false })).toEqual({ fullName: 'Aisha', terms: false });
      expect(messages(draft.safeParse({ dependants: 99 }))).toEqual({ dependants: 'Number of dependants must be at most 10' });
    });
    it('unknown keys are dropped by default and reported in strict mode', () => {
      expect(v.parse({ ...valid, isAdmin: true, __proto__: { polluted: true } })).toEqual({ fullName: 'Aisha Khan', visaType: 'visit', terms: true });
      const strict = buildFormValidator(form, { unknownKeys: 'reject' });
      expect(messages(strict.safeParse({ ...valid, isAdmin: true }))).toEqual({ isAdmin: '"isAdmin" is not a field of this form' });
    });
    it('field keys that shadow Object.prototype members behave like any other field', () => {
      const f: FormSchema = { steps: [{ key: 's', title: 'S', fields: [{ key: 'constructor', label: 'Builder', type: 'text' }, { key: 'toString', label: 'Text', type: 'text', required: true }] }] };
      const fv = buildFormValidator(f);
      expect(messages(fv.safeParse({}))).toEqual({ toString: 'Text is required' });
      expect(fv.parse({ toString: 'ok' })).toEqual({ toString: 'ok' });
      expect(visibleFormFieldKeys(f, {})).toEqual(['constructor', 'toString']);
    });
    it('a form without fields accepts an empty object', () => {
      expect(buildFormValidator({ steps: [] }).parse({ anything: 1 })).toEqual({});
    });
  });
});
