import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_exception.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/page.dart';
import '../../../core/network/url_rewriter.dart';
import '../../../core/providers.dart';
import '../../../core/utils/json.dart';
import 'document_models.dart';
import 'upload_rules.dart';

/// A file chosen on the device, checked and ready to upload.
class LocalFile {
  const LocalFile({required this.path, required this.name, required this.mime, required this.sizeBytes});

  final String path;
  final String name;
  final String mime;
  final int sizeBytes;

  bool get isImage => mime.startsWith('image/');
}

/// Thrown when a chosen file fails the checks before upload.
class LocalFileRejected implements Exception {
  const LocalFileRejected(this.reason, this.name);

  /// `empty`, `tooLarge`, `type` or `unreadable`.
  final String reason;
  final String name;
}

/// What an upload is filed under.
class UploadTarget {
  const UploadTarget({required this.documentTypeKey, this.requestId, this.checklistItemId, this.title, this.expiryDate});

  final String documentTypeKey;
  final String? requestId;
  final String? checklistItemId;
  final String? title;

  /// `YYYY-MM-DD`, as stated by the customer (unverified until staff confirm).
  final String? expiryDate;
}

class DocumentsRepository {
  DocumentsRepository(this._api, this._rewriter, [Dio? transfer]) : _transfer = transfer ?? _defaultTransferClient();

  final ApiClient _api;
  final UrlRewriter _rewriter;

  /// A bare client for the signed upload URL: no base URL, no interceptors
  /// and - importantly - no `Authorization` header.
  final Dio _transfer;

  static Dio _defaultTransferClient() {
    return Dio(
      BaseOptions(
        connectTimeout: const Duration(seconds: 20),
        sendTimeout: const Duration(minutes: 5),
        receiveTimeout: const Duration(seconds: 60),
        responseType: ResponseType.plain,
      ),
    );
  }

  /// Reads size and real type of a picked file and applies [UploadRules].
  /// Throws [LocalFileRejected].
  static Future<LocalFile> inspect({required String path, required String name}) async {
    final file = File(path);
    int size;
    List<int> head;
    try {
      size = await file.length();
      final opened = await file.open();
      try {
        head = await opened.read(16);
      } finally {
        await opened.close();
      }
    } catch (_) {
      throw LocalFileRejected('unreadable', name);
    }
    // The content decides; the name is only a fallback for the message.
    final mime = UploadRules.sniffMime(head);
    final reason = UploadRules.problem(sizeBytes: size, mime: mime);
    if (reason != null || mime == null) throw LocalFileRejected(reason ?? 'type', name);
    return LocalFile(path: path, name: UploadRules.cleanName(name, mime), mime: mime, sizeBytes: size);
  }

  /// `GET /documents` - the customer's own documents.
  Future<Page<DocumentItem>> list({String? requestId, int page = 1, int pageSize = 50}) async {
    final json = await _api.get(
      '/documents',
      query: <String, dynamic>{'requestId': requestId, 'page': page, 'pageSize': pageSize, 'sort': 'createdAt:desc'},
    );
    return Page<DocumentItem>.fromJson(json, DocumentItem.fromJson);
  }

  /// `GET /document-types` - the centre's document types (platform defaults
  /// merged with its own).
  Future<List<DocumentType>> documentTypes() async {
    final json = await _api.get('/document-types');
    return asMapList(json).map(DocumentType.fromJson).where((t) => t.key.isNotEmpty).toList(growable: false);
  }

  /// `GET /documents/checklist-assist?requestId=`
  Future<ChecklistAssist> checklistAssist(String requestId) async {
    final json = await _api.get('/documents/checklist-assist', query: <String, dynamic>{'requestId': requestId});
    return ChecklistAssist.fromJson(json);
  }

  /// `POST /documents/:id/download-link` - a short-lived signed link.
  Future<DownloadLink> downloadLink(String documentId) async {
    final json = await _api.post('/documents/$documentId/download-link', body: <String, dynamic>{'disposition': 'attachment'});
    final link = DownloadLink.fromJson(json);
    return DownloadLink(url: _rewriter.rewrite(link.url), filename: link.filename, mime: link.mime, expiresAt: link.expiresAt);
  }

  /// `POST /documents/:id/preview-link` - opens PDFs and images inline.
  Future<DownloadLink> previewLink(String documentId) async {
    final json = await _api.post('/documents/$documentId/preview-link');
    final link = DownloadLink.fromJson(json);
    return DownloadLink(url: _rewriter.rewrite(link.url), filename: link.filename, mime: link.mime, expiresAt: link.expiresAt);
  }

  /// The three-step upload:
  ///  1. `POST /documents/upload-intents` (declares name, type and exact size);
  ///  2. `PUT` the bytes to the returned one-time URL, with exactly the
  ///     headers the server asked for (progress is reported here);
  ///  3. `POST /documents/:id/versions/:versionId/complete`.
  Future<UploadSummary> upload({
    required LocalFile file,
    required UploadTarget target,
    void Function(double fraction)? onProgress,
    CancelToken? cancelToken,
  }) async {
    final intent = await _createIntent(file, target);
    await _putBytes(file, intent, onProgress: onProgress, cancelToken: cancelToken);
    final json = await _api.post('/documents/${intent.documentId}/versions/${intent.versionId}/complete');
    return UploadSummary.fromJson(json);
  }

  Future<UploadIntent> _createIntent(LocalFile file, UploadTarget target) async {
    final body = <String, dynamic>{
      'documentTypeKey': target.documentTypeKey,
      'filename': file.name,
      'mime': file.mime,
      'sizeBytes': file.sizeBytes,
    };
    final requestId = target.requestId;
    final checklistItemId = target.checklistItemId;
    final title = target.title;
    final expiryDate = target.expiryDate;
    if (requestId != null) body['requestId'] = requestId;
    if (checklistItemId != null) body['checklistItemId'] = checklistItemId;
    if (title != null && title.trim().isNotEmpty) body['title'] = title.trim();
    if (expiryDate != null && expiryDate.isNotEmpty) body['expiryDate'] = expiryDate;
    final intent = UploadIntent.fromJson(await _api.post('/documents/upload-intents', body: body));
    if (!intent.isValid) {
      throw const ApiException(kind: ApiErrorKind.unknown, code: 'INVALID_UPLOAD_INTENT', message: '');
    }
    return intent;
  }

  Future<void> _putBytes(
    LocalFile file,
    UploadIntent intent, {
    void Function(double fraction)? onProgress,
    CancelToken? cancelToken,
  }) async {
    // Send exactly the headers the server asked for. The content type goes
    // through Dio's own option (header names are case-insensitive, and Dio
    // must not see the same header twice).
    final headers = <String, dynamic>{};
    String contentType = file.mime;
    intent.headers.forEach((key, value) {
      if (key.toLowerCase() == 'content-type') {
        contentType = value;
      } else {
        headers[key] = value;
      }
    });
    // The upload URL accepts a body of exactly the declared size.
    headers[Headers.contentLengthHeader] = file.sizeBytes;
    try {
      await _transfer.request<dynamic>(
        _rewriter.rewrite(intent.url),
        data: File(file.path).openRead(),
        options: Options(method: intent.method, headers: headers, contentType: contentType),
        cancelToken: cancelToken,
        onSendProgress: (sent, total) {
          final callback = onProgress;
          if (callback == null) return;
          final size = total > 0 ? total : file.sizeBytes;
          if (size <= 0) return;
          final fraction = sent / size;
          callback(fraction > 1 ? 1 : fraction);
        },
      );
    } on DioException catch (error) {
      throw ApiException.fromDio(error);
    }
  }
}

final documentsRepositoryProvider = Provider<DocumentsRepository>((ref) {
  return DocumentsRepository(ref.watch(apiClientProvider), ref.watch(urlRewriterProvider));
});
