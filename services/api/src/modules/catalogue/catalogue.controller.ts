import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { serviceImportSchema } from '@typease/validation';
import { MAX_IMPORT_BYTES } from '../../common/tabular';
import { ServicesImportService } from './services-import.service';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  catalogueDocumentTypeSchema, catalogueOrderSchema, createServiceFormSchema, customerCatalogueQuery, publicCatalogueQuery, queryBool,
  serviceCategorySchema, serviceFullQuery, serviceListQuery, servicePriceQuery, servicePriceSchema, serviceRequirementSchema, serviceSchema,
  updateCatalogueDocumentTypeSchema, updateServiceCategorySchema, updateServiceFormSchema, updateServiceRequirementSchema, updateServiceSchema, uuid, z,
} from '@typease/validation';
import { Permissions, Public, TenantMember } from '../../common/auth/access';
import { SupportSessionSafe } from '../../common/auth/support-session';
import { RateLimit } from '../../common/rate-limit';
import { dto } from '../../common/zod';
import { CatalogueService } from './catalogue.service';
import { FormsService } from './forms.service';
import { PricingService } from './pricing.service';
import { StorefrontService } from './storefront.service';

class IncludeInactiveQuery extends dto(z.object({ includeInactive: queryBool })) {}
class CategoryDto extends dto(serviceCategorySchema) {}
class UpdateCategoryDto extends dto(updateServiceCategorySchema) {}
class OrderDto extends dto(catalogueOrderSchema) {}
class DocumentTypeDto extends dto(catalogueDocumentTypeSchema) {}
class UpdateDocumentTypeDto extends dto(updateCatalogueDocumentTypeSchema) {}
class ServiceDto extends dto(serviceSchema) {}
class UpdateServiceDto extends dto(updateServiceSchema) {}
class ServiceListQueryDto extends dto(serviceListQuery) {}
class PriceDto extends dto(servicePriceSchema) {}
class PriceQueryDto extends dto(servicePriceQuery) {}
class FullQueryDto extends dto(serviceFullQuery) {}
class RequirementDto extends dto(serviceRequirementSchema) {}
class UpdateRequirementDto extends dto(updateServiceRequirementSchema) {}
class CreateFormDto extends dto(createServiceFormSchema) {}
class UpdateFormDto extends dto(updateServiceFormSchema) {}
class CustomerCatalogueQueryDto extends dto(customerCatalogueQuery) {}
class CustomerServiceQueryDto extends dto(z.object({ branchId: uuid.optional() })) {}
class PublicCatalogueQueryDto extends dto(publicCatalogueQuery) {}
class PublicServiceQueryDto extends dto(publicCatalogueQuery.pick({ slug: true })) {}

const ID = () => Param('id', ParseUUIDPipe);

@ApiTags('Service categories')
@ApiBearerAuth()
@Controller('service-categories')
export class ServiceCategoriesController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Permissions('service.read')
  @Get()
  list(@Query() query: IncludeInactiveQuery) {
    return this.catalogue.listCategories(query.includeInactive === true);
  }
  @Permissions('service.manage')
  @Post()
  create(@Body() body: CategoryDto) {
    return this.catalogue.createCategory(body);
  }
  @Permissions('service.manage')
  @Put('order')
  @ApiOperation({ summary: 'Reorder categories' })
  reorder(@Body() body: OrderDto) {
    return this.catalogue.reorderCategories(body.ids);
  }
  @Permissions('service.manage')
  @Patch(':id')
  @ApiOperation({ summary: 'Edit, activate or deactivate a category' })
  update(@ID() id: string, @Body() body: UpdateCategoryDto) {
    return this.catalogue.updateCategory(id, body);
  }
  @Permissions('service.manage')
  @Delete(':id')
  remove(@ID() id: string) {
    return this.catalogue.deleteCategory(id);
  }
}

@ApiTags('Document types')
@ApiBearerAuth()
@Controller('document-types')
export class DocumentTypesController {
  constructor(private readonly catalogue: CatalogueService) {}

  @TenantMember()
  @SupportSessionSafe('Reference list (names of document types) that screens need to label what they show. No customer data.')
  @Get()
  @ApiOperation({ summary: 'Platform defaults merged with the centre\'s own document types' })
  list(@Query() query: IncludeInactiveQuery) {
    return this.catalogue.listDocumentTypes(query.includeInactive === true);
  }
  @Permissions('service.manage')
  @Post()
  create(@Body() body: DocumentTypeDto) {
    return this.catalogue.createDocumentType(body);
  }
  @Permissions('service.manage')
  @Patch(':id')
  update(@ID() id: string, @Body() body: UpdateDocumentTypeDto) {
    return this.catalogue.updateDocumentType(id, body);
  }
  @Permissions('service.manage')
  @Delete(':id')
  remove(@ID() id: string) {
    return this.catalogue.deleteDocumentType(id);
  }
}

class ServiceImportDto extends dto(serviceImportSchema) {}

@ApiTags('Services')
@ApiBearerAuth()
@Controller('services')
export class ServicesController {
  constructor(
    private readonly catalogue: CatalogueService,
    private readonly pricing: PricingService,
    private readonly forms: FormsService,
    private readonly storefront: StorefrontService,
    private readonly importer: ServicesImportService,
  ) {}

  // ---- import
  @Permissions('service.manage')
  @Get('import/template')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="services-template.csv"')
  importTemplate() {
    return this.importer.template();
  }
  @Permissions('service.manage')
  @Post('import/preview')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check a CSV / Excel file of services: every row validated. Nothing is saved.' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }))
  importPreview(@UploadedFile() file: Express.Multer.File) {
    return this.importer.preview(file);
  }
  @Permissions('service.manage')
  @Post('import')
  import(@Body() body: ServiceImportDto) {
    return this.importer.import(body);
  }

  // ---- services
  @Permissions('service.read')
  @Get()
  list(@Query() query: ServiceListQueryDto) {
    return this.catalogue.listServices(query);
  }
  @Permissions('service.manage')
  @Post()
  create(@Body() body: ServiceDto) {
    return this.catalogue.createService(body);
  }
  @Permissions('service.manage')
  @Post('starter-catalogue')
  @HttpCode(200)
  @ApiOperation({ summary: 'Install the starter services (idempotent; existing services are never changed)' })
  installStarter() {
    return this.storefront.installStarter();
  }
  @Permissions('service.manage')
  @Put('order')
  @ApiOperation({ summary: 'Reorder services' })
  reorder(@Body() body: OrderDto) {
    return this.catalogue.reorderServices(body.ids);
  }
  @Permissions('service.read')
  @Get(':id')
  get(@ID() id: string) {
    return this.catalogue.getService(id);
  }
  @Permissions('service.read')
  @Get(':id/full')
  @ApiOperation({ summary: 'Service with category, effective price, requirements and published form (request wizard)' })
  full(@ID() id: string, @Query() query: FullQueryDto) {
    return this.storefront.full(id, query);
  }
  @Permissions('service.manage')
  @Patch(':id')
  update(@ID() id: string, @Body() body: UpdateServiceDto) {
    return this.catalogue.updateService(id, body);
  }
  @Permissions('service.manage')
  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a service' })
  remove(@ID() id: string) {
    return this.catalogue.deleteService(id);
  }
  @Permissions('service.manage')
  @Post(':id/restore')
  @HttpCode(200)
  restore(@ID() id: string) {
    return this.catalogue.restoreService(id);
  }

  // ---- prices
  @Permissions('service.read')
  @Get(':id/price')
  @ApiOperation({ summary: 'Effective price: branch price > default price; a corporate contract price replaces the service fee only' })
  price(@ID() id: string, @Query() query: PriceQueryDto) {
    return this.pricing.effectivePrice(id, query);
  }
  @Permissions('service.read')
  @Get(':id/prices')
  @ApiOperation({ summary: 'Price history' })
  prices(@ID() id: string) {
    return this.pricing.listPrices(id);
  }
  @Permissions('service.manage')
  @Post(':id/prices')
  @ApiOperation({ summary: 'Set a new default or branch price (the previous one is closed, never edited)' })
  setPrice(@ID() id: string, @Body() body: PriceDto) {
    return this.pricing.setPrice(id, body);
  }
  @Permissions('service.manage')
  @Delete(':id/prices/:priceId')
  @ApiOperation({ summary: 'End a branch-specific price' })
  removePrice(@ID() id: string, @Param('priceId', ParseUUIDPipe) priceId: string) {
    return this.pricing.removeBranchPrice(id, priceId);
  }

  // ---- requirements
  @Permissions('service.read')
  @Get(':id/requirements')
  requirements(@ID() id: string) {
    return this.catalogue.listRequirements(id);
  }
  @Permissions('service.manage')
  @Post(':id/requirements')
  addRequirement(@ID() id: string, @Body() body: RequirementDto) {
    return this.catalogue.addRequirement(id, body);
  }
  @Permissions('service.manage')
  @Put(':id/requirements/order')
  reorderRequirements(@ID() id: string, @Body() body: OrderDto) {
    return this.catalogue.reorderRequirements(id, body.ids);
  }
  @Permissions('service.manage')
  @Patch(':id/requirements/:requirementId')
  updateRequirement(@ID() id: string, @Param('requirementId', ParseUUIDPipe) requirementId: string, @Body() body: UpdateRequirementDto) {
    return this.catalogue.updateRequirement(id, requirementId, body);
  }
  @Permissions('service.manage')
  @Delete(':id/requirements/:requirementId')
  removeRequirement(@ID() id: string, @Param('requirementId', ParseUUIDPipe) requirementId: string) {
    return this.catalogue.removeRequirement(id, requirementId);
  }

  // ---- dynamic forms
  @Permissions('service.read')
  @Get(':id/forms')
  @ApiOperation({ summary: 'Form versions of a service' })
  formVersions(@ID() id: string) {
    return this.forms.list(id);
  }
  @Permissions('service.manage')
  @Post(':id/forms')
  @ApiOperation({ summary: 'Start a new draft (copied from the published version unless a schema is sent)' })
  createForm(@ID() id: string, @Body() body: CreateFormDto) {
    return this.forms.createDraft(id, body.schema);
  }
  @Permissions('service.read')
  @Get(':id/forms/:formId')
  form(@ID() id: string, @Param('formId', ParseUUIDPipe) formId: string) {
    return this.forms.get(id, formId);
  }
  @Permissions('service.manage')
  @Put(':id/forms/:formId')
  @ApiOperation({ summary: 'Replace the schema of a draft' })
  updateForm(@ID() id: string, @Param('formId', ParseUUIDPipe) formId: string, @Body() body: UpdateFormDto) {
    return this.forms.updateDraft(id, formId, body.schema);
  }
  @Permissions('service.manage')
  @Delete(':id/forms/:formId')
  deleteForm(@ID() id: string, @Param('formId', ParseUUIDPipe) formId: string) {
    return this.forms.deleteDraft(id, formId);
  }
  @Permissions('service.manage')
  @Post(':id/forms/:formId/publish')
  @HttpCode(200)
  @ApiOperation({ summary: 'Publish a draft; the previously published version is archived' })
  publishForm(@ID() id: string, @Param('formId', ParseUUIDPipe) formId: string) {
    return this.forms.publish(id, formId);
  }
  @Permissions('service.manage')
  @Post(':id/forms/:formId/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Withdraw the published form' })
  archiveForm(@ID() id: string, @Param('formId', ParseUUIDPipe) formId: string) {
    return this.forms.archive(id, formId);
  }
}

@ApiTags('Catalogue (portal)')
@ApiBearerAuth()
@Controller('catalogue')
export class PortalCatalogueController {
  constructor(private readonly storefront: StorefrontService) {}

  @TenantMember({ kinds: ['CUSTOMER', 'CORPORATE'] })
  @Get()
  @ApiOperation({ summary: 'Services the signed-in customer / corporate user can request online' })
  list(@Query() query: CustomerCatalogueQueryDto) {
    return this.storefront.customerCatalogue(query);
  }
  @TenantMember({ kinds: ['CUSTOMER', 'CORPORATE'] })
  @Get(':id')
  @ApiOperation({ summary: 'One service with its document checklist and published form' })
  get(@ID() id: string, @Query() query: CustomerServiceQueryDto) {
    return this.storefront.customerService(id, query);
  }
}

@ApiTags('Public')
@Controller('public/services')
export class PublicCatalogueController {
  constructor(private readonly storefront: StorefrontService) {}

  @Public()
  @RateLimit({ name: 'public-catalogue', limit: 120, windowSeconds: 60 })
  @Get()
  @ApiOperation({ summary: 'Public service catalogue of a centre (by slug or portal host). Fees are estimates.' })
  list(@Query() query: PublicCatalogueQueryDto) {
    return this.storefront.publicCatalogue(query);
  }
  @Public()
  @RateLimit({ name: 'public-catalogue', limit: 120, windowSeconds: 60 })
  @Get(':id')
  get(@ID() id: string, @Query() query: PublicServiceQueryDto) {
    return this.storefront.publicService(id, query);
  }
}
