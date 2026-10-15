/** Test configuration. A dedicated database is created and migrated by global-setup.ts. */
const pgHost = process.env.TEST_PG_HOST ?? '127.0.0.1';
const pgPort = process.env.TEST_PG_PORT ?? '5432';
const db = process.env.TEST_PG_DATABASE ?? 'typease_test';
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? `postgresql://typease_app:app_dev_pw@${pgHost}:${pgPort}/${db}`,
  DATABASE_SYSTEM_URL: process.env.TEST_DATABASE_SYSTEM_URL ?? `postgresql://typease_system:system_dev_pw@${pgHost}:${pgPort}/${db}`,
  DATABASE_MIGRATION_URL: process.env.TEST_DATABASE_MIGRATION_URL ?? `postgresql://typease_owner:owner_dev_pw@${pgHost}:${pgPort}/${db}`,
  DATABASE_POOL_MAX: '5',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/1',
  JWT_ACCESS_SECRET: 'test-only-jwt-secret-0123456789abcdef0123456789abcdef',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  HMAC_KEY: 'test-only-hmac-key-0123456789abcdef0123456789abcdef',
  QUEUE_DRIVER: 'inline',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: process.env.TEST_STORAGE_DIR ?? '/tmp/typease-test-storage',
  EXPOSE_DEV_TOKENS: 'true',
  RATE_LIMIT_ENABLED: 'false',
  MFA_ENFORCEMENT: 'optional',
  ONBOARDING_REQUIRE_PHONE_VERIFICATION: 'false',
  PAYMENT_SANDBOX_ENABLED: 'true',
  PLATFORM_BASE_DOMAIN: 'typease.test',
  OCR_PROVIDER: 'disabled',
  MALWARE_SCANNER: 'none',
  ...(process.env.TEST_ENV_OVERRIDES ? JSON.parse(process.env.TEST_ENV_OVERRIDES) : {}),
});
