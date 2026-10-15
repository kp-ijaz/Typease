/// Development helper for emulators.
///
/// A local API signs upload / download / checkout links with its own public
/// address, typically `http://localhost:4000`. On an Android emulator
/// "localhost" is the emulator itself and the host machine is `10.0.2.2`, so
/// such links would not open. When - and only when - a link points at a
/// loopback host and the configured API base URL does not, the link's host
/// and port are replaced with those of the API base URL.
///
/// Production links never point at loopback addresses, so this does nothing
/// outside local development.
class UrlRewriter {
  const UrlRewriter(this.apiBaseUrl);

  final String apiBaseUrl;

  static const Set<String> _loopback = <String>{'localhost', '127.0.0.1', '::1', '[::1]'};

  String rewrite(String url) {
    final target = Uri.tryParse(url);
    final base = Uri.tryParse(apiBaseUrl);
    if (target == null || base == null || !target.hasScheme || base.host.isEmpty) return url;
    if (!_loopback.contains(target.host.toLowerCase())) return url;
    if (_loopback.contains(base.host.toLowerCase())) return url;
    return Uri(
      scheme: base.scheme,
      host: base.host,
      port: base.hasPort ? base.port : null,
      path: target.path,
      query: target.hasQuery ? target.query : null,
      fragment: target.hasFragment ? target.fragment : null,
    ).toString();
  }
}
