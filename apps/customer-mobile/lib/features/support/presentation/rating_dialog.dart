import 'package:flutter/material.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/theme/brand_tokens.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

class RatingResult {
  const RatingResult({required this.rating, this.comment});

  final int rating;
  final String? comment;
}

/// Asks for a 1-5 rating and an optional comment. Returns null when cancelled.
Future<RatingResult?> showRatingDialog(BuildContext context, {required String title}) {
  return showDialog<RatingResult>(context: context, builder: (dialogContext) => _RatingDialog(title: title));
}

class _RatingDialog extends StatefulWidget {
  const _RatingDialog({required this.title});

  final String title;

  @override
  State<_RatingDialog> createState() => _RatingDialogState();
}

class _RatingDialogState extends State<_RatingDialog> {
  final TextEditingController _comment = TextEditingController();
  int _rating = 0;

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final tokens = BrandTokens.of(context);
    return AlertDialog(
      title: Text(widget.title),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                for (var star = 1; star <= 5; star++)
                  IconButton(
                    tooltip: l10n.t('ratingStars', <String, Object?>{'count': star}),
                    isSelected: star <= _rating,
                    icon: Icon(star <= _rating ? PhosphorIconsFill.star : PhosphorIconsRegular.star, color: tokens.warning, size: 32),
                    onPressed: () => setState(() => _rating = star),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _comment,
              minLines: 2,
              maxLines: 4,
              maxLength: 1000,
              decoration: InputDecoration(labelText: l10n.t('ratingComment')),
            ),
          ],
        ),
      ),
      actions: <Widget>[
        TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(l10n.t('commonCancel'))),
        FilledButton(
          onPressed: _rating == 0
              ? null
              : () {
                  final text = _comment.text.trim();
                  Navigator.of(context).pop(RatingResult(rating: _rating, comment: text.isEmpty ? null : text));
                },
          child: Text(l10n.t('ratingSubmit')),
        ),
      ],
    );
  }
}
