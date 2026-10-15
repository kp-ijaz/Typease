import { ERASED_TEXT, identifierPattern, scrubJson, scrubText } from './erasure';

describe('erasure: scrubbing copies of personal values', () => {
  const identifiers = { names: ['Zainab  Al Farouqi', 'زينب الفاروقي', 'Li'], emails: ['zainab@example.test'], phones: ['+971501112233'], identityNumbers: ['784199012345671', 'P7654321'] };
  const pattern = identifierPattern(identifiers);

  it('finds names whatever the case or spacing, emails, phone numbers in their usual spellings and identity numbers as printed', () => {
    const text = 'ZAINAB AL  FAROUQI (zainab@example.test, 00971501112233 / 971501112233) زينب الفاروقي EID 784-1990-1234567-1, passport p7654321.';
    expect(scrubText(text, pattern)).toBe(`${ERASED_TEXT} (${ERASED_TEXT}, ${ERASED_TEXT} / ${ERASED_TEXT}) ${ERASED_TEXT} EID ${ERASED_TEXT}, passport ${ERASED_TEXT}.`);
  });

  it('leaves everything else alone: very short names are not used as a pattern, other people are untouched', () => {
    expect(scrubText('Liability report for Lina Farouqi, phone +971509998877', pattern)).toBe('Liability report for Lina Farouqi, phone +971509998877');
    expect(scrubText(null, pattern)).toBeNull();
    expect(scrubText('unchanged', null)).toBe('unchanged');
    expect(identifierPattern({ names: ['Al'], emails: [], phones: ['12'], identityNumbers: [] })).toBeNull();
    // Characters with a meaning in patterns are matched literally.
    expect(scrubText('a.b+c@example.test and aXb+c@example.test', identifierPattern({ names: [], emails: ['a.b+c@example.test'], phones: [], identityNumbers: [] }))).toBe(`${ERASED_TEXT} and aXb+c@example.test`);
  });

  it('scrubs JSON by key and by value, keeping ids, numbers and structure', () => {
    const before = {
      customerId: 'c-1', fullName: 'Somebody Else Entirely', email: null, total: 305.5, nested: [{ note: 'Call Zainab Al Farouqi back', phone: '+971509998877' }],
      address: { city: 'Dubai' }, emiratesIdMasked: '•••• 5671', reason: 'Requested by zainab@example.test', value: '+971501112233',
    };
    expect(scrubJson(before, pattern)).toEqual({
      customerId: 'c-1', fullName: ERASED_TEXT, email: null, total: 305.5, nested: [{ note: `Call ${ERASED_TEXT} back`, phone: ERASED_TEXT }],
      address: ERASED_TEXT, emiratesIdMasked: ERASED_TEXT, reason: `Requested by ${ERASED_TEXT}`, value: ERASED_TEXT,
    });
    // Extra keys are personal only where the caller says so.
    expect(scrubJson({ value: 'left alone', label: 'Home' }, pattern)).toEqual({ value: 'left alone', label: 'Home' });
    expect(scrubJson({ value: 'private', label: 'Home' }, pattern, ['value', 'label'])).toEqual({ value: ERASED_TEXT, label: ERASED_TEXT });
    // Running it again changes nothing.
    const once = scrubJson(before, pattern);
    expect(scrubJson(once, pattern)).toEqual(once);
    expect(scrubJson(null, pattern)).toBeNull();
    expect(scrubJson(42, pattern)).toBe(42);
  });
});
