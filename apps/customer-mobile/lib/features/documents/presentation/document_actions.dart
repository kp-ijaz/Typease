import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/widgets/feedback.dart';
import '../data/documents_repository.dart';

/// Opens a URL outside the app (browser, PDF viewer). Returns false when no
/// application could open it.
Future<bool> openExternalUrl(String url) async {
  final uri = Uri.tryParse(url);
  if (uri == null) return false;
  try {
    return await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (_) {
    return false;
  }
}

/// Fetches a short-lived signed link for a vault document and opens it.
/// The link is requested at the moment of the tap because it expires within
/// minutes; it is never stored.
Future<void> openDocument(BuildContext context, WidgetRef ref, String documentId, {bool download = false}) async {
  final l10n = context.l10n;
  final messenger = ScaffoldMessenger.maybeOf(context);
  try {
    final repository = ref.read(documentsRepositoryProvider);
    final link = download ? await repository.downloadLink(documentId) : await repository.previewLink(documentId);
    final opened = await openExternalUrl(link.url);
    if (!opened && messenger != null) {
      messenger.showSnackBar(SnackBar(content: Text(l10n.t('documentCannotOpen'))));
    }
  } catch (error) {
    if (messenger != null) {
      messenger.showSnackBar(SnackBar(content: Text(describeError(l10n, error))));
    }
  }
}
