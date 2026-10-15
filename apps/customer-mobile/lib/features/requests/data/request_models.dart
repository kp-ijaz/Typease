import '../../../core/utils/json.dart';
import 'form_schema.dart';

/// Statuses in which a request is finished. Everything else is "active".
const List<String> kClosedRequestStatuses = <String>['COMPLETED', 'CANCELLED'];

/// All open statuses, for the "Active" filter of the history screen.
const List<String> kActiveRequestStatuses = <String>[
  'DRAFT',
  'SUBMITTED',
  'AWAITING_CUSTOMER',
  'UNDER_REVIEW',
  'QUOTED',
  'AWAITING_PAYMENT',
  'READY_FOR_PROCESSING',
  'IN_PREPARATION',
  'PENDING_APPROVAL',
  'READY_TO_SUBMIT',
  'EXTERNAL_PROCESSING',
  'RETURNED',
  'REJECTED',
  'FINAL_REVIEW',
];

/// Statuses in which the customer has to do something.
const List<String> kCustomerActionStatuses = <String>['DRAFT', 'AWAITING_CUSTOMER', 'QUOTED', 'AWAITING_PAYMENT'];

/// The customer wording and tone of each status. Used as a fallback when a
/// response does not carry `statusLabel` / `tone` (copied from
/// REQUEST_STATUS_META in packages/types/src/requests.ts).
class RequestStatusMeta {
  const RequestStatusMeta(this.label, this.tone);

  final LocalizedText label;
  final String tone;

  static const Map<String, RequestStatusMeta> _all = <String, RequestStatusMeta>{
    'DRAFT': RequestStatusMeta(LocalizedText(en: 'Draft — not submitted yet', ar: 'مسودة — لم تُرسل بعد'), 'neutral'),
    'SUBMITTED': RequestStatusMeta(LocalizedText(en: 'Submitted', ar: 'تم الإرسال'), 'info'),
    'AWAITING_CUSTOMER': RequestStatusMeta(LocalizedText(en: 'Action needed from you', ar: 'مطلوب إجراء منك'), 'warning'),
    'UNDER_REVIEW': RequestStatusMeta(LocalizedText(en: 'Documents under review', ar: 'المستندات قيد المراجعة'), 'info'),
    'QUOTED': RequestStatusMeta(LocalizedText(en: 'Quotation ready for approval', ar: 'عرض السعر جاهز للموافقة'), 'warning'),
    'AWAITING_PAYMENT': RequestStatusMeta(LocalizedText(en: 'Payment required', ar: 'الدفع مطلوب'), 'warning'),
    'READY_FOR_PROCESSING': RequestStatusMeta(LocalizedText(en: 'Queued for processing', ar: 'في قائمة المعالجة'), 'info'),
    'IN_PREPARATION': RequestStatusMeta(LocalizedText(en: 'Being prepared', ar: 'قيد التحضير'), 'info'),
    'PENDING_APPROVAL': RequestStatusMeta(LocalizedText(en: 'Being prepared', ar: 'قيد التحضير'), 'info'),
    'READY_TO_SUBMIT': RequestStatusMeta(LocalizedText(en: 'Ready for submission', ar: 'جاهز للتقديم'), 'info'),
    'EXTERNAL_PROCESSING': RequestStatusMeta(LocalizedText(en: 'Submitted — in processing', ar: 'تم التقديم — قيد المعالجة'), 'info'),
    'RETURNED': RequestStatusMeta(LocalizedText(en: 'Returned for correction', ar: 'أُعيد للتصحيح'), 'warning'),
    'REJECTED': RequestStatusMeta(LocalizedText(en: 'Application was not accepted', ar: 'لم يُقبل الطلب'), 'danger'),
    'FINAL_REVIEW': RequestStatusMeta(LocalizedText(en: 'Final checks', ar: 'المراجعة النهائية'), 'info'),
    'COMPLETED': RequestStatusMeta(LocalizedText(en: 'Completed', ar: 'مكتمل'), 'success'),
    'CANCELLED': RequestStatusMeta(LocalizedText(en: 'Cancelled', ar: 'ملغي'), 'neutral'),
  };

  static RequestStatusMeta of(String status) {
    return _all[status] ?? RequestStatusMeta(LocalizedText(en: status.replaceAll('_', ' ')), 'neutral');
  }
}

/// How an external (authority / partner) status must be labelled wherever it
/// is shown (STATUS_SOURCE_LABEL in packages/types/src/requests.ts). Used as a
/// fallback when the response carries no label of its own.
const Map<String, LocalizedText> kStatusSourceLabels = <String, LocalizedText>{
  'INTERNAL': LocalizedText(en: 'TypEase internal status', ar: 'حالة داخلية'),
  'STAFF_ENTERED': LocalizedText(en: 'Entered by staff (not verified by the authority)', ar: 'أدخلها الموظف (غير مؤكدة من الجهة)'),
  'PARTNER_PROVIDED': LocalizedText(en: 'Provided by partner', ar: 'مقدمة من الشريك'),
  'VERIFIED_OFFICIAL': LocalizedText(en: 'Verified via official integration', ar: 'مؤكدة عبر الربط الرسمي'),
};

LocalizedText statusSourceLabelFor(String source, Object? fromApi) {
  final parsed = LocalizedText.fromJson(fromApi);
  if (!parsed.isEmpty) return parsed;
  // An unknown source is never presented as official.
  return kStatusSourceLabels[source] ?? kStatusSourceLabels['STAFF_ENTERED']!;
}

/// The newest status reported by an outside party, mirrored on the request.
/// It is ALWAYS shown together with [sourceLabel].
class ExternalStatus {
  const ExternalStatus({required this.status, required this.source, required this.sourceLabel, this.at});

  static ExternalStatus? fromJson(Object? json) {
    final map = asMapOrNull(json);
    if (map == null) return null;
    final status = asStringOrNull(map['status']);
    if (status == null || status.isEmpty) return null;
    final source = asString(map['source'], 'STAFF_ENTERED');
    return ExternalStatus(
      status: status,
      source: source,
      sourceLabel: statusSourceLabelFor(source, map['sourceLabel']),
      at: asStringOrNull(map['at']),
    );
  }

  final String status;
  final String source;
  final LocalizedText sourceLabel;
  final String? at;

  bool get isVerifiedOfficial => source == 'VERIFIED_OFFICIAL';
}

/// A submission to an authority or partner (`externalReferences[]`).
class ExternalReference {
  const ExternalReference({
    required this.id,
    required this.channel,
    required this.referenceNo,
    required this.statusSource,
    required this.statusSourceLabel,
    this.authorityName,
    this.status,
    this.result,
    this.recordedAt,
  });

  factory ExternalReference.fromJson(Object? json) {
    final map = asMap(json);
    final source = asString(map['statusSource'], 'STAFF_ENTERED');
    return ExternalReference(
      id: asString(map['id']),
      channel: asString(map['channel']),
      authorityName: asStringOrNull(map['authorityName']),
      referenceNo: asString(map['referenceNo']),
      status: asStringOrNull(map['status']),
      statusSource: source,
      statusSourceLabel: statusSourceLabelFor(source, map['statusSourceLabel']),
      result: asStringOrNull(map['result']),
      recordedAt: asStringOrNull(map['recordedAt']),
    );
  }

  final String id;
  final String channel;
  final String? authorityName;
  final String referenceNo;
  final String? status;
  final String statusSource;
  final LocalizedText statusSourceLabel;
  final String? result;
  final String? recordedAt;
}

/// A row of `GET /requests`.
class RequestSummary {
  const RequestSummary({
    required this.id,
    required this.requestNo,
    required this.status,
    required this.statusLabel,
    required this.paymentStatus,
    required this.serviceName,
    required this.overdue,
    this.serviceId,
    this.serviceNameAr,
    this.branchId,
    this.submittedAt,
    this.targetDate,
    this.completedAt,
    this.createdAt,
    this.updatedAt,
    this.externalStatus,
  });

  factory RequestSummary.fromJson(Object? json) {
    final map = asMap(json);
    final service = asMap(map['service']);
    final status = asString(map['status']);
    final label = LocalizedText.fromJson(map['statusLabel']);
    return RequestSummary(
      id: asString(map['id']),
      requestNo: asString(map['requestNo']),
      status: status,
      statusLabel: label.isEmpty ? RequestStatusMeta.of(status).label : label,
      paymentStatus: asString(map['paymentStatus']),
      serviceId: asStringOrNull(service['id']) ?? asStringOrNull(map['serviceId']),
      serviceName: asString(service['name'], asString(map['serviceName'])),
      serviceNameAr: asStringOrNull(service['nameAr']),
      branchId: asStringOrNull(map['branchId']),
      submittedAt: asStringOrNull(map['submittedAt']),
      targetDate: asStringOrNull(map['targetDate']),
      completedAt: asStringOrNull(map['completedAt']),
      createdAt: asStringOrNull(map['createdAt']),
      updatedAt: asStringOrNull(map['updatedAt']),
      overdue: asBool(map['overdue']),
      externalStatus: ExternalStatus.fromJson(map['externalStatus']),
    );
  }

  final String id;
  final String requestNo;
  final String status;
  final LocalizedText statusLabel;
  final String paymentStatus;
  final String? serviceId;
  final String serviceName;
  final String? serviceNameAr;
  final String? branchId;
  final String? submittedAt;
  final String? targetDate;
  final String? completedAt;
  final String? createdAt;
  final String? updatedAt;
  final bool overdue;
  final ExternalStatus? externalStatus;

  String get tone => RequestStatusMeta.of(status).tone;
  bool get isDraft => status == 'DRAFT';
  bool get isClosed => kClosedRequestStatuses.contains(status);
  bool get needsCustomerAction => kCustomerActionStatuses.contains(status);
}

/// `GET /requests/counts`
class RequestCounts {
  const RequestCounts({required this.open, required this.drafts, required this.byStatus});

  factory RequestCounts.fromJson(Object? json) {
    final map = asMap(json);
    final byStatus = <String, int>{};
    asMap(map['byStatus']).forEach((key, value) {
      byStatus[key] = asInt(value);
    });
    return RequestCounts(open: asInt(map['open']), drafts: asInt(map['drafts']), byStatus: byStatus);
  }

  /// Submitted requests that are not finished (drafts are not included).
  final int open;
  final int drafts;
  final Map<String, int> byStatus;

  int count(String status) => byStatus[status] ?? 0;

  int get completed => count('COMPLETED');

  /// Requests waiting for the customer (information, quotation, payment).
  int get needingAction => count('AWAITING_CUSTOMER') + count('QUOTED') + count('AWAITING_PAYMENT');
}

/// The document attached to a checklist line.
class ChecklistDocument {
  const ChecklistDocument({
    required this.id,
    required this.title,
    required this.status,
    required this.verificationStatus,
    this.expiryDate,
    this.uploadedAt,
  });

  factory ChecklistDocument.fromJson(Object? json) {
    final map = asMap(json);
    return ChecklistDocument(
      id: asString(map['id']),
      title: asString(map['title']),
      status: asString(map['status']),
      verificationStatus: asString(map['verificationStatus']),
      expiryDate: asStringOrNull(map['expiryDate']),
      uploadedAt: asStringOrNull(map['uploadedAt']),
    );
  }

  final String id;
  final String title;

  /// `PENDING_UPLOAD`, `PENDING_SCAN`, `AVAILABLE`, `QUARANTINED`, `DELETED`.
  final String status;

  /// `UNVERIFIED`, `VERIFIED`, `REJECTED`.
  final String verificationStatus;
  final String? expiryDate;
  final String? uploadedAt;

  bool get isAvailable => status == 'AVAILABLE';
}

/// One line of the request's document checklist.
class ChecklistItem {
  const ChecklistItem({
    required this.id,
    required this.kind,
    required this.documentTypeKey,
    required this.label,
    required this.isMandatory,
    required this.status,
    required this.actionRequired,
    this.labelAr,
    this.note,
    this.document,
  });

  factory ChecklistItem.fromJson(Object? json) {
    final map = asMap(json);
    final document = asMapOrNull(map['document']);
    return ChecklistItem(
      id: asString(map['id']),
      kind: asString(map['kind'], 'INPUT'),
      documentTypeKey: asString(map['documentTypeKey']),
      label: asString(map['label']),
      labelAr: asStringOrNull(map['labelAr']),
      isMandatory: asBool(map['isMandatory']),
      status: asString(map['status'], 'MISSING'),
      note: asStringOrNull(map['note']),
      actionRequired: asBool(map['actionRequired']),
      document: document == null ? null : ChecklistDocument.fromJson(document),
    );
  }

  final String id;

  /// `INPUT` (the customer provides it) or `COMPLETION` (the centre delivers it).
  final String kind;
  final String documentTypeKey;
  final String label;
  final String? labelAr;
  final bool isMandatory;

  /// `MISSING`, `UPLOADED`, `VERIFIED`, `REJECTED`, `WAIVED`.
  final String status;

  /// Why a document was rejected.
  final String? note;
  final bool actionRequired;
  final ChecklistDocument? document;

  bool get isInput => kind == 'INPUT';
  bool get isCompletion => kind == 'COMPLETION';
  bool get isMissing => status == 'MISSING';
  bool get isRejected => status == 'REJECTED';

  /// Accepted lines cannot be changed online any more.
  bool get isLocked => status == 'VERIFIED' || status == 'WAIVED';

  /// A mandatory line that still stops the request from being complete.
  bool get blocksSubmission => isInput && isMandatory && (isMissing || isRejected);
}

/// A customer-visible message on the request.
class RequestComment {
  const RequestComment({required this.id, required this.authorType, required this.body, this.authorName, this.createdAt});

  factory RequestComment.fromJson(Object? json) {
    final map = asMap(json);
    return RequestComment(
      id: asString(map['id']),
      authorType: asString(map['authorType']),
      authorName: asStringOrNull(map['authorName']),
      body: asString(map['body']),
      createdAt: asStringOrNull(map['createdAt']),
    );
  }

  final String id;

  /// `CUSTOMER`, `CORPORATE`, `STAFF`, ...
  final String authorType;
  final String? authorName;
  final String body;
  final String? createdAt;

  bool get fromCentre => authorType != 'CUSTOMER' && authorType != 'CORPORATE';
}

/// One customer-visible entry of the status history.
class HistoryEntry {
  const HistoryEntry({required this.id, required this.status, required this.statusLabel, this.message, this.at});

  factory HistoryEntry.fromJson(Object? json) {
    final map = asMap(json);
    final status = asString(map['status']);
    final label = LocalizedText.fromJson(map['statusLabel']);
    return HistoryEntry(
      id: asString(map['id']),
      status: status,
      statusLabel: label.isEmpty ? RequestStatusMeta.of(status).label : label,
      message: asStringOrNull(map['message']),
      at: asStringOrNull(map['at']),
    );
  }

  final String id;
  final String status;
  final LocalizedText statusLabel;

  /// A message for the customer; equals the status wording when the centre
  /// wrote nothing specific.
  final String? message;
  final String? at;
}

/// A customer-visible workflow step.
class WorkflowStep {
  const WorkflowStep({
    required this.key,
    required this.name,
    required this.type,
    required this.status,
    required this.current,
    this.nameAr,
    this.startedAt,
    this.completedAt,
  });

  factory WorkflowStep.fromJson(Object? json) {
    final map = asMap(json);
    return WorkflowStep(
      key: asString(map['key']),
      name: asString(map['name']),
      nameAr: asStringOrNull(map['nameAr']),
      type: asString(map['type']),
      status: asString(map['status'], 'PENDING'),
      current: asBool(map['current']),
      startedAt: asStringOrNull(map['startedAt']),
      completedAt: asStringOrNull(map['completedAt']),
    );
  }

  final String key;
  final String name;
  final String? nameAr;
  final String type;

  /// `PENDING`, `ACTIVE`, `COMPLETED`, `SKIPPED`, `FAILED`, `TIMED_OUT`, `CANCELLED`.
  final String status;
  final bool current;
  final String? startedAt;
  final String? completedAt;

  bool get isDone => status == 'COMPLETED' || status == 'SKIPPED';
}

/// An edge of the state machine the signed-in customer may use now.
class AllowedTransition {
  const AllowedTransition({
    required this.to,
    required this.action,
    required this.requiresReason,
    required this.enabled,
    this.blockedCode,
    this.blockedMessage,
  });

  factory AllowedTransition.fromJson(Object? json) {
    final map = asMap(json);
    final blocked = asMap(map['blocked']);
    return AllowedTransition(
      to: asString(map['to']),
      action: asString(map['action']),
      requiresReason: asBool(map['requiresReason']),
      enabled: asBool(map['enabled']),
      blockedCode: asStringOrNull(blocked['code']),
      blockedMessage: asStringOrNull(blocked['message']),
    );
  }

  final String to;
  final String action;
  final bool requiresReason;
  final bool enabled;
  final String? blockedCode;
  final String? blockedMessage;
}

/// Summary of the request's quotation inside the case view.
class RequestQuotationRef {
  const RequestQuotationRef({required this.id, required this.quotationNo, required this.status, required this.total, required this.currency, this.validUntil});

  factory RequestQuotationRef.fromJson(Object? json) {
    final map = asMap(json);
    return RequestQuotationRef(
      id: asString(map['id']),
      quotationNo: asString(map['quotationNo']),
      status: asString(map['status']),
      total: asString(map['total'], '0.00'),
      currency: asString(map['currency'], 'AED'),
      validUntil: asStringOrNull(map['validUntil']),
    );
  }

  final String id;
  final String quotationNo;
  final String status;
  final String total;
  final String currency;
  final String? validUntil;
}

/// Summary of an invoice inside the case view.
class RequestInvoiceRef {
  const RequestInvoiceRef({
    required this.id,
    required this.invoiceNo,
    required this.status,
    required this.total,
    required this.amountPaid,
    required this.balanceDue,
    required this.currency,
  });

  factory RequestInvoiceRef.fromJson(Object? json, String fallbackCurrency) {
    final map = asMap(json);
    return RequestInvoiceRef(
      id: asString(map['id']),
      invoiceNo: asString(map['invoiceNo']),
      status: asString(map['status']),
      total: asString(map['total'], '0.00'),
      amountPaid: asString(map['amountPaid'], '0.00'),
      balanceDue: asString(map['balanceDue'], '0.00'),
      currency: asString(map['currency'], fallbackCurrency),
    );
  }

  final String id;
  final String invoiceNo;
  final String status;
  final String total;
  final String amountPaid;
  final String balanceDue;
  final String currency;

  bool get isPayable => status == 'ISSUED' || status == 'PARTIALLY_PAID';
}

/// A valid document already on the customer's file that may satisfy a
/// checklist line (`reuseCandidates[]` of `POST /requests`).
class ReuseCandidate {
  const ReuseCandidate({required this.checklistItemId, required this.documentId, required this.title, required this.linked, this.expiryDate});

  factory ReuseCandidate.fromJson(Object? json) {
    final map = asMap(json);
    return ReuseCandidate(
      checklistItemId: asString(map['checklistItemId']),
      documentId: asString(map['documentId']),
      title: asString(map['title']),
      expiryDate: asStringOrNull(map['expiryDate']),
      linked: asBool(map['linked']),
    );
  }

  final String checklistItemId;
  final String documentId;
  final String title;
  final String? expiryDate;

  /// True when the server linked it automatically (the customer has given
  /// the "document reuse" consent).
  final bool linked;
}

/// The full case view (`GET /requests/:id`), as returned to a customer.
class RequestDetail {
  const RequestDetail({
    required this.id,
    required this.requestNo,
    required this.status,
    required this.statusLabel,
    required this.tone,
    required this.paymentStatus,
    required this.version,
    required this.serviceId,
    required this.serviceName,
    required this.overdue,
    required this.formSchema,
    required this.formValues,
    required this.checklist,
    required this.externalReferences,
    required this.comments,
    required this.invoices,
    required this.workflowSteps,
    required this.transitions,
    required this.otherActions,
    required this.history,
    required this.reuseCandidates,
    required this.nextStepText,
    this.serviceNameAr,
    this.branchName,
    this.branchNameAr,
    this.customerInstructions,
    this.submittedAt,
    this.targetDate,
    this.completedAt,
    this.cancelledAt,
    this.createdAt,
    this.externalStatus,
    this.quotation,
    this.totalInvoiced,
    this.totalPaid,
    this.totalBalance,
    this.waitingOn,
    this.trackingCode,
  });

  factory RequestDetail.fromJson(Object? json) {
    final map = asMap(json);
    final service = asMap(map['service']);
    final branch = asMap(map['branch']);
    final form = asMap(map['form']);
    final finance = asMap(map['finance']);
    final totals = asMap(finance['totals']);
    final workflow = asMap(map['workflow']);
    final allowed = asMap(map['allowedActions']);
    final nextStep = asMap(map['nextStep']);
    final status = asString(map['status']);
    final label = LocalizedText.fromJson(map['statusLabel']);
    final meta = RequestStatusMeta.of(status);
    final quotation = asMapOrNull(finance['quotation']);
    final quotationRef = quotation == null ? null : RequestQuotationRef.fromJson(quotation);
    final currency = quotationRef?.currency ?? 'AED';

    final values = <String, Object?>{};
    asMap(form['values']).forEach((key, value) {
      values[key] = value;
    });

    return RequestDetail(
      id: asString(map['id']),
      requestNo: asString(map['requestNo']),
      status: status,
      statusLabel: label.isEmpty ? meta.label : label,
      tone: asString(map['tone'], meta.tone),
      paymentStatus: asString(map['paymentStatus']),
      version: asInt(map['version'], 1),
      serviceId: asString(service['id']),
      serviceName: asString(service['name']),
      serviceNameAr: asStringOrNull(service['nameAr']),
      branchName: asStringOrNull(branch['name']),
      branchNameAr: asStringOrNull(branch['nameAr']),
      customerInstructions: asStringOrNull(map['customerInstructions']),
      submittedAt: asStringOrNull(map['submittedAt']),
      targetDate: asStringOrNull(map['targetDate']),
      completedAt: asStringOrNull(map['completedAt']),
      cancelledAt: asStringOrNull(map['cancelledAt']),
      createdAt: asStringOrNull(map['createdAt']),
      overdue: asBool(map['overdue']),
      externalStatus: ExternalStatus.fromJson(map['externalStatus']),
      formSchema: FormSchema.fromJson(form['schema']),
      formValues: values,
      checklist: asMapList(map['checklist']).map(ChecklistItem.fromJson).toList(growable: false),
      externalReferences: asMapList(map['externalReferences']).map(ExternalReference.fromJson).toList(growable: false),
      comments: asMapList(map['comments']).map(RequestComment.fromJson).toList(growable: false),
      quotation: quotationRef,
      invoices: asMapList(finance['invoices']).map((i) => RequestInvoiceRef.fromJson(i, currency)).toList(growable: false),
      totalInvoiced: asStringOrNull(totals['invoiced']),
      totalPaid: asStringOrNull(totals['paid']),
      totalBalance: asStringOrNull(totals['balance']),
      workflowSteps: asMapList(workflow['steps']).map(WorkflowStep.fromJson).toList(growable: false),
      transitions: asMapList(allowed['transitions']).map(AllowedTransition.fromJson).toList(growable: false),
      otherActions: asStringList(allowed['other']),
      waitingOn: asStringOrNull(nextStep['waitingOn']),
      nextStepText: LocalizedText.fromJson(nextStep['text']),
      history: asMapList(map['history']).map(HistoryEntry.fromJson).toList(growable: false),
      reuseCandidates: asMapList(map['reuseCandidates']).map(ReuseCandidate.fromJson).toList(growable: false),
      trackingCode: asStringOrNull(map['trackingCode']),
    );
  }

  final String id;
  final String requestNo;
  final String status;
  final LocalizedText statusLabel;

  /// `neutral`, `info`, `warning`, `success` or `danger`.
  final String tone;
  final String paymentStatus;

  /// Optimistic-concurrency version, sent back with detail changes.
  final int version;
  final String serviceId;
  final String serviceName;
  final String? serviceNameAr;
  final String? branchName;
  final String? branchNameAr;
  final String? customerInstructions;
  final String? submittedAt;
  final String? targetDate;
  final String? completedAt;
  final String? cancelledAt;
  final String? createdAt;
  final bool overdue;
  final ExternalStatus? externalStatus;
  final FormSchema formSchema;
  final Map<String, Object?> formValues;
  final List<ChecklistItem> checklist;
  final List<ExternalReference> externalReferences;
  final List<RequestComment> comments;
  final RequestQuotationRef? quotation;
  final List<RequestInvoiceRef> invoices;
  final String? totalInvoiced;
  final String? totalPaid;
  final String? totalBalance;
  final List<WorkflowStep> workflowSteps;
  final List<AllowedTransition> transitions;

  /// Further things the customer can do now: `edit_fields`, `edit_details`,
  /// `upload_documents`, `resubmit`, `comment`.
  final List<String> otherActions;

  /// `CUSTOMER`, `CENTRE`, `AUTHORITY` or `NOBODY`.
  final String? waitingOn;

  /// "What happens next" in plain words.
  final LocalizedText nextStepText;
  final List<HistoryEntry> history;
  final List<ReuseCandidate> reuseCandidates;

  /// Only present in the response of `submit`. Shown once; the server keeps
  /// only its hash.
  final String? trackingCode;

  bool get isDraft => status == 'DRAFT';
  bool get isClosed => kClosedRequestStatuses.contains(status);
  bool get isCompleted => status == 'COMPLETED';
  bool get awaitingCustomer => status == 'AWAITING_CUSTOMER';

  bool can(String action) => otherActions.contains(action);

  List<ChecklistItem> get inputItems => checklist.where((c) => c.isInput).toList(growable: false);
  List<ChecklistItem> get completionItems => checklist.where((c) => c.isCompletion).toList(growable: false);

  AllowedTransition? transitionTo(String status) {
    for (final transition in transitions) {
      if (transition.to == status) return transition;
    }
    return null;
  }

  String currencyOr(String fallback) => quotation?.currency ?? (invoices.isNotEmpty ? invoices.first.currency : fallback);
}
