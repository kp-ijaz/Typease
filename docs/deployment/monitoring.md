# Monitoring, alerting and logs

Configuration: `infrastructure/monitoring/`. Services: profile `monitoring` in both Compose
files (Prometheus, Alertmanager, Grafana, Loki, Alloy, postgres-exporter, redis-exporter,
blackbox-exporter, node-exporter).

> **Not executed.** No container was started where this was written. The YAML and JSON files
> parse; `promtool check config / rules`, `amtool check-config` and `alloy fmt` run in CI
> through `scripts/validate-infra.sh` (they need Docker). Metric names of the API were
> reconciled with its source code, not with a live scrape.

## 1. What is collected

| Source | How | What you get |
| --- | --- | --- |
| API `GET /api/v1/internal/metrics` | Prometheus job `typease-api`, header `x-internal-token` read from a file, one target per replica (DNS discovery) | centres by status, outbox pending / processing / failed / oldest pending age, queue jobs by state, notifications failed in the last hour, database / queue reachability, process memory and uptime |
| Caddy `:9180/metrics` | job `caddy` | request rate, status codes, request duration histograms (per server, **not per route**) |
| postgres-exporter | job `postgres`, role `typease_monitor` (`pg_monitor`, no table data) | connections, transactions, deadlocks, database size |
| redis-exporter | job `redis` | memory, clients, rejected connections |
| node-exporter | job `node` | disk, memory, CPU of the host; **backup freshness** through the textfile collector |
| blackbox-exporter | jobs `blackbox-internal`, `blackbox-public` | `/health`, `/health/ready`, worker health inside the network; public URLs and **certificate expiry** from outside-in |
| Container logs | Alloy -> Loki | all container output, labelled with the container name |

### API metrics (as implemented in `services/api/src/modules/platform/metrics.service.ts`)

```
typease_process_uptime_seconds            typease_process_resident_memory_bytes     typease_process_heap_used_bytes
typease_database_up                       typease_queue_up{driver}
typease_tenants{status}
typease_outbox_pending                    typease_outbox_processing                 typease_outbox_failed
typease_outbox_oldest_pending_seconds
typease_queue_jobs{state="waiting|active|delayed|failed"}
typease_notifications_failed              typease_notification_delivery_attempts_failed      (both: last hour)
```

All are gauges computed at scrape time from the database and the queue, so every replica
reports the same values. `prometheus/rules/typease-recording.yml` maps them to `typease:*`
series (taking `max` across replicas); alerts and the dashboard use only those. If the API
renames a metric, that file is the only place to change.

### What the application does NOT expose

Stated so that nobody assumes a dashboard panel exists for it:

* **HTTP request counts, error rates and latency per route.** The API has no request
  instrumentation. The proxy's metrics give totals and latency per server only. Per-route
  figures would need instrumentation in the API or log-derived metrics from the Caddy access
  log (`request.uri` is in the JSON; high cardinality - aggregate carefully).
* **Per-tenant metrics** (requests, storage, queue share). Usage is in the database
  (`usage_records`) and in the platform console, not in Prometheus.
* **Job durations, per-job-type failure counts, retries.** Only queue sizes by state.
* **Worker process metrics.** The metrics endpoint belongs to the API. The worker has a
  health endpoint only (`GET /health` and `/health/live` on `WORKER_HEALTH_PORT`), probed by
  the blackbox exporter; its memory, uptime and per-job figures are not exported.
* **Database query timings from the application.** Use `log_min_duration_statement`
  (set to 1 s in the bundled PostgreSQL) and `pg_stat_statements` if you enable it.
* **Structured application logs.** The API writes NestJS text log lines; the `LOG_LEVEL`
  variable and the `pino` dependency are present but not wired to the logger at the time of
  writing. Only the Caddy access log is JSON.
* **Business alerts** (payments failing at the gateway, webhooks rejected). These are
  security events / rows in the database, visible in the platform console.

## 2. Alerts

`prometheus/rules/typease-alerts.yml` - 33 rules. The ones asked for explicitly:

| Alert | Fires when | Severity |
| --- | --- | --- |
| `TypeaseApiDown` / `TypeaseApiAbsent` | a replica cannot be scraped for 2 min / no replica is registered | critical |
| `TypeaseApiNotReady` | `/health/ready` fails for 2 min (PostgreSQL or Redis unreachable from the API) | critical |
| `TypeaseOutboxBacklogGrowing` | more than 100 pending and rising for 15 min | warning |
| `TypeaseOutboxStuck` | oldest pending event older than 5 min | critical |
| `TypeaseOutboxFailedEvents` | any event in FAILED for 5 min | warning |
| `TypeaseQueueFailedJobs` | failed set not empty and growing over 30 min | warning |
| `TypeaseQueueBacklog` / `TypeaseQueueStalled` | more than 500 waiting for 15 min / waiting but none active for 10 min | warning / critical |
| `TypeaseNotificationFailures` | more than 10 notifications failed in the last hour, for 10 min | warning |
| `TypeasePostgresConnectionsHigh` | above 80 % of `max_connections` for 5 min | warning |
| `TypeaseDiskUsageHigh` / `TypeaseDiskWillFillIn24h` | above 85 % / predicted full within 24 h | warning / critical |
| `TypeaseBackupTooOld` / `...MetricMissing` / `...NotOffsite` / `...Shrunk` | last successful backup older than 26 h / no metric / not uploaded / half the usual size | critical / warning |
| `TypeaseCertificateExpiresSoon` / `...VerySoon` | a probed certificate has fewer than 14 / 3 days left | warning / critical |

Plus: worker down, public endpoint down, proxy 5xx ratio, API memory and restart loops,
PostgreSQL / Redis down, deadlocks, Redis memory and rejected connections, host memory.

Thresholds are starting values chosen without production data; expect to tune them in the
first weeks.

**Alertmanager ships with a `null` receiver: nothing is sent anywhere until you configure
one.** Copy `infrastructure/monitoring/alertmanager/alertmanager.yml` to
`/etc/typease/alertmanager.yml`, add an email / webhook receiver and route `severity:
critical` to whoever is on call. Test it: `amtool alert add test severity=critical`.

Monitoring that runs on the same host as the application cannot tell you that the host is
down. Add one external check (any uptime service) on `https://api.<domain>/health/ready`.

## 3. Uptime checks

* `GET /health` - liveness: the process answers. Not behind `/api/v1`.
* `GET /health/ready` - readiness: `200 {"status":"ready","checks":{"database":true,"systemDatabase":true,"redis":true}}`,
  `503` with the failing check otherwise. Used by the image `HEALTHCHECK`, by `scripts/deploy.sh`
  as the gate for a rolling restart, by the blackbox probes and by `scripts/smoke-test.sh`.

Public targets are listed per environment in `<PROMETHEUS_TARGETS_DIR>/public-*.yml`
(template: `prometheus/targets/public-example.yml.example`).

## 4. Scraping the internal metrics endpoint

`/api/v1/internal/*` is blocked at the reverse proxy, so Prometheus scrapes the API
container directly on the application network. The token is the API's `INTERNAL_API_TOKEN`:
the Prometheus container writes it from `monitoring.env` to a file at start and the scrape
configuration reads it with `http_headers: x-internal-token: files: [...]`.

`http_headers` needs a recent Prometheus (the Compose files pin 3.x). With an older server,
either upgrade, or scrape through a tiny internal Caddy site that adds the header
(`reverse_proxy api:4000 { header_up X-Internal-Token {env.INTERNAL_API_TOKEN} }`, listening
on the monitoring network only).

A `401` on the scrape means the two token values differ.

## 5. Logs

* Every container logs to stdout / stderr; Docker's `json-file` driver rotates them
  (20 MB x 5 per container in production). The Compose files add `tag: "{{.Name}}"`.
* **Alloy** tails `/var/lib/docker/containers/*/*-json.log` (read-only mount, no Docker
  socket) and ships to **Loki** with the labels `container` and `stream`. Promtail, which
  the Grafana stack used before, reached end-of-life upstream in 2026; an equivalent
  configuration is kept in `promtail/promtail.yml` for hosts that still run it.
* Loki keeps 30 days (`retention_period: 720h`), on local disk.
* Queries: `{container=~"typease-api-.*"} |= "ERROR"`,
  `{container=~"typease-caddy-.*"} | json | status >= 500`.

### Personal data in logs

Logs are personal data under UAE data-protection rules as soon as they contain an IP
address, an email or a name. What is done, and what is not:

* The proxy access log redacts `Authorization`, `Cookie`, `X-Internal-Token` and one-time
  tokens in URLs. It **does** contain client IP addresses, user agents and request paths
  (which contain record ids, not names).
* The shipper redacts obvious credential patterns once more.
* The API's audit trail has its own redaction of secret-looking keys; its ordinary log lines
  were not audited for personal data as part of this work. Error messages can contain
  values from a failing request. Keep `LOG_LEVEL` at `info` or quieter.
* Mailpit (development) stores complete emails. Never point production at it.
* Retention: 30 days in Loki, a few files on the host. Decide the period deliberately,
  document it in the privacy notice, restrict Grafana access to the operations team, and do
  not export logs to a third-party service without recording it as a processor.

## 6. Grafana

Provisioned datasources (Prometheus, Loki) and one dashboard, *TypEase - Overview*:
availability tiles, application series, proxy traffic and latency, data stores and host,
backup age, and two log panels. Development: `http://localhost:3030` (`admin` / the
development password in `infrastructure/docker/env/dev/monitoring.env`). Production: not
published - SSH tunnel, or the protected Caddy site `sites/grafana.caddy.example`.

The dashboard JSON was generated and parsed but never loaded into a Grafana; expect cosmetic
fixes on first use.
