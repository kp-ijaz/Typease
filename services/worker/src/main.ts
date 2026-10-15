/**
 * Entry point of the TypEase worker service.
 *
 * The worker is part of the API code base (services/api/src/worker.ts): it has
 * to load every API module to run the job handlers, schedules and event
 * subscribers they register. This package only starts it from the BUILT API,
 * so the worker image runs plain JavaScript and never compiles TypeScript.
 *
 *   pnpm --filter @typease/api build       # produces services/api/dist/worker.js
 *   pnpm --filter @typease/worker build    # produces services/worker/dist/main.js
 *   pnpm --filter @typease/worker start    # node dist/main.js
 *
 * Configuration comes from the same environment as the API (QUEUE_DRIVER must
 * be "bullmq") plus WORKER_CONCURRENCY, WORKER_HEALTH_PORT,
 * WORKER_OUTBOX_INTERVAL_MS and WORKER_SHUTDOWN_TIMEOUT_MS.
 * See docs/architecture/WORKER.md.
 */

/** The part of services/api/src/worker.ts this launcher uses. */
interface WorkerModule {
  startWorker(options?: { concurrency?: number; healthPort?: number | false }): Promise<{ healthPort: number | null; stop(reason?: string): Promise<void> }>;
}

function loadWorker(): WorkerModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@typease/api/dist/worker') as WorkerModule;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'MODULE_NOT_FOUND' && String((err as Error).message).includes('@typease/api/dist/worker')) {
      throw new Error('The API has not been built: services/api/dist/worker.js is missing. Run "pnpm --filter @typease/api build" first (or use "pnpm --filter @typease/worker dev" during development).');
    }
    throw err;
  }
}

// SIGTERM / SIGINT handling, the health endpoint and the graceful shutdown are installed by startWorker().
loadWorker()
  .startWorker()
  .catch((err: unknown) => {
    // Configuration and start-up errors must be loud and fatal.
    console.error(err);
    process.exit(1);
  });

export {};
