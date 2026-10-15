import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/auth/access';
import { SystemDb, TenantDb } from '../../common/db/prisma.service';
import { RedisService } from '../../common/redis';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: TenantDb,
    private readonly sys: SystemDb,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: the process is up. */
  @Public()
  @Get()
  @HttpCode(200)
  live() {
    return { status: 'ok', service: 'typease-api', time: new Date().toISOString() };
  }

  /** Readiness: dependencies are reachable. Used by load balancers and deploy checks. */
  @Public()
  @Get('ready')
  async ready(@Res() res: Response) {
    const check = async (fn: () => Promise<unknown>) => fn().then(() => true).catch(() => false);
    const checks = {
      database: await check(() => this.db.client.$queryRaw`SELECT 1`),
      systemDatabase: await check(() => this.sys.client.$queryRaw`SELECT 1`),
      redis: await this.redis.ping(),
    };
    const ok = Object.values(checks).every(Boolean);
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', checks });
  }
}
