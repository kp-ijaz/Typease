import { Body, Controller, Get, Header, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { tenantSignupSchema } from '@typease/validation';
import { Public } from '../../common/auth/access';
import { ctx } from '../../common/context';
import { Errors } from '../../common/errors';
import { RateLimit } from '../../common/rate-limit';
import { dto } from '../../common/zod';
import { BrandingService, PublicAssetStore } from './branding.service';
import { OnboardingService } from './onboarding.service';
import { TenantResolver } from './tenant-resolver.service';

class SignupDto extends dto(tenantSignupSchema) {}

@ApiTags('Public')
@Controller()
export class PublicTenancyController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly branding: BrandingService,
    private readonly resolver: TenantResolver,
    private readonly assets: PublicAssetStore,
  ) {}

  @Public()
  @RateLimit({ name: 'tenant-signup', limit: 5, windowSeconds: 3600 })
  @Post('public/signup')
  @ApiOperation({ summary: 'A new typing centre signs up for TypEase' })
  signup(@Body() body: SignupDto) {
    return this.onboarding.signup(body);
  }

  @Public()
  @Get('public/tenant-config')
  @ApiOperation({ summary: 'White-label presentation for a centre (by slug, host or request origin)' })
  async tenantConfig(@Query('slug') slug?: string, @Query('host') host?: string, @Query('branchId') branchId?: string) {
    const tenantId = slug ? await this.resolver.resolveId(slug) : host ? await this.resolver.fromHost(host) : ctx().hostTenantId;
    if (!tenantId) throw Errors.notFound('Centre');
    return this.branding.publicConfig(tenantId, branchId);
  }

  @Public()
  @Get('public/slug-available')
  @RateLimit({ name: 'slug-check', limit: 60, windowSeconds: 60 })
  async slugAvailable(@Query('slug') slug: string) {
    const ok = /^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$/.test(slug ?? '') && !(await this.resolver.resolveId(slug));
    return { slug, available: ok };
  }

  @Public()
  @Get('public/assets/:key')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  @Header('X-Content-Type-Options', 'nosniff')
  async asset(@Param('key') key: string, @Res() res: Response) {
    const body = await this.assets.read(key);
    if (!body) throw Errors.notFound('Asset');
    const type = key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    res.type(type).send(body);
  }

  /** Called by the reverse proxy before it requests a certificate for an unknown host. Not routed publicly. */
  @Public()
  @Get('internal/tls/ask')
  async tlsAsk(@Query('domain') domain: string, @Res() res: Response) {
    res.status((await this.branding.tlsAllowed(String(domain ?? ''))) ? 200 : 404).end();
  }
}
