import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SystemDb } from '../common/db/prisma.service';
import { AuditService } from '../common/audit.service';
import { runAsSystem } from '../common/context';
import { passwordPolicy, passwordProblems } from '../common/password-policy';
import { env } from '../config/env';
import { hashPassword } from '../modules/auth/auth.service';
import { ProvisioningService } from '../modules/tenancy/provisioning.service';

/**
 * Creates (or re-enables) a TypEase platform administrator. This is the only
 * way to obtain the FIRST platform super admin; further platform staff are
 * invited from the platform console.
 *
 *   PLATFORM_ADMIN_PASSWORD='...' pnpm --filter @typease/api platform-admin -- \
 *       --email ops@example.com --name "Operations Lead" [--role SUPER_ADMIN|SUPPORT_AGENT]
 *
 * The password is read from the PLATFORM_ADMIN_PASSWORD environment variable
 * (never from the command line, where it would end up in shell history and
 * process lists). The account must enrol in two-step verification at first
 * sign-in when MFA_ENFORCEMENT=required.
 */
const PLATFORM_ADMIN_MIN_LENGTH = 14;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = (arg('email') ?? '').trim().toLowerCase();
  const fullName = (arg('name') ?? '').trim();
  const role = (arg('role') ?? 'SUPER_ADMIN').toUpperCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? '';
  const problems: string[] = [];
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push('--email must be a valid email address');
  if (fullName.length < 2) problems.push('--name is required');
  if (!['SUPER_ADMIN', 'SUPPORT_AGENT'].includes(role)) problems.push('--role must be SUPER_ADMIN or SUPPORT_AGENT');
  // The API's password policy, with a higher minimum for the most powerful accounts.
  const policy = passwordPolicy(Math.max(PLATFORM_ADMIN_MIN_LENGTH, env().PASSWORD_MIN_LENGTH));
  for (const problem of passwordProblems(password, policy)) problems.push(`PLATFORM_ADMIN_PASSWORD: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`);
  if (problems.length) {
    console.error(`Cannot create the platform administrator:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(2);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    await app.get(ProvisioningService).bootstrapPlatform();
    const sys = app.get(SystemDb).client;
    const existing = await sys.user.findUnique({ where: { email } });
    if (existing && !existing.platformRole && (await sys.tenantMembership.count({ where: { userId: existing.id } })) > 0) {
      console.error(`${email} already belongs to a typing centre. Platform staff must use a separate account.`);
      process.exit(2);
    }
    const data = { fullName, platformRole: role as 'SUPER_ADMIN' | 'SUPPORT_AGENT', status: 'ACTIVE' as const, passwordHash: await hashPassword(password), passwordChangedAt: new Date(), emailVerifiedAt: new Date(), failedLoginCount: 0, lockedUntil: null };
    const user = existing ? await sys.user.update({ where: { id: existing.id }, data }) : await sys.user.create({ data: { email, ...data } });
    if (existing) await sys.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'CREDENTIALS_RESET_BY_CLI' } });
    await runAsSystem(() => app.get(AuditService).logSystem({ action: existing ? 'platform.staff.reset_by_cli' : 'platform.staff.created_by_cli', resourceType: 'User', resourceId: user.id, summary: `${role} ${email}` }), { actorLabel: 'cli:platform-admin' });
    console.log(`${existing ? 'Updated' : 'Created'} platform ${role === 'SUPER_ADMIN' ? 'super admin' : 'support agent'} ${email}.`);
    console.log(user.mfaEnabled ? 'Two-step verification is already enabled for this account.' : 'Sign in to the platform console and set up two-step verification.');
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
