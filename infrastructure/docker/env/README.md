# Environment files of the Compose stacks

`dev/` holds the **development defaults** of `docker-compose.yml`. Every value in there is a
publicly known, development-only value: it is committed on purpose so that `docker compose
--profile full up` works out of the box, and it must never be used on a server that is
reachable from the internet. `scripts/production-readiness.mjs` fails on each of them.

| File | Read by | Content |
| --- | --- | --- |
| `dev/api.env` | api, worker, migrate, minio-init | every variable of `services/api/src/config/env.ts` that the stack sets |
| `dev/migrate.env` | migrate | the schema-owner connection (kept out of the API and worker containers) |
| `dev/postgres.env` | postgres | bootstrap superuser, owner role, optional backup / monitoring roles |
| `dev/minio.env` | minio, minio-init | root credentials and the built-in KMS key for SSE-S3 |
| `dev/n8n.env` | n8n | n8n encryption key and host settings |
| `dev/monitoring.env` | prometheus, grafana, exporters (`--profile monitoring`) | scrape token, Grafana admin, exporter DSNs |

Production uses the same split with real secrets. The templates are in
`infrastructure/deployment/env/*.env.example`; the real files live outside the repository
(default `/etc/typease`, mode `0600`, owner `root`). Use `TYPEASE_ENV_DIR` to point either
Compose file at another directory.
