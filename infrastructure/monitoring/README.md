# Monitoring configuration

Used by the `monitoring` profile of `docker-compose.yml` and `docker-compose.prod.yml`.
Full description, alert list, what the application does not expose, log handling and PII:
**`docs/deployment/monitoring.md`**.

| Path | Purpose |
| --- | --- |
| `prometheus/prometheus.yml` | scrape configuration (API metrics with token header, Caddy, exporters, blackbox probes) |
| `prometheus/rules/typease-recording.yml` | maps the API's metric names to `typease:*` series - the only file to edit if the API renames a metric |
| `prometheus/rules/typease-alerts.yml` | alert rules |
| `prometheus/targets/public-example.yml.example` | template for the public URLs probed from outside-in (uptime + certificate expiry) |
| `alertmanager/alertmanager.yml` | starter routing with a `null` receiver - **configure a real receiver** |
| `blackbox/blackbox.yml` | probe modules |
| `grafana/provisioning/`, `grafana/dashboards/typease-overview.json` | datasources and the starter dashboard |
| `loki/loki.yml` | single-binary Loki, 30 days retention |
| `alloy/config.alloy` | log shipper (reads Docker json-file logs; no Docker socket) |
| `promtail/promtail.yml` | the same for hosts that still run Promtail (end-of-life upstream) |

Validation: `scripts/validate-infra.sh` (YAML / JSON parsing everywhere; `promtool`,
`amtool`, `alloy fmt` when Docker is available). Nothing in this directory has been run in a
container by its author.
