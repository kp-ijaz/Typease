import { Global, Module } from '@nestjs/common';
import { BrandingService, DnsLookup, PublicAssetStore, SystemDnsLookup } from './branding.service';
import { OnboardingService } from './onboarding.service';
import { OrganisationService } from './organisation.service';
import { ProvisioningService } from './provisioning.service';
import { PublicTenancyController } from './public.controller';
import { BranchesController, BrandingController, RolesController, StaffController, TenancyController } from './tenancy.controller';
import { TenantResolver } from './tenant-resolver.service';

@Global()
@Module({
  controllers: [TenancyController, BranchesController, StaffController, RolesController, BrandingController, PublicTenancyController],
  providers: [TenantResolver, ProvisioningService, OnboardingService, OrganisationService, BrandingService, PublicAssetStore, { provide: DnsLookup, useClass: SystemDnsLookup }],
  exports: [TenantResolver, ProvisioningService, OnboardingService, OrganisationService, BrandingService, PublicAssetStore, DnsLookup],
})
export class TenancyModule {}
