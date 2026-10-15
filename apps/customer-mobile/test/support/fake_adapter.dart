import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';

/// What the fake server answers.
class FakeResponse {
  const FakeResponse(this.statusCode, this.body);

  final int statusCode;
  final Object? body;
}

/// A request as the fake server saw it.
class RecordedRequest {
  const RecordedRequest({required this.method, required this.path, required this.headers, required this.data});

  final String method;
  final String path;
  final Map<String, dynamic> headers;
  final Object? data;

  /// Header lookup that ignores case (HTTP header names are case-insensitive).
  String? header(String name) {
    final wanted = name.toLowerCase();
    for (final entry in headers.entries) {
      if (entry.key.toLowerCase() == wanted) return entry.value?.toString();
    }
    return null;
  }

  String? get authorization => header('Authorization');
}

/// An in-memory replacement for the network: Dio calls [fetch] instead of
/// opening a socket. The handler decides the answer for each request.
class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this.handler);

  /// Return a [FakeResponse], or throw (e.g. a [SocketException]) to simulate
  /// a transport failure.
  final FutureOr<FakeResponse> Function(RecordedRequest request) handler;

  final List<RecordedRequest> requests = <RecordedRequest>[];

  int count(String method, String pathSuffix) {
    return requests.where((r) => r.method == method && r.path.endsWith(pathSuffix)).length;
  }

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {
    final recorded = RecordedRequest(
      method: options.method.toUpperCase(),
      path: options.uri.path,
      headers: Map<String, dynamic>.of(options.headers),
      data: options.data,
    );
    requests.add(recorded);
    final response = await handler(recorded);
    return ResponseBody.fromString(
      jsonEncode(response.body),
      response.statusCode,
      headers: <String, List<String>>{
        Headers.contentTypeHeader: <String>[Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

/// The API error body.
Map<String, dynamic> apiError(int status, String code, String message, {Object? details}) {
  return <String, dynamic>{
    'statusCode': status,
    'code': code,
    'message': message,
    if (details != null) 'details': details,
    'requestId': '00000000-0000-4000-8000-000000000000',
  };
}

/// Convenience for handlers that simulate "no connection".
Never offline() => throw const SocketException('Network is unreachable');
