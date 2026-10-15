import type { PersonFx } from '../../services/api/src/cli/seed/fixture-types';
import { identity } from './identity';

/**
 * Form answers for the services of the demo catalogue: the starter services
 * installed by the API (codes ST-...) and the centres' own services defined in
 * `tenants/*.ts`. Every value is invented.
 *
 * `pick(n)` returns a deterministic number in [0, n): the seed supplies it, so
 * two runs fill the forms identically.
 */
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const LANDLORDS = ['Sample Landlord One', 'Sample Landlord Two', 'Sample Properties Office (fictional)', 'Sample Landlord Three'];
const AREAS = ['Flat 204, Sample Tower, Al Nahda (fictional address)', 'Villa 17, Sample Street 9, Mirdif (fictional address)', 'Office 310, Sample Business Centre, Deira (fictional address)', 'Shop 4, Sample Plaza, Al Majaz (fictional address)'];
const EMPLOYERS = ['Sample Trading Co. (fictional)', 'Sample Facilities Management (fictional)', 'Sample Restaurant Group (fictional)'];
const JOBS = ['Sales Executive', 'Accountant', 'Site Supervisor', 'Customer Service Agent', 'Driver'];
const COUNTERS = ['Sample customer service counter, Deira (fictional)', 'Sample service centre, Al Qusais (fictional)', 'Sample typing hall, Sharjah Industrial Area (fictional)'];

export function formValues(serviceCode: string, person: PersonFx, pick: (n: number) => number): Record<string, unknown> {
  const applicant = { applicantName: person.fullName, nationality: person.nationality, dateOfBirth: person.dateOfBirth, mobile: identity.phone(900 + pick(90)) };
  switch (serviceCode) {
    case 'ST-TENANCY': {
      const type = ['apartment', 'villa', 'office', 'shop'][pick(4)];
      return {
        landlordName: LANDLORDS[pick(LANDLORDS.length)],
        tenantName: person.fullName,
        propertyType: type,
        propertyAddress: AREAS[pick(AREAS.length)],
        annualRent: 38000 + pick(40) * 1000,
        startDate: day(10 + pick(30)),
        termMonths: 12,
        paymentCount: ['1', '2', '4', '12'][pick(4)],
      };
    }
    case 'ST-LETTER':
      return {
        language: ['en', 'ar', 'both'][pick(3)],
        addressedTo: ['To whom it may concern', 'The Manager, Sample Bank (fictional)', 'Sample School Administration (fictional)'][pick(3)],
        purpose: ['No-objection letter for a family visit (sample text).', 'Salary transfer request letter (sample text).', 'Undertaking letter for a school registration (sample text).'][pick(3)],
        copies: 1 + pick(3),
      };
    case 'ST-VISA-TYPING': {
      const sponsorType = ['family', 'company', 'self'][pick(3)];
      return {
        ...applicant,
        visaType: ['visit', 'tourist', 'residence'][pick(3)],
        sponsorType,
        ...(sponsorType === 'self' ? {} : { sponsorName: sponsorType === 'company' ? EMPLOYERS[pick(EMPLOYERS.length)] : 'Sample Sponsor (family member)' }),
        passportExpiry: day(400 + pick(900)),
        insideCountry: pick(2) === 0,
      };
    }
    case 'ST-RES-RENEWAL':
      return { ...applicant, sponsorType: ['employer', 'family', 'self'][pick(3)], currentExpiry: day(5 + pick(40)), notes: 'Sample note: please call before preparing the file.' };
    case 'ST-EID-TYPING': {
      const applicationType = ['new', 'renewal', 'replacement'][pick(3)];
      return {
        ...applicant,
        applicationType,
        ...(applicationType === 'replacement' ? { replacementReason: ['lost', 'damaged'][pick(2)] } : {}),
        ...(applicationType === 'renewal' ? { currentIdExpiry: day(3 + pick(30)) } : {}),
      };
    }
    case 'ST-LABOUR-CONTRACT':
      return {
        employerName: EMPLOYERS[pick(EMPLOYERS.length)],
        employeeName: person.fullName,
        jobTitle: JOBS[pick(JOBS.length)],
        contractType: ['full_time', 'part_time'][pick(2)],
        monthlySalary: 3500 + pick(30) * 250,
        startDate: day(7 + pick(21)),
      };
    case 'ST-TL-RENEWAL':
      return { companyName: `${person.fullName.split(' ')[0]} Sample Trading (fictional)`, licenceExpiry: day(10 + pick(35)), changes: [] };
    case 'ST-PRO-VISIT':
      return { destination: COUNTERS[pick(COUNTERS.length)], task: 'Deliver the sample file and collect the stamped receipt (sample instruction).', preferredDate: day(1 + pick(5)) };
    case 'ST-ATTESTATION':
      return { certificateType: ['education', 'marriage', 'birth'][pick(3)], issuingCountry: person.nationality, holderName: person.fullName };
    case 'ST-TRANSLATION':
      return { fromLanguage: ['Hindi', 'Urdu', 'Tagalog', 'French'][pick(4)], toLanguage: ['ar', 'en'][pick(2)], pages: 1 + pick(6), certified: pick(2) === 0 };
    case 'ST-COPY-SCAN': {
      const jobType = ['copy', 'print', 'scan'][pick(3)];
      return { jobType, pages: 2 + pick(40), ...(jobType === 'scan' ? {} : { colour: pick(2) === 0 }) };
    }
    case 'ST-CORP-FILES':
      return {};
    case 'ST-INFO':
      return { topic: ['visa', 'id', 'business', 'other'][pick(4)], details: 'Sample question: which documents do I need to prepare? (demo text)' };
    // ---- services defined by the demo centres
    case 'AN-FAMILY-FILE':
    case 'GS-FAMILY-FILE':
      return {
        sponsorName: person.fullName,
        relationship: ['spouse', 'child', 'parent'][pick(3)],
        familyMemberName: `Sample Family Member of ${person.fullName.split(' ')[0]}`,
        monthlySalary: 8000 + pick(20) * 500,
        insideCountry: pick(2) === 0,
      };
    case 'AN-MEDICAL-BUNDLE':
      return { applicantName: person.fullName, nationality: person.nationality, visaCategory: ['employment', 'family', 'investor'][pick(3)], preferredCentre: 'Sample screening centre (fictional)' };
    case 'AN-EXPRESS':
      return { documentKind: ['letter', 'form', 'cv', 'other'][pick(4)], pages: 1 + pick(4), language: ['en', 'ar'][pick(2)] };
    default:
      throw new Error(`No sample form answers are defined for service ${serviceCode}.`);
  }
}

// ---------------------------------------------------------------- forms of the centres' own services

export const FAMILY_FILE_FORM = {
  steps: [
    {
      key: 'sponsor',
      title: 'Sponsor and family member',
      titleAr: 'الكفيل وفرد الأسرة',
      fields: [
        { key: 'sponsorName', label: 'Sponsor name', labelAr: 'اسم الكفيل', type: 'text', required: true, prefillFrom: 'customer.fullName', maxLength: 160 },
        { key: 'relationship', label: 'Relationship to the sponsor', labelAr: 'صلة القرابة', type: 'select', required: true, options: [{ value: 'spouse', label: 'Spouse', labelAr: 'زوج / زوجة' }, { value: 'child', label: 'Child', labelAr: 'ابن / ابنة' }, { value: 'parent', label: 'Parent', labelAr: 'أب / أم' }] },
        { key: 'familyMemberName', label: 'Family member name (as in passport)', labelAr: 'اسم فرد الأسرة', type: 'text', required: true, maxLength: 160 },
        { key: 'monthlySalary', label: "Sponsor's monthly salary", labelAr: 'الراتب الشهري للكفيل', type: 'number', required: true, min: 0, max: 1000000, sensitive: true },
        { key: 'insideCountry', label: 'The family member is currently in the UAE', labelAr: 'فرد الأسرة موجود داخل الدولة', type: 'checkbox' },
      ],
    },
  ],
};

export const MEDICAL_BUNDLE_FORM = {
  steps: [
    {
      key: 'applicant',
      title: 'Applicant',
      titleAr: 'مقدم الطلب',
      fields: [
        { key: 'applicantName', label: 'Full name (as in passport)', labelAr: 'الاسم الكامل', type: 'text', required: true, prefillFrom: 'customer.fullName', maxLength: 160 },
        { key: 'nationality', label: 'Nationality', labelAr: 'الجنسية', type: 'country', required: true, prefillFrom: 'customer.nationality' },
        { key: 'visaCategory', label: 'Visa category', labelAr: 'فئة التأشيرة', type: 'radio', required: true, options: [{ value: 'employment', label: 'Employment', labelAr: 'عمل' }, { value: 'family', label: 'Family', labelAr: 'عائلية' }, { value: 'investor', label: 'Investor / partner', labelAr: 'مستثمر / شريك' }] },
        { key: 'preferredCentre', label: 'Preferred screening centre', labelAr: 'مركز الفحص المفضل', type: 'text', maxLength: 160 },
      ],
    },
  ],
};

export const EXPRESS_FORM = {
  steps: [
    {
      key: 'job',
      title: 'What should we type?',
      titleAr: 'ما المطلوب طباعته؟',
      fields: [
        { key: 'documentKind', label: 'Document', labelAr: 'المستند', type: 'select', required: true, options: [{ value: 'letter', label: 'Letter', labelAr: 'رسالة' }, { value: 'form', label: 'Form', labelAr: 'نموذج' }, { value: 'cv', label: 'CV', labelAr: 'سيرة ذاتية' }, { value: 'other', label: 'Other', labelAr: 'أخرى' }] },
        { key: 'pages', label: 'Pages', labelAr: 'عدد الصفحات', type: 'number', required: true, min: 1, max: 50 },
        { key: 'language', label: 'Language', labelAr: 'اللغة', type: 'radio', required: true, options: [{ value: 'en', label: 'English', labelAr: 'الإنجليزية' }, { value: 'ar', label: 'Arabic', labelAr: 'العربية' }] },
      ],
    },
  ],
};
