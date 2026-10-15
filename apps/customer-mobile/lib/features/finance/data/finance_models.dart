import '../../../core/utils/json.dart';
import '../../../core/utils/money.dart';

/// A line of a quotation or an invoice.
class MoneyLine {
  const MoneyLine({
    required this.description,
    required this.component,
    required this.quantity,
    required this.unitAmount,
    required this.discountAmount,
    required this.taxAmount,
    required this.lineTotal,
    this.taxRatePercent,
  });

  factory MoneyLine.fromJson(Object? json) {
    final map = asMap(json);
    return MoneyLine(
      description: asString(map['description']),
      component: asString(map['component']),
      quantity: asString(map['quantity'], '1'),
      unitAmount: asString(map['unitAmount'], '0.00'),
      discountAmount: asString(map['discountAmount'], '0.00'),
      taxRatePercent: asStringOrNull(map['taxRatePercent']),
      taxAmount: asString(map['taxAmount'], '0.00'),
      lineTotal: asString(map['lineTotal'], '0.00'),
    );
  }

  final String description;

  /// `SERVICE_FEE`, `GOVERNMENT_FEE` or `THIRD_PARTY_FEE`.
  final String component;
  final String quantity;
  final String unitAmount;
  final String discountAmount;
  final String? taxRatePercent;
  final String taxAmount;
  final String lineTotal;

  /// Quantity x unit amount is not recomputed on the device: the amount
  /// before tax is derived exactly from the server's own figures.
  String get netAmount => (Decimal.parseOrZero(lineTotal) - Decimal.parseOrZero(taxAmount)).toStringAsFixed(2);
}

/// The totals every quotation and invoice carries. Service fees, government
/// fees and third-party charges are always kept apart.
class MoneyTotals {
  const MoneyTotals({
    required this.currency,
    required this.subtotalServiceFee,
    required this.subtotalGovernmentFee,
    required this.subtotalThirdParty,
    required this.discountTotal,
    required this.taxTotal,
    required this.total,
  });

  factory MoneyTotals.fromJson(JsonMap map) {
    return MoneyTotals(
      currency: asString(map['currency'], 'AED'),
      subtotalServiceFee: asString(map['subtotalServiceFee'], '0.00'),
      subtotalGovernmentFee: asString(map['subtotalGovernmentFee'], '0.00'),
      subtotalThirdParty: asString(map['subtotalThirdParty'], '0.00'),
      discountTotal: asString(map['discountTotal'], '0.00'),
      taxTotal: asString(map['taxTotal'], '0.00'),
      total: asString(map['total'], '0.00'),
    );
  }

  final String currency;
  final String subtotalServiceFee;
  final String subtotalGovernmentFee;
  final String subtotalThirdParty;
  final String discountTotal;
  final String taxTotal;
  final String total;
}

class Quotation {
  const Quotation({
    required this.id,
    required this.quotationNo,
    required this.status,
    required this.totals,
    required this.expired,
    required this.items,
    this.requestId,
    this.requestNo,
    this.validUntil,
    this.notes,
    this.sentAt,
    this.decidedAt,
    this.rejectionReason,
    this.invoiceId,
    this.invoiceNo,
  });

  factory Quotation.fromJson(Object? json) {
    final map = asMap(json);
    final request = asMap(map['request']);
    final invoice = asMap(map['invoice']);
    return Quotation(
      id: asString(map['id']),
      quotationNo: asString(map['quotationNo']),
      status: asString(map['status']),
      totals: MoneyTotals.fromJson(map),
      expired: asBool(map['expired']),
      items: asMapList(map['quotationItems']).map(MoneyLine.fromJson).toList(growable: false),
      requestId: asStringOrNull(map['requestId']),
      requestNo: asStringOrNull(request['requestNo']),
      validUntil: asStringOrNull(map['validUntil']),
      notes: asStringOrNull(map['notes']),
      sentAt: asStringOrNull(map['sentAt']),
      decidedAt: asStringOrNull(map['decidedAt']),
      rejectionReason: asStringOrNull(map['rejectionReason']),
      invoiceId: asStringOrNull(invoice['id']),
      invoiceNo: asStringOrNull(invoice['invoiceNo']),
    );
  }

  final String id;
  final String quotationNo;

  /// `SENT`, `APPROVED`, `REJECTED`, `EXPIRED`, `SUPERSEDED`, `CANCELLED`.
  final String status;
  final MoneyTotals totals;
  final bool expired;
  final List<MoneyLine> items;
  final String? requestId;
  final String? requestNo;
  final String? validUntil;
  final String? notes;
  final String? sentAt;
  final String? decidedAt;
  final String? rejectionReason;
  final String? invoiceId;
  final String? invoiceNo;

  /// The customer can still approve or reject it.
  bool get awaitingDecision => status == 'SENT' && !expired;
}

/// Result of `POST /quotations/:id/approve`.
class QuotationApproval {
  const QuotationApproval({required this.quotation, this.invoiceId, this.invoiceNo});

  factory QuotationApproval.fromJson(Object? json) {
    final map = asMap(json);
    final invoice = asMap(map['invoice']);
    return QuotationApproval(
      quotation: Quotation.fromJson(map['quotation']),
      invoiceId: asStringOrNull(invoice['id']),
      invoiceNo: asStringOrNull(invoice['invoiceNo']),
    );
  }

  final Quotation quotation;
  final String? invoiceId;
  final String? invoiceNo;
}

/// A payment as listed inside an invoice (`invoice.payments[]`).
class InvoicePayment {
  const InvoicePayment({
    required this.id,
    required this.method,
    required this.status,
    required this.amount,
    required this.allocated,
    this.paymentNo,
    this.receiptNo,
    this.receivedAt,
  });

  factory InvoicePayment.fromJson(Object? json) {
    final map = asMap(json);
    return InvoicePayment(
      id: asString(map['id']),
      paymentNo: asStringOrNull(map['paymentNo']),
      receiptNo: asStringOrNull(map['receiptNo']),
      method: asString(map['method']),
      status: asString(map['status']),
      amount: asString(map['amount'], '0.00'),
      allocated: asString(map['allocated'], asString(map['amount'], '0.00')),
      receivedAt: asStringOrNull(map['receivedAt']),
    );
  }

  final String id;
  final String? paymentNo;
  final String? receiptNo;
  final String method;
  final String status;
  final String amount;

  /// The part of the payment that settled this invoice.
  final String allocated;
  final String? receivedAt;
}

class Invoice {
  const Invoice({
    required this.id,
    required this.invoiceNo,
    required this.status,
    required this.totals,
    required this.amountPaid,
    required this.amountCredited,
    required this.amountRefunded,
    required this.balanceDue,
    required this.overdue,
    required this.items,
    required this.payments,
    this.requestId,
    this.requestNo,
    this.quotationNo,
    this.issuedAt,
    this.dueAt,
    this.notes,
  });

  factory Invoice.fromJson(Object? json) {
    final map = asMap(json);
    final request = asMap(map['request']);
    final quotation = asMap(map['quotation']);
    return Invoice(
      id: asString(map['id']),
      invoiceNo: asString(map['invoiceNo']),
      status: asString(map['status']),
      totals: MoneyTotals.fromJson(map),
      amountPaid: asString(map['amountPaid'], '0.00'),
      amountCredited: asString(map['amountCredited'], '0.00'),
      amountRefunded: asString(map['amountRefunded'], '0.00'),
      balanceDue: asString(map['balanceDue'], '0.00'),
      overdue: asBool(map['overdue']),
      items: asMapList(map['invoiceItems']).map(MoneyLine.fromJson).toList(growable: false),
      payments: asMapList(map['payments']).map(InvoicePayment.fromJson).toList(growable: false),
      requestId: asStringOrNull(map['requestId']),
      requestNo: asStringOrNull(request['requestNo']),
      quotationNo: asStringOrNull(quotation['quotationNo']),
      issuedAt: asStringOrNull(map['issuedAt']),
      dueAt: asStringOrNull(map['dueAt']),
      notes: asStringOrNull(map['notes']),
    );
  }

  final String id;
  final String invoiceNo;

  /// `ISSUED`, `PARTIALLY_PAID`, `PAID`, `VOID`, `CREDITED`.
  final String status;
  final MoneyTotals totals;
  final String amountPaid;
  final String amountCredited;
  final String amountRefunded;
  final String balanceDue;
  final bool overdue;
  final List<MoneyLine> items;
  final List<InvoicePayment> payments;
  final String? requestId;
  final String? requestNo;
  final String? quotationNo;
  final String? issuedAt;
  final String? dueAt;
  final String? notes;

  bool get isPayable => (status == 'ISSUED' || status == 'PARTIALLY_PAID') && Money.isPositive(balanceDue);
}

/// A row of `GET /payments`.
class Payment {
  const Payment({
    required this.id,
    required this.method,
    required this.status,
    required this.amount,
    required this.refundedAmount,
    required this.currency,
    this.paymentNo,
    this.receiptNo,
    this.reference,
    this.failureReason,
    this.receivedAt,
    this.createdAt,
  });

  factory Payment.fromJson(Object? json) {
    final map = asMap(json);
    return Payment(
      id: asString(map['id']),
      paymentNo: asStringOrNull(map['paymentNo']),
      receiptNo: asStringOrNull(map['receiptNo']),
      method: asString(map['method']),
      status: asString(map['status']),
      amount: asString(map['amount'], '0.00'),
      refundedAmount: asString(map['refundedAmount'], '0.00'),
      currency: asString(map['currency'], 'AED'),
      reference: asStringOrNull(map['reference']),
      failureReason: asStringOrNull(map['failureReason']),
      receivedAt: asStringOrNull(map['receivedAt']),
      createdAt: asStringOrNull(map['createdAt']),
    );
  }

  final String id;
  final String? paymentNo;
  final String? receiptNo;

  /// `CASH`, `CARD_POS`, `BANK_TRANSFER`, `CHEQUE`, `ONLINE_GATEWAY`.
  final String method;

  /// `PENDING`, `COMPLETED`, `FAILED`, `CANCELLED`, `PARTIALLY_REFUNDED`, `REFUNDED`.
  final String status;
  final String amount;
  final String refundedAmount;
  final String currency;
  final String? reference;
  final String? failureReason;
  final String? receivedAt;
  final String? createdAt;
}

/// Result of `POST /invoices/:id/pay`: a hosted checkout to open. Nothing is
/// paid until the gateway confirms it to the server.
class PaymentStart {
  const PaymentStart({
    required this.paymentId,
    required this.amount,
    required this.currency,
    required this.gateway,
    required this.testMode,
    required this.checkoutUrl,
    this.expiresAt,
  });

  factory PaymentStart.fromJson(Object? json) {
    final map = asMap(json);
    return PaymentStart(
      paymentId: asString(map['paymentId']),
      amount: asString(map['amount'], '0.00'),
      currency: asString(map['currency'], 'AED'),
      gateway: asString(map['gateway']),
      testMode: asBool(map['testMode']),
      checkoutUrl: asString(map['checkoutUrl']),
      expiresAt: asStringOrNull(map['expiresAt']),
    );
  }

  final String paymentId;
  final String amount;
  final String currency;
  final String gateway;
  final bool testMode;
  final String checkoutUrl;
  final String? expiresAt;

  /// The TypEase test gateway of development environments. It has no web
  /// page; the app completes or fails the test payment itself.
  bool get isSandbox => gateway == 'sandbox' && testMode;
}
