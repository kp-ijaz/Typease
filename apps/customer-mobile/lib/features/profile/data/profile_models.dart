import '../../../core/utils/json.dart';

class PostalAddress {
  const PostalAddress({this.line1, this.city, this.emirate, this.country});

  factory PostalAddress.fromJson(Object? json) {
    final map = asMap(json);
    return PostalAddress(
      line1: asStringOrNull(map['line1']),
      city: asStringOrNull(map['city']),
      emirate: asStringOrNull(map['emirate']),
      country: asStringOrNull(map['country']),
    );
  }

  final String? line1;
  final String? city;
  final String? emirate;
  final String? country;

  bool get isEmpty => _blank(line1) && _blank(city) && _blank(emirate) && _blank(country);

  static bool _blank(String? value) => value == null || value.trim().isEmpty;

  JsonMap toJson() {
    final out = <String, dynamic>{};
    void put(String key, String? value) {
      if (!_blank(value)) out[key] = value!.trim();
    }

    put('line1', line1);
    put('city', city);
    put('emirate', emirate);
    put('country', country);
    return out;
  }

  String get oneLine {
    final parts = <String>[];
    for (final part in <String?>[line1, city, emirate, country]) {
      if (!_blank(part)) parts.add(part!.trim());
    }
    return parts.join(', ');
  }
}

/// `customers.communicationPrefs`
class CommunicationPrefs {
  const CommunicationPrefs({required this.email, required this.sms, required this.whatsapp, required this.push});

  factory CommunicationPrefs.fromJson(Object? json) {
    final map = asMap(json);
    return CommunicationPrefs(
      email: asBool(map['email'], true),
      sms: asBool(map['sms'], true),
      whatsapp: asBool(map['whatsapp']),
      push: asBool(map['push'], true),
    );
  }

  final bool email;
  final bool sms;
  final bool whatsapp;
  final bool push;

  bool valueOf(String channel) {
    switch (channel) {
      case 'email':
        return email;
      case 'sms':
        return sms;
      case 'whatsapp':
        return whatsapp;
      case 'push':
        return push;
      default:
        return false;
    }
  }
}

/// The customer's own record (`GET /me/customer`). Identity numbers are only
/// ever returned masked.
class CustomerProfile {
  const CustomerProfile({
    required this.id,
    required this.customerNo,
    required this.fullName,
    required this.preferredLanguage,
    required this.communicationPrefs,
    required this.marketingOptIn,
    required this.hasEmiratesId,
    required this.hasPassport,
    this.fullNameAr,
    this.email,
    this.phone,
    this.nationality,
    this.dateOfBirth,
    this.address,
    this.emiratesIdMasked,
    this.emiratesIdExpiry,
    this.passportNoMasked,
    this.passportExpiry,
  });

  factory CustomerProfile.fromJson(Object? json) {
    final map = asMap(json);
    final address = asMapOrNull(map['address']);
    return CustomerProfile(
      id: asString(map['id']),
      customerNo: asString(map['customerNo']),
      fullName: asString(map['fullName']),
      fullNameAr: asStringOrNull(map['fullNameAr']),
      preferredLanguage: asString(map['preferredLanguage'], 'en'),
      email: asStringOrNull(map['email']),
      phone: asStringOrNull(map['phone']),
      nationality: asStringOrNull(map['nationality']),
      dateOfBirth: asStringOrNull(map['dateOfBirth']),
      address: address == null ? null : PostalAddress.fromJson(address),
      communicationPrefs: CommunicationPrefs.fromJson(map['communicationPrefs']),
      marketingOptIn: asBool(map['marketingOptIn']),
      emiratesIdMasked: asStringOrNull(map['emiratesIdMasked']),
      hasEmiratesId: asBool(map['hasEmiratesId']),
      emiratesIdExpiry: asStringOrNull(map['emiratesIdExpiry']),
      passportNoMasked: asStringOrNull(map['passportNoMasked']),
      hasPassport: asBool(map['hasPassport']),
      passportExpiry: asStringOrNull(map['passportExpiry']),
    );
  }

  final String id;
  final String customerNo;
  final String fullName;
  final String? fullNameAr;
  final String preferredLanguage;
  final String? email;
  final String? phone;
  final String? nationality;
  final String? dateOfBirth;
  final PostalAddress? address;
  final CommunicationPrefs communicationPrefs;
  final bool marketingOptIn;
  final String? emiratesIdMasked;
  final bool hasEmiratesId;
  final String? emiratesIdExpiry;
  final String? passportNoMasked;
  final bool hasPassport;
  final String? passportExpiry;
}

/// The current decision for one consent purpose (`GET /me/consents`).
class ConsentState {
  const ConsentState({required this.purpose, required this.description, required this.status, required this.granted, this.lawfulBasis});

  factory ConsentState.fromJson(Object? json) {
    final map = asMap(json);
    return ConsentState(
      purpose: asString(map['purpose']),
      description: asString(map['description']),
      status: asString(map['status'], 'NOT_SET'),
      granted: asBool(map['granted']),
      lawfulBasis: asStringOrNull(map['lawfulBasis']),
    );
  }

  /// `SERVICE_PROCESSING`, `REMINDERS`, `MARKETING`, `AI_PROCESSING`,
  /// `DOCUMENT_REUSE`, `WHATSAPP`.
  final String purpose;

  /// The centre's own wording of what the purpose means.
  final String description;

  /// `GRANTED`, `WITHDRAWN` or `NOT_SET`.
  final String status;
  final bool granted;
  final String? lawfulBasis;

  /// Needed to deliver the service at all; cannot be switched off in the app.
  bool get isRequired => purpose == 'SERVICE_PROCESSING';
}

/// A data subject request of the customer (`/privacy/my/requests`).
class PrivacyRequest {
  const PrivacyRequest({
    required this.id,
    required this.type,
    required this.status,
    required this.overdue,
    this.details,
    this.decisionNote,
    this.retentionException,
    this.exportDocumentId,
    this.dueAt,
    this.completedAt,
    this.createdAt,
  });

  factory PrivacyRequest.fromJson(Object? json) {
    final map = asMap(json);
    return PrivacyRequest(
      id: asString(map['id']),
      type: asString(map['type']),
      status: asString(map['status']),
      details: asStringOrNull(map['details']),
      decisionNote: asStringOrNull(map['decisionNote']),
      retentionException: asStringOrNull(map['retentionException']),
      exportDocumentId: asStringOrNull(map['exportDocumentId']),
      dueAt: asStringOrNull(map['dueAt']),
      overdue: asBool(map['overdue']),
      completedAt: asStringOrNull(map['completedAt']),
      createdAt: asStringOrNull(map['createdAt']),
    );
  }

  final String id;

  /// `ACCESS`, `CORRECTION`, `DELETION` or `EXPORT`.
  final String type;

  /// `RECEIVED`, `IN_REVIEW`, `APPROVED`, `REJECTED`, `COMPLETED`.
  final String status;
  final String? details;

  /// The centre's written answer.
  final String? decisionNote;

  /// Why a deletion could not be carried out yet.
  final String? retentionException;

  /// The vault document that holds the export, once it is ready.
  final String? exportDocumentId;
  final String? dueAt;
  final bool overdue;
  final String? completedAt;
  final String? createdAt;

  bool get isOpen => status == 'RECEIVED' || status == 'IN_REVIEW' || status == 'APPROVED';
}
