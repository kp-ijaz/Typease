import '../../../core/utils/json.dart';
import '../../requests/data/form_schema.dart';

class ServiceCategory {
  const ServiceCategory({required this.key, required this.name, required this.serviceCount, this.nameAr, this.icon});

  factory ServiceCategory.fromJson(Object? json) {
    final map = asMap(json);
    return ServiceCategory(
      key: asString(map['key']),
      name: asString(map['name']),
      nameAr: asStringOrNull(map['nameAr']),
      icon: asStringOrNull(map['icon']),
      serviceCount: asInt(map['serviceCount']),
    );
  }

  final String key;
  final String name;
  final String? nameAr;

  /// Icon name chosen by the centre (e.g. `file-text`, `plane`).
  final String? icon;
  final int serviceCount;
}

/// One part of a price: service fee, government fee or third-party charge.
class PriceComponent {
  const PriceComponent({
    required this.component,
    required this.amount,
    required this.isEstimate,
    required this.taxAmount,
    required this.total,
  });

  factory PriceComponent.fromJson(Object? json) {
    final map = asMap(json);
    return PriceComponent(
      component: asString(map['component']),
      amount: asString(map['amount'], '0.00'),
      isEstimate: asBool(map['isEstimate']),
      taxAmount: asString(map['taxAmount'], '0.00'),
      total: asString(map['total'], '0.00'),
    );
  }

  /// `SERVICE_FEE`, `GOVERNMENT_FEE` or `THIRD_PARTY_FEE`.
  final String component;
  final String amount;
  final bool isEstimate;
  final String taxAmount;
  final String total;
}

/// The effective price of a service. Government and third-party amounts are
/// ESTIMATES; what the customer actually pays is fixed on the quotation.
class ServicePrice {
  const ServicePrice({
    required this.currency,
    required this.serviceFee,
    required this.governmentFeeEstimate,
    required this.thirdPartyFeeEstimate,
    required this.taxAmount,
    required this.total,
    required this.components,
    required this.containsEstimates,
    required this.paymentPolicy,
    this.taxRatePercent,
    this.dueBeforeProcessing,
    this.depositPercent,
  });

  factory ServicePrice.fromJson(Object? json) {
    final map = asMap(json);
    return ServicePrice(
      currency: asString(map['currency'], 'AED'),
      serviceFee: asString(map['serviceFee'], '0.00'),
      governmentFeeEstimate: asString(map['governmentFeeEstimate'], '0.00'),
      thirdPartyFeeEstimate: asString(map['thirdPartyFeeEstimate'], '0.00'),
      taxAmount: asString(map['taxAmount'], '0.00'),
      total: asString(map['total'], '0.00'),
      components: asMapList(map['components']).map(PriceComponent.fromJson).toList(growable: false),
      containsEstimates: asBool(map['containsEstimates']),
      paymentPolicy: asString(map['paymentPolicy']),
      taxRatePercent: asStringOrNull(map['taxRatePercent']),
      dueBeforeProcessing: asStringOrNull(map['dueBeforeProcessing']),
      depositPercent: asStringOrNull(map['depositPercent']),
    );
  }

  /// The public catalogue's `feeEstimate` (what guests see).
  factory ServicePrice.fromEstimate(Map<String, dynamic> map) {
    return ServicePrice(
      currency: asString(map['currency'], 'AED'),
      serviceFee: asString(map['serviceFee'], '0.00'),
      governmentFeeEstimate: asString(map['governmentFeeEstimate'], '0.00'),
      thirdPartyFeeEstimate: asString(map['thirdPartyFeeEstimate'], '0.00'),
      taxAmount: asString(map['taxEstimate'], '0.00'),
      total: asString(map['totalEstimate'], '0.00'),
      components: const <PriceComponent>[],
      containsEstimates: asBool(map['isEstimate'], true),
      paymentPolicy: '',
    );
  }

  final String currency;
  final String serviceFee;
  final String governmentFeeEstimate;
  final String thirdPartyFeeEstimate;
  final String taxAmount;
  final String total;
  final List<PriceComponent> components;
  final bool containsEstimates;

  /// `BEFORE_PROCESSING`, `AFTER_COMPLETION` or `DEPOSIT`.
  final String paymentPolicy;
  final String? taxRatePercent;
  final String? dueBeforeProcessing;
  final String? depositPercent;
}

class ServiceRequirement {
  const ServiceRequirement({
    required this.id,
    required this.documentTypeKey,
    required this.label,
    required this.isMandatory,
    required this.allowReuse,
    this.labelAr,
    this.description,
  });

  factory ServiceRequirement.fromJson(Object? json) {
    final map = asMap(json);
    return ServiceRequirement(
      id: asString(map['id']),
      documentTypeKey: asString(map['documentTypeKey']),
      label: asString(map['label']),
      labelAr: asStringOrNull(map['labelAr']),
      description: asStringOrNull(map['description']),
      isMandatory: asBool(map['isMandatory']),
      allowReuse: asBool(map['allowReuse']),
    );
  }

  final String id;
  final String documentTypeKey;
  final String label;
  final String? labelAr;
  final String? description;
  final bool isMandatory;
  final bool allowReuse;
}

/// A service as the portal catalogue returns it (`GET /catalogue`,
/// `GET /catalogue/:id`). `requirements` and `form` are only present in the
/// detail response.
class CatalogueService {
  const CatalogueService({
    required this.id,
    required this.name,
    required this.categoryKey,
    required this.categoryName,
    required this.complianceCapability,
    required this.onlineAvailable,
    required this.requirements,
    this.nameAr,
    this.description,
    this.descriptionAr,
    this.eligibilityGuidance,
    this.categoryNameAr,
    this.categoryIcon,
    this.estimatedProcessingHours,
    this.price,
    this.form,
  });

  factory CatalogueService.fromJson(Object? json) {
    final map = asMap(json);
    final category = asMap(map['category']);
    final price = asMapOrNull(map['price']);
    // The public catalogue (guests) names these `feeEstimate` / `requiredDocuments`.
    final estimate = asMapOrNull(map['feeEstimate']);
    final form = asMapOrNull(map['form']);
    return CatalogueService(
      id: asString(map['id']),
      name: asString(map['name']),
      nameAr: asStringOrNull(map['nameAr']),
      description: asStringOrNull(map['description']),
      descriptionAr: asStringOrNull(map['descriptionAr']),
      eligibilityGuidance: asStringOrNull(map['eligibilityGuidance']),
      categoryKey: asString(category['key']),
      categoryName: asString(category['name']),
      categoryNameAr: asStringOrNull(category['nameAr']),
      categoryIcon: asStringOrNull(category['icon']),
      complianceCapability: asString(map['complianceCapability']),
      estimatedProcessingHours: asIntOrNull(map['estimatedProcessingHours']),
      onlineAvailable: asBool(map['onlineAvailable'], true),
      price: price != null ? ServicePrice.fromJson(price) : (estimate != null ? ServicePrice.fromEstimate(estimate) : null),
      requirements: (map.containsKey('requirements') ? asMapList(map['requirements']) : asMapList(map['requiredDocuments']))
          .map(ServiceRequirement.fromJson)
          .toList(growable: false),
      form: form == null ? null : FormSchema.fromJson(form['schema']),
    );
  }

  final String id;
  final String name;
  final String? nameAr;
  final String? description;
  final String? descriptionAr;
  final String? eligibilityGuidance;
  final String categoryKey;
  final String categoryName;
  final String? categoryNameAr;
  final String? categoryIcon;

  /// What the centre itself does for this service, e.g.
  /// `DOCUMENT_PREPARATION_ONLY`. Never a claim of government authorisation.
  final String complianceCapability;
  final int? estimatedProcessingHours;
  final bool onlineAvailable;
  final ServicePrice? price;
  final List<ServiceRequirement> requirements;
  final FormSchema? form;
}

class Catalogue {
  const Catalogue({required this.categories, required this.services});

  factory Catalogue.fromJson(Object? json) {
    final map = asMap(json);
    return Catalogue(
      categories: asMapList(map['categories']).map(ServiceCategory.fromJson).toList(growable: false),
      services: asMapList(map['services']).map(CatalogueService.fromJson).toList(growable: false),
    );
  }

  final List<ServiceCategory> categories;
  final List<CatalogueService> services;

  /// Categories that have at least one service the customer can request.
  List<ServiceCategory> get usedCategories => categories.where((c) => c.serviceCount > 0).toList(growable: false);
}
