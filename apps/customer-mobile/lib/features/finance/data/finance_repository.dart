import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/page.dart';
import '../../../core/network/url_rewriter.dart';
import '../../../core/providers.dart';
import 'finance_models.dart';

class FinanceRepository {
  FinanceRepository(this._api, this._rewriter);

  final ApiClient _api;
  final UrlRewriter _rewriter;

  /// `GET /quotations` - the customer's own quotations (once sent).
  Future<Page<Quotation>> quotations({String? requestId, int page = 1, int pageSize = 50}) async {
    final json = await _api.get(
      '/quotations',
      query: <String, dynamic>{'requestId': requestId, 'page': page, 'pageSize': pageSize},
    );
    return Page<Quotation>.fromJson(json, Quotation.fromJson);
  }

  /// `GET /quotations/:id`
  Future<Quotation> quotation(String id) async => Quotation.fromJson(await _api.get('/quotations/$id'));

  /// `POST /quotations/:id/approve` - also issues the invoice.
  Future<QuotationApproval> approveQuotation(String id) async {
    final json = await _api.post('/quotations/$id/approve', body: <String, dynamic>{});
    return QuotationApproval.fromJson(json);
  }

  /// `POST /quotations/:id/reject`
  Future<Quotation> rejectQuotation(String id, String reason) async {
    final json = await _api.post('/quotations/$id/reject', body: <String, dynamic>{'reason': reason});
    return Quotation.fromJson(json);
  }

  /// `GET /invoices` - the customer's own issued invoices.
  Future<Page<Invoice>> invoices({String? requestId, int page = 1, int pageSize = 50}) async {
    final json = await _api.get(
      '/invoices',
      query: <String, dynamic>{'requestId': requestId, 'page': page, 'pageSize': pageSize},
    );
    return Page<Invoice>.fromJson(json, Invoice.fromJson);
  }

  /// `GET /invoices/:id`
  Future<Invoice> invoice(String id) async => Invoice.fromJson(await _api.get('/invoices/$id'));

  /// `GET /payments`
  Future<Page<Payment>> payments({int page = 1, int pageSize = 50}) async {
    final json = await _api.get('/payments', query: <String, dynamic>{'page': page, 'pageSize': pageSize});
    return Page<Payment>.fromJson(json, Payment.fromJson);
  }

  /// `POST /invoices/:id/pay` - opens a checkout session at the centre's
  /// payment gateway. Answers 503 `INTEGRATION_NOT_CONFIGURED` when the centre
  /// has no online payment.
  ///
  /// [returnUrl] must be an address of the centre's own web portal; the API
  /// rejects anything else (`INVALID_RETURN_URL`), including custom schemes.
  Future<PaymentStart> payInvoice(String id, {String? returnUrl}) async {
    final body = <String, dynamic>{};
    if (returnUrl != null && returnUrl.isNotEmpty) body['returnUrl'] = returnUrl;
    final start = PaymentStart.fromJson(await _api.post('/invoices/$id/pay', body: body));
    return PaymentStart(
      paymentId: start.paymentId,
      amount: start.amount,
      currency: start.currency,
      gateway: start.gateway,
      testMode: start.testMode,
      checkoutUrl: _rewriter.rewrite(start.checkoutUrl),
      expiresAt: start.expiresAt,
    );
  }

  /// Development only: finishes a payment at the TypEase sandbox gateway
  /// (`POST <checkoutUrl>/complete` or `/fail`). No money moves.
  Future<void> finishSandboxPayment(PaymentStart start, {required bool succeed}) async {
    final client = Dio(BaseOptions(connectTimeout: const Duration(seconds: 15), receiveTimeout: const Duration(seconds: 30)));
    try {
      final action = succeed ? 'complete' : 'fail';
      await client.post<dynamic>('${start.checkoutUrl}/$action');
    } on DioException catch (error) {
      throw ApiException.fromDio(error);
    } finally {
      client.close();
    }
  }
}

final financeRepositoryProvider = Provider<FinanceRepository>((ref) {
  return FinanceRepository(ref.watch(apiClientProvider), ref.watch(urlRewriterProvider));
});
