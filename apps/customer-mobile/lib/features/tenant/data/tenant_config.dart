import '../../../core/utils/json.dart';

/// Public presentation data of a centre (`GET /public/tenant-config`).
/// Everything the app shows as "branding" comes from here.
class TenantConfig {
  const TenantConfig({
    required this.tenantId,
    required this.slug,
    required this.name,
    required this.mode,
    required this.primaryHex,
    required this.secondaryHex,
    required this.accentHex,
    required this.websiteTitle,
    required this.defaultLanguage,
    required this.currency,
    required this.timezone,
    required this.publicCatalogueEnabled,
    required this.features,
    this.nameAr,
    this.logoUrl,
    this.faviconUrl,
    this.tagline,
    this.supportEmail,
    this.supportPhone,
  });

  factory TenantConfig.fromJson(Object? json) {
    final map = asMap(json);
    final colors = asMap(map['colors']);
    final features = <String, bool>{};
    asMap(map['features']).forEach((key, value) {
      if (value is bool) features[key] = value;
    });
    return TenantConfig(
      tenantId: asString(map['tenantId']),
      slug: asString(map['slug']),
      name: asString(map['name']),
      nameAr: asStringOrNull(map['nameAr']),
      mode: asString(map['mode'], 'TYPEASE'),
      logoUrl: asStringOrNull(map['logoUrl']),
      faviconUrl: asStringOrNull(map['faviconUrl']),
      primaryHex: asString(colors['primary']),
      secondaryHex: asString(colors['secondary']),
      accentHex: asString(colors['accent']),
      websiteTitle: asString(map['websiteTitle'], asString(map['name'])),
      tagline: asStringOrNull(map['tagline']),
      supportEmail: asStringOrNull(map['supportEmail']),
      supportPhone: asStringOrNull(map['supportPhone']),
      defaultLanguage: asString(map['defaultLanguage'], 'en'),
      currency: asString(map['currency'], 'AED'),
      timezone: asString(map['timezone'], 'Asia/Dubai'),
      publicCatalogueEnabled: asBool(map['publicCatalogueEnabled']),
      features: features,
    );
  }

  final String tenantId;
  final String slug;
  final String name;
  final String? nameAr;

  /// `TYPEASE` (TypEase-branded SaaS mode) or `WHITE_LABEL`.
  final String mode;
  final String? logoUrl;
  final String? faviconUrl;
  final String primaryHex;
  final String secondaryHex;
  final String accentHex;
  final String websiteTitle;
  final String? tagline;
  final String? supportEmail;
  final String? supportPhone;
  final String defaultLanguage;
  final String currency;
  final String timezone;
  final bool publicCatalogueEnabled;
  final Map<String, bool> features;

  bool get isWhiteLabel => mode == 'WHITE_LABEL';

  /// A usable configuration needs at least an id, a slug and a name.
  bool get isValid => tenantId.isNotEmpty && slug.isNotEmpty && name.isNotEmpty;

  bool feature(String key) => features[key] ?? false;

  String displayName(String languageCode) => pickLanguage(languageCode, name, nameAr);

  /// Same shape as the API response, so the cache can be read with [TenantConfig.fromJson].
  JsonMap toJson() {
    return <String, dynamic>{
      'tenantId': tenantId,
      'slug': slug,
      'name': name,
      'nameAr': nameAr,
      'mode': mode,
      'logoUrl': logoUrl,
      'faviconUrl': faviconUrl,
      'colors': <String, dynamic>{'primary': primaryHex, 'secondary': secondaryHex, 'accent': accentHex},
      'websiteTitle': websiteTitle,
      'tagline': tagline,
      'supportEmail': supportEmail,
      'supportPhone': supportPhone,
      'defaultLanguage': defaultLanguage,
      'currency': currency,
      'timezone': timezone,
      'publicCatalogueEnabled': publicCatalogueEnabled,
      'features': features,
    };
  }
}
