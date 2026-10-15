import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Patch, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  acceptInvitationSchema, changePasswordSchema, forgotPasswordSchema, loginSchema, mfaDisableSchema, mfaEnableSchema, mfaVerifySchema,
  otpRequestSchema, otpVerifySchema, phoneVerifyConfirmSchema, phoneVerifyRequestSchema, refreshSchema, registerCustomerSchema,
  resendVerificationSchema, resetPasswordSchema, selectTenantSchema, sessionListQuery, supportSessionExchangeSchema, switchTenantSchema, updateProfileSchema, verifyEmailSchema,
} from '@typease/validation';
import { env } from '../../config/env';
import { Authenticated, Public } from '../../common/auth/access';
import { SupportSessionSafe } from '../../common/auth/support-session';
import { Errors } from '../../common/errors';
import { RateLimit } from '../../common/rate-limit';
import { dto } from '../../common/zod';
import { AuthService, IssuedSession, LoginOutcome } from './auth.service';

class LoginDto extends dto(loginSchema) {}
class OtpRequestDto extends dto(otpRequestSchema) {}
class OtpVerifyDto extends dto(otpVerifySchema) {}
class MfaVerifyDto extends dto(mfaVerifySchema) {}
class SelectTenantDto extends dto(selectTenantSchema) {}
class SwitchTenantDto extends dto(switchTenantSchema) {}
class RefreshDto extends dto(refreshSchema) {}
class RegisterDto extends dto(registerCustomerSchema) {}
class VerifyEmailDto extends dto(verifyEmailSchema) {}
class ResendDto extends dto(resendVerificationSchema) {}
class ForgotDto extends dto(forgotPasswordSchema) {}
class ResetDto extends dto(resetPasswordSchema) {}
class ChangePasswordDto extends dto(changePasswordSchema) {}
class MfaEnableDto extends dto(mfaEnableSchema) {}
class MfaDisableDto extends dto(mfaDisableSchema) {}
class AcceptInvitationDto extends dto(acceptInvitationSchema) {}
class PhoneRequestDto extends dto(phoneVerifyRequestSchema) {}
class PhoneConfirmDto extends dto(phoneVerifyConfirmSchema) {}
class ProfileDto extends dto(updateProfileSchema) {}
class SupportExchangeDto extends dto(supportSessionExchangeSchema) {}
class SessionListDto extends dto(sessionListQuery) {}

const WEB_APPS = ['centre', 'customer', 'corporate', 'platform'];
const cookieName = (app: string) => `te_rt_${app}`;

/**
 * Browser apps keep the refresh token in an HttpOnly cookie scoped to the auth
 * path; the mobile app receives it in the response body and stores it in the
 * platform keystore. Access tokens are short-lived and kept in memory only.
 */
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private deliver(res: Response, app: string, outcome: LoginOutcome | ({ status: 'OK' } & IssuedSession)) {
    if (outcome.status !== 'OK') return outcome;
    const { refreshToken, ...body } = outcome;
    if (WEB_APPS.includes(app)) {
      // The cookie of a support session lives no longer than the access the centre approved.
      const supportEnds = outcome.session.supportGrant ? new Date(outcome.session.supportGrant.expiresAt).getTime() - Date.now() : null;
      res.cookie(cookieName(app), refreshToken, {
        httpOnly: true,
        secure: env().COOKIE_SECURE,
        sameSite: 'lax',
        domain: env().COOKIE_DOMAIN || undefined,
        path: '/api/v1/auth',
        maxAge: supportEnds !== null ? Math.max(1000, supportEnds) : env().REFRESH_TTL_DAYS * 86400_000,
      });
      return body;
    }
    return outcome;
  }
  private clear(res: Response, app: string) {
    res.clearCookie(cookieName(app), { path: '/api/v1/auth', domain: env().COOKIE_DOMAIN || undefined });
  }

  @Public()
  @RateLimit({ name: 'login', limit: 10, windowSeconds: 300, bodyKeys: ['email'] })
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with email and password' })
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response) {
    return this.deliver(res, body.app, await this.auth.login(body));
  }

  @Public()
  @RateLimit({ name: 'otp-request', limit: 5, windowSeconds: 600, bodyKeys: ['phone'] })
  @Post('otp/request')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a one-time passcode to a verified phone number' })
  requestOtp(@Body() body: OtpRequestDto) {
    return this.auth.requestLoginOtp(body);
  }

  @Public()
  @RateLimit({ name: 'otp-verify', limit: 10, windowSeconds: 600, bodyKeys: ['phone'] })
  @Post('otp/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with a one-time passcode' })
  async verifyOtp(@Body() body: OtpVerifyDto, @Res({ passthrough: true }) res: Response) {
    return this.deliver(res, body.app, await this.auth.verifyLoginOtp(body));
  }

  @Public()
  @RateLimit({ name: 'mfa-verify', limit: 10, windowSeconds: 300 })
  @Post('mfa/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete sign-in with an authenticator or recovery code' })
  async verifyMfa(@Body() body: MfaVerifyDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const outcome = await this.auth.verifyMfa(body.challengeToken, body.code);
    return this.deliver(res, clientApp(req), outcome);
  }

  @Public()
  @Post('select-tenant')
  @HttpCode(200)
  @ApiOperation({ summary: 'Choose a centre after signing in (users with several memberships)' })
  async selectTenant(@Body() body: SelectTenantDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.deliver(res, clientApp(req), await this.auth.selectTenant(body.selectionToken, body.membershipId));
  }

  @Authenticated({ allowWithoutMfa: true })
  @ApiBearerAuth()
  @Post('switch-tenant')
  @HttpCode(200)
  async switchTenant(@Body() body: SwitchTenantDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.deliver(res, clientApp(req), { status: 'OK', ...(await this.auth.switchTenant(body.membershipId)) });
  }

  /**
   * Second half of the support-session hand-off (first half: POST /platform/access-grants/:id/enter). Public
   * because the staff app has no session yet; the one-time code is the credential. Always for the staff app.
   */
  @Public()
  @RateLimit({ name: 'support-handoff', limit: 10, windowSeconds: 300 })
  @Post('support-session/exchange')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange the one-time hand-off code from the platform console for a support session of the staff app' })
  async exchangeSupportSession(@Body() body: SupportExchangeDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Sets a cookie: require the custom header that a cross-site form or image request cannot send.
    if (req.header('x-requested-with') !== 'typease') throw Errors.forbidden('CSRF_CHECK_FAILED', 'Request blocked.');
    return this.deliver(res, 'centre', { status: 'OK', ...(await this.auth.exchangeSupportHandoff(body.code)) });
  }

  @Authenticated({ allowWithoutMfa: true })
  @ApiBearerAuth()
  @Get('memberships')
  memberships() {
    return this.auth.listMemberships();
  }

  @Public()
  @RateLimit({ name: 'refresh', limit: 60, windowSeconds: 60 })
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the refresh token and get a new access token' })
  async refresh(@Body() body: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const app = body.app ?? clientApp(req);
    let token = body.refreshToken;
    if (!token) {
      // Cookie-based refresh: require a custom header (not sendable cross-site without CORS approval).
      if (req.header('x-requested-with') !== 'typease') throw Errors.forbidden('CSRF_CHECK_FAILED', 'Request blocked.');
      token = req.cookies?.[cookieName(app)];
    }
    if (!token) throw Errors.unauthorized('SESSION_EXPIRED', 'Your session has ended. Please sign in again.');
    try {
      return this.deliver(res, app, { status: 'OK', ...(await this.auth.refresh(token)) });
    } catch (e) {
      this.clear(res, app);
      throw e;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Body() body: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const app = body.app ?? clientApp(req);
    await this.auth.logout(body.refreshToken ?? req.cookies?.[cookieName(app)]);
    this.clear(res, app);
    return { status: 'SIGNED_OUT' };
  }

  @Authenticated({ allowWithoutMfa: true })
  @SupportSessionSafe('The session itself: who is signed in, in which centre, under which access grant and until when.')
  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Current user, centre, role and permissions' })
  me(@Req() req: Request) {
    return (req as any).sessionInfo;
  }

  @Authenticated({ allowWithoutMfa: true })
  @ApiBearerAuth()
  @Patch('me')
  updateProfile(@Body() body: ProfileDto) {
    return this.auth.updateProfile(body);
  }

  // ---- registration and verification
  @Public()
  @RateLimit({ name: 'register', limit: 10, windowSeconds: 3600 })
  @Post('register')
  @ApiOperation({ summary: 'Customer self-registration at a centre' })
  register(@Body() body: RegisterDto) {
    return this.auth.registerCustomer(body);
  }

  @Public()
  @RateLimit({ name: 'verify-email', limit: 20, windowSeconds: 600 })
  @Post('verify-email')
  @HttpCode(200)
  verifyEmail(@Body() body: VerifyEmailDto) {
    return this.auth.verifyEmail(body.token);
  }

  @Public()
  @RateLimit({ name: 'resend-verification', limit: 5, windowSeconds: 900, bodyKeys: ['email'] })
  @Post('resend-verification')
  @HttpCode(200)
  resend(@Body() body: ResendDto) {
    return this.auth.resendVerification(body.email);
  }

  @Authenticated({ allowWithoutMfa: true })
  @ApiBearerAuth()
  @RateLimit({ name: 'phone-verify', limit: 5, windowSeconds: 900 })
  @Post('phone/request-verification')
  @HttpCode(200)
  requestPhoneVerification(@Body() body: PhoneRequestDto) {
    return this.auth.requestPhoneVerification(body.phone);
  }

  @Authenticated({ allowWithoutMfa: true })
  @ApiBearerAuth()
  @Post('phone/verify')
  @HttpCode(200)
  confirmPhone(@Body() body: PhoneConfirmDto) {
    return this.auth.confirmPhoneVerification(body.phone, body.code);
  }

  // ---- passwords
  @Public()
  @RateLimit({ name: 'forgot-password', limit: 5, windowSeconds: 900, bodyKeys: ['email'] })
  @Post('password/forgot')
  @HttpCode(200)
  forgot(@Body() body: ForgotDto) {
    return this.auth.forgotPassword(body.email, body.app, body.tenantSlug);
  }

  @Public()
  @RateLimit({ name: 'reset-password', limit: 10, windowSeconds: 900 })
  @Post('password/reset')
  @HttpCode(200)
  reset(@Body() body: ResetDto) {
    return this.auth.resetPassword(body.token, body.password);
  }

  @Authenticated({ allowWithoutMfa: true })
  @ApiBearerAuth()
  @Post('password/change')
  @HttpCode(200)
  changePassword(@Body() body: ChangePasswordDto) {
    return this.auth.changePassword(body.currentPassword, body.newPassword);
  }

  // ---- MFA
  @Authenticated({ allowWithoutMfa: true })
  @ApiBearerAuth()
  @Post('mfa/setup')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start authenticator-app enrolment' })
  mfaSetup() {
    return this.auth.mfaSetup();
  }

  @Authenticated({ allowWithoutMfa: true })
  @ApiBearerAuth()
  @Post('mfa/enable')
  @HttpCode(200)
  mfaEnable(@Body() body: MfaEnableDto) {
    return this.auth.mfaEnable(body.code);
  }

  @Authenticated()
  @ApiBearerAuth()
  @Post('mfa/disable')
  @HttpCode(200)
  mfaDisable(@Body() body: MfaDisableDto) {
    return this.auth.mfaDisable(body.password, body.code);
  }

  // ---- sessions
  @Authenticated({ allowWithoutMfa: true })
  @ApiBearerAuth()
  @Get('sessions')
  @ApiOperation({ summary: 'Own live sessions, most recent first (at most `limit`, default 20; the current session is always included). Header X-Total-Count = all live sessions.' })
  async sessions(@Query() query: SessionListDto, @Res({ passthrough: true }) res: Response) {
    const { total, sessions } = await this.auth.listSessions(query);
    res.setHeader('X-Total-Count', String(total));
    return sessions;
  }

  @Authenticated({ allowWithoutMfa: true })
  @ApiBearerAuth()
  @Post('sessions/revoke-others')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign out everywhere else: ends every other live session of the user, in every app. `{ revoked }`' })
  revokeOthers() {
    return this.auth.revokeOtherSessions();
  }

  @Authenticated({ allowWithoutMfa: true })
  @ApiBearerAuth()
  @Delete('sessions/:id')
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    await this.auth.revokeSession(id);
    return { status: 'REVOKED' };
  }

  @Authenticated({ allowWithoutMfa: true })
  @ApiBearerAuth()
  @Get('login-activity')
  loginActivity() {
    return this.auth.loginActivity();
  }

  // ---- invitations
  @Public()
  @RateLimit({ name: 'invitation', limit: 30, windowSeconds: 600 })
  @Get('invitations/preview')
  previewInvitation(@Query('token') token: string) {
    return this.auth.previewInvitation(String(token ?? ''));
  }

  @Public()
  @RateLimit({ name: 'invitation', limit: 30, windowSeconds: 600 })
  @Post('invitations/accept')
  @HttpCode(200)
  async accept(@Body() body: AcceptInvitationDto, @Res({ passthrough: true }) res: Response) {
    const outcome = await this.auth.acceptInvitation(body);
    const app = outcome.status === 'OK' ? (outcome.session.membership?.kind === 'STAFF' ? 'centre' : body.app) : body.app;
    return this.deliver(res, app, outcome);
  }
}

function clientApp(req: Request): string {
  const app = String(req.header('x-client-app') ?? '').toLowerCase();
  return ['centre', 'customer', 'corporate', 'platform', 'mobile'].includes(app) ? app : 'mobile';
}
