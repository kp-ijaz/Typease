import '../../../core/utils/json.dart';

/// A document in the vault (`GET /documents`). Bytes are never part of the
/// JSON API: files are fetched through short-lived signed links.
class DocumentItem {
  const DocumentItem({
    required this.id,
    required this.documentTypeKey,
    required this.title,
    required this.status,
    required this.verificationStatus,
    required this.isCompletionDocument,
    required this.downloadable,
    this.requestId,
    this.expiryDate,
    this.createdAt,
    this.filename,
    this.mime,
    this.sizeBytes,
  });

  factory DocumentItem.fromJson(Object? json) {
    final map = asMap(json);
    final version = asMap(map['currentVersion']);
    return DocumentItem(
      id: asString(map['id']),
      requestId: asStringOrNull(map['requestId']),
      documentTypeKey: asString(map['documentTypeKey']),
      title: asString(map['title']),
      status: asString(map['status']),
      verificationStatus: asString(map['verificationStatus']),
      expiryDate: asStringOrNull(map['expiryDate']),
      isCompletionDocument: asBool(map['isCompletionDocument']),
      downloadable: asBool(map['downloadable']),
      createdAt: asStringOrNull(map['createdAt']),
      filename: asStringOrNull(version['filename']),
      mime: asStringOrNull(version['mime']),
      sizeBytes: asIntOrNull(version['sizeBytes']),
    );
  }

  final String id;
  final String? requestId;
  final String documentTypeKey;
  final String title;
  final String status;
  final String verificationStatus;
  final String? expiryDate;
  final bool isCompletionDocument;
  final bool downloadable;
  final String? createdAt;
  final String? filename;
  final String? mime;
  final int? sizeBytes;
}

/// Step 1 of an upload (`POST /documents/upload-intents`).
class UploadIntent {
  const UploadIntent({
    required this.documentId,
    required this.versionId,
    required this.url,
    required this.method,
    required this.headers,
    this.expiresAt,
  });

  factory UploadIntent.fromJson(Object? json) {
    final map = asMap(json);
    final upload = asMap(map['upload']);
    final headers = <String, String>{};
    asMap(upload['headers']).forEach((key, value) {
      if (value != null) headers[key] = value.toString();
    });
    return UploadIntent(
      documentId: asString(map['documentId']),
      versionId: asString(map['versionId']),
      url: asString(upload['url']),
      method: asString(upload['method'], 'PUT'),
      headers: headers,
      expiresAt: asStringOrNull(upload['expiresAt']),
    );
  }

  final String documentId;
  final String versionId;

  /// One-time signed URL. It is the capability: no bearer token is sent to it.
  final String url;
  final String method;

  /// Headers that must be sent exactly as given.
  final Map<String, String> headers;
  final String? expiresAt;

  bool get isValid => documentId.isNotEmpty && versionId.isNotEmpty && url.isNotEmpty;
}

/// Result of step 3 (`POST /documents/:id/versions/:versionId/complete`).
class UploadSummary {
  const UploadSummary({required this.documentId, required this.versionId, required this.status, this.filename, this.scanStatus});

  factory UploadSummary.fromJson(Object? json) {
    final map = asMap(json);
    return UploadSummary(
      documentId: asString(map['documentId']),
      versionId: asString(map['versionId']),
      status: asString(map['status']),
      filename: asStringOrNull(map['filename']),
      scanStatus: asStringOrNull(map['scanStatus']),
    );
  }

  final String documentId;
  final String versionId;

  /// `PENDING_SCAN` right after the upload; `AVAILABLE` after the scan.
  final String status;
  final String? filename;
  final String? scanStatus;
}

/// `POST /documents/:id/download-link`
class DownloadLink {
  const DownloadLink({required this.url, this.filename, this.mime, this.expiresAt});

  factory DownloadLink.fromJson(Object? json) {
    final map = asMap(json);
    return DownloadLink(
      url: asString(map['url']),
      filename: asStringOrNull(map['filename']),
      mime: asStringOrNull(map['mime']),
      expiresAt: asStringOrNull(map['expiresAt']),
    );
  }

  final String url;
  final String? filename;
  final String? mime;
  final String? expiresAt;
}

/// A document already on file that could be reused for a checklist line.
class AssistCandidate {
  const AssistCandidate({required this.documentId, required this.title, required this.verificationStatus, this.expiryDate});

  factory AssistCandidate.fromJson(Object? json) {
    final map = asMap(json);
    return AssistCandidate(
      documentId: asString(map['documentId']),
      title: asString(map['title']),
      verificationStatus: asString(map['verificationStatus']),
      expiryDate: asStringOrNull(map['expiryDate']),
    );
  }

  final String documentId;
  final String title;
  final String verificationStatus;
  final String? expiryDate;
}

/// One line of `GET /documents/checklist-assist`.
class AssistItem {
  const AssistItem({required this.checklistItemId, required this.state, required this.candidates, this.hint, this.daysToExpiry});

  factory AssistItem.fromJson(Object? json) {
    final map = asMap(json);
    return AssistItem(
      checklistItemId: asString(map['checklistItemId']),
      state: asString(map['state']),
      hint: asStringOrNull(map['hint']),
      daysToExpiry: asIntOrNull(map['daysToExpiry']),
      candidates: asMapList(map['candidates']).map(AssistCandidate.fromJson).toList(growable: false),
    );
  }

  final String checklistItemId;

  /// `MISSING`, `PROCESSING`, `BLOCKED`, `REJECTED`, `EXPIRED`, `EXPIRING`,
  /// `UNVERIFIED`, `PRESENT`, `WAIVED`.
  final String state;
  final String? hint;
  final int? daysToExpiry;
  final List<AssistCandidate> candidates;
}

class ChecklistAssist {
  const ChecklistAssist({required this.items});

  factory ChecklistAssist.fromJson(Object? json) {
    final map = asMap(json);
    return ChecklistAssist(items: asMapList(map['items']).map(AssistItem.fromJson).toList(growable: false));
  }

  final List<AssistItem> items;

  AssistItem? forItem(String checklistItemId) {
    for (final item in items) {
      if (item.checklistItemId == checklistItemId) return item;
    }
    return null;
  }
}

/// A kind of document the centre works with (`GET /document-types`).
class DocumentType {
  const DocumentType({required this.key, required this.name, required this.hasExpiry, this.nameAr});

  factory DocumentType.fromJson(Object? json) {
    final map = asMap(json);
    return DocumentType(
      key: asString(map['key']),
      name: asString(map['name'], asString(map['key'])),
      nameAr: asStringOrNull(map['nameAr']),
      hasExpiry: asBool(map['hasExpiry']),
    );
  }

  final String key;
  final String name;
  final String? nameAr;
  final bool hasExpiry;
}
