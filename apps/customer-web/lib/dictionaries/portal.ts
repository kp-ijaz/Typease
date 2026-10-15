import type { Dictionary } from '@typease/ui/server';

/**
 * Strings of the signed-in part of the customer portal, English and Arabic side by side.
 * Everything here lives under the `my.` namespace: t('my.requests.search').
 *
 * Each text is written once as a pair [English, Arabic], so the two languages can never
 * drift apart: `portalEn` and `portalAr` are derived from the same tree and always have
 * exactly the same keys (also checked by packages/ui/src/i18n/apps.test.ts).
 * A plural entry is written with `plural({ one, other }, { zero, one, two, few, many, other })`.
 *
 * Written for customers: plain verbs, sentence case, say what happens next.
 */
type Pair = readonly [en: string, ar: string];
interface PluralPair {
  readonly __plural: readonly [Dictionary, Dictionary];
}
interface Tree {
  readonly [key: string]: Pair | PluralPair | Tree;
}
const plural = (en: { one: string; other: string }, ar: { zero: string; one: string; two: string; few: string; many: string; other: string }): PluralPair => ({ __plural: [en, ar] });

function side(tree: Tree, index: 0 | 1): Dictionary {
  const out: Dictionary = {};
  for (const [key, value] of Object.entries(tree)) {
    if (Array.isArray(value)) out[key] = (value as unknown as Pair)[index];
    else if ('__plural' in value) out[key] = (value as PluralPair).__plural[index];
    else out[key] = side(value as Tree, index);
  }
  return out;
}

// ------------------------------------------------------------------ shared

const common: Tree = {
  you: ['You', 'أنت'],
  source: ['Source', 'المصدر'],
  attachment: ['Attachment', 'مرفق'],
  pdf: ['Download PDF', 'تنزيل PDF'],
};

const shell: Tree = {
  unreadNotifications: plural(
    { one: 'Notifications, 1 unread', other: 'Notifications, {count} unread' },
    {
      zero: 'الإشعارات',
      one: 'الإشعارات، إشعار واحد غير مقروء',
      two: 'الإشعارات، إشعاران غير مقروءين',
      few: 'الإشعارات، {count} إشعارات غير مقروءة',
      many: 'الإشعارات، {count} إشعارًا غير مقروء',
      other: 'الإشعارات، {count} إشعار غير مقروء',
    },
  ),
  shortcuts: ['More in your account', 'المزيد في حسابك'],
};

// ------------------------------------------------------------------ requests

const requests: Tree = {
  search: ['Search by request number', 'ابحث برقم الطلب'],
  columns: {
    service: ['Service', 'الخدمة'],
    status: ['Status', 'الحالة'],
    number: ['Request number', 'رقم الطلب'],
    created: ['Requested', 'تاريخ الطلب'],
    payment: ['Payment', 'الدفع'],
  },
  filter: {
    label: ['Show', 'عرض'],
    waiting: ['Waiting for you', 'بانتظارك'],
    progress: ['In progress', 'قيد التنفيذ'],
    completed: ['Completed', 'مكتملة'],
    cancelled: ['Cancelled', 'ملغاة'],
  },
};

const form: Tree = {
  prefilled: ['From your profile – please check', 'من ملفك – يُرجى التحقق'],
  errors: {
    number: ['Enter a number', 'أدخل رقمًا'],
    format: ['This is not in the expected format', 'الصيغة غير صحيحة'],
    chooseMin: ['Choose at least {count}', 'اختر {count} على الأقل'],
    chooseMax: ['Choose at most {count}', 'اختر {count} على الأكثر'],
  },
};

const price: Tree = {
  title: ['Fees', 'الرسوم'],
  total: ['Total', 'الإجمالي'],
  fixedNote: ['You see the exact amount in your quotation before you pay.', 'ستجد المبلغ الدقيق في عرض السعر قبل أن تدفع.'],
  freeNote: ['There is no fee for this service.', 'لا توجد رسوم على هذه الخدمة.'],
  policy: {
    BEFORE_PROCESSING: ['Payment is due before the centre starts.', 'يُستحق الدفع قبل أن يبدأ المركز العمل.'],
    DEPOSIT: ['A deposit of {percent}% is due before the centre starts; the rest when your request is completed.', 'تُستحق دفعة مقدمة بنسبة {percent}% قبل أن يبدأ المركز العمل، والباقي عند اكتمال طلبك.'],
    AFTER_COMPLETION: ['You pay when your request is completed.', 'تدفع عند اكتمال طلبك.'],
  },
};

const next: Tree = {
  title: ['What happens next', 'ماذا يحدث بعد ذلك'],
  check: ['We check your details and documents. If something is missing or unclear, we tell you exactly what.', 'نراجع بياناتك ومستنداتك. إذا كان هناك شيء ناقص أو غير واضح نخبرك به تحديدًا.'],
  quotation: ['You receive a quotation with the exact amount. Nothing is charged before you approve it.', 'يصلك عرض سعر بالمبلغ الدقيق. لا يُخصم أي مبلغ قبل موافقتك عليه.'],
  pay: {
    BEFORE_PROCESSING: ['You pay online or at the centre. Then we start working on your request.', 'تدفع عبر الإنترنت أو في المركز، ثم نبدأ العمل على طلبك.'],
    DEPOSIT: ['You pay a deposit online or at the centre, then we start. The rest is due when your request is completed.', 'تدفع دفعة مقدمة عبر الإنترنت أو في المركز ثم نبدأ العمل. ويُستحق الباقي عند اكتمال طلبك.'],
    AFTER_COMPLETION: ['We start working on your request. You pay when it is completed.', 'نبدأ العمل على طلبك، وتدفع عند اكتماله.'],
  },
  work: {
    DOCUMENT_PREPARATION_ONLY: ['We prepare and type your documents and hand them to you. You submit them to the authority yourself.', 'نجهّز مستنداتك ونطبعها ونسلّمها لك. وتقدّمها أنت بنفسك إلى الجهة المختصة.'],
    INFORMATIONAL_ONLY: ['We explain the requirements and help you prepare. The application itself is made by you with the authority.', 'نوضّح لك المتطلبات ونساعدك في التحضير. أما الطلب نفسه فتقدّمه أنت لدى الجهة المختصة.'],
    PARTNER_COORDINATION: ['We prepare your file and pass it to an authorised partner who handles the submission. We show you every update we receive.', 'نجهّز ملفك ونسلّمه إلى شريك معتمد يتولى التقديم. ونعرض لك كل تحديث يصلنا.'],
    DIRECT_AUTHORISED: ['We prepare your file and submit it through the channels the centre is authorised to use. The authority decides.', 'نجهّز ملفك ونقدّمه عبر القنوات المصرّح للمركز باستخدامها. والقرار للجهة المختصة.'],
  },
  follow: ['You can follow every step here, and we send you a message when something changes.', 'يمكنك متابعة كل خطوة هنا، ونرسل لك رسالة عند أي تغيير.'],
};

const wizard: Tree = {
  intro: ['Choose a service, fill in the details and add your documents. Your progress is saved as a draft.', 'اختر الخدمة وأدخل البيانات وأضف مستنداتك. يُحفظ تقدمك كمسودة.'],
  draftSaved: ['Draft {number}. Everything you enter is saved; you can finish later on any device.', 'المسودة {number}. يُحفظ كل ما تدخله، ويمكنك الإكمال لاحقًا من أي جهاز.'],
  draftBadge: ['Draft', 'مسودة'],
  draftMissingTitle: ['We could not find this draft', 'لم نعثر على هذه المسودة'],
  draftMissingText: ['It may have been discarded or submitted already. Your requests are listed under My requests.', 'ربما حُذفت أو أُرسلت من قبل. تجد طلباتك في صفحة طلباتي.'],
  alreadySubmittedTitle: ['This request was already submitted', 'تم إرسال هذا الطلب من قبل'],
  alreadySubmittedText: ['Request {number} is with the centre. Open it to follow its progress.', 'الطلب {number} لدى المركز. افتحه لمتابعة سيره.'],
  openRequest: ['Open my request', 'فتح طلبي'],
  saveLater: ['Save and finish later', 'حفظ والإكمال لاحقًا'],
  discard: ['Discard this draft', 'حذف هذه المسودة'],
  discardTitle: ['Discard this draft?', 'هل تريد حذف هذه المسودة؟'],
  discardText: ['Draft {number} is cancelled and what you entered is no longer used. This cannot be undone.', 'ستُلغى المسودة {number} ولن يُستخدم ما أدخلته. لا يمكن التراجع عن ذلك.'],
  discardReason: ['Draft discarded by the customer', 'حذف العميل المسودة'],
  discarded: ['Draft {number} discarded', 'تم حذف المسودة {number}'],
  steps: {
    service: ['Service', 'الخدمة'],
    details: ['Details', 'البيانات'],
    documents: ['Documents', 'المستندات'],
    review: ['Review', 'المراجعة'],
  },
  service: {
    title: ['Which service do you need?', 'ما الخدمة التي تحتاجها؟'],
    noneTitle: ['No service can be requested online yet', 'لا توجد خدمات متاحة للطلب عبر الإنترنت بعد'],
    noneText: ['Contact the centre or visit a branch to start a request.', 'تواصل مع المركز أو زر أحد الفروع لبدء طلب.'],
    other: ['Choose another service', 'اختيار خدمة أخرى'],
    renewalTitle: ['Renewal', 'تجديد'],
    renewalText: ['This request is for renewing your {document}, which expires on {date} according to our records.', 'هذا الطلب لتجديد {document} الذي ينتهي في {date} حسب سجلاتنا.'],
    reuseNote: ['If a valid copy is already on your file, you can reuse it instead of uploading it again.', 'إذا كانت لديك نسخة سارية في ملفك يمكنك إعادة استخدامها بدل رفعها من جديد.'],
    branch: ['Branch', 'الفرع'],
    branchHint: ['The branch that handles your request and where you collect documents.', 'الفرع الذي يتولى طلبك وتستلم منه المستندات.'],
    start: ['Start this request', 'ابدأ هذا الطلب'],
    startHint: ['Nothing is sent to the centre yet. You can review everything before you submit.', 'لن يُرسل شيء إلى المركز الآن. يمكنك مراجعة كل شيء قبل الإرسال.'],
  },
  details: {
    title: ['Your details', 'بياناتك'],
    text: ['Fill in what the centre needs for this service. Fields marked * are required.', 'أدخل ما يحتاجه المركز لهذه الخدمة. الحقول المعلّمة بعلامة * مطلوبة.'],
    savedAt: ['Saved at {time}', 'تم الحفظ {time}'],
    noForm: ['This service needs no extra details. Add a note below if there is something the centre should know.', 'لا تحتاج هذه الخدمة إلى بيانات إضافية. أضف ملاحظة أدناه إن كان هناك ما يجب أن يعرفه المركز.'],
    instructions: ['Anything else the centre should know?', 'هل هناك شيء آخر يجب أن يعرفه المركز؟'],
    instructionsHint: ['For example the best time to call you.', 'مثلًا أفضل وقت للاتصال بك.'],
    incomplete: ['Some required details are missing or not valid. Please check the highlighted fields.', 'بعض البيانات المطلوبة ناقصة أو غير صحيحة. يُرجى مراجعة الحقول المحددة.'],
  },
  documents: {
    title: ['Your documents', 'مستنداتك'],
    text: ['A clear photo from your phone is enough. Make sure the whole page is visible and readable.', 'تكفي صورة واضحة من هاتفك. تأكد من ظهور الصفحة كاملة وأنها مقروءة.'],
    missing: plural(
      {
        one: '1 required document is still missing. You can continue and add it later, but the centre can only start once it has it.',
        other: '{count} required documents are still missing. You can continue and add them later, but the centre can only start once it has them.',
      },
      {
        zero: 'لا توجد مستندات مطلوبة ناقصة.',
        one: 'ما زال مستند مطلوب واحد ناقصًا. يمكنك المتابعة وإضافته لاحقًا، لكن المركز لا يبدأ إلا بعد استلامه.',
        two: 'ما زال مستندان مطلوبان ناقصين. يمكنك المتابعة وإضافتهما لاحقًا، لكن المركز لا يبدأ إلا بعد استلامهما.',
        few: 'ما زالت {count} مستندات مطلوبة ناقصة. يمكنك المتابعة وإضافتها لاحقًا، لكن المركز لا يبدأ إلا بعد استلامها.',
        many: 'ما زال {count} مستندًا مطلوبًا ناقصًا. يمكنك المتابعة وإضافتها لاحقًا، لكن المركز لا يبدأ إلا بعد استلامها.',
        other: 'ما زال {count} مستند مطلوب ناقصًا. يمكنك المتابعة وإضافتها لاحقًا، لكن المركز لا يبدأ إلا بعد استلامها.',
      },
    ),
  },
  review: {
    details: ['Your details', 'بياناتك'],
    documents: ['Your documents', 'مستنداتك'],
    complete: ['Complete the details', 'إكمال البيانات'],
    addDocuments: ['Add documents', 'إضافة المستندات'],
    submit: ['Submit request', 'إرسال الطلب'],
    confirm: ['By submitting you confirm that the details and documents are correct and yours to use.', 'بإرسالك الطلب تؤكد أن البيانات والمستندات صحيحة ويحق لك استخدامها.'],
    formInvalid: ['Some details are missing or not valid. Go back to the details step and check the highlighted fields.', 'بعض البيانات ناقصة أو غير صحيحة. عد إلى خطوة البيانات وراجع الحقول المحددة.'],
  },
  done: {
    title: ['Request submitted', 'تم إرسال الطلب'],
    text: ['The centre has received your request for {service} and will review it.', 'استلم المركز طلبك لخدمة {service} وسيراجعه.'],
    copyNumber: ['Copy request number', 'نسخ رقم الطلب'],
    copyCode: ['Copy tracking code', 'نسخ رمز التتبع'],
    codeHint: ['Keep this code. With the request number it shows the status without logging in. It is shown only this once.', 'احتفظ بهذا الرمز. يعرض مع رقم الطلب حالة الطلب دون تسجيل الدخول. ويظهر هذه المرة فقط.'],
    dashboard: ['Back to the dashboard', 'العودة إلى لوحة المعلومات'],
  },
};

const checklist: Tree = {
  none: ['No documents are needed from you for this request.', 'لا يُطلب منك أي مستند لهذا الطلب.'],
  optional: ['If available', 'إن وُجد'],
  upload: ['Upload', 'رفع'],
  uploadNew: ['Upload a new copy', 'رفع نسخة جديدة'],
  replace: ['Replace', 'استبدال'],
  reuse: ['Use this one', 'استخدام هذا المستند'],
  reuseHint: ['You already have a valid copy on file:', 'لديك نسخة سارية في ملفك:'],
  linked: ['{name}: document from your file attached', '{name}: تم إرفاق مستند من ملفك'],
  uploaded: ['{name} uploaded', 'تم رفع {name}'],
  uploadedOn: ['Added {date}', 'أُضيف في {date}'],
  validUntil: ['Valid until {date}', 'ساري حتى {date}'],
  expiredOn: ['Expired on {date}', 'انتهى في {date}'],
  uploadHint: ['Files are checked for viruses and stored encrypted. Only the staff working on your request can open them.', 'تُفحص الملفات ضد الفيروسات وتُحفظ مشفّرة. ولا يفتحها إلا الموظفون العاملون على طلبك.'],
  scanning: ['Security check in progress. This takes a moment.', 'الفحص الأمني جارٍ. يستغرق ذلك لحظات.'],
  blocked: ['This file was blocked by the security check and was not saved. Please upload another copy.', 'حُظر هذا الملف في الفحص الأمني ولم يُحفظ. يُرجى رفع نسخة أخرى.'],
  rejectedTitle: ['The centre could not accept this document', 'تعذّر على المركز قبول هذا المستند'],
  rejectedNoReason: ['Please upload a clearer or corrected copy.', 'يُرجى رفع نسخة أوضح أو مصحّحة.'],
  removeTitle: ['Remove this document?', 'هل تريد إزالة هذا المستند؟'],
  removeText: ['{name} is taken off this request. The file stays in your documents.', 'سيُزال {name} من هذا الطلب. ويبقى الملف في مستنداتك.'],
};

const request: Tree = {
  notFoundTitle: ['We could not find this request', 'لم نعثر على هذا الطلب'],
  notFoundText: ['Check the link, or open the request from your list.', 'تحقق من الرابط أو افتح الطلب من قائمتك.'],
  submittedOn: ['Submitted {date}', 'أُرسل في {date}'],
  tabs: {
    overview: ['Overview', 'نظرة عامة'],
    documents: ['Documents', 'المستندات'],
    messages: ['Messages', 'الرسائل'],
    details: ['Details', 'البيانات'],
  },
  waitingOn: {
    CUSTOMER: ['Waiting for you', 'بانتظارك'],
    CENTRE: ['The centre is working on it', 'المركز يعمل على طلبك'],
    AUTHORITY: ['Waiting for the authority', 'بانتظار الجهة المختصة'],
    NOBODY: ['Nothing more to do', 'لا يوجد إجراء مطلوب'],
  },
  now: {
    AWAITING_CUSTOMER: ['The centre needs something from you before it can continue.', 'يحتاج المركز منك شيئًا قبل أن يتمكن من المتابعة.'],
    COMPLETED: ['Your request is complete.', 'اكتمل طلبك.'],
    CANCELLED: ['This request was cancelled.', 'تم إلغاء هذا الطلب.'],
  },
  update: ['Update from the centre', 'تحديث من المركز'],
  centreSays: ['The centre wrote:', 'كتب المركز:'],
  continueDraft: ['Continue the request', 'متابعة الطلب'],
  reviewQuotation: ['Review the quotation', 'مراجعة عرض السعر'],
  openInvoice: ['Open the invoice', 'فتح الفاتورة'],
  fixDocuments: ['Go to my documents', 'الانتقال إلى مستنداتي'],
  resubmit: ['Send back to the centre', 'إعادة الإرسال إلى المركز'],
  resubmitHint: ['When you have done what the centre asked for, send the request back so that work can continue.', 'بعد أن تنفّذ ما طلبه المركز، أعد إرسال الطلب ليستمر العمل.'],
  resubmitted: ['Sent back to the centre', 'تمت إعادة الإرسال إلى المركز'],
  blocked: {
    REJECTED_DOCUMENTS_PENDING: ['Replace the documents that were not accepted first. Then you can send the request back.', 'استبدل أولًا المستندات التي لم تُقبل، ثم يمكنك إعادة إرسال الطلب.'],
  },
  completedDocuments: ['Your completed documents', 'مستنداتك المكتملة'],
  yourDocuments: ['Documents from you', 'المستندات المطلوبة منك'],
  documentsHint: ['Upload what is missing. A clear photo from your phone is enough.', 'ارفع ما ينقص. تكفي صورة واضحة من هاتفك.'],
  expectedBy: ['Expected by', 'متوقع بحلول'],
  expectedHint: ['An estimate from the centre. Authorities decide their own timing.', 'تقدير من المركز. الجهات المختصة تحدد مواعيدها بنفسها.'],
  cancelledOn: ['Cancelled', 'تاريخ الإلغاء'],
  bookVisit: ['Book a visit', 'حجز زيارة'],
  askSupport: ['Ask about this request', 'استفسار عن هذا الطلب'],
  cancel: ['Cancel request', 'إلغاء الطلب'],
  keep: ['Keep request', 'الإبقاء على الطلب'],
  cancelTitle: ['Cancel this request?', 'هل تريد إلغاء هذا الطلب؟'],
  cancelText: ['Request {number} is stopped. This cannot be undone; you would have to start a new request.', 'سيتوقف الطلب {number}. لا يمكن التراجع عن ذلك، وستحتاج إلى بدء طلب جديد.'],
  cancelReason: ['Why are you cancelling?', 'ما سبب الإلغاء؟'],
  cancelReasonHint: ['The centre sees this.', 'يطّلع المركز على ذلك.'],
  cancelPaid: ['You have already paid for this request. Cancelling does not refund by itself: the centre reviews what can be returned and contacts you.', 'لقد دفعت مقابل هذا الطلب. الإلغاء لا يعيد المبلغ تلقائيًا: يراجع المركز ما يمكن استرداده ويتواصل معك.'],
  cancelNotAllowed: ['The centre has already started working on this request, so it cannot be cancelled here. Write to the centre in the Messages tab.', 'بدأ المركز العمل على هذا الطلب، لذا لا يمكن إلغاؤه من هنا. راسل المركز من تبويب الرسائل.'],
  cancelled: ['Request {number} cancelled', 'تم إلغاء الطلب {number}'],
  external: {
    text: ['What we know about your application outside the centre. Each status says where it comes from.', 'ما نعرفه عن طلبك خارج المركز. كل حالة تبيّن مصدرها.'],
    authority: ['Authority', 'الجهة'],
    reference: ['Reference number', 'الرقم المرجعي'],
    channel: ['Submitted through', 'طريقة التقديم'],
    recorded: ['Recorded', 'تاريخ التسجيل'],
    noStatus: ['No status has been recorded yet.', 'لم تُسجَّل أي حالة بعد.'],
    channels: {
      MANUAL_PORTAL: ['The authority’s portal, by our staff', 'بوابة الجهة، عن طريق موظفينا'],
      AUTHORISED_PARTNER: ['An authorised partner', 'شريك معتمد'],
      OFFICIAL_API: ['An official connection to the authority', 'ربط رسمي مع الجهة'],
    },
    results: {
      COMPLETED: ['Result: completed', 'النتيجة: مكتمل'],
      RETURNED: ['Result: returned for correction', 'النتيجة: أُعيد للتصحيح'],
      REJECTED: ['Result: not accepted', 'النتيجة: لم يُقبل'],
    },
  },
  money: {
    title: ['Quotation and payment', 'عرض السعر والدفع'],
    invoiced: ['Invoiced', 'قيمة الفواتير'],
    paid: ['Paid', 'المدفوع'],
  },
  messages: {
    title: ['Messages with {centre}', 'الرسائل مع {centre}'],
    text: ['Questions and answers about this request. The team answers during working hours.', 'أسئلة وأجوبة حول هذا الطلب. يجيب الفريق خلال ساعات العمل.'],
    emptyTitle: ['No messages yet', 'لا توجد رسائل بعد'],
    emptyText: ['Write to the centre if you have a question about this request.', 'راسل المركز إذا كان لديك سؤال عن هذا الطلب.'],
    write: ['Your message', 'رسالتك'],
    placeholder: ['Write your question or update…', 'اكتب سؤالك أو ما تريد إضافته…'],
    send: ['Send message', 'إرسال الرسالة'],
    sent: ['Message sent', 'تم إرسال الرسالة'],
    closed: ['This request is closed for new messages. Use Support to contact the centre.', 'هذا الطلب مغلق أمام الرسائل الجديدة. استخدم الدعم للتواصل مع المركز.'],
  },
  details: {
    title: ['What you told us', 'ما أدخلته'],
    none: ['This request has no extra details.', 'لا توجد بيانات إضافية لهذا الطلب.'],
    edit: ['Edit my details', 'تعديل بياناتي'],
    editText: ['Correct what is wrong. The centre sees the new values at once.', 'صحّح ما هو خاطئ. يرى المركز القيم الجديدة فورًا.'],
    saved: ['Details saved', 'تم حفظ البيانات'],
    locked: ['The centre is working with these details. If something is wrong, write to the centre in the Messages tab.', 'يعمل المركز بهذه البيانات. إذا كان هناك خطأ راسل المركز من تبويب الرسائل.'],
  },
};

// ------------------------------------------------------------------ documents

const documents: Tree = {
  search: ['Search by name', 'ابحث بالاسم'],
  upload: ['Upload a document', 'رفع مستند'],
  uploadText: ['Keep a document on your file so the centre can reuse it for your next request.', 'احفظ مستندًا في ملفك ليتمكن المركز من استخدامه في طلبك القادم.'],
  whatIsIt: ['What kind of document is it?', 'ما نوع المستند؟'],
  chooseTypeFirst: ['Choose the kind of document first.', 'اختر نوع المستند أولًا.'],
  expiryDate: ['Expiry date', 'تاريخ الانتهاء'],
  expiryHint: ['As printed on the document. The centre confirms it when it checks the document.', 'كما هو مطبوع على المستند. يؤكده المركز عند تدقيق المستند.'],
  uploadedNote: ['Uploaded. The file is checked for viruses and then appears in your list.', 'تم الرفع. يُفحص الملف ضد الفيروسات ثم يظهر في قائمتك.'],
  uploadedToast: ['Document uploaded', 'تم رفع المستند'],
  newVersion: ['Upload a new version', 'رفع نسخة جديدة'],
  newVersionText: ['The new file replaces “{name}” once it has passed the security check. The centre checks it again.', 'يحل الملف الجديد محل «{name}» بعد اجتيازه الفحص الأمني. ويدققه المركز من جديد.'],
  fromCentre: ['From the centre', 'من المركز'],
  expired: ['Expired', 'منتهٍ'],
  expiresIn: plural(
    { one: 'in 1 day', other: 'in {count} days' },
    { zero: 'اليوم', one: 'بعد يوم واحد', two: 'بعد يومين', few: 'بعد {count} أيام', many: 'بعد {count} يومًا', other: 'بعد {count} يوم' },
  ),
  emptyTitle: ['No documents yet', 'لا توجد مستندات بعد'],
  emptyText: ['Documents you upload and documents the centre completes for you appear here.', 'تظهر هنا المستندات التي ترفعها والمستندات التي ينجزها المركز لك.'],
  privacyNote: ['Download links work for a few minutes only and every access is recorded.', 'روابط التنزيل تعمل لدقائق معدودة فقط، ويُسجَّل كل وصول.'],
  columns: {
    title: ['Document', 'المستند'],
    status: ['Status', 'الحالة'],
    type: ['Type', 'النوع'],
    expiry: ['Expires', 'ينتهي في'],
    added: ['Added', 'تاريخ الإضافة'],
    size: ['Size', 'الحجم'],
  },
  expiring: {
    title: ['Expiring soon', 'تنتهي قريبًا'],
    on: ['expires on {date} ({left})', 'ينتهي في {date} ({left})'],
    expiredOn: ['expired on {date}', 'انتهى في {date}'],
    renew: ['Request renewal', 'طلب التجديد'],
    openRenewal: ['Open renewal request', 'فتح طلب التجديد'],
    note: ['Dates are according to our records. Check the document itself for the exact date.', 'التواريخ حسب سجلاتنا. راجع المستند نفسه للتأكد من التاريخ الدقيق.'],
  },
};

// ------------------------------------------------------------------ money

const fees: Tree = {
  groups: {
    SERVICE_FEE: ['Centre service fees', 'رسوم خدمة المركز'],
    GOVERNMENT_FEE: ['Government fees', 'الرسوم الحكومية'],
    THIRD_PARTY_FEE: ['Third-party charges', 'رسوم الأطراف الأخرى'],
  },
  governmentNote: ['Collected on behalf of the relevant authority.', 'تُحصَّل نيابةً عن الجهة المختصة.'],
  discount: ['Discount', 'خصم'],
  discountIncluded: ['Discount included', 'الخصم المشمول'],
  taxIncluded: ['VAT included', 'ضريبة القيمة المضافة المشمولة'],
  total: ['Total', 'الإجمالي'],
};

const quotations: Tree = {
  search: ['Search by quotation number', 'ابحث برقم عرض السعر'],
  waiting: ['Waiting for your decision', 'بانتظار قرارك'],
  validUntil: ['valid until {date}', 'ساري حتى {date}'],
  emptyTitle: ['No quotations yet', 'لا توجد عروض أسعار بعد'],
  emptyText: ['When the centre has checked a request, its quotation appears here for your approval.', 'بعد أن يراجع المركز طلبًا يظهر عرض سعره هنا لتوافق عليه.'],
  notFoundTitle: ['We could not find this quotation', 'لم نعثر على عرض السعر'],
  notFoundText: ['Check the link, or open the quotation from your list.', 'تحقق من الرابط أو افتح عرض السعر من قائمتك.'],
  columns: {
    number: ['Quotation', 'عرض السعر'],
    request: ['Request', 'الطلب'],
    validUntil: ['Valid until', 'ساري حتى'],
    sent: ['Sent', 'تاريخ الإرسال'],
  },
  status: {
    SENT: ['Waiting for your decision', 'بانتظار قرارك'],
    APPROVED: ['Approved', 'تمت الموافقة'],
    REJECTED: ['Declined', 'مرفوض'],
    EXPIRED: ['Expired', 'منتهي الصلاحية'],
  },
  openText: ['Check the fees below. If you agree, approve the quotation so the centre can continue.', 'راجع الرسوم أدناه. إذا وافقت، اعتمد عرض السعر ليتابع المركز العمل.'],
  notes: ['Note from the centre', 'ملاحظة من المركز'],
  decided: ['Decided', 'تاريخ القرار'],
  approve: ['Approve quotation', 'الموافقة على عرض السعر'],
  approveHint: ['Nothing is charged when you approve. You then get an invoice that you can pay online or at the centre.', 'لا يُخصم أي مبلغ عند الموافقة. تصلك بعدها فاتورة يمكنك دفعها عبر الإنترنت أو في المركز.'],
  approveTitle: ['Approve this quotation?', 'هل توافق على عرض السعر؟'],
  approveText: ['You accept the total of {amount}. An invoice is created for it.', 'أنت توافق على الإجمالي البالغ {amount}. وستُنشأ فاتورة بذلك.'],
  approved: ['Quotation {number} approved', 'تمت الموافقة على عرض السعر {number}'],
  approvedInvoice: ['Invoice {number} is ready to pay.', 'الفاتورة {number} جاهزة للدفع.'],
  reject: ['Decline quotation', 'رفض عرض السعر'],
  rejectTitle: ['Decline this quotation?', 'هل تريد رفض عرض السعر؟'],
  rejectText: ['Tell the centre why, so that it can send you a new quotation or contact you.', 'أخبر المركز بالسبب ليرسل لك عرضًا جديدًا أو يتواصل معك.'],
  rejectReason: ['Reason', 'السبب'],
  rejectReasonHint: ['For example: the price is higher than expected.', 'مثلًا: السعر أعلى من المتوقع.'],
  rejected: ['Quotation {number} declined', 'تم رفض عرض السعر {number}'],
  rejectedTitle: ['You declined this quotation', 'لقد رفضت عرض السعر هذا'],
  expiredText: ['This quotation has expired. The centre will send a new one; write to the centre if you need it sooner.', 'انتهت صلاحية عرض السعر هذا. سيرسل المركز عرضًا جديدًا، وراسل المركز إن احتجته أسرع.'],
  supersededText: ['The centre replaced this quotation with a newer one. You find it in your list.', 'استبدل المركز هذا العرض بعرض أحدث. تجده في قائمتك.'],
  cancelledText: ['The centre withdrew this quotation.', 'سحب المركز عرض السعر هذا.'],
  invoiceTitle: ['Invoice {number}', 'الفاتورة {number}'],
  invoiceDue: ['{amount} to pay.', 'المبلغ المطلوب دفعه {amount}.'],
  invoicePaid: ['Nothing left to pay.', 'لا يوجد مبلغ متبقٍّ للدفع.'],
  openInvoice: ['Open invoice', 'فتح الفاتورة'],
};

const invoices: Tree = {
  search: ['Search by invoice number', 'ابحث برقم الفاتورة'],
  notFoundTitle: ['We could not find this invoice', 'لم نعثر على هذه الفاتورة'],
  notFoundText: ['Check the link, or open the invoice from your payments.', 'تحقق من الرابط أو افتح الفاتورة من صفحة المدفوعات.'],
  overdue: ['Overdue', 'متأخرة'],
  issued: ['Issued', 'تاريخ الإصدار'],
  due: ['Due', 'تاريخ الاستحقاق'],
  dueOn: ['Due {date}', 'تستحق في {date}'],
  payAtCentre: ['You can also pay at {centre}: cash, card or bank transfer. Mention the invoice number.', 'يمكنك أيضًا الدفع في {centre}: نقدًا أو بالبطاقة أو بتحويل بنكي. اذكر رقم الفاتورة.'],
  voidText: ['The centre cancelled this invoice. There is nothing to pay.', 'ألغى المركز هذه الفاتورة. لا يوجد ما يُدفع.'],
  credited: ['Credited', 'المبلغ الدائن'],
  refunded: ['Refunded', 'المبلغ المسترد'],
  history: ['Payments', 'المدفوعات'],
  noPayments: ['No payment has been received for this invoice yet.', 'لم يُستلم أي مبلغ عن هذه الفاتورة بعد.'],
  creditNote: ['Credit note', 'إشعار دائن'],
  emptyTitle: ['No invoices yet', 'لا توجد فواتير بعد'],
  emptyText: ['An invoice appears here when you approve a quotation.', 'تظهر الفاتورة هنا عند موافقتك على عرض سعر.'],
  columns: { number: ['Invoice', 'الفاتورة'] },
  status: {
    ISSUED: ['Unpaid', 'غير مدفوعة'],
    PARTIALLY_PAID: ['Partly paid', 'مدفوعة جزئيًا'],
    PAID: ['Paid', 'مدفوعة'],
    CREDITED: ['Credited', 'مُصدَر لها إشعار دائن'],
    VOID: ['Cancelled', 'ملغاة'],
  },
};

const payments: Tree = {
  description: ['What is still to pay, your invoices, and your payments with their receipts.', 'ما تبقّى للدفع، وفواتيرك، ومدفوعاتك مع إيصالاتها.'],
  tabs: {
    due: ['To pay', 'للدفع'],
    invoices: ['Invoices', 'الفواتير'],
    payments: ['Payments and receipts', 'المدفوعات والإيصالات'],
  },
  toPay: ['To pay', 'المطلوب دفعه'],
  outstanding: ['Outstanding balance', 'الرصيد المستحق'],
  invoiceCount: plural(
    { one: '1 invoice to pay', other: '{count} invoices to pay' },
    { zero: 'لا توجد فواتير للدفع', one: 'فاتورة واحدة للدفع', two: 'فاتورتان للدفع', few: '{count} فواتير للدفع', many: '{count} فاتورة للدفع', other: '{count} فاتورة للدفع' },
  ),
  forRequest: ['For request', 'للطلب'],
  nothingDueTitle: ['Nothing to pay', 'لا يوجد ما يُدفع'],
  nothingDueText: ['You have no unpaid invoices. When a payment is needed it appears here.', 'ليست لديك فواتير غير مدفوعة. عند الحاجة إلى دفع يظهر هنا.'],
  receipt: ['Receipt', 'الإيصال'],
  downloadReceipt: ['Download receipt', 'تنزيل الإيصال'],
  openInvoice: ['Open invoice', 'فتح الفاتورة'],
  emptyTitle: ['No payments yet', 'لا توجد مدفوعات بعد'],
  emptyText: ['Payments you make online or at the centre appear here with their receipts.', 'تظهر هنا المدفوعات التي تجريها عبر الإنترنت أو في المركز مع إيصالاتها.'],
  columns: {
    receipt: ['Receipt', 'الإيصال'],
    date: ['Date', 'التاريخ'],
    method: ['Paid by', 'طريقة الدفع'],
  },
  methods: {
    CASH: ['Cash', 'نقدًا'],
    CARD_POS: ['Card at the centre', 'بطاقة في المركز'],
    BANK_TRANSFER: ['Bank transfer', 'تحويل بنكي'],
    CHEQUE: ['Cheque', 'شيك'],
    ONLINE_GATEWAY: ['Online payment', 'دفع إلكتروني'],
  },
  status: {
    COMPLETED: ['Received', 'تم الاستلام'],
    PENDING: ['Not completed', 'لم يكتمل'],
    FAILED: ['Failed', 'فشل'],
    PARTIALLY_REFUNDED: ['Partly refunded', 'مسترد جزئيًا'],
    REFUNDED: ['Refunded', 'مسترد'],
  },
};

const pay: Tree = {
  pay: ['Pay', 'ادفع'],
  payOnline: ['Pay online', 'ادفع عبر الإنترنت'],
  amount: ['Amount', 'المبلغ'],
  failedTitle: ['The payment could not be started', 'تعذّر بدء عملية الدفع'],
  offlineTitle: ['Online payment is not available', 'الدفع الإلكتروني غير متاح'],
  offlineText: ['This centre does not take online payments at the moment. You can pay at the centre; mention the invoice number.', 'لا يقبل هذا المركز الدفع الإلكتروني حاليًا. يمكنك الدفع في المركز مع ذكر رقم الفاتورة.'],
  test: {
    title: ['Test payment', 'دفع تجريبي'],
    description: ['Invoice {number}', 'الفاتورة {number}'],
    notice: ['This centre uses the test payment provider. No money is taken and no card is needed.', 'يستخدم هذا المركز مزوّد الدفع التجريبي. لا يُخصم أي مبلغ ولا حاجة إلى بطاقة.'],
    hint: ['The result is confirmed by the provider in the same way as a real payment.', 'يؤكد المزوّد النتيجة بالطريقة نفسها المتبعة في الدفع الحقيقي.'],
    complete: ['Pay {amount} (test)', 'ادفع {amount} (تجريبي)'],
    decline: ['Try a declined payment', 'تجربة دفع مرفوض'],
    declinedReason: ['Declined in the test checkout', 'رُفض في صفحة الدفع التجريبية'],
  },
};

const payReturn: Tree = {
  title: ['Payment result', 'نتيجة الدفع'],
  noPaymentTitle: ['We could not find this payment', 'لم نعثر على عملية الدفع'],
  noPaymentText: ['Open your invoice to see whether it is paid.', 'افتح فاتورتك لتتأكد من سدادها.'],
  backToInvoice: ['Back to the invoice', 'العودة إلى الفاتورة'],
  tryAgain: ['Try again', 'حاول مرة أخرى'],
  checkAgain: ['Check again', 'تحقق مرة أخرى'],
  waiting: {
    title: ['Confirming your payment…', 'جارٍ تأكيد الدفع…'],
    text: ['We are waiting for the confirmation of the payment provider. Please keep this page open.', 'ننتظر تأكيد مزوّد الدفع. يُرجى إبقاء هذه الصفحة مفتوحة.'],
  },
  paid: {
    title: ['Payment received', 'تم استلام الدفع'],
    text: ['Thank you. Your receipt is ready and the centre has been told.', 'شكرًا لك. إيصالك جاهز وقد أُبلغ المركز.'],
  },
  failed: {
    title: ['The payment did not go through', 'لم تتم عملية الدفع'],
    text: ['No money was taken. You can try again from the invoice.', 'لم يُخصم أي مبلغ. يمكنك المحاولة مجددًا من الفاتورة.'],
    reason: ['The provider said:', 'ذكر المزوّد:'],
  },
  left: {
    title: ['The payment was not completed', 'لم تكتمل عملية الدفع'],
    text: ['You left the payment page before paying. Nothing was charged.', 'غادرت صفحة الدفع قبل إتمامه. لم يُخصم أي مبلغ.'],
  },
  unconfirmed: {
    title: ['We have no confirmation yet', 'لم يصلنا التأكيد بعد'],
    text: ['If you completed the payment, the confirmation can take a few minutes. Check again shortly; do not pay twice.', 'إذا أتممت الدفع فقد يستغرق التأكيد بضع دقائق. تحقق مجددًا بعد قليل ولا تدفع مرتين.'],
  },
};

// ------------------------------------------------------------------ appointments

const appointments: Tree = {
  book: ['Book an appointment', 'حجز موعد'],
  bookText: ['Choose a branch, a day and a free time.', 'اختر الفرع واليوم ووقتًا متاحًا.'],
  upcoming: ['Upcoming', 'القادمة'],
  earlier: ['Earlier', 'السابقة'],
  noUpcoming: ['You have no upcoming appointments.', 'ليست لديك مواعيد قادمة.'],
  emptyTitle: ['No appointments yet', 'لا توجد مواعيد بعد'],
  emptyText: ['Book a visit to the centre so you do not have to wait.', 'احجز زيارة إلى المركز لتتجنب الانتظار.'],
  branch: ['Branch', 'الفرع'],
  date: ['Day', 'اليوم'],
  service: ['What is the visit for?', 'ما سبب الزيارة؟'],
  servicePlaceholder: ['Choose a service', 'اختر الخدمة'],
  time: ['Free times on {date}', 'الأوقات المتاحة في {date}'],
  notes: ['Note for the centre', 'ملاحظة للمركز'],
  closed: ['The branch is closed on this day. Choose another day.', 'الفرع مغلق في هذا اليوم. اختر يومًا آخر.'],
  full: ['All times on this day are taken. Choose another day.', 'جميع الأوقات في هذا اليوم محجوزة. اختر يومًا آخر.'],
  noSlots: ['No appointments are offered on this day. Choose another day.', 'لا توجد مواعيد متاحة في هذا اليوم. اختر يومًا آخر.'],
  confirmAt: ['Book {time}', 'احجز {time}'],
  booked: ['Appointment booked', 'تم حجز الموعد'],
  bookedOn: ['{date} at {time}', '{date} الساعة {time}'],
  reschedule: ['Reschedule', 'تغيير الموعد'],
  rescheduleTitle: ['Choose a new time', 'اختر وقتًا جديدًا'],
  rescheduleText: ['Your appointment on {date} at {time} is moved to the time you choose.', 'سيُنقل موعدك في {date} الساعة {time} إلى الوقت الذي تختاره.'],
  rescheduled: ['Appointment rescheduled', 'تم تغيير الموعد'],
  cancel: ['Cancel appointment', 'إلغاء الموعد'],
  keep: ['Keep appointment', 'الإبقاء على الموعد'],
  cancelTitle: ['Cancel this appointment?', 'هل تريد إلغاء هذا الموعد؟'],
  cancelText: ['The time becomes free for other customers. You can book a new appointment at any time.', 'سيصبح الوقت متاحًا لعملاء آخرين. يمكنك حجز موعد جديد في أي وقت.'],
  cancelReason: ['Reason', 'السبب'],
  cancelled: ['Appointment cancelled', 'تم إلغاء الموعد'],
  errors: {
    SLOT_FULL: ['Someone just took this time. Please choose another one.', 'حُجز هذا الوقت للتو. يُرجى اختيار وقت آخر.'],
    SLOT_UNAVAILABLE: ['This time is not offered any more. Please choose another one.', 'هذا الوقت لم يعد متاحًا. يُرجى اختيار وقت آخر.'],
    SLOT_IN_PAST: ['This time has already passed. Please choose a later one.', 'هذا الوقت قد مضى. يُرجى اختيار وقت لاحق.'],
    BRANCH_CLOSED: ['The branch is closed on this day. Choose another day.', 'الفرع مغلق في هذا اليوم. اختر يومًا آخر.'],
    TOO_FAR_AHEAD: ['Appointments cannot be booked this far ahead. Choose an earlier day.', 'لا يمكن حجز موعد بهذا البعد. اختر يومًا أقرب.'],
    ALREADY_BOOKED: ['You already have an appointment at this time.', 'لديك موعد في هذا الوقت بالفعل.'],
    TOO_LATE_TO_CHANGE: ['It is too close to the appointment to change it here. Please call the centre.', 'اقترب موعدك كثيرًا ولا يمكن تعديله من هنا. يُرجى الاتصال بالمركز.'],
  },
};

// ------------------------------------------------------------------ messages, notifications

const messages: Tree = {
  new: ['New', 'جديد'],
  count: plural(
    { one: '1 message', other: '{count} messages' },
    { zero: 'لا رسائل', one: 'رسالة واحدة', two: 'رسالتان', few: '{count} رسائل', many: '{count} رسالة', other: '{count} رسالة' },
  ),
  emptyTitle: ['No conversations yet', 'لا توجد محادثات بعد'],
  emptyText: ['Messages with the centre belong to a request. Open a request and write from its Messages tab.', 'الرسائل مع المركز مرتبطة بطلب. افتح طلبًا واكتب من تبويب الرسائل.'],
  noneYet: ['No messages yet.', 'لا توجد رسائل بعد.'],
  writeAbout: ['Write about a request', 'اكتب بخصوص طلب'],
  noMessages: ['No messages yet. Tap to write to the centre.', 'لا توجد رسائل بعد. اضغط لمراسلة المركز.'],
  partial: ['Some conversations could not be loaded. Reload the page to try again.', 'تعذّر تحميل بعض المحادثات. أعد تحميل الصفحة للمحاولة مجددًا.'],
  supportHint: ['A question that is not about one request?', 'لديك سؤال لا يخص طلبًا بعينه؟'],
};

const notifications: Tree = {
  tabs: { inbox: ['Inbox', 'الوارد'], settings: ['How we contact you', 'طرق التواصل معك'] },
  markAll: ['Mark all as read', 'تحديد الكل كمقروء'],
  allRead: ['All notifications marked as read', 'تم تحديد جميع الإشعارات كمقروءة'],
  unread: ['unread', 'غير مقروء'],
  unreadOnly: ['Show unread only', 'عرض غير المقروء فقط'],
  emptyTitle: ['No notifications yet', 'لا توجد إشعارات بعد'],
  emptyText: ['Updates about your requests, payments and appointments appear here.', 'تظهر هنا التحديثات الخاصة بطلباتك ومدفوعاتك ومواعيدك.'],
  noUnreadTitle: ['You have read everything', 'قرأت كل شيء'],
  noUnreadText: ['There are no unread notifications.', 'لا توجد إشعارات غير مقروءة.'],
  settingsTitle: ['How should we tell you?', 'كيف نبلغك؟'],
  settingsText: ['Choose how the centre may send you updates about your requests, payments and appointments.', 'اختر كيف يرسل لك المركز التحديثات الخاصة بطلباتك ومدفوعاتك ومواعيدك.'],
  alwaysOn: ['Always on', 'مفعّل دائمًا'],
  channelOn: ['{channel} switched on', 'تم تفعيل {channel}'],
  channelOff: ['{channel} switched off', 'تم إيقاف {channel}'],
  securityNote: ['Messages that protect your account (verification, password reset, one-time codes) are always sent. Offers and WhatsApp also need your permission.', 'الرسائل التي تحمي حسابك (التحقق، إعادة تعيين كلمة المرور، الرموز المؤقتة) تُرسل دائمًا. أما العروض وواتساب فتحتاج أيضًا إلى إذنك.'],
  consentLink: ['Privacy choices', 'خيارات الخصوصية'],
  channels: {
    EMAIL: { name: ['Email', 'البريد الإلكتروني'], hint: ['To the email address on your file.', 'إلى البريد الإلكتروني المسجل في ملفك.'] },
    SMS: { name: ['Text message (SMS)', 'الرسائل النصية'], hint: ['To the mobile number on your file.', 'إلى رقم الهاتف المتحرك المسجل في ملفك.'] },
    WHATSAPP: { name: ['WhatsApp', 'واتساب'], hint: ['To the mobile number on your file, where the centre offers it.', 'إلى رقم الهاتف المتحرك المسجل في ملفك، حيثما يوفّر المركز ذلك.'] },
    PUSH: { name: ['Mobile app notifications', 'إشعارات تطبيق الهاتف'], hint: ['On phones where you use the centre’s app.', 'على الهواتف التي تستخدم فيها تطبيق المركز.'] },
    IN_APP: { name: ['Notifications in this portal', 'الإشعارات في هذه البوابة'], hint: ['The list you see under Notifications.', 'القائمة التي تراها في صفحة الإشعارات.'] },
  },
};

// ------------------------------------------------------------------ support, feedback

const support: Tree = {
  description: ['Ask the centre a question or report a problem. You see the answer here and get a notification.', 'اطرح سؤالًا على المركز أو أبلغ عن مشكلة. ترى الرد هنا ويصلك إشعار به.'],
  ask: ['Ask a question', 'اطرح سؤالًا'],
  askText: ['The team of {centre} answers during working hours.', 'يجيب فريق {centre} خلال ساعات العمل.'],
  send: ['Send question', 'إرسال السؤال'],
  sent: ['Question {number} sent', 'تم إرسال السؤال {number}'],
  sentText: ['{centre} will answer here. You get a notification when they do.', 'سيجيب {centre} هنا. ويصلك إشعار عند الرد.'],
  waitingForYou: ['Waiting for your reply', 'بانتظار ردك'],
  waitingText: ['The centre asked you something. Reply below so they can continue.', 'سألك المركز عن شيء. اكتب ردك أدناه ليتابع العمل.'],
  emptyTitle: ['No questions yet', 'لا توجد أسئلة بعد'],
  emptyText: ['Ask about a service, a document, a payment or your account.', 'اسأل عن خدمة أو مستند أو دفعة أو عن حسابك.'],
  notFoundTitle: ['We could not find this conversation', 'لم نعثر على هذه المحادثة'],
  notFoundText: ['Check the link, or open it from your support list.', 'تحقق من الرابط أو افتحها من قائمة الدعم.'],
  openedOn: ['Asked {date}', 'طُرح في {date}'],
  aboutRequest: ['About request', 'بخصوص الطلب'],
  reply: ['Your reply', 'ردك'],
  reopenHint: ['Sending a reply reopens the conversation.', 'إرسال رد يعيد فتح المحادثة.'],
  attach: ['Add a file', 'إضافة ملف'],
  sendReply: ['Send reply', 'إرسال الرد'],
  replySent: ['Reply sent', 'تم إرسال الرد'],
  resolvedTitle: ['The centre marked this as resolved', 'اعتبر المركز هذه المحادثة محلولة'],
  resolvedText: ['If the problem is not solved, reply below and the conversation opens again.', 'إذا لم تُحل المشكلة فاكتب ردًا أدناه وستُفتح المحادثة من جديد.'],
  closedTitle: ['This conversation is closed', 'هذه المحادثة مغلقة'],
  cannotReply: ['This conversation is closed for replies. Ask a new question if you still need help.', 'لم تعد هذه المحادثة تقبل الردود. اطرح سؤالًا جديدًا إذا كنت ما زلت بحاجة إلى مساعدة.'],
  columns: {
    subject: ['Subject', 'الموضوع'],
    number: ['Number', 'الرقم'],
    category: ['Topic', 'الموضوع العام'],
    updated: ['Last update', 'آخر تحديث'],
  },
  fields: {
    subject: ['Subject', 'الموضوع'],
    subjectHint: ['A few words, for example “When can I collect my documents?”', 'بضع كلمات، مثلًا «متى يمكنني استلام مستنداتي؟»'],
    category: ['Topic', 'الموضوع العام'],
    request: ['About a request', 'بخصوص طلب'],
    noRequest: ['Not about a request', 'لا يخص طلبًا'],
    message: ['Your question', 'سؤالك'],
    attachments: ['Files', 'الملفات'],
  },
  categories: {
    request_status: ['Request status', 'حالة الطلب'],
    documents: ['Documents', 'المستندات'],
    payment: ['Payment', 'الدفع'],
    appointment: ['Appointment', 'المواعيد'],
    account: ['Account', 'الحساب'],
    other: ['Other', 'أخرى'],
  },
};

const feedback: Tree = {
  title: ['How did we do?', 'ما رأيك في خدمتنا؟'],
  text: ['Your rating helps the centre to improve.', 'تقييمك يساعد المركز على التحسّن.'],
  yours: ['Your rating', 'تقييمك'],
  comment: ['Anything you want to add?', 'هل تود إضافة شيء؟'],
  send: ['Send rating', 'إرسال التقييم'],
  sent: ['Thank you for your rating', 'شكرًا على تقييمك'],
  stars: plural(
    { one: '1 star out of 5', other: '{count} stars out of 5' },
    { zero: 'بلا نجوم', one: 'نجمة واحدة من 5', two: 'نجمتان من 5', few: '{count} نجوم من 5', many: '{count} نجمة من 5', other: '{count} نجمة من 5' },
  ),
};

// ------------------------------------------------------------------ profile, privacy

const profile: Tree = {
  tabs: { details: ['My details', 'بياناتي'], security: ['Password and security', 'كلمة المرور والأمان'], privacy: ['Privacy', 'الخصوصية'] },
  details: {
    title: ['About you', 'معلوماتك'],
    text: ['Your name, language and address as the centre uses them on your requests.', 'اسمك ولغتك وعنوانك كما يستخدمها المركز في طلباتك.'],
    fullName: ['Full name', 'الاسم الكامل'],
    fullNameHint: ['As in your passport.', 'كما في جواز سفرك.'],
    fullNameAr: ['Name in Arabic', 'الاسم بالعربية'],
    language: ['Language', 'اللغة'],
    languageHint: ['For this portal and for the messages the centre sends you.', 'لهذه البوابة وللرسائل التي يرسلها لك المركز.'],
    address: ['Address', 'العنوان'],
    addressLine: ['Street and building', 'الشارع والمبنى'],
    city: ['City', 'المدينة'],
    emirate: ['Emirate', 'الإمارة'],
    country: ['Country', 'الدولة'],
    saved: ['Your details were saved', 'تم حفظ بياناتك'],
  },
  onFile: {
    title: ['On file with the centre', 'المسجل لدى المركز'],
    text: ['These details are checked against your documents, so only the centre can change them.', 'تُطابَق هذه البيانات مع مستنداتك، لذا لا يغيّرها إلا المركز.'],
    customerNo: ['Customer number', 'رقم العميل'],
    phone: ['Mobile number', 'رقم الهاتف المتحرك'],
    nationality: ['Nationality', 'الجنسية'],
    dateOfBirth: ['Date of birth', 'تاريخ الميلاد'],
    emiratesId: ['Emirates ID', 'الهوية الإماراتية'],
    passport: ['Passport', 'جواز السفر'],
    correct: ['Missing or wrong? Ask the centre to update it', 'هل هناك نقص أو خطأ؟ اطلب من المركز التحديث'],
  },
  security: {
    mfaText: ['Protect your account with a code from an authenticator app in addition to your password.', 'احمِ حسابك برمز من تطبيق المصادقة إضافةً إلى كلمة المرور.'],
  },
};

const privacy: Tree = {
  consents: {
    title: ['What the centre may use your data for', 'ما يجوز للمركز استخدام بياناتك فيه'],
    text: ['Switch a permission off at any time. It applies from that moment on.', 'يمكنك إيقاف أي إذن في أي وقت. ويسري ذلك من تلك اللحظة.'],
    required: ['Needed to handle the requests you make. It ends when you ask for your data to be deleted.', 'ضروري لتنفيذ الطلبات التي تقدّمها. وينتهي عند طلبك حذف بياناتك.'],
    since: ['Allowed since {date}', 'مسموح منذ {date}'],
    withdrawnOn: ['Switched off on {date}', 'أُوقف في {date}'],
    granted: ['Permission given', 'تم منح الإذن'],
    withdrawn: ['Permission withdrawn', 'تم سحب الإذن'],
    policy: ['How your data is used is explained in the', 'توضيح كيفية استخدام بياناتك تجده في'],
  },
  purposes: {
    SERVICE_PROCESSING: { name: ['Handling your requests', 'تنفيذ طلباتك'], text: ['Using your details and documents for the services you request.', 'استخدام بياناتك ومستنداتك للخدمات التي تطلبها.'] },
    REMINDERS: { name: ['Expiry reminders', 'تذكيرات الانتهاء'], text: ['A reminder before your passport, Emirates ID or residence expires.', 'تذكير قبل انتهاء جواز سفرك أو هويتك الإماراتية أو إقامتك.'] },
    MARKETING: { name: ['Offers and news', 'العروض والأخبار'], text: ['Occasional offers and news from the centre.', 'عروض وأخبار من المركز بين حين وآخر.'] },
    AI_PROCESSING: { name: ['Automatic reading of documents', 'القراءة الآلية للمستندات'], text: ['Software reads your documents to pre-fill forms. Staff always check the result.', 'يقرأ برنامج مستنداتك لتعبئة النماذج مسبقًا. ويدقق الموظفون النتيجة دائمًا.'] },
    DOCUMENT_REUSE: { name: ['Reusing your documents', 'إعادة استخدام مستنداتك'], text: ['Valid documents on your file are attached to new requests, so you do not upload them again.', 'تُرفق المستندات السارية في ملفك بالطلبات الجديدة فلا ترفعها من جديد.'] },
    WHATSAPP: { name: ['WhatsApp messages', 'رسائل واتساب'], text: ['Updates about your requests on WhatsApp.', 'تحديثات طلباتك عبر واتساب.'] },
  },
  requests: {
    title: ['Your data', 'بياناتك'],
    text: ['Ask {centre} for a copy of your data, for a correction, or for deletion. The centre answers within 30 days.', 'اطلب من {centre} نسخة من بياناتك أو تصحيحها أو حذفها. يجيب المركز خلال 30 يومًا.'],
    yours: ['Your requests', 'طلباتك'],
    alreadyOpen: ['Already requested', 'تم الطلب مسبقًا'],
    alreadyOpenText: ['You already have an open request of this kind. The centre is working on it.', 'لديك طلب مفتوح من هذا النوع. يعمل المركز عليه.'],
    details: ['Anything you want to tell the centre?', 'هل تود إخبار المركز بشيء؟'],
    whatIsWrong: ['What is wrong, and what is correct?', 'ما الخطأ، وما الصحيح؟'],
    whatIsWrongRequired: ['Tell the centre what is wrong and what the correct value is.', 'أخبر المركز بالخطأ وبالقيمة الصحيحة.'],
    deletionWarning: ['Deletion cannot be undone. Your account stops working and your documents are removed. Invoices and payments are kept as the law requires. It is not possible while a request is open or an invoice is unpaid.', 'لا يمكن التراجع عن الحذف. يتوقف حسابك عن العمل وتُزال مستنداتك. وتُحفظ الفواتير والمدفوعات وفق ما يقتضيه القانون. ولا يمكن الحذف ما دام هناك طلب مفتوح أو فاتورة غير مدفوعة.'],
    sent: ['Your request was sent', 'تم إرسال طلبك'],
    sentText: ['The centre reviews it and answers here.', 'يراجعه المركز ويجيب هنا.'],
    askedOn: ['Asked {date}', 'طُلب في {date}'],
    answerBy: ['answer by {date}', 'الرد قبل {date}'],
    completedOn: ['completed {date}', 'اكتمل في {date}'],
    answer: ['Answer from {centre}', 'رد {centre}'],
    downloadExport: ['Download my data', 'تنزيل بياناتي'],
  },
  types: {
    EXPORT: {
      name: ['A copy of my data', 'نسخة من بياناتي'],
      text: ['A file with your profile, requests, documents list, invoices and payments.', 'ملف يضم ملفك الشخصي وطلباتك وقائمة مستنداتك وفواتيرك ومدفوعاتك.'],
      action: ['Ask for a copy', 'طلب نسخة'],
      confirm: ['The centre prepares a file with your data. You download it here when it is ready.', 'يجهّز المركز ملفًا ببياناتك. وتنزّله من هنا عند جاهزيته.'],
    },
    ACCESS: {
      name: ['Access to my data', 'الاطلاع على بياناتي'],
      text: ['See what the centre holds about you.', 'اطّلع على ما يحتفظ به المركز عنك.'],
      action: ['Ask for access', 'طلب الاطلاع'],
      confirm: ['The centre prepares a file with your data. You download it here when it is ready.', 'يجهّز المركز ملفًا ببياناتك. وتنزّله من هنا عند جاهزيته.'],
    },
    CORRECTION: {
      name: ['Correct my data', 'تصحيح بياناتي'],
      text: ['Email, phone, nationality, date of birth or identity details that are wrong.', 'بريد إلكتروني أو هاتف أو جنسية أو تاريخ ميلاد أو بيانات هوية غير صحيحة.'],
      action: ['Ask for a correction', 'طلب تصحيح'],
      confirm: ['The centre checks your documents and corrects your file.', 'يراجع المركز مستنداتك ويصحّح ملفك.'],
    },
    DELETION: {
      name: ['Delete my data', 'حذف بياناتي'],
      text: ['Remove your profile and documents from the centre’s system.', 'إزالة ملفك الشخصي ومستنداتك من نظام المركز.'],
      action: ['Ask for deletion', 'طلب الحذف'],
      confirm: ['The centre reviews your request and tells you here what will be deleted and what it must keep.', 'يراجع المركز طلبك ويخبرك هنا بما سيُحذف وما يتوجب عليه الاحتفاظ به.'],
    },
  },
  status: {
    RECEIVED: ['Received', 'تم الاستلام'],
    IN_REVIEW: ['Being reviewed', 'قيد المراجعة'],
    APPROVED: ['Approved, in progress', 'تمت الموافقة، قيد التنفيذ'],
    REJECTED: ['Not approved', 'لم تتم الموافقة'],
    COMPLETED: ['Completed', 'مكتمل'],
  },
};

// ------------------------------------------------------------------ API errors with one meaning, in the customer's words
// (the API writes its messages in English only; see docs/architecture/FRONTEND_CONVENTIONS.md, section 20)

const apiErrors: Tree = {
  FILE_TYPE_NOT_ALLOWED: ['This kind of file is not accepted. Upload a PDF, or a JPG or PNG photo.', 'هذا النوع من الملفات غير مقبول. ارفع ملف PDF أو صورة JPG أو PNG.'],
  FILE_TOO_LARGE: ['The file is too large. Choose a smaller file, or take the photo again at a lower quality.', 'حجم الملف كبير جدًا. اختر ملفًا أصغر أو التقط الصورة مجددًا بجودة أقل.'],
  FILE_TYPE_MISMATCH: ['The file is not what its name says (for example a renamed file). Upload a PDF, JPG or PNG.', 'الملف لا يطابق نوعه المعلن (مثل ملف أُعيدت تسميته). ارفع ملف PDF أو JPG أو PNG.'],
  UPLOAD_REJECTED: ['The upload did not arrive completely. Please upload the file again.', 'لم يكتمل وصول الملف. يُرجى رفعه مرة أخرى.'],
  UPLOAD_NOT_FOUND: ['The upload did not arrive completely. Please upload the file again.', 'لم يكتمل وصول الملف. يُرجى رفعه مرة أخرى.'],
  DOCUMENT_NOT_READY: ['This file is still in its security check. Try again in a moment.', 'ما زال هذا الملف في الفحص الأمني. حاول بعد لحظات.'],
  DOCUMENT_QUARANTINED: ['This file was blocked by the security check and cannot be opened.', 'حُظر هذا الملف في الفحص الأمني ولا يمكن فتحه.'],
  DOCUMENT_REJECTED: ['The centre did not accept this document. Upload a new copy instead.', 'لم يقبل المركز هذا المستند. ارفع نسخة جديدة بدلًا منه.'],
  DOCUMENT_EXPIRED: ['This document has expired and cannot be used. Upload the renewed one.', 'انتهت صلاحية هذا المستند ولا يمكن استخدامه. ارفع المستند المجدَّد.'],
  DOCUMENT_ALREADY_ACCEPTED: ['The centre has already accepted this document; it cannot be changed here.', 'قبل المركز هذا المستند بالفعل، ولا يمكن تغييره من هنا.'],
  REQUEST_CLOSED: ['This request is closed and takes no more changes.', 'هذا الطلب مغلق ولا يقبل تغييرات أخرى.'],
  FORM_INVALID: ['Some details are missing or not valid. Please check the highlighted fields.', 'بعض البيانات ناقصة أو غير صحيحة. يُرجى مراجعة الحقول المحددة.'],
  REJECTED_DOCUMENTS_PENDING: ['Replace the documents that were not accepted first. Then you can send the request back.', 'استبدل أولًا المستندات التي لم تُقبل، ثم يمكنك إعادة إرسال الطلب.'],
  CANCELLATION_NOT_ALLOWED: ['The centre has already started working on this request, so it cannot be cancelled here. Please contact the centre.', 'بدأ المركز العمل على هذا الطلب، لذا لا يمكن إلغاؤه من هنا. يُرجى التواصل مع المركز.'],
  PLAN_LIMIT_REACHED: ['The centre cannot take this online at the moment. Please contact the centre.', 'لا يستطيع المركز استقبال ذلك عبر الإنترنت حاليًا. يُرجى التواصل مع المركز.'],
  QUOTATION_EXPIRED: ['This quotation has expired. The centre will send you a new one.', 'انتهت صلاحية عرض السعر هذا. سيرسل لك المركز عرضًا جديدًا.'],
  QUOTATION_NOT_OPEN: ['This quotation is no longer waiting for a decision.', 'لم يعد عرض السعر هذا بانتظار قرار.'],
  INVOICE_NOT_PAYABLE: ['This invoice has nothing left to pay.', 'لا يوجد مبلغ متبقٍّ للدفع في هذه الفاتورة.'],
  INTEGRATION_NOT_CONFIGURED: ['This centre does not take online payments at the moment. You can pay at the centre.', 'لا يقبل هذا المركز الدفع الإلكتروني حاليًا. يمكنك الدفع في المركز.'],
  GATEWAY_ERROR: ['The payment provider could not be reached. No money was taken. Please try again in a few minutes.', 'تعذّر الوصول إلى مزوّد الدفع. لم يُخصم أي مبلغ. يُرجى المحاولة بعد دقائق.'],
  SLOT_FULL: ['Someone just took this time. Please choose another one.', 'حُجز هذا الوقت للتو. يُرجى اختيار وقت آخر.'],
  SLOT_UNAVAILABLE: ['This time is not offered any more. Please choose another one.', 'هذا الوقت لم يعد متاحًا. يُرجى اختيار وقت آخر.'],
  TOO_LATE_TO_CHANGE: ['It is too close to the appointment to change it here. Please call the centre.', 'اقترب موعدك كثيرًا ولا يمكن تعديله من هنا. يُرجى الاتصال بالمركز.'],
  TICKET_CLOSED: ['This conversation is closed. Ask a new question if you still need help.', 'هذه المحادثة مغلقة. اطرح سؤالًا جديدًا إذا كنت ما زلت بحاجة إلى مساعدة.'],
  ALREADY_RATED: ['You have already given your rating. Thank you.', 'لقد قدّمت تقييمك من قبل. شكرًا لك.'],
  REQUEST_ALREADY_OPEN: ['You already have an open request of this kind. The centre is working on it.', 'لديك طلب مفتوح من هذا النوع. يعمل المركز عليه.'],
  CONSENT_REQUIRED_FOR_SERVICE: ['This permission is needed to handle your requests and cannot be switched off here.', 'هذا الإذن ضروري لتنفيذ طلباتك ولا يمكن إيقافه من هنا.'],
  PROFILE_LOCKED: ['Your profile cannot be changed at the moment. Please contact the centre.', 'لا يمكن تعديل ملفك حاليًا. يُرجى التواصل مع المركز.'],
};

const statement: Tree = {
  description: ['Everything charged and paid, with your balance. Download it as a PDF for your records or your company.', 'كل ما تمت المطالبة به وما دُفع، مع رصيدك. نزّله بصيغة PDF لسجلاتك أو لشركتك.'],
  from: ['From', 'من'],
  to: ['To', 'إلى'],
  download: ['Download PDF', 'تنزيل PDF'],
  opening: ['Opening balance', 'الرصيد الافتتاحي'],
  charged: ['Charged', 'المطالبات'],
  received: ['Paid and credited', 'المدفوع والمخصوم'],
  closing: ['Balance now', 'الرصيد الحالي'],
  balance: ['Balance', 'الرصيد'],
  empty: ['Nothing in this period', 'لا شيء في هذه الفترة'],
  emptyText: ['Invoices and payments appear here.', 'تظهر هنا الفواتير والدفعات.'],
  types: { INVOICE: ['Invoice', 'فاتورة'], INVOICE_VOID: ['Invoice cancelled', 'فاتورة ملغاة'], PAYMENT: ['Payment', 'دفعة'], CREDIT_NOTE: ['Credit', 'خصم'], REFUND: ['Refund', 'مبلغ مسترد'] },
};

const tree: Tree = {
  common, shell, requests, form, price, next, wizard, checklist, request, documents, fees, quotations, invoices, payments, pay, payReturn, appointments, messages, notifications, support,
  feedback, profile, privacy, statement };

export const portalEn: Dictionary = side(tree, 0);
export const portalAr: Dictionary = side(tree, 1);
export const portalApiErrorsEn: Dictionary = side(apiErrors, 0);
export const portalApiErrorsAr: Dictionary = side(apiErrors, 1);
