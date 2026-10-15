import 'dart:convert';
import 'dart:io' show SocketException, HandshakeException;

import 'package:dio/dio.dart';

import '../utils/json.dart';

/// What went wrong, in terms the UI can act on.
enum ApiErrorKind {
  /// No connection to the server (offline, DNS, refused).
  network,

  /// The server did not answer in time.
  timeout,

  /// The request was cancelled by the app.
  cancelled,

  /// 401: not signed in / session ended.
  unauthorized,

  /// 403.
  forbidden,

  /// 404.
  notFound,

  /// 400 / 422 with field or business-rule details.
  validation,

  /// 409.
  conflict,

  /// 429.
  rateLimited,

  /// 5xx, including 503 "not configured".
  server,

  /// Anything else.
  unknown,
}

/// One field-level message from `VALIDATION_FAILED.details` (`{ path, message }`)
/// or `FORM_INVALID.details` (`{ field, code, message }`).
class FieldError {
  const FieldError({required this.field, required this.message, this.code});

  final String field;
  final String message;
  final String? code;
}

/// The API error body (`statusCode`, `code`, `message`, `details`, `requestId`)
/// or a transport failure, as one typed exception.
class ApiException implements Exception {
  const ApiException({
    required this.kind,
    required this.code,
    required this.message,
    this.statusCode,
    this.details,
    this.requestId,
  });

  /// Maps a Dio failure. Never throws.
  factory ApiException.fromDio(DioException error) {
    final type = error.type;
    if (type == DioExceptionType.connectionTimeout ||
        type == DioExceptionType.sendTimeout ||
        type == DioExceptionType.receiveTimeout) {
      return const ApiException(kind: ApiErrorKind.timeout, code: 'TIMEOUT', message: '');
    }
    if (type == DioExceptionType.cancel) {
      return const ApiException(kind: ApiErrorKind.cancelled, code: 'CANCELLED', message: '');
    }
    if (type == DioExceptionType.connectionError) {
      return const ApiException(kind: ApiErrorKind.network, code: 'NO_CONNECTION', message: '');
    }
    if (type == DioExceptionType.badCertificate) {
      return const ApiException(kind: ApiErrorKind.network, code: 'BAD_CERTIFICATE', message: '');
    }
    if (type == DioExceptionType.badResponse) {
      return ApiException.fromResponse(error.response?.statusCode, error.response?.data);
    }
    final cause = error.error;
    if (cause is ApiException) return cause;
    if (cause is SocketException) {
      return const ApiException(kind: ApiErrorKind.network, code: 'NO_CONNECTION', message: '');
    }
    if (cause is HandshakeException) {
      return const ApiException(kind: ApiErrorKind.network, code: 'BAD_CERTIFICATE', message: '');
    }
    if (error.response != null) {
      return ApiException.fromResponse(error.response?.statusCode, error.response?.data);
    }
    return const ApiException(kind: ApiErrorKind.unknown, code: 'UNKNOWN', message: '');
  }

  /// Maps an HTTP error status and its (possibly non-JSON) body.
  factory ApiException.fromResponse(int? statusCode, Object? body) {
    Object? decoded = body;
    if (body is String && body.isNotEmpty) {
      // Clients that ask for plain text (file transfer) still get JSON errors.
      try {
        decoded = jsonDecode(body);
      } catch (_) {
        decoded = null;
      }
    }
    final map = asMap(decoded);
    final status = statusCode ?? asIntOrNull(map['statusCode']);
    final code = asString(map['code'], status == null ? 'UNKNOWN' : 'HTTP_$status');
    return ApiException(
      kind: _kindFor(status, code),
      code: code,
      message: asString(map['message']),
      statusCode: status,
      details: map['details'],
      requestId: asStringOrNull(map['requestId']),
    );
  }

  final ApiErrorKind kind;

  /// Stable machine-readable code, e.g. `VALIDATION_FAILED`, `SLOT_FULL`.
  final String code;

  /// Plain-language message from the server. Empty for transport failures;
  /// the UI then shows its own localised text.
  final String message;
  final int? statusCode;
  final Object? details;

  /// Server request id; useful when the customer contacts support.
  final String? requestId;

  bool get isNetwork => kind == ApiErrorKind.network || kind == ApiErrorKind.timeout;

  /// The session is gone and the user has to sign in again.
  bool get isSessionExpired => statusCode == 401 && (code == 'SESSION_EXPIRED' || code == 'TOKEN_INVALID' || code == 'UNAUTHENTICATED');

  /// Field messages, when `details` is a list of `{ path | field, message }`.
  List<FieldError> get fieldErrors {
    final out = <FieldError>[];
    for (final item in asMapList(details)) {
      final field = asStringOrNull(item['path']) ?? asStringOrNull(item['field']);
      final message = asStringOrNull(item['message']);
      if (field == null || field.isEmpty || message == null) continue;
      out.add(FieldError(field: field, message: message, code: asStringOrNull(item['code'])));
    }
    return out;
  }

  /// First message per field; later messages for the same field are dropped.
  Map<String, String> get fieldErrorMap {
    final out = <String, String>{};
    for (final error in fieldErrors) {
      out.putIfAbsent(error.field, () => error.message);
    }
    return out;
  }

  static ApiErrorKind _kindFor(int? status, String code) {
    if (status == null) return ApiErrorKind.unknown;
    if (status == 401) return ApiErrorKind.unauthorized;
    if (status == 403) return ApiErrorKind.forbidden;
    if (status == 404) return ApiErrorKind.notFound;
    if (status == 409) return ApiErrorKind.conflict;
    if (status == 429) return ApiErrorKind.rateLimited;
    if (status == 400 || status == 413 || status == 415 || status == 422 || status == 402) return ApiErrorKind.validation;
    if (status >= 500) return ApiErrorKind.server;
    return ApiErrorKind.unknown;
  }

  @override
  String toString() => 'ApiException($code, status: $statusCode)';
}
