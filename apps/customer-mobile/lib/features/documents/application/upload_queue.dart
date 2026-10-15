import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../requests/application/requests_providers.dart';
import '../data/documents_repository.dart';

enum UploadPhase { uploading, done, failed, cancelled }

/// One file being uploaded for a request.
@immutable
class UploadTask {
  const UploadTask({
    required this.id,
    required this.file,
    required this.target,
    required this.phase,
    required this.progress,
    this.error,
  });

  final int id;
  final LocalFile file;
  final UploadTarget target;
  final UploadPhase phase;

  /// 0.0 - 1.0 of the byte transfer.
  final double progress;
  final Object? error;

  UploadTask copyWith({UploadPhase? phase, double? progress, Object? error}) {
    return UploadTask(
      id: id,
      file: file,
      target: target,
      phase: phase ?? this.phase,
      progress: progress ?? this.progress,
      error: error,
    );
  }
}

/// Uploads for one request (the family argument is the request id). Several
/// files can run at the same time; each reports its own progress.
class UploadQueue extends AutoDisposeFamilyNotifier<List<UploadTask>, String> {
  final Map<int, CancelToken> _tokens = <int, CancelToken>{};
  int _nextId = 1;
  bool _disposed = false;

  @override
  List<UploadTask> build(String arg) {
    ref.onDispose(() {
      _disposed = true;
      for (final token in _tokens.values) {
        if (!token.isCancelled) token.cancel();
      }
      _tokens.clear();
    });
    return const <UploadTask>[];
  }

  bool get hasRunning => state.any((t) => t.phase == UploadPhase.uploading);

  /// Starts uploading [file]. Returns when the upload finished or failed; the
  /// outcome is in the task list (it never throws).
  Future<bool> start(LocalFile file, UploadTarget target) async {
    final id = _nextId++;
    final token = CancelToken();
    _tokens[id] = token;
    state = <UploadTask>[...state, UploadTask(id: id, file: file, target: target, phase: UploadPhase.uploading, progress: 0)];
    try {
      await ref.read(documentsRepositoryProvider).upload(
            file: file,
            target: target,
            cancelToken: token,
            onProgress: (fraction) => _update(id, (t) => t.copyWith(progress: fraction)),
          );
      _update(id, (t) => t.copyWith(phase: UploadPhase.done, progress: 1));
      if (!_disposed) ref.invalidate(requestDetailProvider(arg));
      return true;
    } catch (error) {
      final cancelled = token.isCancelled;
      _update(id, (t) => t.copyWith(phase: cancelled ? UploadPhase.cancelled : UploadPhase.failed, error: error));
      return false;
    } finally {
      _tokens.remove(id);
    }
  }

  /// Tries a failed upload again.
  Future<bool> retry(int id) async {
    UploadTask? task;
    for (final candidate in state) {
      if (candidate.id == id) task = candidate;
    }
    if (task == null || task.phase == UploadPhase.uploading) return false;
    remove(id);
    return start(task.file, task.target);
  }

  void cancel(int id) {
    final token = _tokens[id];
    if (token != null && !token.isCancelled) token.cancel();
  }

  void remove(int id) {
    if (_disposed) return;
    state = state.where((t) => t.id != id).toList(growable: false);
  }

  void _update(int id, UploadTask Function(UploadTask task) change) {
    if (_disposed) return;
    state = <UploadTask>[
      for (final task in state)
        if (task.id == id) change(task) else task,
    ];
  }
}

final uploadQueueProvider =
    NotifierProvider.autoDispose.family<UploadQueue, List<UploadTask>, String>(UploadQueue.new);
