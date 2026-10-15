# Reverse proxy, TLS and custom domains

Files: `infrastructure/docker/caddy/Caddyfile` (development, plain HTTP),
`infrastructure/docker/caddy/Caddyfile.prod` (production), optional sites in
`infrastructure/docker/caddy/sites/*.caddy.example`, optional image with a DNS module in
`infrastructure/docker/caddy/Dockerfile`.

> **Not executed.** No Caddy binary or Docker daemon was available where these files were
> written. They were reviewed against the Caddy 2.10 Caddyfile syntax; `scripts/validate-infra.sh`
> runs `caddy validate` on both files as soon as Docker is available (CI job `quality`).
> Treat the first `caddy validate` as part of bringing up any environment.

## 1. Routing

`BASE` is `TYPEASE_BASE_DOMAIN` (= `PLATFORM_BASE_DOMAIN` of the API).

| Host | Goes to | Certificate |
| --- | --- | --- |
| `api.BASE` | `api:4000` | automatic, at start-up |
| `app.BASE` | `centre-web:3001` (staff console) | automatic |
| `admin.BASE` | `platform-admin:3004` | automatic |
| `corporate.BASE` | `corporate-portal:3003` | automatic |
| `portal.BASE` | `customer-web:3002` - shared customer portal (`CUSTOMER_WEB_URL`) and CNAME target for custom domains | automatic |
| `BASE`, `www.BASE` | redirect to `app.BASE` (replace with your marketing site; delete the block if the apex is hosted elsewhere) | automatic |
| `<slug>.BASE` | `customer-web:3002` | **on demand**, only if the API knows the slug (or one wildcard certificate, section 3) |
| any **verified** custom domain | `customer-web:3002` | **on demand**, only if the API confirms it |
| anything else | TLS handshake is refused (no certificate) | - |

On **every host that serves a web application** (the three consoles, `portal.BASE`, tenant
sub-domains, custom domains) the prefix `/api/v1/*` is proxied straight to the API. Two
reasons:

* *First-party cookies.* The API's refresh cookie is `SameSite=Lax` and scoped to
  `/api/v1/auth`. A portal served from `portal.some-centre.ae` that called
  `https://api.BASE` would make a cross-site request and the browser would not send the
  cookie - sessions could not be refreshed. Calling the API on the portal's own origin
  avoids that.
* *The web apps can proxy `/api/v1` themselves* (`apiProxy` in `packages/config/next.mjs`,
  a Next.js rewrite to `API_INTERNAL_URL`). That is right for development with pnpm, but
  behind the proxy it must not carry traffic: the API would see the web container as the
  client (wrong address for rate limits, lockouts and the audit trail), and
  `/api/v1/internal/*` would be reachable through the application. Because Caddy handles the
  prefix first, the rewrite is never reached in the Compose stacks.

Upstreams in production are resolved with Caddy's dynamic `A`-record lookup against Docker's
DNS (`refresh 5s`), with passive health checks and retries (`lb_try_duration 10s`). Scaling
`api` or doing a rolling restart needs no proxy reload.

### What the proxy adds

* `Strict-Transport-Security: max-age=31536000; includeSubDomains` (production only),
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`; removes `Server` and `X-Powered-By`.
  Set with `defer`, so they replace whatever the upstream sent (the API's own helmet headers
  stay in place for everything else, including its CSP).
* Request body limit: 16 MB on every site (`UPLOAD_MAX_BODY`; the API's upload limit
  `UPLOAD_MAX_BYTES` is 15 MiB - keep the proxy limit above it). With S3 storage the browser
  uploads directly to the object store, so the limit only matters for the local storage
  driver and multipart endpoints. The API itself limits JSON bodies to 1 MB.
* `encode zstd gzip`.
* JSON access logs on stdout. `Authorization` and `Cookie` are redacted by Caddy itself; the
  configuration additionally redacts one-time tokens that travel in URLs
  (`?token=`, `?code=`, `?sig=`, `/storage/local/upload|download/<token>`,
  `/shared-documents/<token>`) and drops `X-Internal-Token`.
* Proxy metrics on `:9180/metrics` (not published; scraped by Prometheus).

### Internal endpoints are blocked

`/api/v1/internal/*` holds the on-demand TLS check (`/internal/tls/ask`, public for the
proxy by design - Caddy cannot send a secret with it) and the Prometheus metrics
(`/internal/metrics`, `x-internal-token`). They are for the proxy and the monitoring network
only. On **every** public site the proxy

1. strips the `X-Internal-Token` request header, and
2. answers `404` for `/api/v1/internal` and `/api/v1/internal/*` before anything is proxied.

The match is made on Caddy's cleaned path (decoded, dot segments and duplicate slashes
resolved) and is case-insensitive. `scripts/smoke-test.sh` verifies from outside that a
request to those paths never reaches the API (a response that reached the API carries
`x-request-id`).

Consequence if you put another proxy or a load balancer in front of the API **without**
Caddy: replicate this rule there. Without it, anyone can ask the API which host names are
registered (`/internal/tls/ask`), and the metrics endpoint is protected by the token alone.

### Real client address

The API calls `app.set('trust proxy', 1)`: it trusts exactly **one** proxy hop and takes the
client address from the last entry of `X-Forwarded-For`. Caddy has no trusted proxies
configured, so it discards any `X-Forwarded-For` sent by the client and writes the real peer
address. Rate limiting, login lockouts and the audit trail therefore see the true client IP.

Behind a CDN or load balancer the peer is that device, not the client. Then:

```
{
	servers {
		trusted_proxies static <CDN / LB address ranges>
		client_ip_headers X-Forwarded-For        # or CF-Connecting-IP for Cloudflare
	}
}
```

and, inside each `reverse_proxy` block that reaches the API, collapse the chain to a single
value so that "one hop" still means the client:

```
header_up X-Forwarded-For {client_ip}
```

Without the second part the API would record the CDN's address for every request. This
variant was not tested.

### Logos with S3 storage

With `STORAGE_DRIVER=s3` the API uploads logos and favicons to `S3_PUBLIC_ASSETS_BUCKET` and
its own route `GET /api/v1/public/assets/<key>` reads them back from that bucket
(`PublicAssetStore` in `services/api/src/modules/tenancy/branding.service.ts`); with the
local driver it reads the local directory. The URL it hands out is
`<S3_PUBLIC_ASSETS_BASE_URL>/<key>` when that variable is set (a CDN or the bucket's public
address), otherwise `<API_PUBLIC_URL>/api/v1/public/assets/<key>`. So logos work without any
proxy rule; the S3 path was unit-tested offline and never run against a bucket.

The Caddyfiles still offer an edge short-cut: when `S3_PUBLIC_ASSETS_PROXY=true`, a `GET` for
`/api/v1/public/assets/<key>` (same key pattern as the API) is rewritten to
`/<S3_PUBLIC_ASSETS_BUCKET>/<key>` and proxied to `S3_PUBLIC_ASSETS_UPSTREAM`, which keeps the
API out of the path of a public, cacheable file. The public assets bucket must then allow
anonymous `GetObject` (the bundled MinIO job sets this; the documents bucket never does). Both
Compose stacks enable it. With `STORAGE_DRIVER=local` leave it off.

## 2. On-demand TLS for custom domains

```
{
	on_demand_tls {
		ask http://api:4000/api/v1/internal/tls/ask
	}
}
https:// {
	tls {
		on_demand
	}
	...
}
```

When a TLS handshake arrives for a host name that has no explicit site, Caddy calls the ask
URL with `?domain=<name>`. The API answers `200` only for `<slug>.BASE` of an existing centre
or a custom domain with status `VERIFIED`; anything else gets `404` and no certificate is
requested. The API caches the answer per host for 30 seconds.

This is what makes it safe to accept arbitrary host names: nobody can point DNS at the
server and make it request certificates (and burn the CA's rate limits) for names the
platform has not verified. Certificates and ACME account keys are stored in the `caddy-data`
volume; keep it across restarts.

### What a centre has to do for a custom domain

1. Add the domain in the staff console (API: `POST /api/v1/domains`, permission
   `domain.manage`; the centre's plan must include custom domains). The API returns two DNS
   records:

   | Type | Name | Value | Purpose |
   | --- | --- | --- | --- |
   | `TXT` | `_typease-verify.<domain>` | `typease-verify=<token>` | proves ownership |
   | `CNAME` | `<domain>` | `CUSTOM_DOMAIN_CNAME_TARGET` (e.g. `portal.BASE`) | sends visitors to the platform |

2. Create both records at the DNS provider. A `CNAME` cannot be placed on a zone apex
   (`centre.ae` itself): use a sub-domain such as `portal.centre.ae`, or the provider's
   `ALIAS` / `ANAME` / flattened CNAME feature, or `A` / `AAAA` records with the platform's
   addresses (those then have to be updated if the platform moves).
3. Ask for verification (`POST /api/v1/domains/:id/verify`). The API looks up the TXT
   record; DNS changes can take time to propagate, so this may need to be repeated.
4. On the first visit Caddy asks the API, obtains a certificate (a few seconds) and serves
   the portal. If the domain has a `CAA` record it must allow the CA Caddy uses
   (`letsencrypt.org`, and `sectigo.com` for the ZeroSSL fallback).

Platform side, once: `portal.BASE` must resolve to the proxy (it is an explicit site -
"portal" is a reserved name that the ask endpoint does not approve), and
`CUSTOM_DOMAIN_CNAME_TARGET` must be that name.

Removing a domain (`DELETE /api/v1/domains/:id`) stops routing immediately (the ask endpoint and the tenant
resolver no longer know it); the certificate simply expires.

## 3. Tenant sub-domains: on-demand certificates or one wildcard

Both work; choose by growth rate.

| | On demand per host (default) | Wildcard `*.BASE` |
| --- | --- | --- |
| Needs | stock `caddy` image, nothing else | Caddy built with your DNS provider's module + an API token that can edit the zone |
| ACME challenge | HTTP-01 / TLS-ALPN-01 | **DNS-01** (the only challenge a CA accepts for wildcards) |
| DNS | wildcard `*.BASE A/AAAA` -> proxy (still needed so that names resolve) | the same |
| First request to a new centre | a few seconds slower (certificate is issued) | no delay |
| CA limits | one certificate per centre: Let's Encrypt limits new certificates per registered domain per week | one certificate for all centres |
| Unknown sub-domains | no certificate, handshake refused | valid certificate; the portal answers "centre not found" |

Start with on-demand. Switch when you expect more new centres per week than the CA's limit
(check the current Let's Encrypt rate limits; ask for an increase if needed), or when the
first-request delay matters:

1. `docker build -f infrastructure/docker/caddy/Dockerfile --build-arg CADDY_DNS_MODULE=github.com/caddy-dns/<provider> ...`
   and set `CADDY_IMAGE` in `compose.env`.
2. `cp sites/wildcard.caddy.example sites/wildcard.caddy`, adapt the `dns` line, put the
   token into `caddy.env` (`CADDY_DNS_API_TOKEN`).
3. Reload Caddy. Explicit hosts keep their sites (most specific name wins); custom domains
   keep using on-demand TLS.

Custom domains can never be covered by a wildcard: they are other people's domains.

## 4. DNS records for the platform

| Name | Type | Value |
| --- | --- | --- |
| `api`, `app`, `admin`, `corporate`, `portal` `.BASE` | `A` / `AAAA` | proxy address |
| `*.BASE` | `A` / `AAAA` | proxy address (tenant sub-domains) |
| `BASE`, `www.BASE` | `A` / `AAAA` | proxy address, or your marketing site |
| `s3.BASE` | `A` / `AAAA` | proxy address - only with the bundled MinIO (`sites/minio.caddy`) |
| `BASE` | `CAA` | `0 issue "letsencrypt.org"` (optional, recommended) |
| mail records (`SPF`, `DKIM`, `DMARC`) | `TXT` | as required by your email provider for `MAIL_FROM_ADDRESS` |

Ports 80 and 443 (TCP) and 443 (UDP, HTTP/3) must be reachable from the internet; port 80 is
needed for the HTTP-01 challenge and for redirects.

## 5. Operating Caddy

```bash
dc="docker compose --env-file /etc/typease/compose.env -f docker-compose.prod.yml"
$dc exec caddy caddy validate --config /etc/caddy/Caddyfile     # before every reload
$dc exec caddy caddy reload   --config /etc/caddy/Caddyfile     # zero-downtime configuration reload
$dc logs -f caddy | grep -i -E 'acme|certificate|tls'           # certificate issuance problems
```

Certificate expiry is monitored from outside by the blackbox exporter for the URLs listed in
`prometheus/targets/public-*.yml` (alerts `TypeaseCertificateExpiresSoon` /
`...VerySoon`). Add important custom domains to that list.

## 6. Development proxy

`Caddyfile` serves the same host layout over plain HTTP on `*.typease.localhost` (browsers
resolve every `*.localhost` name to `127.0.0.1`). It also serves `s3.typease.localhost` ->
MinIO, because presigned URLs must be reachable by the browser **and** by the API under the
same name; inside the Compose network the public names are aliases of the Caddy container.
Caddy listens inside the container on the same port number that is published
(`HTTP_PORT`, default 80) for that reason: if you change `HTTP_PORT`, append `:<port>` to
the six URL values and to `S3_ENDPOINT` in `infrastructure/docker/env/dev/api.env`.

## 7. Decisions on the application side

1. **Custom domains for the corporate portal and the staff console.** The API accepts a
   custom domain for the app `customer` only (`domainSchema` in `packages/validation`;
   `TenantDomain.app` has no other value in practice), and the proxy routes every custom
   domain to `customer-web`. Routing by application would need both an API change and a
   lookup for the proxy (for example `GET /api/v1/internal/route?host=` with Caddy's
   `forward_auth`). Nothing of that exists; it is a limitation, not an open question.
2. **Same-origin API on portal hosts.** See section 1. The shared Next configuration has an
   `apiProxy` option for this, and `customer-web` and `corporate-portal` enable it
   (`apps/<app>/next.config.mjs`): the Next.js server of each portal rewrites `/api/v1/*` to
   `API_INTERNAL_URL` (or `NEXT_PUBLIC_API_URL`) in every environment, and the Caddy rule in
   front of it does the same at the edge. If any other proxy or CDN is
   put in front of the web apps, it must also keep `/api/v1/internal/*` away from them.
3. **Reserved names.** `s3`, `n8n`, `grafana`, `prometheus` and `monitoring` are in the API's
   `RESERVED_SLUGS`, so no centre can take a slug that collides with a bundled or optional
   site. The explicit Caddy sites would win anyway.
