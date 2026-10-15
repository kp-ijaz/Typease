import { NOTIFICATION_EVENTS, NotificationEventKey } from '@typease/types';

export type Channel = 'EMAIL' | 'SMS' | 'WHATSAPP' | 'IN_APP' | 'PUSH';
export const CHANNELS: Channel[] = ['EMAIL', 'SMS', 'WHATSAPP', 'IN_APP', 'PUSH'];
/** Channels that leave the platform through a provider (metered against the plan). */
export const EXTERNAL_CHANNELS: Channel[] = ['EMAIL', 'SMS', 'WHATSAPP', 'PUSH'];
export type Lang = 'en' | 'ar';
export const LANGS: Lang[] = ['en', 'ar'];

/** Preference groups. `security` can never be switched off by a preference. */
/** `security` also covers requests of TypEase support to access the centre: the people who decide must always hear about them. */
export type EventGroup = 'security' | 'account' | 'requests' | 'payments' | 'appointments' | 'reminders' | 'support' | 'billing' | 'reports' | 'marketing';

/**
 * Template keys. Every key of NOTIFICATION_EVENTS has platform defaults; the
 * extra keys are staff-facing variants that need their own wording.
 */
export type TemplateKey = NotificationEventKey | 'request.assigned_to_you';

export interface TemplateText {
  subject?: string;
  body: string;
}
export interface EventDefinition {
  key: TemplateKey;
  label: string;
  group: EventGroup;
  /** Who normally receives it. */
  audience: 'CUSTOMER' | 'STAFF' | 'OWNER' | 'PLATFORM' | 'ANY';
  /** Consent purpose that must be GRANTED for customers (besides channel consent). */
  consent?: 'REMINDERS' | 'MARKETING';
  /** Variables available to the template: name -> meaning. */
  variables: Record<string, string>;
  /** Realistic values for previews. */
  sample: Record<string, string>;
  /** Channels switched on unless the centre changes it in its notification settings. */
  defaultChannels: Channel[];
  templates: Partial<Record<Channel, Record<Lang, TemplateText>>>;
}

/** Variables every template may use; filled from the centre's branding. */
export const COMMON_VARIABLES: Record<string, string> = {
  centreName: 'Name of the typing centre',
  supportEmail: 'Support email address of the centre',
  supportPhone: 'Support phone number of the centre',
};
const COMMON_SAMPLE = { centreName: 'Al Noor Typing Centre', supportEmail: 'support@alnoor.example', supportPhone: '+97140000000' };

const requestVars = {
  customerName: 'Customer name',
  requestNumber: 'Request number, e.g. TE-000123',
  serviceName: 'Name of the service',
  portalLink: 'Link to the request in the customer portal (sign-in required)',
};
const requestSample = { customerName: 'Fatima Al Mansoori', requestNumber: 'TE-000123', serviceName: 'Residence visa renewal', portalLink: 'https://portal.example/requests/123' };
const appointmentVars = {
  customerName: 'Customer or guest name',
  appointmentDate: 'Date of the appointment in the branch time zone',
  appointmentTime: 'Start time in the branch time zone',
  branchName: 'Branch name',
  serviceName: 'Service booked (may be empty)',
  portalLink: 'Link to the appointment in the customer portal (sign-in required; empty for guests)',
};
const appointmentSample = { customerName: 'Fatima Al Mansoori', appointmentDate: '14 Oct 2026', appointmentTime: '10:30', branchName: 'Main Branch', serviceName: 'Emirates ID renewal', portalLink: 'https://portal.example/appointments' };

const def = (d: EventDefinition): EventDefinition => d;

export const EVENT_DEFINITIONS: EventDefinition[] = [
  // ------------------------------------------------------------------ account / security
  def({
    key: 'account.registered',
    label: NOTIFICATION_EVENTS['account.registered'],
    group: 'account',
    audience: 'CUSTOMER',
    variables: { customerName: 'Customer name', portalLink: 'Link to the customer portal' },
    sample: { customerName: 'Fatima Al Mansoori', portalLink: 'https://portal.example/' },
    defaultChannels: ['EMAIL', 'IN_APP'],
    templates: {
      EMAIL: {
        en: { subject: 'Welcome to {{centreName}}', body: 'Hello {{customerName}},\n\nYour account with {{centreName}} is ready. You can submit requests, upload documents and follow their progress online.\n\n[Open your account]({{portalLink}})' },
        ar: { subject: 'مرحباً بك في {{centreName}}', body: 'مرحباً {{customerName}}،\n\nحسابك لدى {{centreName}} جاهز. يمكنك تقديم الطلبات ورفع المستندات ومتابعة حالتها عبر الإنترنت.\n\n[افتح حسابك]({{portalLink}})' },
      },
      IN_APP: {
        en: { subject: 'Welcome', body: 'Your account with {{centreName}} is ready.' },
        ar: { subject: 'مرحباً بك', body: 'حسابك لدى {{centreName}} جاهز.' },
      },
    },
  }),
  def({
    key: 'account.email_verification',
    label: NOTIFICATION_EVENTS['account.email_verification'],
    group: 'security',
    audience: 'ANY',
    variables: { name: 'Name of the person', link: 'One-time verification link' },
    sample: { name: 'Fatima Al Mansoori', link: 'https://portal.example/verify-email?token=sample' },
    defaultChannels: ['EMAIL'],
    templates: {
      EMAIL: {
        en: { subject: 'Confirm your email address', body: 'Hello {{name}},\n\nPlease confirm your email address to activate your account with {{centreName}}.\n\n[Confirm email address]({{link}})\n\nIf you did not create this account, you can ignore this message.' },
        ar: { subject: 'تأكيد عنوان بريدك الإلكتروني', body: 'مرحباً {{name}}،\n\nيرجى تأكيد عنوان بريدك الإلكتروني لتفعيل حسابك لدى {{centreName}}.\n\n[تأكيد البريد الإلكتروني]({{link}})\n\nإذا لم تقم بإنشاء هذا الحساب، يمكنك تجاهل هذه الرسالة.' },
      },
      IN_APP: {
        en: { subject: 'Confirm your email address', body: 'We sent a confirmation link to your email address.' },
        ar: { subject: 'تأكيد عنوان بريدك الإلكتروني', body: 'أرسلنا رابط التأكيد إلى بريدك الإلكتروني.' },
      },
    },
  }),
  def({
    key: 'account.password_reset',
    label: NOTIFICATION_EVENTS['account.password_reset'],
    group: 'security',
    audience: 'ANY',
    variables: { name: 'Name of the person', link: 'One-time password reset link', minutes: 'Minutes until the link expires' },
    sample: { name: 'Fatima Al Mansoori', link: 'https://portal.example/reset-password?token=sample', minutes: '60' },
    defaultChannels: ['EMAIL'],
    templates: {
      EMAIL: {
        en: { subject: 'Reset your password', body: 'Hello {{name}},\n\nWe received a request to reset your password. The link below works for {{minutes}} minutes.\n\n[Choose a new password]({{link}})\n\nIf you did not ask for this, you can ignore this message. Your password stays the same.' },
        ar: { subject: 'إعادة تعيين كلمة المرور', body: 'مرحباً {{name}}،\n\nتلقينا طلباً لإعادة تعيين كلمة المرور الخاصة بك. الرابط أدناه صالح لمدة {{minutes}} دقيقة.\n\n[اختر كلمة مرور جديدة]({{link}})\n\nإذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة وستبقى كلمة المرور كما هي.' },
      },
      IN_APP: {
        en: { subject: 'Password reset requested', body: 'A password reset link was sent to your email address.' },
        ar: { subject: 'طلب إعادة تعيين كلمة المرور', body: 'تم إرسال رابط إعادة تعيين كلمة المرور إلى بريدك الإلكتروني.' },
      },
    },
  }),
  def({
    key: 'account.otp',
    label: NOTIFICATION_EVENTS['account.otp'],
    group: 'security',
    audience: 'ANY',
    variables: { code: 'One-time passcode', minutes: 'Minutes until the code expires' },
    sample: { code: '482913', minutes: '5' },
    defaultChannels: ['SMS', 'EMAIL'],
    templates: {
      EMAIL: {
        en: { subject: 'Your verification code', body: 'Your {{centreName}} verification code is {{code}}.\n\nIt expires in {{minutes}} minutes. Never share this code with anyone.' },
        ar: { subject: 'رمز التحقق الخاص بك', body: 'رمز التحقق الخاص بك لدى {{centreName}} هو {{code}}.\n\nتنتهي صلاحيته خلال {{minutes}} دقائق. لا تشارك هذا الرمز مع أي شخص.' },
      },
      SMS: {
        en: { body: '{{code}} is your {{centreName}} verification code. It expires in {{minutes}} minutes. Do not share it.' },
        ar: { body: '{{code}} هو رمز التحقق الخاص بك لدى {{centreName}}. تنتهي صلاحيته خلال {{minutes}} دقائق. لا تشاركه مع أحد.' },
      },
      WHATSAPP: {
        en: { body: '{{code}} is your verification code. It expires in {{minutes}} minutes.' },
        ar: { body: '{{code}} هو رمز التحقق الخاص بك. تنتهي صلاحيته خلال {{minutes}} دقائق.' },
      },
      IN_APP: {
        en: { subject: 'Verification code sent', body: 'A verification code was sent to your phone.' },
        ar: { subject: 'تم إرسال رمز التحقق', body: 'تم إرسال رمز التحقق إلى هاتفك.' },
      },
    },
  }),
  def({
    key: 'staff.invitation',
    label: NOTIFICATION_EVENTS['staff.invitation'],
    group: 'security',
    audience: 'STAFF',
    variables: { name: 'Name of the invited person', role: 'Role they are invited to', link: 'One-time invitation link', days: 'Days until the invitation expires' },
    sample: { name: 'Omar Khalid', role: 'Receptionist', link: 'https://centre.example/accept-invitation?token=sample', days: '7' },
    defaultChannels: ['EMAIL'],
    templates: {
      EMAIL: {
        en: { subject: 'You are invited to join {{centreName}}', body: 'Hello {{name}},\n\nYou have been invited to join {{centreName}} on TypEase as {{role}}.\n\n[Accept the invitation]({{link}})\n\nThe invitation is valid for {{days}} days.' },
        ar: { subject: 'دعوة للانضمام إلى {{centreName}}', body: 'مرحباً {{name}}،\n\nتمت دعوتك للانضمام إلى {{centreName}} على منصة TypEase بصفة {{role}}.\n\n[قبول الدعوة]({{link}})\n\nالدعوة صالحة لمدة {{days}} أيام.' },
      },
      IN_APP: {
        en: { subject: 'Invitation sent', body: 'An invitation to join {{centreName}} was sent by email.' },
        ar: { subject: 'تم إرسال الدعوة', body: 'تم إرسال دعوة الانضمام إلى {{centreName}} عبر البريد الإلكتروني.' },
      },
    },
  }),

  // ------------------------------------------------------------------ requests
  def({
    key: 'request.created',
    label: NOTIFICATION_EVENTS['request.created'],
    group: 'requests',
    audience: 'CUSTOMER',
    variables: requestVars,
    sample: requestSample,
    defaultChannels: ['EMAIL', 'IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: 'We received your request {{requestNumber}}', body: 'Hello {{customerName}},\n\nThank you. {{centreName}} has received your request {{requestNumber}} for {{serviceName}}. We will let you know when there is an update.\n\n[View your request]({{portalLink}})' },
        ar: { subject: 'استلمنا طلبك رقم {{requestNumber}}', body: 'مرحباً {{customerName}}،\n\nشكراً لك. استلم {{centreName}} طلبك رقم {{requestNumber}} لخدمة {{serviceName}}. سنبلغك عند وجود أي تحديث.\n\n[عرض الطلب]({{portalLink}})' },
      },
      IN_APP: {
        en: { subject: 'Request {{requestNumber}} received', body: 'We received your request for {{serviceName}}.' },
        ar: { subject: 'تم استلام الطلب {{requestNumber}}', body: 'استلمنا طلبك لخدمة {{serviceName}}.' },
      },
    },
  }),
  def({
    key: 'request.documents_missing',
    label: NOTIFICATION_EVENTS['request.documents_missing'],
    group: 'requests',
    audience: 'CUSTOMER',
    variables: { ...requestVars, message: 'What the centre asked for' },
    sample: { ...requestSample, message: 'Please upload a clear copy of your passport (photo page).' },
    defaultChannels: ['EMAIL', 'SMS', 'IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: 'Action needed for request {{requestNumber}}', body: 'Hello {{customerName}},\n\nWe need something from you to continue with request {{requestNumber}} ({{serviceName}}):\n\n{{message}}\n\n[Open your request]({{portalLink}})\n\nFor your security, please upload documents only through the portal.' },
        ar: { subject: 'مطلوب إجراء للطلب رقم {{requestNumber}}', body: 'مرحباً {{customerName}}،\n\nنحتاج منك بعض المعلومات لمتابعة الطلب رقم {{requestNumber}} ({{serviceName}}):\n\n{{message}}\n\n[افتح الطلب]({{portalLink}})\n\nحرصاً على أمانك، يرجى رفع المستندات عبر البوابة فقط.' },
      },
      SMS: {
        en: { body: '{{centreName}}: we need more information for request {{requestNumber}}. Please sign in to your portal: {{portalLink}}' },
        ar: { body: '{{centreName}}: نحتاج معلومات إضافية للطلب رقم {{requestNumber}}. يرجى تسجيل الدخول إلى البوابة: {{portalLink}}' },
      },
      WHATSAPP: {
        en: { body: 'Hello {{customerName}}, we need more information to continue with request {{requestNumber}}. Please sign in to your portal to see the details.' },
        ar: { body: 'مرحباً {{customerName}}، نحتاج معلومات إضافية لمتابعة الطلب رقم {{requestNumber}}. يرجى تسجيل الدخول إلى البوابة للاطلاع على التفاصيل.' },
      },
      IN_APP: {
        en: { subject: 'Action needed: {{requestNumber}}', body: '{{message}}' },
        ar: { subject: 'مطلوب إجراء: {{requestNumber}}', body: '{{message}}' },
      },
    },
  }),
  def({
    key: 'request.staff_assigned',
    label: NOTIFICATION_EVENTS['request.staff_assigned'],
    group: 'requests',
    audience: 'CUSTOMER',
    variables: requestVars,
    sample: requestSample,
    defaultChannels: ['IN_APP'],
    templates: {
      EMAIL: {
        en: { subject: 'Your request {{requestNumber}} is being handled', body: 'Hello {{customerName}},\n\nA member of our team is now working on your request {{requestNumber}} ({{serviceName}}).\n\n[View your request]({{portalLink}})' },
        ar: { subject: 'جارٍ العمل على طلبك رقم {{requestNumber}}', body: 'مرحباً {{customerName}}،\n\nيعمل أحد أعضاء فريقنا الآن على طلبك رقم {{requestNumber}} ({{serviceName}}).\n\n[عرض الطلب]({{portalLink}})' },
      },
      IN_APP: {
        en: { subject: 'Request {{requestNumber}} assigned', body: 'A member of our team is now working on your request.' },
        ar: { subject: 'تم إسناد الطلب {{requestNumber}}', body: 'يعمل أحد أعضاء فريقنا الآن على طلبك.' },
      },
    },
  }),
  def({
    key: 'request.assigned_to_you',
    label: 'Request assigned to a staff member',
    group: 'requests',
    audience: 'STAFF',
    variables: { staffName: 'Name of the staff member', requestNumber: 'Request number', serviceName: 'Name of the service', customerName: 'Customer name', centreLink: 'Link to the request in the centre application' },
    sample: { staffName: 'Omar Khalid', requestNumber: 'TE-000123', serviceName: 'Residence visa renewal', customerName: 'Fatima Al Mansoori', centreLink: 'https://centre.example/requests/123' },
    defaultChannels: ['IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: 'Request {{requestNumber}} was assigned to you', body: 'Hello {{staffName}},\n\nRequest {{requestNumber}} ({{serviceName}}) for {{customerName}} was assigned to you.\n\n[Open the request]({{centreLink}})' },
        ar: { subject: 'تم إسناد الطلب رقم {{requestNumber}} إليك', body: 'مرحباً {{staffName}}،\n\nتم إسناد الطلب رقم {{requestNumber}} ({{serviceName}}) للعميل {{customerName}} إليك.\n\n[افتح الطلب]({{centreLink}})' },
      },
      IN_APP: {
        en: { subject: 'New assignment: {{requestNumber}}', body: '{{serviceName}} for {{customerName}} was assigned to you.' },
        ar: { subject: 'مهمة جديدة: {{requestNumber}}', body: 'تم إسناد {{serviceName}} للعميل {{customerName}} إليك.' },
      },
    },
  }),
  def({
    key: 'request.status_changed',
    label: NOTIFICATION_EVENTS['request.status_changed'],
    group: 'requests',
    audience: 'CUSTOMER',
    variables: { ...requestVars, statusLabel: 'New status in customer-friendly words', customerMessage: 'Optional note from the centre' },
    sample: { ...requestSample, statusLabel: 'Being prepared', customerMessage: '' },
    defaultChannels: ['EMAIL', 'IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: 'Update on your request {{requestNumber}}: {{statusLabel}}', body: 'Hello {{customerName}},\n\nThe status of your request {{requestNumber}} ({{serviceName}}) is now: {{statusLabel}}.\n\n{{customerMessage}}\n\n[View your request]({{portalLink}})' },
        ar: { subject: 'تحديث على طلبك رقم {{requestNumber}}: {{statusLabel}}', body: 'مرحباً {{customerName}}،\n\nحالة طلبك رقم {{requestNumber}} ({{serviceName}}) الآن: {{statusLabel}}.\n\n{{customerMessage}}\n\n[عرض الطلب]({{portalLink}})' },
      },
      SMS: {
        en: { body: '{{centreName}}: request {{requestNumber}} is now "{{statusLabel}}". Details: {{portalLink}}' },
        ar: { body: '{{centreName}}: حالة الطلب رقم {{requestNumber}} الآن "{{statusLabel}}". التفاصيل: {{portalLink}}' },
      },
      WHATSAPP: {
        en: { body: 'Hello {{customerName}}, the status of your request {{requestNumber}} is now: {{statusLabel}}.' },
        ar: { body: 'مرحباً {{customerName}}، حالة طلبك رقم {{requestNumber}} الآن: {{statusLabel}}.' },
      },
      IN_APP: {
        en: { subject: '{{requestNumber}}: {{statusLabel}}', body: 'Your request for {{serviceName}} was updated. {{customerMessage}}' },
        ar: { subject: '{{requestNumber}}: {{statusLabel}}', body: 'تم تحديث طلبك لخدمة {{serviceName}}. {{customerMessage}}' },
      },
    },
  }),
  def({
    key: 'request.completed',
    label: NOTIFICATION_EVENTS['request.completed'],
    group: 'requests',
    audience: 'CUSTOMER',
    variables: requestVars,
    sample: requestSample,
    defaultChannels: ['EMAIL', 'SMS', 'IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: 'Your request {{requestNumber}} is complete', body: 'Hello {{customerName}},\n\nGood news: your request {{requestNumber}} ({{serviceName}}) is complete.\n\nSign in to your portal to see the result and download your documents securely.\n\n[Open your request]({{portalLink}})\n\nThank you for choosing {{centreName}}.' },
        ar: { subject: 'اكتمل طلبك رقم {{requestNumber}}', body: 'مرحباً {{customerName}}،\n\nخبر سار: اكتمل طلبك رقم {{requestNumber}} ({{serviceName}}).\n\nسجّل الدخول إلى البوابة للاطلاع على النتيجة وتنزيل مستنداتك بأمان.\n\n[افتح الطلب]({{portalLink}})\n\nشكراً لاختيارك {{centreName}}.' },
      },
      SMS: {
        en: { body: '{{centreName}}: your request {{requestNumber}} is complete. Sign in to view it: {{portalLink}}' },
        ar: { body: '{{centreName}}: اكتمل طلبك رقم {{requestNumber}}. سجّل الدخول للاطلاع عليه: {{portalLink}}' },
      },
      WHATSAPP: {
        en: { body: 'Hello {{customerName}}, your request {{requestNumber}} is complete. Please sign in to your portal to view the result.' },
        ar: { body: 'مرحباً {{customerName}}، اكتمل طلبك رقم {{requestNumber}}. يرجى تسجيل الدخول إلى البوابة للاطلاع على النتيجة.' },
      },
      IN_APP: {
        en: { subject: 'Request {{requestNumber}} completed', body: 'Your request for {{serviceName}} is complete.' },
        ar: { subject: 'اكتمل الطلب {{requestNumber}}', body: 'اكتمل طلبك لخدمة {{serviceName}}.' },
      },
    },
  }),

  // ------------------------------------------------------------------ money
  def({
    key: 'quotation.ready',
    label: NOTIFICATION_EVENTS['quotation.ready'],
    group: 'payments',
    audience: 'CUSTOMER',
    variables: { customerName: 'Customer name', quotationNumber: 'Quotation number', requestNumber: 'Related request number (may be empty)', amount: 'Total amount', currency: 'Currency code', validUntil: 'Date until which the quotation is valid (may be empty)', portalLink: 'Link to the quotation in the customer portal (sign-in required)' },
    sample: { customerName: 'Fatima Al Mansoori', quotationNumber: 'QUO-000045', requestNumber: 'TE-000123', amount: '525.00', currency: 'AED', validUntil: '21 Oct 2026', portalLink: 'https://portal.example/quotations/45' },
    defaultChannels: ['EMAIL', 'SMS', 'IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: 'Your quotation {{quotationNumber}} is ready', body: 'Hello {{customerName}},\n\nYour quotation {{quotationNumber}} from {{centreName}} is ready. Total: {{amount}} {{currency}}.\n\nPlease review and approve it in your portal so that we can continue.\n\n[Review the quotation]({{portalLink}})' },
        ar: { subject: 'عرض السعر رقم {{quotationNumber}} جاهز', body: 'مرحباً {{customerName}}،\n\nعرض السعر رقم {{quotationNumber}} من {{centreName}} جاهز. الإجمالي: {{amount}} {{currency}}.\n\nيرجى مراجعته والموافقة عليه عبر البوابة حتى نتمكن من المتابعة.\n\n[مراجعة عرض السعر]({{portalLink}})' },
      },
      SMS: {
        en: { body: '{{centreName}}: quotation {{quotationNumber}} for {{amount}} {{currency}} is ready. Review it here: {{portalLink}}' },
        ar: { body: '{{centreName}}: عرض السعر رقم {{quotationNumber}} بقيمة {{amount}} {{currency}} جاهز. راجعه هنا: {{portalLink}}' },
      },
      WHATSAPP: {
        en: { body: 'Hello {{customerName}}, your quotation {{quotationNumber}} for {{amount}} {{currency}} is ready. Please sign in to your portal to review it.' },
        ar: { body: 'مرحباً {{customerName}}، عرض السعر رقم {{quotationNumber}} بقيمة {{amount}} {{currency}} جاهز. يرجى تسجيل الدخول إلى البوابة لمراجعته.' },
      },
      IN_APP: {
        en: { subject: 'Quotation {{quotationNumber}} ready', body: 'Total {{amount}} {{currency}}. Review and approve it to continue.' },
        ar: { subject: 'عرض السعر {{quotationNumber}} جاهز', body: 'الإجمالي {{amount}} {{currency}}. راجعه ووافق عليه للمتابعة.' },
      },
    },
  }),
  def({
    key: 'payment.requested',
    label: NOTIFICATION_EVENTS['payment.requested'],
    group: 'payments',
    audience: 'CUSTOMER',
    variables: { customerName: 'Customer name', invoiceNumber: 'Invoice number', requestNumber: 'Related request number (may be empty)', amount: 'Amount to pay', currency: 'Currency code', dueDate: 'Due date (may be empty)', portalLink: 'Link to the invoice in the customer portal (sign-in required)' },
    sample: { customerName: 'Fatima Al Mansoori', invoiceNumber: 'INV-000078', requestNumber: 'TE-000123', amount: '525.00', currency: 'AED', dueDate: '16 Oct 2026', portalLink: 'https://portal.example/invoices/78' },
    defaultChannels: ['EMAIL', 'SMS', 'IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: 'Payment requested: invoice {{invoiceNumber}}', body: 'Hello {{customerName}},\n\n{{centreName}} is requesting a payment of {{amount}} {{currency}} for invoice {{invoiceNumber}}.\n\n[View and pay the invoice]({{portalLink}})\n\nYou can also pay at the centre. If you have already paid, please ignore this message.' },
        ar: { subject: 'طلب دفع: الفاتورة رقم {{invoiceNumber}}', body: 'مرحباً {{customerName}}،\n\nيطلب {{centreName}} دفع مبلغ {{amount}} {{currency}} للفاتورة رقم {{invoiceNumber}}.\n\n[عرض الفاتورة والدفع]({{portalLink}})\n\nيمكنك أيضاً الدفع في المركز. إذا كنت قد دفعت بالفعل، يرجى تجاهل هذه الرسالة.' },
      },
      SMS: {
        en: { body: '{{centreName}}: payment of {{amount}} {{currency}} requested for invoice {{invoiceNumber}}. Pay securely: {{portalLink}}' },
        ar: { body: '{{centreName}}: مطلوب دفع {{amount}} {{currency}} للفاتورة رقم {{invoiceNumber}}. ادفع بأمان: {{portalLink}}' },
      },
      WHATSAPP: {
        en: { body: 'Hello {{customerName}}, a payment of {{amount}} {{currency}} is requested for invoice {{invoiceNumber}}. Please sign in to your portal to pay.' },
        ar: { body: 'مرحباً {{customerName}}، مطلوب دفع مبلغ {{amount}} {{currency}} للفاتورة رقم {{invoiceNumber}}. يرجى تسجيل الدخول إلى البوابة للدفع.' },
      },
      IN_APP: {
        en: { subject: 'Payment requested', body: '{{amount}} {{currency}} for invoice {{invoiceNumber}}.' },
        ar: { subject: 'طلب دفع', body: '{{amount}} {{currency}} للفاتورة رقم {{invoiceNumber}}.' },
      },
    },
  }),
  def({
    key: 'invoice.reminder',
    label: NOTIFICATION_EVENTS['invoice.reminder'],
    group: 'payments',
    audience: 'CUSTOMER',
    variables: {
      customerName: 'Customer name',
      invoiceNumber: 'Invoice number',
      amount: 'Balance still to pay',
      currency: 'Currency code',
      dueDate: 'Due date',
      daysOverdue: 'Days since the due date (0 on the due date, negative before it)',
      portalLink: 'Link to the invoice in the portal, where it can be paid online (sign-in required)',
    },
    sample: { customerName: 'Fatima Al Mansoori', invoiceNumber: 'INV-000078', amount: '525.00', currency: 'AED', dueDate: '16 Oct 2026', daysOverdue: '3', portalLink: 'https://portal.example/invoices/78' },
    defaultChannels: ['EMAIL', 'SMS', 'IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: 'Reminder: invoice {{invoiceNumber}} is unpaid', body: 'Hello {{customerName}},\n\nThis is a friendly reminder that invoice {{invoiceNumber}} from {{centreName}} has a balance of {{amount}} {{currency}}, due on {{dueDate}}.\n\n[View and pay the invoice]({{portalLink}})\n\nYou can also pay at the centre. If you have paid in the meantime, thank you, and please ignore this message.' },
        ar: { subject: 'تذكير: الفاتورة {{invoiceNumber}} غير مدفوعة', body: 'مرحباً {{customerName}}،\n\nنذكّرك بأن الفاتورة {{invoiceNumber}} من {{centreName}} عليها رصيد بقيمة {{amount}} {{currency}}، وتاريخ استحقاقها {{dueDate}}.\n\n[عرض الفاتورة والدفع]({{portalLink}})\n\nيمكنك أيضاً الدفع في المركز. إذا كنت قد دفعت في هذه الأثناء فشكراً لك، ويرجى تجاهل هذه الرسالة.' },
      },
      SMS: {
        en: { body: '{{centreName}}: invoice {{invoiceNumber}} has {{amount}} {{currency}} unpaid (due {{dueDate}}). Pay securely: {{portalLink}}' },
        ar: { body: '{{centreName}}: الفاتورة {{invoiceNumber}} عليها {{amount}} {{currency}} غير مدفوعة (الاستحقاق {{dueDate}}). ادفع بأمان: {{portalLink}}' },
      },
      WHATSAPP: {
        en: { body: 'Hello {{customerName}}, a reminder from {{centreName}}: invoice {{invoiceNumber}} has {{amount}} {{currency}} unpaid, due {{dueDate}}. You can pay online here: {{portalLink}}' },
        ar: { body: 'مرحباً {{customerName}}، تذكير من {{centreName}}: الفاتورة {{invoiceNumber}} عليها {{amount}} {{currency}} غير مدفوعة، تاريخ الاستحقاق {{dueDate}}. يمكنك الدفع عبر الإنترنت من هنا: {{portalLink}}' },
      },
      IN_APP: {
        en: { subject: 'Invoice {{invoiceNumber}} is unpaid', body: '{{amount}} {{currency}} due on {{dueDate}}. Tap to pay.' },
        ar: { subject: 'الفاتورة {{invoiceNumber}} غير مدفوعة', body: '{{amount}} {{currency}} مستحقة في {{dueDate}}. اضغط للدفع.' },
      },
    },
  }),
  def({
    key: 'renewal.offer',
    label: NOTIFICATION_EVENTS['renewal.offer'],
    group: 'reminders',
    audience: 'CUSTOMER',
    variables: {
      customerName: 'Customer name',
      documentName: 'The expiring document',
      expiryDate: 'Expiry date of the document',
      serviceName: 'The renewal service',
      amount: 'Total to pay',
      currency: 'Currency code',
      renewLink: 'One-tap link: see the price, approve and pay (no sign-in needed)',
    },
    sample: { customerName: 'Fatima Al Mansoori', documentName: 'Emirates ID - Fatima Al Mansoori', expiryDate: '12 Nov 2026', serviceName: 'Emirates ID renewal', amount: '370.00', currency: 'AED', renewLink: 'https://portal.example/renew?t=...' },
    defaultChannels: ['WHATSAPP', 'EMAIL', 'SMS', 'IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: 'Your {{documentName}} expires on {{expiryDate}}: renewal ready', body: 'Hello {{customerName}},\n\nYour {{documentName}} expires on {{expiryDate}}. {{centreName}} has prepared the renewal ({{serviceName}}) for you: {{amount}} {{currency}} in total.\n\n[See the price, approve and pay]({{renewLink}})\n\nOne tap is enough - no sign-in needed. If you do not want to renew with us, you can decline on the same page.' },
        ar: { subject: 'تنتهي صلاحية {{documentName}} في {{expiryDate}}: التجديد جاهز', body: 'مرحباً {{customerName}}،\n\nتنتهي صلاحية {{documentName}} في {{expiryDate}}. جهّز لك {{centreName}} طلب التجديد ({{serviceName}}) بإجمالي {{amount}} {{currency}}.\n\n[عرض السعر والموافقة والدفع]({{renewLink}})\n\nضغطة واحدة تكفي - دون تسجيل دخول. إذا لم ترغب في التجديد معنا يمكنك الرفض من الصفحة نفسها.' },
      },
      SMS: {
        en: { body: '{{centreName}}: your {{documentName}} expires {{expiryDate}}. Renewal ready, {{amount}} {{currency}}. Approve & pay: {{renewLink}}' },
        ar: { body: '{{centreName}}: تنتهي صلاحية {{documentName}} في {{expiryDate}}. التجديد جاهز بقيمة {{amount}} {{currency}}. وافق وادفع: {{renewLink}}' },
      },
      WHATSAPP: {
        en: { body: 'Hello {{customerName}}, your {{documentName}} expires on {{expiryDate}}. {{centreName}} has prepared the renewal ({{serviceName}}): {{amount}} {{currency}}. Approve and pay in one tap, no sign-in needed: {{renewLink}}' },
        ar: { body: 'مرحباً {{customerName}}، تنتهي صلاحية {{documentName}} في {{expiryDate}}. جهّز {{centreName}} طلب التجديد ({{serviceName}}) بقيمة {{amount}} {{currency}}. وافق وادفع بضغطة واحدة دون تسجيل دخول: {{renewLink}}' },
      },
      IN_APP: {
        en: { subject: 'Renewal ready: {{documentName}}', body: 'Expires {{expiryDate}}. {{amount}} {{currency}}. Tap to approve and pay.' },
        ar: { subject: 'التجديد جاهز: {{documentName}}', body: 'تنتهي في {{expiryDate}}. {{amount}} {{currency}}. اضغط للموافقة والدفع.' },
      },
    },
  }),
  def({
    key: 'paperwork.sign',
    label: NOTIFICATION_EVENTS['paperwork.sign'],
    group: 'requests',
    audience: 'CUSTOMER',
    variables: {
      customerName: 'Customer name',
      documentTitle: 'The document (for example "Salary Certificate")',
      documentNumber: 'Document number',
      signLink: 'Link to read and sign the document (signed, expiring; no sign-in needed)',
    },
    sample: { customerName: 'Fatima Al Mansoori', documentTitle: 'Salary Certificate', documentNumber: 'DOC-000012', signLink: 'https://portal.example/sign?t=...' },
    defaultChannels: ['WHATSAPP', 'EMAIL', 'SMS', 'IN_APP'],
    templates: {
      EMAIL: {
        en: { subject: 'Please sign: {{documentTitle}} ({{documentNumber}})', body: 'Hello {{customerName}},\n\n{{centreName}} has prepared your {{documentTitle}}. Please read it and sign it on your phone or computer:\n\n[Read and sign]({{signLink}})\n\nIf anything is wrong, do not sign: reply to us and we will correct it.' },
        ar: { subject: 'يرجى التوقيع: {{documentTitle}} ({{documentNumber}})', body: 'مرحباً {{customerName}}،\n\nجهّز {{centreName}} مستندك: {{documentTitle}}. يرجى قراءته وتوقيعه من هاتفك أو حاسوبك:\n\n[القراءة والتوقيع]({{signLink}})\n\nإذا كان هناك أي خطأ فلا توقّع، وراسلنا لنصححه.' },
      },
      SMS: {
        en: { body: '{{centreName}}: your {{documentTitle}} is ready to sign: {{signLink}}' },
        ar: { body: '{{centreName}}: مستندك {{documentTitle}} جاهز للتوقيع: {{signLink}}' },
      },
      WHATSAPP: {
        en: { body: 'Hello {{customerName}}, {{centreName}} has prepared your {{documentTitle}} ({{documentNumber}}). Read and sign it here: {{signLink}}' },
        ar: { body: 'مرحباً {{customerName}}، جهّز {{centreName}} مستندك {{documentTitle}} ({{documentNumber}}). اقرأه ووقّعه من هنا: {{signLink}}' },
      },
      IN_APP: {
        en: { subject: 'Ready to sign: {{documentTitle}}', body: 'Tap to read and sign {{documentNumber}}.' },
        ar: { subject: 'جاهز للتوقيع: {{documentTitle}}', body: 'اضغط لقراءة وتوقيع {{documentNumber}}.' },
      },
    },
  }),
  def({
    key: 'request.stage_overdue',
    label: NOTIFICATION_EVENTS['request.stage_overdue'],
    group: 'requests',
    audience: 'STAFF',
    variables: {
      name: 'Name of the staff member who is told',
      requestNumber: 'Request number',
      stage: 'The board column (status)',
      waited: 'How long it has been there, in hours',
      limit: 'The time limit of the column, in hours',
      centreLink: 'Link to the request in the centre application',
    },
    sample: { name: 'Priya Nair', requestNumber: 'AN-000123', stage: 'Under review', waited: '5.5', limit: '4', centreLink: 'https://centre.example/requests/123' },
    defaultChannels: ['IN_APP', 'PUSH', 'EMAIL'],
    templates: {
      EMAIL: {
        en: { subject: '{{requestNumber}} is waiting too long in "{{stage}}"', body: 'Hello {{name}},\n\n{{requestNumber}} has been in "{{stage}}" for {{waited}} hours. The limit for this column is {{limit}} hours.\n\n[Open the request]({{centreLink}})' },
        ar: { subject: 'الطلب {{requestNumber}} ينتظر طويلاً في «{{stage}}»', body: 'مرحباً {{name}}،\n\nالطلب {{requestNumber}} في «{{stage}}» منذ {{waited}} ساعة، والحد المسموح لهذا العمود {{limit}} ساعة.\n\n[فتح الطلب]({{centreLink}})' },
      },
      IN_APP: {
        en: { subject: '{{requestNumber}}: over the time limit', body: '"{{stage}}" for {{waited}} h (limit {{limit}} h).' },
        ar: { subject: '{{requestNumber}}: تجاوز الحد الزمني', body: '«{{stage}}» منذ {{waited}} ساعة (الحد {{limit}} ساعة).' },
      },
      PUSH: {
        en: { subject: '{{requestNumber}}: over the time limit', body: '"{{stage}}" for {{waited}} h (limit {{limit}} h).' },
        ar: { subject: '{{requestNumber}}: تجاوز الحد الزمني', body: '«{{stage}}» منذ {{waited}} ساعة (الحد {{limit}} ساعة).' },
      },
    },
  }),
  def({
    key: 'cash.variance',
    label: NOTIFICATION_EVENTS['cash.variance'],
    group: 'payments',
    audience: 'STAFF',
    variables: {
      name: 'Name of the manager who is told',
      shiftNumber: 'Shift number',
      cashierName: 'Cashier who closed the shift',
      expectedCash: 'Cash the drawer should have held',
      countedCash: 'Cash that was counted',
      difference: 'Counted minus expected (negative = short)',
      currency: 'Currency code',
      centreLink: 'Link to the shift in the centre application',
    },
    sample: { name: 'Omar Khalid', shiftNumber: 'SH-000042', cashierName: 'Maria Santos', expectedCash: '2450.00', countedCash: '2400.00', difference: '-50.00', currency: 'AED', centreLink: 'https://centre.example/cash?shift=42' },
    defaultChannels: ['IN_APP', 'EMAIL'],
    templates: {
      EMAIL: {
        en: { subject: 'Cash difference on shift {{shiftNumber}}: {{difference}} {{currency}}', body: 'Hello {{name}},\n\n{{cashierName}} closed shift {{shiftNumber}} with a cash difference.\n\nExpected in the drawer: {{expectedCash}} {{currency}}\nCounted: {{countedCash}} {{currency}}\nDifference: {{difference}} {{currency}}\n\n[Review the shift]({{centreLink}})' },
        ar: { subject: 'فرق نقدي في الوردية {{shiftNumber}}: {{difference}} {{currency}}', body: 'مرحباً {{name}}،\n\nأغلق {{cashierName}} الوردية {{shiftNumber}} مع وجود فرق نقدي.\n\nالمتوقع في الدرج: {{expectedCash}} {{currency}}\nالمعدود: {{countedCash}} {{currency}}\nالفرق: {{difference}} {{currency}}\n\n[مراجعة الوردية]({{centreLink}})' },
      },
      IN_APP: {
        en: { subject: 'Cash difference: {{difference}} {{currency}}', body: '{{cashierName}} closed {{shiftNumber}}: expected {{expectedCash}}, counted {{countedCash}}.' },
        ar: { subject: 'فرق نقدي: {{difference}} {{currency}}', body: 'أغلق {{cashierName}} الوردية {{shiftNumber}}: المتوقع {{expectedCash}}، المعدود {{countedCash}}.' },
      },
    },
  }),
  def({
    key: 'payment.received',
    label: NOTIFICATION_EVENTS['payment.received'],
    group: 'payments',
    audience: 'CUSTOMER',
    variables: { customerName: 'Customer name', receiptNumber: 'Receipt or payment number', amount: 'Amount received', currency: 'Currency code', portalLink: 'Link to payments in the customer portal (sign-in required)' },
    sample: { customerName: 'Fatima Al Mansoori', receiptNumber: 'RCT-000091', amount: '525.00', currency: 'AED', portalLink: 'https://portal.example/payments' },
    defaultChannels: ['EMAIL', 'SMS', 'IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: 'Payment received: {{amount}} {{currency}}', body: 'Hello {{customerName}},\n\nThank you. {{centreName}} received your payment of {{amount}} {{currency}}. Reference: {{receiptNumber}}.\n\n[View your payments]({{portalLink}})' },
        ar: { subject: 'تم استلام الدفعة: {{amount}} {{currency}}', body: 'مرحباً {{customerName}}،\n\nشكراً لك. استلم {{centreName}} دفعتك بمبلغ {{amount}} {{currency}}. المرجع: {{receiptNumber}}.\n\n[عرض مدفوعاتك]({{portalLink}})' },
      },
      SMS: {
        en: { body: '{{centreName}}: we received your payment of {{amount}} {{currency}}. Ref {{receiptNumber}}. Thank you.' },
        ar: { body: '{{centreName}}: استلمنا دفعتك بمبلغ {{amount}} {{currency}}. المرجع {{receiptNumber}}. شكراً لك.' },
      },
      WHATSAPP: {
        en: { body: 'Hello {{customerName}}, we received your payment of {{amount}} {{currency}}. Reference: {{receiptNumber}}. Thank you.' },
        ar: { body: 'مرحباً {{customerName}}، استلمنا دفعتك بمبلغ {{amount}} {{currency}}. المرجع: {{receiptNumber}}. شكراً لك.' },
      },
      IN_APP: {
        en: { subject: 'Payment received', body: '{{amount}} {{currency}} — reference {{receiptNumber}}.' },
        ar: { subject: 'تم استلام الدفعة', body: '{{amount}} {{currency}} — المرجع {{receiptNumber}}.' },
      },
    },
  }),

  // ------------------------------------------------------------------ appointments
  def({
    key: 'appointment.confirmation',
    label: NOTIFICATION_EVENTS['appointment.confirmation'],
    group: 'appointments',
    audience: 'CUSTOMER',
    variables: appointmentVars,
    sample: appointmentSample,
    defaultChannels: ['EMAIL', 'SMS', 'IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: 'Appointment confirmed: {{appointmentDate}} at {{appointmentTime}}', body: 'Hello {{customerName}},\n\nYour appointment at {{centreName}} ({{branchName}}) is booked for {{appointmentDate}} at {{appointmentTime}}.\n\n{{serviceName}}\n\nPlease arrive a few minutes early and bring your original documents.\n\n[Manage your appointment]({{portalLink}})' },
        ar: { subject: 'تأكيد الموعد: {{appointmentDate}} الساعة {{appointmentTime}}', body: 'مرحباً {{customerName}}،\n\nتم حجز موعدك لدى {{centreName}} ({{branchName}}) بتاريخ {{appointmentDate}} الساعة {{appointmentTime}}.\n\n{{serviceName}}\n\nيرجى الحضور قبل الموعد بدقائق وإحضار المستندات الأصلية.\n\n[إدارة الموعد]({{portalLink}})' },
      },
      SMS: {
        en: { body: '{{centreName}}: your appointment at {{branchName}} is booked for {{appointmentDate}} at {{appointmentTime}}.' },
        ar: { body: '{{centreName}}: تم حجز موعدك في {{branchName}} بتاريخ {{appointmentDate}} الساعة {{appointmentTime}}.' },
      },
      WHATSAPP: {
        en: { body: 'Hello {{customerName}}, your appointment at {{branchName}} is booked for {{appointmentDate}} at {{appointmentTime}}.' },
        ar: { body: 'مرحباً {{customerName}}، تم حجز موعدك في {{branchName}} بتاريخ {{appointmentDate}} الساعة {{appointmentTime}}.' },
      },
      IN_APP: {
        en: { subject: 'Appointment booked', body: '{{appointmentDate}} at {{appointmentTime}} — {{branchName}}.' },
        ar: { subject: 'تم حجز الموعد', body: '{{appointmentDate}} الساعة {{appointmentTime}} — {{branchName}}.' },
      },
    },
  }),
  def({
    key: 'appointment.reminder',
    label: NOTIFICATION_EVENTS['appointment.reminder'],
    group: 'appointments',
    audience: 'CUSTOMER',
    variables: appointmentVars,
    sample: appointmentSample,
    defaultChannels: ['EMAIL', 'SMS', 'IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: 'Reminder: appointment on {{appointmentDate}} at {{appointmentTime}}', body: 'Hello {{customerName}},\n\nThis is a reminder of your appointment at {{centreName}} ({{branchName}}) on {{appointmentDate}} at {{appointmentTime}}.\n\nIf you cannot attend, please reschedule or cancel so that someone else can use the slot.\n\n[Manage your appointment]({{portalLink}})' },
        ar: { subject: 'تذكير: موعد بتاريخ {{appointmentDate}} الساعة {{appointmentTime}}', body: 'مرحباً {{customerName}}،\n\nنذكّرك بموعدك لدى {{centreName}} ({{branchName}}) بتاريخ {{appointmentDate}} الساعة {{appointmentTime}}.\n\nإذا تعذّر عليك الحضور، يرجى تغيير الموعد أو إلغاؤه ليستفيد منه شخص آخر.\n\n[إدارة الموعد]({{portalLink}})' },
      },
      SMS: {
        en: { body: '{{centreName}} reminder: appointment at {{branchName}} on {{appointmentDate}} at {{appointmentTime}}.' },
        ar: { body: 'تذكير من {{centreName}}: موعدك في {{branchName}} بتاريخ {{appointmentDate}} الساعة {{appointmentTime}}.' },
      },
      WHATSAPP: {
        en: { body: 'Hello {{customerName}}, a reminder of your appointment at {{branchName}} on {{appointmentDate}} at {{appointmentTime}}.' },
        ar: { body: 'مرحباً {{customerName}}، نذكّرك بموعدك في {{branchName}} بتاريخ {{appointmentDate}} الساعة {{appointmentTime}}.' },
      },
      IN_APP: {
        en: { subject: 'Appointment reminder', body: '{{appointmentDate}} at {{appointmentTime}} — {{branchName}}.' },
        ar: { subject: 'تذكير بالموعد', body: '{{appointmentDate}} الساعة {{appointmentTime}} — {{branchName}}.' },
      },
    },
  }),

  // ------------------------------------------------------------------ document expiry
  def({
    key: 'document.expiry',
    label: NOTIFICATION_EVENTS['document.expiry'],
    group: 'reminders',
    audience: 'CUSTOMER',
    consent: 'REMINDERS',
    variables: {
      recipientName: 'Name of the customer or company contact',
      documentName: 'Document type, e.g. Passport',
      subjectLabel: 'Whose document it is',
      expiryDate: 'Expiry date according to the centre records',
      daysLeft: 'Days until the expiry date',
      renewalLink: 'Link to start a renewal request in the portal (sign-in required)',
    },
    sample: { recipientName: 'Fatima Al Mansoori', documentName: 'Passport', subjectLabel: 'Fatima Al Mansoori', expiryDate: '8 Jan 2027', daysLeft: '90', renewalLink: 'https://portal.example/requests/new?renewalOf=sample' },
    defaultChannels: ['EMAIL', 'SMS', 'IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: '{{documentName}} expires on {{expiryDate}} according to our records', body: 'Hello {{recipientName}},\n\nAccording to our records, the {{documentName}} for {{subjectLabel}} expires on {{expiryDate}} (in {{daysLeft}} days).\n\nIf you would like {{centreName}} to help with the renewal, you can start a request online.\n\n[Start a renewal request]({{renewalLink}})\n\nThis is a courtesy reminder based on the date we have on file. Please check the document itself and the issuing authority for the exact dates and requirements. If it has already been renewed, you can ignore this message.' },
        ar: { subject: 'تنتهي صلاحية {{documentName}} بتاريخ {{expiryDate}} وفقاً لسجلاتنا', body: 'مرحباً {{recipientName}}،\n\nوفقاً لسجلاتنا، تنتهي صلاحية {{documentName}} الخاص بـ {{subjectLabel}} بتاريخ {{expiryDate}} (خلال {{daysLeft}} يوماً).\n\nإذا رغبت في أن يساعدك {{centreName}} في التجديد، يمكنك بدء طلب عبر الإنترنت.\n\n[بدء طلب تجديد]({{renewalLink}})\n\nهذا تذكير ودّي مبني على التاريخ المسجل لدينا. يرجى مراجعة المستند نفسه والجهة المصدرة للتأكد من التواريخ والمتطلبات. إذا تم التجديد بالفعل، يمكنك تجاهل هذه الرسالة.' },
      },
      SMS: {
        en: { body: '{{centreName}}: according to our records, the {{documentName}} for {{subjectLabel}} expires on {{expiryDate}}. Need help renewing? {{renewalLink}}' },
        ar: { body: '{{centreName}}: وفقاً لسجلاتنا، تنتهي صلاحية {{documentName}} الخاص بـ {{subjectLabel}} بتاريخ {{expiryDate}}. للمساعدة في التجديد: {{renewalLink}}' },
      },
      WHATSAPP: {
        en: { body: 'Hello {{recipientName}}, according to our records the {{documentName}} for {{subjectLabel}} expires on {{expiryDate}}. Sign in to your portal if you would like help with the renewal.' },
        ar: { body: 'مرحباً {{recipientName}}، وفقاً لسجلاتنا تنتهي صلاحية {{documentName}} الخاص بـ {{subjectLabel}} بتاريخ {{expiryDate}}. سجّل الدخول إلى البوابة إذا رغبت في المساعدة في التجديد.' },
      },
      IN_APP: {
        en: { subject: '{{documentName}} expires on {{expiryDate}}', body: 'According to our records, the {{documentName}} for {{subjectLabel}} expires in {{daysLeft}} days.' },
        ar: { subject: 'تنتهي صلاحية {{documentName}} بتاريخ {{expiryDate}}', body: 'وفقاً لسجلاتنا، تنتهي صلاحية {{documentName}} الخاص بـ {{subjectLabel}} خلال {{daysLeft}} يوماً.' },
      },
    },
  }),

  // ------------------------------------------------------------------ rejected documents
  def({
    key: 'document.rejected',
    label: NOTIFICATION_EVENTS['document.rejected'],
    group: 'requests',
    audience: 'CUSTOMER',
    variables: {
      recipientName: 'Name of the customer or of the company administrator',
      documentName: 'Document type, e.g. Passport',
      requestNumber: 'Request the document belongs to ("-" for a document outside a request)',
      reason: 'Why the centre could not accept the document',
      portalLink: 'Link to the request, or to the documents, in the portal the person signs in to (sign-in required)',
    },
    sample: { recipientName: 'Fatima Al Mansoori', documentName: 'Passport', requestNumber: 'TE-000123', reason: 'The photo page is cut off. Please upload a complete copy.', portalLink: 'https://portal.example/requests/123' },
    defaultChannels: ['EMAIL', 'IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: 'Please send your {{documentName}} again', body: 'Hello {{recipientName}},\n\n{{centreName}} could not accept the {{documentName}} that was uploaded.\n\nRequest: {{requestNumber}}\nReason: {{reason}}\n\nPlease upload a new copy so that we can continue.\n\n[Upload a new copy]({{portalLink}})\n\nFor your security, please upload documents only through the portal.' },
        ar: { subject: 'يرجى إرسال {{documentName}} مرة أخرى', body: 'مرحباً {{recipientName}}،\n\nلم يتمكن {{centreName}} من قبول {{documentName}} الذي تم رفعه.\n\nالطلب: {{requestNumber}}\nالسبب: {{reason}}\n\nيرجى رفع نسخة جديدة لنتمكن من المتابعة.\n\n[رفع نسخة جديدة]({{portalLink}})\n\nحرصاً على أمانك، يرجى رفع المستندات عبر البوابة فقط.' },
      },
      SMS: {
        en: { body: '{{centreName}}: we could not accept the {{documentName}} you uploaded. Please sign in and upload a new copy: {{portalLink}}' },
        ar: { body: '{{centreName}}: لم نتمكن من قبول {{documentName}} الذي رفعته. يرجى تسجيل الدخول ورفع نسخة جديدة: {{portalLink}}' },
      },
      IN_APP: {
        en: { subject: '{{documentName}} was not accepted', body: '{{reason}}' },
        ar: { subject: 'لم يتم قبول {{documentName}}', body: '{{reason}}' },
      },
    },
  }),

  // ------------------------------------------------------------------ SaaS billing (centre owners)
  def({
    key: 'subscription.renewal',
    label: NOTIFICATION_EVENTS['subscription.renewal'],
    group: 'billing',
    audience: 'OWNER',
    variables: { name: 'Name of the centre owner', planName: 'Subscription plan', amount: 'Renewal amount', currency: 'Currency code', renewalDate: 'Renewal date', centreLink: 'Link to the subscription page in the centre application' },
    sample: { name: 'Omar Khalid', planName: 'Professional', amount: '349.00', currency: 'AED', renewalDate: '1 Nov 2026', centreLink: 'https://centre.example/settings/subscription' },
    defaultChannels: ['EMAIL', 'IN_APP'],
    templates: {
      EMAIL: {
        en: { subject: 'Your TypEase subscription renews on {{renewalDate}}', body: 'Hello {{name}},\n\nThe TypEase subscription of {{centreName}} ({{planName}}) renews on {{renewalDate}} for {{amount}} {{currency}}.\n\n[Review your subscription]({{centreLink}})' },
        ar: { subject: 'يتجدد اشتراكك في TypEase بتاريخ {{renewalDate}}', body: 'مرحباً {{name}}،\n\nيتجدد اشتراك {{centreName}} في TypEase ({{planName}}) بتاريخ {{renewalDate}} بمبلغ {{amount}} {{currency}}.\n\n[مراجعة الاشتراك]({{centreLink}})' },
      },
      IN_APP: {
        en: { subject: 'Subscription renews on {{renewalDate}}', body: '{{planName}} — {{amount}} {{currency}}.' },
        ar: { subject: 'يتجدد الاشتراك بتاريخ {{renewalDate}}', body: '{{planName}} — {{amount}} {{currency}}.' },
      },
    },
  }),
  def({
    key: 'subscription.payment_failed',
    label: NOTIFICATION_EVENTS['subscription.payment_failed'],
    group: 'billing',
    audience: 'OWNER',
    variables: { name: 'Name of the centre owner', planName: 'Subscription plan', amount: 'Amount that could not be collected', currency: 'Currency code', reason: 'Reason reported by the payment provider (may be empty)', centreLink: 'Link to the subscription page in the centre application' },
    sample: { name: 'Omar Khalid', planName: 'Professional', amount: '349.00', currency: 'AED', reason: 'The card was declined.', centreLink: 'https://centre.example/settings/subscription' },
    defaultChannels: ['EMAIL', 'IN_APP'],
    templates: {
      EMAIL: {
        en: { subject: 'We could not collect your TypEase subscription payment', body: 'Hello {{name}},\n\nThe subscription payment of {{amount}} {{currency}} for {{centreName}} could not be collected.\n\n{{reason}}\n\nPlease update your payment method to keep your centre running without interruption.\n\n[Update payment method]({{centreLink}})' },
        ar: { subject: 'تعذّر تحصيل دفعة اشتراكك في TypEase', body: 'مرحباً {{name}}،\n\nتعذّر تحصيل دفعة الاشتراك بمبلغ {{amount}} {{currency}} الخاصة بـ {{centreName}}.\n\n{{reason}}\n\nيرجى تحديث وسيلة الدفع لضمان استمرار عمل مركزك دون انقطاع.\n\n[تحديث وسيلة الدفع]({{centreLink}})' },
      },
      IN_APP: {
        en: { subject: 'Subscription payment failed', body: 'We could not collect {{amount}} {{currency}}. Please update your payment method.' },
        ar: { subject: 'فشل دفع الاشتراك', body: 'تعذّر تحصيل {{amount}} {{currency}}. يرجى تحديث وسيلة الدفع.' },
      },
    },
  }),

  // ------------------------------------------------------------------ support / reports
  def({
    key: 'support.response',
    label: NOTIFICATION_EVENTS['support.response'],
    group: 'support',
    audience: 'ANY',
    variables: { recipientName: 'Name of the person who opened the ticket', ticketNumber: 'Ticket number', ticketSubject: 'Subject of the ticket', teamName: 'Who replied (the centre, or TypEase Support)', portalLink: 'Link to the ticket (sign-in required)' },
    sample: { recipientName: 'Fatima Al Mansoori', ticketNumber: 'TKT-000012', ticketSubject: 'Question about my visa request', teamName: 'Al Noor Typing Centre', portalLink: 'https://portal.example/support/12' },
    defaultChannels: ['EMAIL', 'IN_APP', 'PUSH'],
    templates: {
      EMAIL: {
        en: { subject: 'New reply to your ticket {{ticketNumber}}', body: 'Hello {{recipientName}},\n\n{{teamName}} replied to your support ticket {{ticketNumber}} ("{{ticketSubject}}").\n\nFor your privacy the reply is shown only after you sign in.\n\n[Read the reply]({{portalLink}})' },
        ar: { subject: 'رد جديد على تذكرتك رقم {{ticketNumber}}', body: 'مرحباً {{recipientName}}،\n\nقام {{teamName}} بالرد على تذكرة الدعم رقم {{ticketNumber}} ("{{ticketSubject}}").\n\nحفاظاً على خصوصيتك، يظهر الرد بعد تسجيل الدخول فقط.\n\n[قراءة الرد]({{portalLink}})' },
      },
      IN_APP: {
        en: { subject: 'Reply to ticket {{ticketNumber}}', body: '{{teamName}} replied to "{{ticketSubject}}".' },
        ar: { subject: 'رد على التذكرة {{ticketNumber}}', body: 'قام {{teamName}} بالرد على "{{ticketSubject}}".' },
      },
    },
  }),
  def({
    key: 'report.scheduled',
    label: NOTIFICATION_EVENTS['report.scheduled'],
    group: 'reports',
    audience: 'STAFF',
    variables: { name: 'Name of the recipient', reportName: 'Name of the report', periodLabel: 'Period covered by the report', centreLink: 'Link to the report in the centre application (sign-in required)' },
    sample: { name: 'Omar Khalid', reportName: 'Monthly revenue', periodLabel: 'September 2026', centreLink: 'https://centre.example/reports' },
    defaultChannels: ['EMAIL', 'IN_APP'],
    templates: {
      EMAIL: {
        en: { subject: '{{reportName}} is ready ({{periodLabel}})', body: 'Hello {{name}},\n\nYour scheduled report "{{reportName}}" for {{periodLabel}} is ready.\n\n[Open the report]({{centreLink}})\n\nReports are available only after you sign in.' },
        ar: { subject: 'تقرير {{reportName}} جاهز ({{periodLabel}})', body: 'مرحباً {{name}}،\n\nتقريرك المجدول "{{reportName}}" للفترة {{periodLabel}} جاهز.\n\n[افتح التقرير]({{centreLink}})\n\nالتقارير متاحة بعد تسجيل الدخول فقط.' },
      },
      IN_APP: {
        en: { subject: '{{reportName}} is ready', body: 'The report for {{periodLabel}} is ready.' },
        ar: { subject: 'تقرير {{reportName}} جاهز', body: 'التقرير الخاص بالفترة {{periodLabel}} جاهز.' },
      },
    },
  }),

  // ------------------------------------------------------------------ support access (TypEase support asks, the centre decides)
  def({
    key: 'support_access.requested',
    label: NOTIFICATION_EVENTS['support_access.requested'],
    // A security matter: it cannot be switched off by a personal preference and does not use the plan allowance.
    group: 'security',
    audience: 'OWNER',
    variables: {
      name: 'Name of the person who may decide (holds "Approve or deny TypEase support access")',
      requesterName: 'Name of the TypEase support staff member who asks',
      reason: 'The reason they gave',
      durationMinutes: 'How many minutes of access they ask for',
      accessKind: 'What the access allows, in words, worked out from the permissions asked for: "read-only access", or read access plus writing internal notes on requests',
      centreLink: 'Link to the support-access screen of the centre application (sign-in required)',
    },
    sample: { name: 'Omar Khalid', requesterName: 'Layla Haddad', reason: 'A customer reports that an invoice PDF cannot be opened', durationMinutes: '60', accessKind: 'read-only access', centreLink: 'https://centre.example/settings?tab=support' },
    defaultChannels: ['EMAIL', 'IN_APP'],
    templates: {
      EMAIL: {
        en: {
          subject: 'TypEase support is asking for access to {{centreName}}',
          body: 'Hello {{name}},\n\n{{requesterName}} from TypEase support has asked for access to {{centreName}} for {{durationMinutes}} minutes.\n\nWhat they ask for: {{accessKind}}.\nReason given: {{reason}}\n\nNobody at TypEase can see the data of your centre unless you approve. You can approve the request, give less than was asked for, or deny it, and you can end the access at any time.\n\n[Review the request]({{centreLink}})',
        },
        ar: {
          subject: 'فريق دعم TypEase يطلب الوصول إلى {{centreName}}',
          body: 'مرحباً {{name}}،\n\nطلب {{requesterName}} من فريق دعم TypEase الوصول إلى {{centreName}} لمدة {{durationMinutes}} دقيقة.\n\nما يطلبه: {{accessKind}}.\nالسبب المذكور: {{reason}}\n\nلا يستطيع أي شخص في TypEase الاطلاع على بيانات مركزك إلا بموافقتك. يمكنك الموافقة على الطلب أو منح أقل مما طُلب أو رفضه، ويمكنك إنهاء الوصول في أي وقت.\n\n[مراجعة الطلب]({{centreLink}})',
        },
      },
      IN_APP: {
        en: { subject: 'Support access requested', body: '{{requesterName}} from TypEase support asks for {{durationMinutes}} minutes of access: {{accessKind}}. Your decision is needed.' },
        ar: { subject: 'طلب وصول من فريق الدعم', body: 'يطلب {{requesterName}} من فريق دعم TypEase الوصول لمدة {{durationMinutes}} دقيقة: {{accessKind}}. بانتظار قرارك.' },
      },
    },
  }),
  def({
    key: 'support_access.decided',
    label: NOTIFICATION_EVENTS['support_access.decided'],
    group: 'security',
    // Sent to the TypEase staff member who asked, with the platform's own template and provider (email only).
    audience: 'PLATFORM',
    variables: {
      name: 'Name of the TypEase staff member who asked',
      tenantName: 'Name of the centre that decided',
      decision: 'What happened to the request, in words: approved, denied or ended',
      details: 'Until when the access is valid, or how it ended, and the note of the centre if there is one',
      consoleLink: 'Link to the access requests in the platform console (sign-in required)',
    },
    sample: { name: 'Layla Haddad', tenantName: 'Al Noor Typing Centre', decision: 'approved', details: 'The access is valid until 2026-10-14 10:30 (UTC).', consoleLink: 'https://console.example/access-requests' },
    defaultChannels: ['EMAIL'],
    templates: {
      EMAIL: {
        en: { subject: 'Support access to {{tenantName}}: {{decision}}', body: 'Hello {{name}},\n\nYour request for support access to {{tenantName}} was {{decision}}.\n\n{{details}}\n\n[Open your access requests]({{consoleLink}})' },
        ar: { subject: 'وصول الدعم إلى {{tenantName}}: {{decision}}', body: 'مرحباً {{name}}،\n\nطلبك للحصول على وصول الدعم إلى {{tenantName}}: {{decision}}.\n\n{{details}}\n\n[افتح طلبات الوصول]({{consoleLink}})' },
      },
      IN_APP: {
        en: { subject: 'Support access {{decision}}', body: 'Your request for support access to {{tenantName}} was {{decision}}.' },
        ar: { subject: 'وصول الدعم: {{decision}}', body: 'طلبك للحصول على وصول الدعم إلى {{tenantName}}: {{decision}}.' },
      },
    },
  }),
];

const BY_KEY = new Map(EVENT_DEFINITIONS.map((d) => [d.key as string, d]));

export function eventDefinition(key: string): EventDefinition | undefined {
  return BY_KEY.get(key);
}
/** Preference group of an event. Tenant-defined keys starting with "marketing." need marketing consent. */
export function eventGroup(key: string): EventGroup {
  const d = BY_KEY.get(key);
  if (d) return d.group;
  return key.startsWith('marketing.') ? 'marketing' : 'requests';
}
export function requiredConsent(key: string): 'REMINDERS' | 'MARKETING' | undefined {
  const d = BY_KEY.get(key);
  if (d) return d.consent;
  return key.startsWith('marketing.') ? 'MARKETING' : undefined;
}
/** Account-security messages must always be delivered: they bypass preferences and plan limits. */
export const isSecurityEvent = (key: string) => eventGroup(key) === 'security';
export const sampleData = (key: string): Record<string, string> => ({ ...COMMON_SAMPLE, ...(BY_KEY.get(key)?.sample ?? {}) });
export const allowedVariables = (key: string): string[] => [...Object.keys(COMMON_VARIABLES), ...Object.keys(BY_KEY.get(key)?.variables ?? {})];

/** Variables whose values are secrets: never stored in clear text or shown in the delivery log. */
export const SECRET_VARIABLES = ['link', 'code', 'token', 'otp', 'password'];

/** Human-readable names for the "from" side of a template row. */
export const templateName = (key: string, channel: Channel, lang: Lang) => `${BY_KEY.get(key)?.label ?? key} (${channel.toLowerCase().replace('_', '-')}, ${lang})`;

/**
 * Earlier built-in wordings that were wrong and have been replaced. The provisioning step never overwrites a
 * platform default that somebody edited - but a stored row that still carries exactly one of these texts was
 * never edited, so it is brought up to date (see TemplateService.seedDefaults).
 *
 * support_access.requested: said "read-only access" whatever was asked for, also when the request included
 * writing internal notes on requests. The wording now comes from the requested permissions ({{accessKind}}).
 */
export const SUPERSEDED_DEFAULTS: Array<{ eventKey: TemplateKey; channel: Channel; language: Lang; subject: string | null; body: string }> = [
  { eventKey: 'support_access.requested', channel: 'EMAIL', language: 'en', subject: 'TypEase support is asking for access to {{centreName}}', body: 'Hello {{name}},\n\n{{requesterName}} from TypEase support has asked for {{durationMinutes}} minutes of read-only access to {{centreName}}.\n\nReason given: {{reason}}\n\nNobody at TypEase can see the data of your centre unless you approve. You can approve the request, give less than was asked for, or deny it, and you can end the access at any time.\n\n[Review the request]({{centreLink}})' },
  { eventKey: 'support_access.requested', channel: 'EMAIL', language: 'ar', subject: 'فريق دعم TypEase يطلب الوصول إلى {{centreName}}', body: 'مرحباً {{name}}،\n\nطلب {{requesterName}} من فريق دعم TypEase وصولاً للقراءة فقط إلى {{centreName}} لمدة {{durationMinutes}} دقيقة.\n\nالسبب المذكور: {{reason}}\n\nلا يستطيع أي شخص في TypEase الاطلاع على بيانات مركزك إلا بموافقتك. يمكنك الموافقة على الطلب أو منح أقل مما طُلب أو رفضه، ويمكنك إنهاء الوصول في أي وقت.\n\n[مراجعة الطلب]({{centreLink}})' },
  { eventKey: 'support_access.requested', channel: 'IN_APP', language: 'en', subject: 'Support access requested', body: '{{requesterName}} from TypEase support asks for {{durationMinutes}} minutes of read-only access. Your decision is needed.' },
  { eventKey: 'support_access.requested', channel: 'IN_APP', language: 'ar', subject: 'طلب وصول من فريق الدعم', body: 'يطلب {{requesterName}} من فريق دعم TypEase وصولاً للقراءة فقط لمدة {{durationMinutes}} دقيقة. بانتظار قرارك.' },
];

/** Flat list of platform default templates (seeded by the provisioning step). */
export function defaultTemplateRows(): Array<{ eventKey: string; channel: Channel; language: Lang; name: string; subject: string | null; body: string }> {
  const rows: Array<{ eventKey: string; channel: Channel; language: Lang; name: string; subject: string | null; body: string }> = [];
  for (const d of EVENT_DEFINITIONS) {
    for (const channel of CHANNELS) {
      const perLang = d.templates[channel];
      if (!perLang) continue;
      for (const language of LANGS) {
        const t = perLang[language];
        rows.push({ eventKey: d.key, channel, language, name: templateName(d.key, channel, language), subject: t.subject ?? null, body: t.body });
      }
    }
  }
  return rows;
}
