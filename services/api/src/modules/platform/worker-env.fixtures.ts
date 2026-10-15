/**
 * Imported FIRST by worker.bullmq.spec.ts: that one spec runs against the real
 * BullMQ driver. The test environment (test/env.ts) is re-applied before every
 * spec file, so this does not leak into other files of the same run.
 *
 * Equivalent to starting jest with TEST_ENV_OVERRIDES='{"QUEUE_DRIVER":"bullmq"}'.
 */
process.env.QUEUE_DRIVER = 'bullmq';

export {};
