-- TypEase: first-time database bootstrap for a MANAGED PostgreSQL service (RDS, Cloud SQL,
-- Azure, DigitalOcean ...), where the container init script cannot run.
-- Run once as the provider's administrative user:
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
--        -v db=typease -v owner=typease_owner -v owner_password="$(openssl rand -hex 24)" \
--        -f infrastructure/docker/postgres/bootstrap.sql
--
-- Afterwards run the migration job with DATABASE_MIGRATION_URL=postgresql://<owner>:<password>@host/<db>.
-- The migration runner (as the owner) creates typease_app and typease_system and sets their
-- passwords from DATABASE_URL / DATABASE_SYSTEM_URL. Do NOT create those two roles here:
-- the owner can only manage roles that it created itself (PostgreSQL 16 CREATEROLE rules).
-- If your provider forces you to create them as the administrator, also run:
--   GRANT typease_app, typease_system TO <owner> WITH ADMIN OPTION;

SELECT format('CREATE ROLE %I LOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD %L', :'owner', :'owner_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner') \gexec

-- Managed services: the administrator is not a superuser and must be a member of the
-- new role to be allowed to create a database owned by it.
SELECT format('GRANT %I TO CURRENT_USER', :'owner')
 WHERE NOT (SELECT rolsuper FROM pg_roles WHERE rolname = CURRENT_USER) \gexec

SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8''', :'db', :'owner')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('ALTER DATABASE %I SET timezone = ''UTC''', :'db') \gexec

-- Optional read-only role for scripts/db-backup.sh (pg_dump must see every tenant's rows):
--   CREATE ROLE typease_backup LOGIN BYPASSRLS PASSWORD '...';   -- some providers only allow this for their admin role
--   GRANT pg_read_all_data TO typease_backup;
-- Optional role for postgres-exporter:
--   CREATE ROLE typease_monitor LOGIN PASSWORD '...'; GRANT pg_monitor TO typease_monitor;
