import type { DemoFixtures } from './fixture-types';
import { fileVaultDocuments, financeExtras, reconcile, recordOptOuts, restoreNotificationLimit, tuneCentre } from './phase-extras';
import { backdateAndRunJobs, demonstrateBoundaries, printSummary, validateFixtures, verifyLogins } from './phase-finish';
import { runAppointments, runQueue, runTasks } from './phase-operations';
import { createPlatformStaff, replayBillingHistory, runSupportAccess } from './phase-platform';
import { createCompanies, createCustomers, suspendCompanies } from './phase-people';
import { runRequests } from './phase-requests';
import { configureCentre, customiseWorkflow, finishOnboarding, inviteStaff, signUp } from './phase-setup';
import { retryOneFailedNotification, runPlatformTickets, runPrivacyRequests, runReminders, runTickets, SmsOutage } from './phase-support';
import { ApiError, elapsed, onStepDone, section, SeedRuntime, StepError } from './runtime';
import { SeedContext } from './state';

export interface SeedOptions {
  port: number;
  skipEmptyCheck: boolean;
  fixturesPath: string;
}

function loadFixtures(path: string): DemoFixtures {
  let loaded: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require(path);
  } catch (e: any) {
    throw new Error(`The demo data could not be loaded from ${path}: ${e?.message ?? e}\nRun the seed through "pnpm db:seed" (it needs the TypeScript loader).`);
  }
  const demo: DemoFixtures | undefined = loaded?.DEMO;
  if (!demo?.tenants?.length) throw new Error(`${path} does not export the demo data set (DEMO).`);
  validateFixtures(demo);
  return demo;
}

const BANNER = `
######################################################################################
#  TypEase DEMO SEED - FOR LOCAL DEVELOPMENT AND DEMONSTRATIONS ONLY                   #
#                                                                                    #
#  Every account created here uses ONE shared password that is PUBLIC KNOWLEDGE       #
#  (it is printed in docs/DEMO_ENVIRONMENT.md). Never run this against, or copy this  #
#  data into, a production system. All people, companies, numbers and documents are   #
#  fictional.                                                                         #
######################################################################################`;

export async function runSeed(options: SeedOptions): Promise<number> {
  const fixtures = loadFixtures(options.fixturesPath);
  const password = process.env[fixtures.defaults.passwordEnv] || fixtures.defaults.password;
  console.log(BANNER);

  const rt = await SeedRuntime.boot(options.port, password);
  let code = 0;
  try {
    const tenants = await rt.sys.tenant.count();
    if (tenants > 0 && !options.skipEmptyCheck) {
      console.error(
        `\nREFUSED: this database already contains ${tenants} centre(s). The seed only fills an empty database and never deletes anything.\n` +
          'Reset the database first (pnpm db:reset, see docs/DEMO_ENVIRONMENT.md), or pass --force-empty-check=skip in development if you know what you are doing.',
      );
      return 2;
    }
    const ctx = new SeedContext(rt, fixtures);
    onStepDone(() => rt.settle());
    await build(ctx);
    console.log(`\nDemo environment ready in ${elapsed()} (${rt.calls} API calls).`);
  } catch (e: any) {
    code = 1;
    const cause = e instanceof StepError ? e.reason : e;
    if (cause instanceof ApiError) {
      console.error(`   The API refused: ${cause.message}`);
    } else {
      console.error(`   ${cause?.stack ?? cause}`);
    }
    console.error(`\nThe seed stopped after ${elapsed()}. Nothing was rolled back: reset the database before running it again.`);
  } finally {
    await rt.close().catch(() => undefined);
  }
  return code;
}

async function build(ctx: SeedContext): Promise<void> {
  section('Platform');
  await createPlatformStaff(ctx);

  section('Centres sign up');
  for (const t of ctx.tenants) await signUp(ctx, t);

  section('Onboarding and subscription history');
  await replayBillingHistory(ctx, (t) => finishOnboarding(ctx, t));

  for (const t of ctx.tenants) {
    section(t.fx.name);
    await inviteStaff(ctx, t);
    await configureCentre(ctx, t);
    await tuneCentre(ctx, t);
    await createCustomers(ctx, t);
    await recordOptOuts(ctx, t);
    await createCompanies(ctx, t);

    // The customised workflow is published part-way through the history: older requests stay on version 1.
    const outage = new SmsOutage(ctx, t);
    let workflowPublished = !t.fx.workflowCustomisation;
    await runRequests(ctx, t, {
      before: async (fx) => {
        await outage.before(fx.ref);
        if (!workflowPublished && fx.start < WORKFLOW_PUBLISHED_DAYS_AGO) {
          workflowPublished = true;
          await customiseWorkflow(ctx, t, WORKFLOW_PUBLISHED_DAYS_AGO);
        }
      },
    });
    await outage.end();

    await fileVaultDocuments(ctx, t);
    await financeExtras(ctx, t);
    await suspendCompanies(ctx, t);
    await reconcile(ctx, t);
    await runQueue(ctx, t);
    await runAppointments(ctx, t);
    await runTasks(ctx, t);
    await runTickets(ctx, t);
    await runPlatformTickets(ctx, t);
    await runReminders(ctx, t);
    await runPrivacyRequests(ctx, t);
    await retryOneFailedNotification(ctx, t);
    await restoreNotificationLimit(ctx, t);
  }

  section('Finishing');
  await backdateAndRunJobs(ctx);
  await runSupportAccess(ctx);
  await demonstrateBoundaries(ctx);
  await verifyLogins(ctx);
  printSummary(ctx);
}

/** The demo centre published its customised workflow this many days ago. */
const WORKFLOW_PUBLISHED_DAYS_AGO = 45;
