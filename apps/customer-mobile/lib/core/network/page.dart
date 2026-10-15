import '../utils/json.dart';

/// `{ data: [...], meta: { page, pageSize, total, totalPages } }`
class Page<T> {
  const Page({
    required this.items,
    required this.page,
    required this.pageSize,
    required this.total,
    required this.totalPages,
  });

  factory Page.fromJson(Object? json, T Function(JsonMap item) parse) {
    final map = asMap(json);
    final meta = asMap(map['meta']);
    final items = asMapList(map['data']).map(parse).toList(growable: false);
    return Page<T>(
      items: items,
      page: asInt(meta['page'], 1),
      pageSize: asInt(meta['pageSize'], items.length),
      total: asInt(meta['total'], items.length),
      totalPages: asInt(meta['totalPages'], 1),
    );
  }

  final List<T> items;
  final int page;
  final int pageSize;
  final int total;
  final int totalPages;

  bool get hasMore => page < totalPages;
}
