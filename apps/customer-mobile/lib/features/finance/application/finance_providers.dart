import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/finance_models.dart';
import '../data/finance_repository.dart';

final quotationsProvider = FutureProvider.autoDispose<List<Quotation>>((ref) async {
  final page = await ref.watch(financeRepositoryProvider).quotations();
  return page.items;
});

final quotationProvider = FutureProvider.autoDispose.family<Quotation, String>((ref, id) {
  return ref.watch(financeRepositoryProvider).quotation(id);
});

final invoicesProvider = FutureProvider.autoDispose<List<Invoice>>((ref) async {
  final page = await ref.watch(financeRepositoryProvider).invoices();
  return page.items;
});

final invoiceProvider = FutureProvider.autoDispose.family<Invoice, String>((ref, id) {
  return ref.watch(financeRepositoryProvider).invoice(id);
});

final paymentsProvider = FutureProvider.autoDispose<List<Payment>>((ref) async {
  final page = await ref.watch(financeRepositoryProvider).payments();
  return page.items;
});
