import '../../../core/utils/json.dart';

/// An item of the in-app inbox (`GET /me/notifications`).
class NotificationItem {
  const NotificationItem({
    required this.id,
    required this.eventKey,
    required this.subject,
    required this.body,
    this.relatedType,
    this.relatedId,
    this.readAt,
    this.createdAt,
  });

  factory NotificationItem.fromJson(Object? json) {
    final map = asMap(json);
    return NotificationItem(
      id: asString(map['id']),
      eventKey: asString(map['eventKey']),
      subject: asString(map['subject']),
      body: asString(map['body']),
      relatedType: asStringOrNull(map['relatedType']),
      relatedId: asStringOrNull(map['relatedId']),
      readAt: asStringOrNull(map['readAt']),
      createdAt: asStringOrNull(map['createdAt']),
    );
  }

  final String id;
  final String eventKey;
  final String subject;
  final String body;

  /// `ServiceRequest`, `Quotation`, `Invoice`, `Payment`, `Appointment`,
  /// `SupportTicket`, `ReminderSchedule`, ... - used to open the right screen.
  final String? relatedType;
  final String? relatedId;
  final String? readAt;
  final String? createdAt;

  bool get isUnread => readAt == null;

  NotificationItem markedRead(String at) {
    return NotificationItem(
      id: id,
      eventKey: eventKey,
      subject: subject,
      body: body,
      relatedType: relatedType,
      relatedId: relatedId,
      readAt: at,
      createdAt: createdAt,
    );
  }
}

/// `{ data, meta, unreadCount }`
class NotificationInbox {
  const NotificationInbox({required this.items, required this.unreadCount, required this.page, required this.totalPages});

  factory NotificationInbox.fromJson(Object? json) {
    final map = asMap(json);
    final meta = asMap(map['meta']);
    return NotificationInbox(
      items: asMapList(map['data']).map(NotificationItem.fromJson).toList(growable: false),
      unreadCount: asInt(map['unreadCount']),
      page: asInt(meta['page'], 1),
      totalPages: asInt(meta['totalPages'], 1),
    );
  }

  final List<NotificationItem> items;
  final int unreadCount;
  final int page;
  final int totalPages;

  bool get hasMore => page < totalPages;
}

/// One explicit choice: "send me [eventGroup] messages on [channel]: yes / no".
class NotificationPreference {
  const NotificationPreference({required this.channel, required this.eventGroup, required this.enabled});

  factory NotificationPreference.fromJson(Object? json) {
    final map = asMap(json);
    return NotificationPreference(
      channel: asString(map['channel']),
      eventGroup: asString(map['eventGroup'], '*'),
      enabled: asBool(map['enabled'], true),
    );
  }

  final String channel;

  /// A group such as `requests`, or `*` for everything on the channel.
  final String eventGroup;
  final bool enabled;
}

/// `GET /me/notification-preferences`
class NotificationPreferences {
  const NotificationPreferences({
    required this.channels,
    required this.groups,
    required this.channelDefaults,
    required this.preferences,
    this.note,
  });

  factory NotificationPreferences.fromJson(Object? json) {
    final map = asMap(json);
    final defaults = <String, bool>{};
    asMap(map['channelDefaults']).forEach((key, value) {
      if (value is bool) defaults[key.toUpperCase()] = value;
    });
    return NotificationPreferences(
      channels: asStringList(map['channels']),
      groups: asStringList(map['groups']),
      channelDefaults: defaults,
      preferences: asMapList(map['preferences']).map(NotificationPreference.fromJson).toList(growable: false),
      note: asStringOrNull(map['note']),
    );
  }

  final List<String> channels;
  final List<String> groups;

  /// Default per channel when nothing was chosen (keys upper-cased: `EMAIL`).
  final Map<String, bool> channelDefaults;
  final List<NotificationPreference> preferences;
  final String? note;

  /// Whether [channel] is on for [group]: an explicit choice for the group
  /// wins over a choice for the whole channel, which wins over the default.
  bool isEnabled(String channel, String group) {
    bool? wholeChannel;
    for (final preference in preferences) {
      if (preference.channel != channel) continue;
      if (preference.eventGroup == group) return preference.enabled;
      if (preference.eventGroup == '*') wholeChannel = preference.enabled;
    }
    return wholeChannel ?? channelDefaults[channel] ?? true;
  }
}
