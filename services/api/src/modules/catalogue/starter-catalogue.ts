import { DEFAULT_SERVICE_CATEGORIES } from '@typease/types';
import type { FormSchema } from '@typease/types';
import type { Tx } from '../../common/db/prisma.service';

/**
 * A neutral starter catalogue a new centre can install during onboarding and
 * then edit. Names, fees and estimates are illustrative: every centre reviews
 * them before offering a service.
 *
 * Every service starts as DOCUMENT_PREPARATION_ONLY or INFORMATIONAL_ONLY. The
 * centre prepares paperwork; nothing here claims that the centre, or TypEase,
 * is an authority or submits applications on a customer's behalf.
 */
export interface StarterService {
  code: string;
  categoryKey: (typeof DEFAULT_SERVICE_CATEGORIES)[number]['key'];
  name: string;
  nameAr: string;
  description: string;
  eligibilityGuidance?: string;
  complianceCapability: 'DOCUMENT_PREPARATION_ONLY' | 'INFORMATIONAL_ONLY';
  estimatedProcessingHours: number;
  requiresApproval?: boolean;
  paymentPolicy?: 'BEFORE_PROCESSING' | 'AFTER_COMPLETION' | 'DEPOSIT';
  depositPercent?: number;
  taxMode?: 'SERVICE_FEE_ONLY' | 'ALL_COMPONENTS' | 'NONE';
  onlineAvailable?: boolean;
  isPublic?: boolean;
  price: { serviceFee: string; governmentFeeEstimate?: string; thirdPartyFeeEstimate?: string };
  requirements: Array<{ documentTypeKey: string; label: string; labelAr?: string; description?: string; isMandatory?: boolean; allowReuse?: boolean; maxAgeDays?: number }>;
  form?: FormSchema;
}

const ESTIMATE_NOTE = 'Authority and third-party amounts shown are estimates only. The amounts that apply on the day are confirmed in your quotation.';
const applicantStep = {
  key: 'applicant',
  title: 'Applicant',
  titleAr: 'مقدم الطلب',
  fields: [
    { key: 'applicantName', label: 'Full name (as in passport)', labelAr: 'الاسم الكامل (كما في جواز السفر)', type: 'text' as const, required: true, prefillFrom: 'customer.fullName', maxLength: 160 },
    { key: 'nationality', label: 'Nationality', labelAr: 'الجنسية', type: 'country' as const, required: true, prefillFrom: 'customer.nationality' },
    { key: 'dateOfBirth', label: 'Date of birth', labelAr: 'تاريخ الميلاد', type: 'date' as const, required: true, prefillFrom: 'customer.dateOfBirth', sensitive: true },
    { key: 'mobile', label: 'Mobile number', labelAr: 'رقم الهاتف المتحرك', type: 'phone' as const, required: true, prefillFrom: 'customer.phone' },
  ],
};

export const STARTER_SERVICES: StarterService[] = [
  {
    code: 'ST-TENANCY',
    categoryKey: 'typing',
    name: 'Tenancy contract typing',
    nameAr: 'طباعة عقد الإيجار',
    description: 'We type your tenancy contract from the details you provide and hand you a print-ready copy for signature.',
    eligibilityGuidance: 'Bring the landlord and tenant identity documents and the property details. Registration of the contract with the relevant authority is not part of this service.',
    complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
    estimatedProcessingHours: 2,
    price: { serviceFee: '75.00' },
    requirements: [
      { documentTypeKey: 'emirates_id', label: "Tenant's Emirates ID", labelAr: 'الهوية الإماراتية للمستأجر' },
      { documentTypeKey: 'passport', label: "Landlord's passport or Emirates ID copy", labelAr: 'نسخة من جواز سفر أو هوية المؤجر', allowReuse: false },
      { documentTypeKey: 'other', label: 'Title deed or previous contract', labelAr: 'سند الملكية أو العقد السابق', isMandatory: false, allowReuse: false },
    ],
    form: {
      steps: [
        {
          key: 'parties',
          title: 'Landlord and tenant',
          titleAr: 'المؤجر والمستأجر',
          fields: [
            { key: 'landlordName', label: 'Landlord name', labelAr: 'اسم المؤجر', type: 'text', required: true, maxLength: 160 },
            { key: 'tenantName', label: 'Tenant name', labelAr: 'اسم المستأجر', type: 'text', required: true, prefillFrom: 'customer.fullName', maxLength: 160 },
            { key: 'tenantMobile', label: 'Tenant mobile number', labelAr: 'هاتف المستأجر', type: 'phone', prefillFrom: 'customer.phone' },
          ],
        },
        {
          key: 'property',
          title: 'Property and term',
          titleAr: 'العقار والمدة',
          fields: [
            { key: 'propertyType', label: 'Property type', labelAr: 'نوع العقار', type: 'select', required: true, options: [{ value: 'apartment', label: 'Apartment', labelAr: 'شقة' }, { value: 'villa', label: 'Villa', labelAr: 'فيلا' }, { value: 'office', label: 'Office', labelAr: 'مكتب' }, { value: 'shop', label: 'Shop', labelAr: 'محل' }, { value: 'other', label: 'Other', labelAr: 'أخرى' }] },
            { key: 'propertyTypeOther', label: 'Describe the property', labelAr: 'وصف العقار', type: 'text', required: true, showIf: { field: 'propertyType', in: ['other'] }, maxLength: 120 },
            { key: 'propertyAddress', label: 'Property address', labelAr: 'عنوان العقار', type: 'textarea', required: true, maxLength: 400 },
            { key: 'annualRent', label: 'Annual rent', labelAr: 'الإيجار السنوي', type: 'number', required: true, min: 0, max: 100000000 },
            { key: 'startDate', label: 'Contract start date', labelAr: 'تاريخ بداية العقد', type: 'date', required: true },
            { key: 'termMonths', label: 'Contract period (months)', labelAr: 'مدة العقد (بالأشهر)', type: 'number', required: true, min: 1, max: 120 },
            { key: 'paymentCount', label: 'Number of rent payments', labelAr: 'عدد دفعات الإيجار', type: 'radio', options: [{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '4', label: '4' }, { value: '12', label: '12' }] },
          ],
        },
      ],
    },
  },
  {
    code: 'ST-LETTER',
    categoryKey: 'typing',
    name: 'Letter and application typing',
    nameAr: 'طباعة الرسائل والطلبات',
    description: 'Typing of letters, undertakings, no-objection letters and general applications in English or Arabic.',
    complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
    estimatedProcessingHours: 1,
    price: { serviceFee: '30.00' },
    requirements: [{ documentTypeKey: 'other', label: 'Draft or supporting document', labelAr: 'مسودة أو مستند داعم', isMandatory: false, allowReuse: false }],
    form: {
      steps: [
        {
          key: 'letter',
          title: 'Letter details',
          titleAr: 'تفاصيل الرسالة',
          fields: [
            { key: 'language', label: 'Language', labelAr: 'اللغة', type: 'select', required: true, options: [{ value: 'en', label: 'English', labelAr: 'الإنجليزية' }, { value: 'ar', label: 'Arabic', labelAr: 'العربية' }, { value: 'both', label: 'English and Arabic', labelAr: 'الإنجليزية والعربية' }] },
            { key: 'addressedTo', label: 'Addressed to', labelAr: 'موجهة إلى', type: 'text', maxLength: 160 },
            { key: 'purpose', label: 'What should the letter say?', labelAr: 'ما مضمون الرسالة؟', type: 'textarea', required: true, maxLength: 2000 },
            { key: 'copies', label: 'Printed copies', labelAr: 'عدد النسخ المطبوعة', type: 'number', min: 1, max: 20 },
          ],
        },
      ],
    },
  },
  {
    code: 'ST-VISA-TYPING',
    categoryKey: 'visa',
    name: 'Visa application typing (document preparation)',
    nameAr: 'طباعة طلب تأشيرة (تجهيز المستندات)',
    description: 'We check your documents for completeness and prepare the visa application form for you. You or your sponsor submit it through the official channel.',
    eligibilityGuidance: `Eligibility is decided by the issuing authority, not by the centre. ${ESTIMATE_NOTE}`,
    complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
    estimatedProcessingHours: 24,
    price: { serviceFee: '120.00', governmentFeeEstimate: '350.00' },
    requirements: [
      { documentTypeKey: 'passport', label: 'Passport copy (valid at least 6 months)', labelAr: 'نسخة جواز السفر (صالح لمدة 6 أشهر على الأقل)' },
      { documentTypeKey: 'photo', label: 'Personal photo, white background', labelAr: 'صورة شخصية بخلفية بيضاء', maxAgeDays: 180 },
      { documentTypeKey: 'residence_visa', label: "Sponsor's residence visa", labelAr: 'إقامة الكفيل', isMandatory: false },
    ],
    form: {
      steps: [
        applicantStep,
        {
          key: 'visa',
          title: 'Visa details',
          titleAr: 'تفاصيل التأشيرة',
          fields: [
            { key: 'visaType', label: 'Type of visa', labelAr: 'نوع التأشيرة', type: 'select', required: true, options: [{ value: 'visit', label: 'Visit', labelAr: 'زيارة' }, { value: 'tourist', label: 'Tourist', labelAr: 'سياحية' }, { value: 'residence', label: 'Residence', labelAr: 'إقامة' }, { value: 'other', label: 'Other', labelAr: 'أخرى' }] },
            { key: 'sponsorType', label: 'Who is the sponsor?', labelAr: 'من هو الكفيل؟', type: 'radio', required: true, options: [{ value: 'family', label: 'Family member', labelAr: 'أحد أفراد الأسرة' }, { value: 'company', label: 'Company', labelAr: 'شركة' }, { value: 'self', label: 'No sponsor', labelAr: 'بدون كفيل' }] },
            { key: 'sponsorName', label: 'Sponsor name', labelAr: 'اسم الكفيل', type: 'text', required: true, showIf: { field: 'sponsorType', in: ['family', 'company'] }, maxLength: 160 },
            { key: 'passportExpiry', label: 'Passport expiry date', labelAr: 'تاريخ انتهاء جواز السفر', type: 'date', required: true, prefillFrom: 'customer.passportExpiry' },
            { key: 'insideCountry', label: 'The applicant is currently in the UAE', labelAr: 'مقدم الطلب موجود حالياً داخل الدولة', type: 'checkbox' },
          ],
        },
      ],
    },
  },
  {
    code: 'ST-RES-RENEWAL',
    categoryKey: 'residence',
    name: 'Residence renewal typing (document preparation)',
    nameAr: 'طباعة طلب تجديد الإقامة (تجهيز المستندات)',
    description: 'Preparation of the residence renewal application and a checklist of what the authority normally asks for.',
    eligibilityGuidance: `Start before the current residence expires. ${ESTIMATE_NOTE}`,
    complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
    estimatedProcessingHours: 24,
    price: { serviceFee: '150.00', governmentFeeEstimate: '500.00', thirdPartyFeeEstimate: '320.00' },
    requirements: [
      { documentTypeKey: 'passport', label: 'Passport copy', labelAr: 'نسخة جواز السفر' },
      { documentTypeKey: 'residence_visa', label: 'Current residence visa', labelAr: 'الإقامة الحالية' },
      { documentTypeKey: 'emirates_id', label: 'Emirates ID', labelAr: 'الهوية الإماراتية' },
      { documentTypeKey: 'photo', label: 'Personal photo, white background', labelAr: 'صورة شخصية بخلفية بيضاء', maxAgeDays: 180 },
    ],
    form: {
      steps: [
        applicantStep,
        {
          key: 'residence',
          title: 'Residence details',
          titleAr: 'تفاصيل الإقامة',
          fields: [
            { key: 'sponsorType', label: 'Sponsored by', labelAr: 'على كفالة', type: 'radio', required: true, options: [{ value: 'employer', label: 'Employer', labelAr: 'جهة العمل' }, { value: 'family', label: 'Family member', labelAr: 'أحد أفراد الأسرة' }, { value: 'self', label: 'Self', labelAr: 'شخصية' }] },
            { key: 'currentExpiry', label: 'Current residence expiry date', labelAr: 'تاريخ انتهاء الإقامة الحالية', type: 'date', required: true },
            { key: 'notes', label: 'Anything we should know?', labelAr: 'ملاحظات', type: 'textarea', maxLength: 1000 },
          ],
        },
      ],
    },
  },
  {
    code: 'ST-EID-TYPING',
    categoryKey: 'emirates-id',
    name: 'Emirates ID application typing (document preparation)',
    nameAr: 'طباعة طلب الهوية الإماراتية (تجهيز المستندات)',
    description: 'We prepare the Emirates ID application form (new, renewal or replacement) from your documents. The application is decided and issued by the authority.',
    eligibilityGuidance: ESTIMATE_NOTE,
    complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
    estimatedProcessingHours: 4,
    price: { serviceFee: '70.00', governmentFeeEstimate: '270.00' },
    requirements: [
      { documentTypeKey: 'passport', label: 'Passport copy', labelAr: 'نسخة جواز السفر' },
      { documentTypeKey: 'photo', label: 'Personal photo, white background', labelAr: 'صورة شخصية بخلفية بيضاء', maxAgeDays: 180 },
      { documentTypeKey: 'residence_visa', label: 'Residence visa or entry permit', labelAr: 'الإقامة أو إذن الدخول', isMandatory: false },
      { documentTypeKey: 'emirates_id', label: 'Previous Emirates ID (renewal / replacement)', labelAr: 'الهوية السابقة (للتجديد أو بدل فاقد)', isMandatory: false },
    ],
    form: {
      steps: [
        applicantStep,
        {
          key: 'application',
          title: 'Application',
          titleAr: 'الطلب',
          fields: [
            { key: 'applicationType', label: 'Application type', labelAr: 'نوع الطلب', type: 'select', required: true, options: [{ value: 'new', label: 'New', labelAr: 'جديد' }, { value: 'renewal', label: 'Renewal', labelAr: 'تجديد' }, { value: 'replacement', label: 'Replacement', labelAr: 'بدل فاقد / تالف' }] },
            { key: 'replacementReason', label: 'Reason for replacement', labelAr: 'سبب الاستبدال', type: 'radio', required: true, showIf: { field: 'applicationType', in: ['replacement'] }, options: [{ value: 'lost', label: 'Lost', labelAr: 'مفقودة' }, { value: 'damaged', label: 'Damaged', labelAr: 'تالفة' }] },
            { key: 'currentIdExpiry', label: 'Current Emirates ID expiry date', labelAr: 'تاريخ انتهاء الهوية الحالية', type: 'date', showIf: { field: 'applicationType', in: ['renewal'] }, prefillFrom: 'customer.emiratesIdExpiry' },
          ],
        },
      ],
    },
  },
  {
    code: 'ST-LABOUR-CONTRACT',
    categoryKey: 'labour',
    name: 'Employment contract typing (document preparation)',
    nameAr: 'طباعة عقد العمل (تجهيز المستندات)',
    description: 'Typing of employment offer letters and contract forms from the details agreed between employer and employee.',
    eligibilityGuidance: 'The employer remains responsible for submitting the contract through its own authorised account.',
    complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
    estimatedProcessingHours: 8,
    price: { serviceFee: '100.00' },
    requirements: [
      { documentTypeKey: 'passport', label: "Employee's passport copy", labelAr: 'نسخة جواز سفر الموظف' },
      { documentTypeKey: 'trade_licence', label: "Employer's trade licence", labelAr: 'الرخصة التجارية لجهة العمل' },
      { documentTypeKey: 'certificate', label: 'Qualification certificate', labelAr: 'شهادة المؤهل', isMandatory: false },
    ],
    form: {
      steps: [
        {
          key: 'employment',
          title: 'Employment details',
          titleAr: 'تفاصيل العمل',
          fields: [
            { key: 'employerName', label: 'Employer (company) name', labelAr: 'اسم جهة العمل', type: 'text', required: true, maxLength: 160 },
            { key: 'employeeName', label: 'Employee name', labelAr: 'اسم الموظف', type: 'text', required: true, prefillFrom: 'customer.fullName', maxLength: 160 },
            { key: 'jobTitle', label: 'Job title', labelAr: 'المسمى الوظيفي', type: 'text', required: true, maxLength: 120 },
            { key: 'contractType', label: 'Contract type', labelAr: 'نوع العقد', type: 'radio', required: true, options: [{ value: 'full_time', label: 'Full time', labelAr: 'دوام كامل' }, { value: 'part_time', label: 'Part time', labelAr: 'دوام جزئي' }] },
            { key: 'monthlySalary', label: 'Total monthly salary', labelAr: 'إجمالي الراتب الشهري', type: 'number', required: true, min: 0, max: 10000000, sensitive: true },
            { key: 'startDate', label: 'Start date', labelAr: 'تاريخ المباشرة', type: 'date' },
          ],
        },
      ],
    },
  },
  {
    code: 'ST-TL-RENEWAL',
    categoryKey: 'business',
    name: 'Trade licence renewal paperwork',
    nameAr: 'تجهيز مستندات تجديد الرخصة التجارية',
    description: 'We collect and check the papers needed to renew a trade licence and prepare the renewal forms for the licence holder to submit.',
    eligibilityGuidance: `The licensing authority decides on the renewal. ${ESTIMATE_NOTE}`,
    complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
    estimatedProcessingHours: 48,
    requiresApproval: true,
    paymentPolicy: 'DEPOSIT',
    depositPercent: 50,
    price: { serviceFee: '400.00', governmentFeeEstimate: '9500.00' },
    requirements: [
      { documentTypeKey: 'trade_licence', label: 'Current trade licence', labelAr: 'الرخصة التجارية الحالية' },
      { documentTypeKey: 'tenancy_contract', label: 'Tenancy contract of the business premises', labelAr: 'عقد إيجار مقر النشاط' },
      { documentTypeKey: 'passport', label: "Owner's / manager's passport copy", labelAr: 'نسخة جواز سفر المالك أو المدير' },
    ],
    form: {
      steps: [
        {
          key: 'licence',
          title: 'Licence details',
          titleAr: 'تفاصيل الرخصة',
          fields: [
            { key: 'companyName', label: 'Company name', labelAr: 'اسم الشركة', type: 'text', required: true, maxLength: 160 },
            { key: 'licenceExpiry', label: 'Licence expiry date', labelAr: 'تاريخ انتهاء الرخصة', type: 'date', required: true },
            { key: 'changes', label: 'Changes requested with the renewal', labelAr: 'تعديلات مطلوبة مع التجديد', type: 'multiselect', options: [{ value: 'activity', label: 'Business activity', labelAr: 'النشاط' }, { value: 'partners', label: 'Partners', labelAr: 'الشركاء' }, { value: 'address', label: 'Address', labelAr: 'العنوان' }, { value: 'trade_name', label: 'Trade name', labelAr: 'الاسم التجاري' }] },
            { key: 'changeDetails', label: 'Describe the changes', labelAr: 'وصف التعديلات', type: 'textarea', required: true, showIf: { field: 'changes', in: ['activity', 'partners', 'address', 'trade_name'] }, maxLength: 1000 },
          ],
        },
      ],
    },
  },
  {
    code: 'ST-PRO-VISIT',
    categoryKey: 'pro',
    name: 'PRO document run (per visit)',
    nameAr: 'خدمة مندوب لتسليم واستلام المستندات (لكل زيارة)',
    description: 'A staff member delivers or collects your documents at a counter you name and reports back with the receipt.',
    eligibilityGuidance: 'A signed authorisation letter is needed when the counter requires one.',
    complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
    estimatedProcessingHours: 24,
    paymentPolicy: 'BEFORE_PROCESSING',
    onlineAvailable: true,
    price: { serviceFee: '150.00' },
    requirements: [{ documentTypeKey: 'other', label: 'Documents to deliver / authorisation letter', labelAr: 'المستندات المطلوب تسليمها / خطاب التفويض', isMandatory: false, allowReuse: false }],
    form: {
      steps: [
        {
          key: 'visit',
          title: 'Visit details',
          titleAr: 'تفاصيل الزيارة',
          fields: [
            { key: 'destination', label: 'Where should we go?', labelAr: 'الجهة المطلوب زيارتها', type: 'text', required: true, maxLength: 200 },
            { key: 'task', label: 'What should be delivered or collected?', labelAr: 'ما المطلوب تسليمه أو استلامه؟', type: 'textarea', required: true, maxLength: 1000 },
            { key: 'preferredDate', label: 'Preferred date', labelAr: 'التاريخ المفضل', type: 'date' },
          ],
        },
      ],
    },
  },
  {
    code: 'ST-ATTESTATION',
    categoryKey: 'attestation',
    name: 'Certificate attestation paperwork',
    nameAr: 'تجهيز مستندات تصديق الشهادات',
    description: 'We prepare the attestation request and guide you through the steps for educational, marriage and birth certificates.',
    eligibilityGuidance: `Original certificates are required by the attesting bodies. ${ESTIMATE_NOTE}`,
    complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
    estimatedProcessingHours: 72,
    paymentPolicy: 'DEPOSIT',
    depositPercent: 50,
    price: { serviceFee: '200.00', governmentFeeEstimate: '150.00', thirdPartyFeeEstimate: '250.00' },
    requirements: [
      { documentTypeKey: 'certificate', label: 'Certificate to be attested', labelAr: 'الشهادة المطلوب تصديقها', allowReuse: false },
      { documentTypeKey: 'passport', label: 'Passport copy of the certificate holder', labelAr: 'نسخة جواز سفر صاحب الشهادة' },
    ],
    form: {
      steps: [
        {
          key: 'certificate',
          title: 'Certificate',
          titleAr: 'الشهادة',
          fields: [
            { key: 'certificateType', label: 'Type of certificate', labelAr: 'نوع الشهادة', type: 'select', required: true, options: [{ value: 'education', label: 'Educational', labelAr: 'تعليمية' }, { value: 'marriage', label: 'Marriage', labelAr: 'زواج' }, { value: 'birth', label: 'Birth', labelAr: 'ميلاد' }, { value: 'other', label: 'Other', labelAr: 'أخرى' }] },
            { key: 'issuingCountry', label: 'Country of issue', labelAr: 'بلد الإصدار', type: 'country', required: true },
            { key: 'holderName', label: 'Name on the certificate', labelAr: 'الاسم في الشهادة', type: 'text', required: true, prefillFrom: 'customer.fullName', maxLength: 160 },
          ],
        },
      ],
    },
  },
  {
    code: 'ST-TRANSLATION',
    categoryKey: 'translation',
    name: 'Document translation coordination',
    nameAr: 'تنسيق ترجمة المستندات',
    description: 'We arrange the translation of your document with a translation office and return the translated copy to you.',
    eligibilityGuidance: 'The translator charges per page; the third-party amount shown is an estimate for one page.',
    complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
    estimatedProcessingHours: 48,
    price: { serviceFee: '40.00', thirdPartyFeeEstimate: '80.00' },
    requirements: [{ documentTypeKey: 'other', label: 'Document to translate', labelAr: 'المستند المطلوب ترجمته', allowReuse: false }],
    form: {
      steps: [
        {
          key: 'translation',
          title: 'Translation details',
          titleAr: 'تفاصيل الترجمة',
          fields: [
            { key: 'fromLanguage', label: 'From language', labelAr: 'من لغة', type: 'text', required: true, maxLength: 60 },
            { key: 'toLanguage', label: 'To language', labelAr: 'إلى لغة', type: 'select', required: true, options: [{ value: 'ar', label: 'Arabic', labelAr: 'العربية' }, { value: 'en', label: 'English', labelAr: 'الإنجليزية' }, { value: 'other', label: 'Other', labelAr: 'أخرى' }] },
            { key: 'toLanguageOther', label: 'Which language?', labelAr: 'ما هي اللغة؟', type: 'text', required: true, showIf: { field: 'toLanguage', in: ['other'] }, maxLength: 60 },
            { key: 'pages', label: 'Number of pages', labelAr: 'عدد الصفحات', type: 'number', required: true, min: 1, max: 500 },
            { key: 'certified', label: 'A certified (legal) translation is needed', labelAr: 'مطلوب ترجمة قانونية معتمدة', type: 'checkbox' },
          ],
        },
      ],
    },
  },
  {
    code: 'ST-COPY-SCAN',
    categoryKey: 'printing',
    name: 'Photocopy & scanning',
    nameAr: 'تصوير ومسح ضوئي',
    description: 'Photocopying, printing and scanning to email or USB while you wait. The fee shown is per page.',
    complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
    estimatedProcessingHours: 1,
    onlineAvailable: false,
    price: { serviceFee: '1.00' },
    requirements: [],
    form: {
      steps: [
        {
          key: 'job',
          title: 'Print job',
          titleAr: 'تفاصيل الطلب',
          fields: [
            { key: 'jobType', label: 'What do you need?', labelAr: 'الخدمة المطلوبة', type: 'radio', required: true, options: [{ value: 'copy', label: 'Photocopy', labelAr: 'تصوير' }, { value: 'print', label: 'Print', labelAr: 'طباعة' }, { value: 'scan', label: 'Scan', labelAr: 'مسح ضوئي' }] },
            { key: 'pages', label: 'Number of pages', labelAr: 'عدد الصفحات', type: 'number', required: true, min: 1, max: 5000 },
            { key: 'colour', label: 'Colour', labelAr: 'ملون', type: 'checkbox', showIf: { field: 'jobType', in: ['copy', 'print'] } },
            { key: 'scanEmail', label: 'Send the scan to this email', labelAr: 'إرسال المسح إلى البريد الإلكتروني', type: 'email', showIf: { field: 'jobType', in: ['scan'] }, prefillFrom: 'customer.email' },
          ],
        },
      ],
    },
  },
  {
    code: 'ST-CORP-FILES',
    categoryKey: 'corporate-docs',
    name: 'Employee document file administration',
    nameAr: 'إدارة ملفات مستندات الموظفين',
    description: 'For companies: we keep employee document files complete, track expiry dates and prepare renewal paperwork in good time.',
    eligibilityGuidance: 'Available to registered corporate clients. Charged per employee file according to the company agreement.',
    complianceCapability: 'DOCUMENT_PREPARATION_ONLY',
    estimatedProcessingHours: 72,
    paymentPolicy: 'AFTER_COMPLETION',
    isPublic: false,
    price: { serviceFee: '60.00' },
    requirements: [
      { documentTypeKey: 'passport', label: 'Employee passport copy', labelAr: 'نسخة جواز سفر الموظف' },
      { documentTypeKey: 'residence_visa', label: 'Employee residence visa', labelAr: 'إقامة الموظف', isMandatory: false },
      { documentTypeKey: 'emirates_id', label: 'Employee Emirates ID', labelAr: 'الهوية الإماراتية للموظف', isMandatory: false },
      { documentTypeKey: 'labour_card', label: 'Labour card / work permit', labelAr: 'بطاقة العمل', isMandatory: false },
    ],
  },
  {
    code: 'ST-INFO',
    categoryKey: 'other',
    name: 'Service information and document checklist',
    nameAr: 'معلومات الخدمات وقائمة المستندات المطلوبة',
    description: 'Not sure what you need? Tell us what you want to do and we will send you the list of documents to prepare. This is general information, not legal advice or a decision of any authority.',
    complianceCapability: 'INFORMATIONAL_ONLY',
    estimatedProcessingHours: 4,
    paymentPolicy: 'AFTER_COMPLETION',
    taxMode: 'NONE',
    price: { serviceFee: '0.00' },
    requirements: [],
    form: {
      steps: [
        {
          key: 'question',
          title: 'Your question',
          titleAr: 'استفسارك',
          fields: [
            { key: 'topic', label: 'What is it about?', labelAr: 'موضوع الاستفسار', type: 'select', required: true, options: [{ value: 'visa', label: 'Visa or residence', labelAr: 'تأشيرة أو إقامة' }, { value: 'id', label: 'Emirates ID', labelAr: 'الهوية الإماراتية' }, { value: 'business', label: 'Business paperwork', labelAr: 'مستندات الأعمال' }, { value: 'other', label: 'Something else', labelAr: 'أمر آخر' }] },
            { key: 'details', label: 'Tell us more', labelAr: 'تفاصيل إضافية', type: 'textarea', required: true, maxLength: 2000 },
          ],
        },
      ],
    },
  },
];

/**
 * Installs the starter services into one centre. Idempotent: a service whose
 * code already exists (even deleted) is left exactly as it is, so running it
 * twice, or after the centre edited the services, changes nothing.
 *
 * Must run inside a transaction of that tenant (or a system transaction).
 */
export async function installStarterCatalogue(tx: Tx, tenantId: string): Promise<{ created: string[]; skipped: string[] }> {
  const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } });
  const categories = new Map((await tx.serviceCategory.findMany({ where: { tenantId }, select: { id: true, key: true } })).map((c) => [c.key, c.id]));
  const existing = new Set((await tx.service.findMany({ where: { tenantId, code: { in: STARTER_SERVICES.map((s) => s.code) } }, select: { code: true } })).map((s) => s.code));
  const created: string[] = [];
  const skipped: string[] = [];

  for (const [index, def] of STARTER_SERVICES.entries()) {
    if (existing.has(def.code)) {
      skipped.push(def.code);
      continue;
    }
    let categoryId = categories.get(def.categoryKey);
    if (!categoryId) {
      // The centre removed a default category: bring it back rather than guessing another one.
      const fallback = DEFAULT_SERVICE_CATEGORIES.find((c) => c.key === def.categoryKey)!;
      const category = await tx.serviceCategory.create({ data: { tenantId, key: fallback.key, name: fallback.name, nameAr: fallback.nameAr, icon: fallback.icon, sortOrder: DEFAULT_SERVICE_CATEGORIES.indexOf(fallback) } });
      categoryId = category.id;
      categories.set(def.categoryKey, categoryId);
    }
    const paymentPolicy = def.paymentPolicy ?? 'BEFORE_PROCESSING';
    const service = await tx.service.create({
      data: {
        tenantId,
        categoryId,
        code: def.code,
        name: def.name,
        nameAr: def.nameAr,
        description: def.description,
        eligibilityGuidance: def.eligibilityGuidance ?? null,
        complianceCapability: def.complianceCapability,
        estimatedProcessingHours: def.estimatedProcessingHours,
        requiresApproval: def.requiresApproval ?? false,
        paymentPolicy,
        depositPercent: paymentPolicy === 'DEPOSIT' ? (def.depositPercent ?? 50) : null,
        taxMode: def.taxMode ?? 'SERVICE_FEE_ONLY',
        onlineAvailable: def.onlineAvailable ?? true,
        isPublic: def.isPublic ?? true,
        isActive: true,
        allBranches: true,
        sortOrder: index,
      },
    });
    await tx.servicePrice.create({
      data: {
        tenantId,
        serviceId: service.id,
        branchId: null,
        serviceFee: def.price.serviceFee,
        governmentFeeEstimate: def.price.governmentFeeEstimate ?? '0',
        thirdPartyFeeEstimate: def.price.thirdPartyFeeEstimate ?? '0',
        currency: tenant.defaultCurrency,
      },
    });
    if (def.requirements.length) {
      await tx.serviceRequirement.createMany({
        data: def.requirements.map((r, sortOrder) => ({
          tenantId,
          serviceId: service.id,
          documentTypeKey: r.documentTypeKey,
          label: r.label,
          labelAr: r.labelAr ?? null,
          description: r.description ?? null,
          isMandatory: r.isMandatory ?? true,
          allowReuse: r.allowReuse ?? true,
          maxAgeDays: r.maxAgeDays ?? null,
          sortOrder,
        })),
      });
    }
    if (def.form) {
      await tx.serviceFormDefinition.create({ data: { tenantId, serviceId: service.id, version: 1, status: 'PUBLISHED', schema: def.form as any, publishedAt: new Date() } });
    }
    created.push(def.code);
  }
  return { created, skipped };
}
