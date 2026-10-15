import { authorKindOf, firstNameOf, presentAuthor } from './author-display';

describe('how authors are shown outside the centre', () => {
  it('takes the first name, keeping names together that cannot stand alone', () => {
    const cases: Array<[string | null | undefined, string | null]> = [
      ['Omar Khalid', 'Omar'],
      ['  Fatima   Al Mansoori ', 'Fatima'],
      ['Sara', 'Sara'],
      ['Dr. Ahmed Al Farsi', 'Ahmed'],
      ['Eng. Mona Hassan', 'Mona'],
      ['Abdul Rahman Al Farsi', 'Abdul Rahman'],
      ['Abu Bakr Siddiq', 'Abu Bakr'],
      ['Abdul-Rahman Al Farsi', 'Abdul-Rahman'],
      ['Jean-Pierre Dupont', 'Jean-Pierre'],
      ['عبد الله محمد', 'عبد الله'],
      ['فاطمة المنصوري', 'فاطمة'],
      ['Sara Ahmad (TypEase support)', 'Sara'],
      ['automation:Thank the customer', null],
      ['system', null],
      ['Dr.', null],
      ['', null],
      [null, null],
      [undefined, null],
    ];
    for (const [full, first] of cases) expect([full, firstNameOf(full)]).toEqual([full, first]);
  });

  it('reduces the author type to a role-neutral kind', () => {
    expect(['STAFF', 'PLATFORM', 'CUSTOMER', 'CORPORATE', 'SYSTEM', 'AUTOMATION'].map(authorKindOf)).toEqual(['STAFF', 'STAFF', 'CUSTOMER', 'CUSTOMER', 'SYSTEM', 'SYSTEM']);
  });

  it('staff see everything; customers see a first name and nothing about role, support or automation', () => {
    const staff = { authorType: 'STAFF', authorName: 'Omar Khalid Al Suwaidi' };
    expect(presentAuthor(staff, false)).toEqual({ authorType: 'STAFF', authorKind: 'STAFF', authorName: 'Omar Khalid Al Suwaidi' });
    expect(presentAuthor(staff, true)).toEqual({ authorType: 'STAFF', authorKind: 'STAFF', authorName: 'Omar' });
    const support = { authorType: 'PLATFORM', authorName: 'Sara Ahmad (TypEase support)' };
    expect(presentAuthor(support, false)).toEqual({ authorType: 'PLATFORM', authorKind: 'STAFF', authorName: 'Sara Ahmad (TypEase support)' });
    expect(presentAuthor(support, true)).toEqual({ authorType: 'STAFF', authorKind: 'STAFF', authorName: 'Sara' });
    const automation = { authorType: 'AUTOMATION', authorName: 'automation:Thank the customer' };
    expect(presentAuthor(automation, false)).toEqual({ authorType: 'AUTOMATION', authorKind: 'SYSTEM', authorName: 'automation:Thank the customer' });
    expect(presentAuthor(automation, true)).toEqual({ authorType: 'SYSTEM', authorKind: 'SYSTEM', authorName: null });
    // The customer's own side is theirs: nothing is hidden from them or from their company.
    for (const authorType of ['CUSTOMER', 'CORPORATE']) {
      expect(presentAuthor({ authorType, authorName: 'Fatima Al Mansoori' }, true)).toEqual({ authorType, authorKind: 'CUSTOMER', authorName: 'Fatima Al Mansoori' });
    }
    expect(presentAuthor({ authorType: 'STAFF', authorName: null }, true)).toEqual({ authorType: 'STAFF', authorKind: 'STAFF', authorName: null });
  });
});
