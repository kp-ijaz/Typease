import { ServicesImportService } from './services-import.service';
import { AuthorityFeesController, PlatformAuthorityFeesController } from './authority-fees.controller';
import { AuthorityFeesService } from './authority-fees.service';
import { Module } from '@nestjs/common';
import { DocumentTypesController, PortalCatalogueController, PublicCatalogueController, ServiceCategoriesController, ServicesController } from './catalogue.controller';
import { CatalogueService } from './catalogue.service';
import { FormsService } from './forms.service';
import { PricingService } from './pricing.service';
import { StorefrontService } from './storefront.service';

/** Service catalogue: categories, document types, services, prices, requirements and dynamic forms. */
@Module({
  controllers: [AuthorityFeesController, PlatformAuthorityFeesController, ServiceCategoriesController, DocumentTypesController, ServicesController, PortalCatalogueController, PublicCatalogueController],
  providers: [ServicesImportService, CatalogueService, PricingService, FormsService, StorefrontService, AuthorityFeesService],
  exports: [CatalogueService, PricingService, FormsService, StorefrontService],
})
export class CatalogueModule {}
