import type { TemplateField } from '@typease/validation';

/**
 * Templates every centre starts with. Centres edit the wording; placeholders in double braces are filled from the
 * customer's record ({{customer.*}}), the centre ({{centre.name}}), today's date ({{today}}) and the fields below.
 * These are typing templates, not legal advice: the centre and the parties are responsible for the content.
 */
export interface BuiltInTemplate {
  key: string;
  kind: 'SALARY_CERTIFICATE' | 'NOC' | 'CONTRACT' | 'LETTER';
  name: string;
  nameAr: string;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  fields: TemplateField[];
  requiresSignature: boolean;
}

const f = (key: string, label: string, labelAr: string, type: TemplateField['type'] = 'text', required = true): TemplateField => ({ key, label, labelAr, type, required });

export const BUILT_IN_TEMPLATES: BuiltInTemplate[] = [
  {
    key: 'salary_certificate',
    kind: 'SALARY_CERTIFICATE',
    name: 'Salary certificate',
    nameAr: 'شهادة راتب',
    titleEn: 'Salary Certificate',
    titleAr: 'شهادة راتب',
    fields: [
      f('employerName', 'Employer (company name)', 'جهة العمل (اسم الشركة)'),
      f('designation', 'Designation', 'المسمى الوظيفي'),
      f('joiningDate', 'Joining date', 'تاريخ الالتحاق', 'date'),
      f('monthlySalary', 'Total monthly salary (AED)', 'إجمالي الراتب الشهري (درهم)', 'money'),
      f('addressedTo', 'Addressed to', 'موجهة إلى'),
      f('purpose', 'Purpose', 'الغرض'),
    ],
    requiresSignature: true,
    bodyEn: [
      'To: {{addressedTo}}',
      '',
      'This is to certify that {{customer.fullName}}, a national of {{customer.nationality}}, holder of passport number {{customer.passportNo}}, is employed with {{employerName}} as {{designation}} since {{joiningDate}}.',
      '',
      '{{customer.fullName}} receives a total monthly salary of AED {{monthlySalary}}.',
      '',
      'This certificate is issued at the request of the employee for the purpose of {{purpose}}, without any liability on the part of the company.',
      '',
      'Date: {{today}}',
    ].join('\n'),
    bodyAr: [
      'إلى: {{addressedTo}}',
      '',
      'نشهد بأن {{customer.fullNameAr}}، الجنسية: {{customer.nationality}}، ويحمل جواز سفر رقم {{customer.passportNo}}، يعمل لدى {{employerName}} بوظيفة {{designation}} منذ {{joiningDate}}.',
      '',
      'ويتقاضى راتباً شهرياً إجمالياً قدره {{monthlySalary}} درهم.',
      '',
      'أُعطيت هذه الشهادة بناءً على طلب الموظف لغرض {{purpose}}، دون أدنى مسؤولية على الشركة.',
      '',
      'التاريخ: {{today}}',
    ].join('\n'),
  },
  {
    key: 'noc',
    kind: 'NOC',
    name: 'No objection certificate (NOC)',
    nameAr: 'شهادة عدم ممانعة',
    titleEn: 'No Objection Certificate',
    titleAr: 'شهادة عدم ممانعة',
    fields: [
      f('issuerName', 'Issued by (company or sponsor)', 'صادرة عن (الشركة أو الكفيل)'),
      f('relationship', 'Relationship to the issuer', 'صفة العلاقة بالجهة المصدرة'),
      f('addressedTo', 'Addressed to', 'موجهة إلى'),
      f('noObjectionTo', 'No objection to (what)', 'عدم الممانعة في (ماذا)', 'textarea'),
    ],
    requiresSignature: true,
    bodyEn: [
      'To: {{addressedTo}}',
      '',
      'We, {{issuerName}}, hereby confirm that {{customer.fullName}}, a national of {{customer.nationality}}, holder of passport number {{customer.passportNo}} and Emirates ID number {{customer.emiratesId}}, is our {{relationship}}.',
      '',
      'We have no objection to {{noObjectionTo}}.',
      '',
      'This certificate is issued at the request of the above-named person without any liability on our part.',
      '',
      'Date: {{today}}',
    ].join('\n'),
    bodyAr: [
      'إلى: {{addressedTo}}',
      '',
      'نحن {{issuerName}} نفيد بأن {{customer.fullNameAr}}، الجنسية: {{customer.nationality}}، ويحمل جواز سفر رقم {{customer.passportNo}} وهوية إماراتية رقم {{customer.emiratesId}}، هو {{relationship}} لدينا.',
      '',
      'ولا مانع لدينا من {{noObjectionTo}}.',
      '',
      'أُعطيت هذه الشهادة بناءً على طلب المذكور أعلاه دون أدنى مسؤولية علينا.',
      '',
      'التاريخ: {{today}}',
    ].join('\n'),
  },
  {
    key: 'employment_contract',
    kind: 'CONTRACT',
    name: 'Employment contract (typing draft)',
    nameAr: 'عقد عمل (مسودة طباعة)',
    titleEn: 'Employment Contract',
    titleAr: 'عقد عمل',
    fields: [
      f('employerName', 'Employer', 'صاحب العمل'),
      f('employerAddress', 'Employer address', 'عنوان صاحب العمل'),
      f('designation', 'Position', 'الوظيفة'),
      f('startDate', 'Start date', 'تاريخ بدء العمل', 'date'),
      f('basicSalary', 'Basic monthly salary (AED)', 'الراتب الأساسي الشهري (درهم)', 'money'),
      f('allowances', 'Monthly allowances (AED)', 'البدلات الشهرية (درهم)', 'money', false),
      f('probationMonths', 'Probation (months)', 'فترة التجربة (بالأشهر)', 'number'),
      f('workingHours', 'Working hours per day', 'ساعات العمل اليومية', 'number'),
      f('annualLeaveDays', 'Annual leave (days)', 'الإجازة السنوية (أيام)', 'number'),
    ],
    requiresSignature: true,
    bodyEn: [
      'This contract is made on {{today}} between {{employerName}}, {{employerAddress}} ("the Employer"), and {{customer.fullName}}, a national of {{customer.nationality}}, passport number {{customer.passportNo}} ("the Employee").',
      '',
      '1. Position. The Employee is employed as {{designation}} from {{startDate}}.',
      '2. Salary. A basic monthly salary of AED {{basicSalary}} and monthly allowances of AED {{allowances}}, paid through the Wage Protection System.',
      '3. Probation. The first {{probationMonths}} months are a probation period.',
      '4. Working hours. {{workingHours}} hours per day, in line with the applicable labour law.',
      '5. Leave. {{annualLeaveDays}} days of paid annual leave per year of service.',
      '6. Law. Matters not covered here follow the UAE labour law in force.',
      '',
      'This typed draft does not replace the official contract that must be registered with the competent authority where required.',
    ].join('\n'),
    bodyAr: [
      'حُرر هذا العقد بتاريخ {{today}} بين {{employerName}}، {{employerAddress}} ("صاحب العمل")، و{{customer.fullNameAr}}، الجنسية: {{customer.nationality}}، جواز سفر رقم {{customer.passportNo}} ("العامل").',
      '',
      '1. الوظيفة: يعمل العامل بوظيفة {{designation}} اعتباراً من {{startDate}}.',
      '2. الراتب: راتب أساسي شهري قدره {{basicSalary}} درهم وبدلات شهرية قدرها {{allowances}} درهم، تُدفع عبر نظام حماية الأجور.',
      '3. فترة التجربة: أول {{probationMonths}} أشهر فترة تجربة.',
      '4. ساعات العمل: {{workingHours}} ساعات يومياً وفقاً لقانون العمل المعمول به.',
      '5. الإجازات: {{annualLeaveDays}} يوماً إجازة سنوية مدفوعة عن كل سنة خدمة.',
      '6. القانون: ما لم يرد فيه نص يخضع لقانون العمل الإماراتي النافذ.',
      '',
      'هذه المسودة المطبوعة لا تغني عن العقد الرسمي الواجب تسجيله لدى الجهة المختصة عند الاقتضاء.',
    ].join('\n'),
  },
  {
    key: 'experience_letter',
    kind: 'LETTER',
    name: 'Experience letter',
    nameAr: 'شهادة خبرة',
    titleEn: 'Experience Certificate',
    titleAr: 'شهادة خبرة',
    fields: [
      f('employerName', 'Employer', 'جهة العمل'),
      f('designation', 'Last position', 'آخر وظيفة'),
      f('joiningDate', 'Joining date', 'تاريخ الالتحاق', 'date'),
      f('lastWorkingDate', 'Last working day', 'آخر يوم عمل', 'date'),
    ],
    requiresSignature: true,
    bodyEn: [
      'To whom it may concern,',
      '',
      'This is to certify that {{customer.fullName}}, a national of {{customer.nationality}}, holder of passport number {{customer.passportNo}}, worked with {{employerName}} as {{designation}} from {{joiningDate}} to {{lastWorkingDate}}.',
      '',
      'During this period the employee performed the duties entrusted to them. We wish them every success.',
      '',
      'Date: {{today}}',
    ].join('\n'),
    bodyAr: [
      'إلى من يهمه الأمر،',
      '',
      'نشهد بأن {{customer.fullNameAr}}، الجنسية: {{customer.nationality}}، ويحمل جواز سفر رقم {{customer.passportNo}}، عمل لدى {{employerName}} بوظيفة {{designation}} من {{joiningDate}} حتى {{lastWorkingDate}}.',
      '',
      'وقد أدى خلال هذه الفترة المهام الموكلة إليه، ونتمنى له التوفيق.',
      '',
      'التاريخ: {{today}}',
    ].join('\n'),
  },
];
