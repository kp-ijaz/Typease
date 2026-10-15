import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { AuthGuard } from './common/auth/auth.guard';
import { ContextMiddleware } from './common/context.middleware';
import { CoreModule } from './common/core.module';
import { AllExceptionsFilter } from './common/errors';
import { RateLimitGuard } from './common/rate-limit';
import { AuthModule } from './modules/auth/auth.module';
import { HealthController } from './modules/health/health.controller';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { FEATURE_MODULES } from './modules';

@Module({
  imports: [CoreModule, TenancyModule, AuthModule, ...FEATURE_MODULES],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Order matters: rate limiting first (cheap), then authentication / authorisation.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ContextMiddleware).forRoutes('*');
  }
}
