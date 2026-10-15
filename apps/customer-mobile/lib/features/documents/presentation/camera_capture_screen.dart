import 'dart:io';

import 'package:app_settings/app_settings.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/widgets/primary_button.dart';
import '../../../core/widgets/states.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

/// What the capture screen returns.
class CapturedPhoto {
  const CapturedPhoto({required this.path, required this.name});

  final String path;
  final String name;
}

/// Camera capture: opens the device camera, shows the photo, and lets the
/// customer retake it or use it. When camera access was refused the screen
/// explains why it is needed and links to the system settings.
///
/// Pops with a [CapturedPhoto], or with nothing when cancelled.
class CameraCaptureScreen extends StatefulWidget {
  const CameraCaptureScreen({super.key});

  @override
  State<CameraCaptureScreen> createState() => _CameraCaptureScreenState();
}

enum _CaptureState { opening, preview, denied, unavailable, cancelled }

class _CameraCaptureScreenState extends State<CameraCaptureScreen> {
  final ImagePicker _picker = ImagePicker();
  _CaptureState _state = _CaptureState.opening;
  XFile? _photo;

  @override
  void initState() {
    super.initState();
    // Open the camera as soon as the screen is shown.
    WidgetsBinding.instance.addPostFrameCallback((_) => _take(ImageSource.camera));
  }

  Future<void> _take(ImageSource source) async {
    if (!mounted) return;
    setState(() => _state = _CaptureState.opening);
    try {
      // Re-encoding at this size keeps a page readable and well below the
      // upload limit; it also turns HEIC photos into JPEG.
      final file = await _picker.pickImage(source: source, maxWidth: 2400, maxHeight: 2400, imageQuality: 85);
      if (!mounted) return;
      setState(() {
        _photo = file ?? _photo;
        if (file != null) {
          _state = _CaptureState.preview;
        } else {
          _state = _photo == null ? _CaptureState.cancelled : _CaptureState.preview;
        }
      });
    } on PlatformException catch (error) {
      if (!mounted) return;
      final code = error.code.toLowerCase();
      final denied = code.contains('denied') || code.contains('restricted') || code.contains('permission');
      setState(() => _state = denied ? _CaptureState.denied : _CaptureState.unavailable);
    } catch (_) {
      if (!mounted) return;
      setState(() => _state = _CaptureState.unavailable);
    }
  }

  void _use() {
    final photo = _photo;
    if (photo == null) return;
    context.pop(CapturedPhoto(path: photo.path, name: photo.name));
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final photo = _photo;

    Widget body;
    Widget? actions;
    if (_state == _CaptureState.opening) {
      body = LoadingView(label: l10n.t('captureOpening'));
    } else if (_state == _CaptureState.denied) {
      body = EmptyStateView(
        icon: PhosphorIconsRegular.cameraSlash,
        title: l10n.t('captureDeniedTitle'),
        message: l10n.t('captureDeniedBody'),
        action: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            FilledButton.icon(
              onPressed: () => AppSettings.openAppSettings(),
              icon: const Icon(PhosphorIconsFill.gear),
              label: Text(l10n.t('captureOpenSettings')),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: () => _take(ImageSource.gallery),
              icon: const Icon(PhosphorIconsRegular.images),
              label: Text(l10n.t('captureChooseInstead')),
            ),
            TextButton(onPressed: () => _take(ImageSource.camera), child: Text(l10n.t('commonRetry'))),
          ],
        ),
      );
    } else if (_state == _CaptureState.unavailable) {
      body = EmptyStateView(
        icon: PhosphorIconsRegular.videoCameraSlash,
        title: l10n.t('captureUnavailableTitle'),
        message: l10n.t('captureUnavailableBody'),
        action: OutlinedButton.icon(
          onPressed: () => _take(ImageSource.gallery),
          icon: const Icon(PhosphorIconsRegular.images),
          label: Text(l10n.t('captureChooseInstead')),
        ),
      );
    } else if (photo == null) {
      body = EmptyStateView(
        icon: PhosphorIconsRegular.camera,
        title: l10n.t('captureNoPhotoTitle'),
        message: l10n.t('captureNoPhotoBody'),
        action: FilledButton.icon(
          onPressed: () => _take(ImageSource.camera),
          icon: const Icon(PhosphorIconsRegular.camera),
          label: Text(l10n.t('captureTake')),
        ),
      );
    } else {
      body = Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: <Widget>[
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: InteractiveViewer(
                  child: Image.file(
                    File(photo.path),
                    fit: BoxFit.contain,
                    semanticLabel: l10n.t('capturePreviewLabel'),
                    errorBuilder: (context, error, stackTrace) => Center(child: Text(l10n.t('capturePreviewFailed'))),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 12),
            Text(l10n.t('captureCheckHint'), textAlign: TextAlign.center),
          ],
        ),
      );
      actions = SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: Row(
            children: <Widget>[
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: () => _take(ImageSource.camera),
                  icon: const Icon(PhosphorIconsRegular.arrowCounterClockwise),
                  label: Text(l10n.t('captureRetake')),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(child: PrimaryButton(label: l10n.t('captureUse'), icon: PhosphorIconsBold.check, onPressed: _use)),
            ],
          ),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('captureTitle'))),
      body: body,
      bottomNavigationBar: actions,
    );
  }
}
