import { defineConfig } from 'prisma/config';

// Prisma is used as the ORM / typed client only. Migrations are plain,
// reviewed SQL files in ./migrations applied by scripts/migrate.ts, because
// row-level security, triggers and check constraints cannot be expressed in
// the Prisma schema. `prisma generate` does not need a database connection.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_MIGRATION_URL ?? 'postgresql://typease:typease@localhost:5432/typease',
  },
});
