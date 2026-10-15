import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/document_models.dart';
import '../data/documents_repository.dart';

/// Reuse suggestions and per-line hints for a request's checklist.
final checklistAssistProvider = FutureProvider.autoDispose.family<ChecklistAssist, String>((ref, requestId) {
  return ref.watch(documentsRepositoryProvider).checklistAssist(requestId);
});

/// The customer's own documents (used when attaching one to a support ticket).
final myDocumentsProvider = FutureProvider.autoDispose<List<DocumentItem>>((ref) async {
  final page = await ref.watch(documentsRepositoryProvider).list(pageSize: 50);
  return page.items;
});

/// Document types, for uploads that are not tied to a checklist line.
final documentTypesProvider = FutureProvider.autoDispose<List<DocumentType>>((ref) {
  return ref.watch(documentsRepositoryProvider).documentTypes();
});
