import '../../../core/utils/json.dart';

class TicketAttachment {
  const TicketAttachment({required this.documentId, required this.title});

  factory TicketAttachment.fromJson(Object? json) {
    final map = asMap(json);
    return TicketAttachment(documentId: asString(map['documentId']), title: asString(map['title']));
  }

  final String documentId;
  final String title;
}

class TicketMessage {
  const TicketMessage({required this.id, required this.fromSupport, required this.body, required this.attachments, this.authorName, this.createdAt});

  factory TicketMessage.fromJson(Object? json) {
    final map = asMap(json);
    return TicketMessage(
      id: asString(map['id']),
      fromSupport: asBool(map['fromSupport']),
      authorName: asStringOrNull(map['authorName']),
      body: asString(map['body']),
      attachments: asMapList(map['attachments']).map(TicketAttachment.fromJson).toList(growable: false),
      createdAt: asStringOrNull(map['createdAt']),
    );
  }

  final String id;

  /// True for replies of the centre (staff names are not disclosed).
  final bool fromSupport;
  final String? authorName;
  final String body;
  final List<TicketAttachment> attachments;
  final String? createdAt;
}

/// A support ticket in the requester's view (`/me/tickets`).
class Ticket {
  const Ticket({
    required this.id,
    required this.ticketNo,
    required this.subject,
    required this.status,
    required this.canReply,
    required this.canRate,
    required this.messages,
    this.category,
    this.requestId,
    this.requestNo,
    this.resolutionSummary,
    this.createdAt,
    this.updatedAt,
    this.rating,
    this.ratingComment,
  });

  factory Ticket.fromJson(Object? json) {
    final map = asMap(json);
    final feedback = asMap(map['feedback']);
    return Ticket(
      id: asString(map['id']),
      ticketNo: asString(map['ticketNo']),
      subject: asString(map['subject']),
      category: asStringOrNull(map['category']),
      status: asString(map['status']),
      requestId: asStringOrNull(map['requestId']),
      requestNo: asStringOrNull(map['requestNo']),
      resolutionSummary: asStringOrNull(map['resolutionSummary']),
      canReply: asBool(map['canReply']),
      canRate: asBool(map['canRate']),
      createdAt: asStringOrNull(map['createdAt']),
      updatedAt: asStringOrNull(map['updatedAt']),
      messages: asMapList(map['messages']).map(TicketMessage.fromJson).toList(growable: false),
      rating: asIntOrNull(feedback['rating']),
      ratingComment: asStringOrNull(feedback['comment']),
    );
  }

  final String id;
  final String ticketNo;
  final String subject;
  final String? category;

  /// `OPEN`, `IN_PROGRESS`, `WAITING_CUSTOMER`, `RESOLVED`, `CLOSED`.
  final String status;
  final String? requestId;
  final String? requestNo;
  final String? resolutionSummary;
  final bool canReply;
  final bool canRate;
  final String? createdAt;
  final String? updatedAt;
  final List<TicketMessage> messages;

  /// 1-5 once the customer rated the ticket.
  final int? rating;
  final String? ratingComment;

  bool get isOpen => status != 'RESOLVED' && status != 'CLOSED';
}
