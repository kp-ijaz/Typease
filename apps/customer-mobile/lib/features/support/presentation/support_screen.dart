import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/l10n_ext.dart';
import '../../../core/routing/routes.dart';
import '../../../core/theme/brand_tokens.dart';
import '../../../core/utils/dates.dart';
import '../../../core/widgets/section_card.dart';
import '../../../core/widgets/states.dart';
import '../../../core/widgets/status_badge.dart';
import '../../documents/presentation/document_actions.dart';
import '../../tenant/application/tenant_controller.dart';
import '../application/support_providers.dart';
import '../data/support_models.dart';
import 'package:phosphor_flutter/phosphor_flutter.dart';

Tone ticketTone(String status) {
  switch (status) {
    case 'OPEN':
    case 'IN_PROGRESS':
      return Tone.info;
    case 'WAITING_CUSTOMER':
      return Tone.warning;
    case 'RESOLVED':
      return Tone.success;
    default:
      return Tone.neutral;
  }
}

/// Support: the customer's tickets, and the centre's contact details.
class SupportScreen extends ConsumerWidget {
  const SupportScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final tokens = BrandTokens.of(context);
    final tickets = ref.watch(ticketsProvider);
    final tenant = ref.watch(tenantControllerProvider);
    final phone = tenant?.supportPhone;
    final email = tenant?.supportEmail;

    Future<void> refresh() async {
      ref.invalidate(ticketsProvider);
      try {
        await ref.read(ticketsProvider.future);
      } catch (_) {
        // Shown by the list.
      }
    }

    final contact = (phone == null && email == null)
        ? const SizedBox.shrink()
        : SectionCard(
            title: l10n.t('supportContactTitle'),
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
            child: Column(
              children: <Widget>[
                if (phone != null)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(PhosphorIconsRegular.phone),
                    title: Text(phone, textDirection: TextDirection.ltr),
                    onTap: () => openExternalUrl('tel:$phone'),
                  ),
                if (email != null)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(PhosphorIconsRegular.envelopeSimple),
                    title: Text(email, textDirection: TextDirection.ltr),
                    onTap: () => openExternalUrl('mailto:$email'),
                  ),
              ],
            ),
          );

    return Scaffold(
      appBar: AppBar(title: Text(l10n.t('supportTitle'))),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push<void>(Routes.newTicket),
        icon: const Icon(PhosphorIconsRegular.chatCircleText),
        label: Text(l10n.t('supportNewTicket')),
      ),
      body: AsyncValueView<List<Ticket>>(
        value: tickets,
        onRetry: () => ref.invalidate(ticketsProvider),
        data: (items) {
          return RefreshableList(
            onRefresh: refresh,
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
            children: <Widget>[
              contact,
              if (items.isEmpty)
                SizedBox(
                  height: 320,
                  child: EmptyStateView(
                    icon: PhosphorIconsRegular.chatsCircle,
                    title: l10n.t('supportEmptyTitle'),
                    message: l10n.t('supportEmptyBody'),
                  ),
                ),
              for (final ticket in items)
                SectionCard(
                  onTap: () => context.push<void>(Routes.ticket(ticket.id)),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(ticket.subject, style: theme.textTheme.titleSmall),
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 8,
                        runSpacing: 4,
                        children: <Widget>[
                          StatusBadge(label: l10n.tOr('ticketStatus_${ticket.status}', ticket.status), tone: ticketTone(ticket.status)),
                          if (ticket.status == 'WAITING_CUSTOMER') StatusBadge(label: l10n.t('supportYourReplyNeeded'), tone: Tone.warning),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(
                        <String>[
                          ticket.ticketNo,
                          if (ticket.requestNo != null) ticket.requestNo!,
                          Dates.date(ticket.updatedAt ?? ticket.createdAt, l10n.languageCode),
                        ].join(' · '),
                        style: theme.textTheme.bodySmall?.copyWith(color: tokens.mutedText),
                      ),
                    ],
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}
