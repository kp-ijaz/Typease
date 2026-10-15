import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { customerImportSchema } from '@typease/validation';
import { MAX_IMPORT_BYTES } from '../../common/tabular';
import { CustomersImportService } from './customers-import.service';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  archiveCustomerSchema, customerContactSchema, customerListQuery, customerNoteSchema, customerSchema, customerTagIdsSchema, customerTagSchema, duplicateCheckSchema,
  inviteCustomerPortalSchema, mergeCustomersSchema, ownConsentsSchema, pageQuery, staffConsentSchema, updateCustomerContactSchema, updateCustomerNoteSchema,
  updateCustomerSchema, updateCustomerTagSchema, updateOwnCustomerSchema,
} from '@typease/validation';
import { Permissions, TenantMember } from '../../common/auth/access';
import { RateLimit } from '../../common/rate-limit';
import { dto } from '../../common/zod';
import { ConsentsService } from './consents.service';
import { CustomersService } from './customers.service';
import { DuplicatesService } from './duplicates.service';
import { MergeService } from './merge.service';
import { CustomerPortalService } from './portal.service';
import { CustomerRecordsService } from './records.service';

class CustomerDto extends dto(customerSchema) {}
class UpdateCustomerDto extends dto(updateCustomerSchema) {}
class CustomerListQueryDto extends dto(customerListQuery) {}
class PageQueryDto extends dto(pageQuery) {}
class DuplicateCheckDto extends dto(duplicateCheckSchema) {}
class MergeDto extends dto(mergeCustomersSchema) {}
class ArchiveDto extends dto(archiveCustomerSchema) {}
class NoteDto extends dto(customerNoteSchema) {}
class UpdateNoteDto extends dto(updateCustomerNoteSchema) {}
class TagDto extends dto(customerTagSchema) {}
class UpdateTagDto extends dto(updateCustomerTagSchema) {}
class TagIdsDto extends dto(customerTagIdsSchema) {}
class ContactDto extends dto(customerContactSchema) {}
class UpdateContactDto extends dto(updateCustomerContactSchema) {}
class StaffConsentDto extends dto(staffConsentSchema) {}
class OwnConsentsDto extends dto(ownConsentsSchema) {}
class InvitePortalDto extends dto(inviteCustomerPortalSchema) {}
class UpdateOwnCustomerDto extends dto(updateOwnCustomerSchema) {}

const ID = () => Param('id', ParseUUIDPipe);
const sub = (name: string) => Param(name, ParseUUIDPipe);

@ApiTags('Customer tags')
@ApiBearerAuth()
@Controller('customer-tags')
export class CustomerTagsController {
  constructor(private readonly records: CustomerRecordsService) {}

  @Permissions('customer.read')
  @Get()
  list() {
    return this.records.listTags();
  }
  @Permissions('customer.update')
  @Post()
  create(@Body() body: TagDto) {
    return this.records.createTag(body);
  }
  @Permissions('customer.update')
  @Patch(':id')
  update(@ID() id: string, @Body() body: UpdateTagDto) {
    return this.records.updateTag(id, body);
  }
  @Permissions('customer.update')
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a tag and remove it from every customer' })
  remove(@ID() id: string) {
    return this.records.deleteTag(id);
  }
}

class CustomerImportDto extends dto(customerImportSchema) {}

@ApiTags('Customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly duplicates: DuplicatesService,
    private readonly merging: MergeService,
    private readonly records: CustomerRecordsService,
    private readonly consents: ConsentsService,
    private readonly portal: CustomerPortalService,
    private readonly importer: CustomersImportService,
  ) {}

  @Permissions('customer.read')
  @Get()
  @ApiOperation({ summary: 'List and search customers (identity numbers masked)' })
  list(@Query() query: CustomerListQueryDto) {
    return this.customers.list(query);
  }
  @Permissions('customer.create')
  @Get('import/template')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="customers-template.csv"')
  importTemplate() {
    return this.importer.template();
  }
  @Permissions('customer.create')
  @Post('import/preview')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check a CSV / Excel file of customers: every row validated, possible duplicates shown. Nothing is saved.' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }))
  importPreview(@UploadedFile() file: Express.Multer.File) {
    return this.importer.preview(file);
  }
  @Permissions('customer.create')
  @Post('import')
  @RateLimit({ name: 'customer-import', limit: 10, windowSeconds: 3600 })
  @ApiOperation({ summary: 'Import the rows of a preview' })
  import(@Body() body: CustomerImportDto) {
    return this.importer.import(body);
  }
  @Permissions('customer.create')
  @Post()
  @ApiOperation({ summary: 'Register a customer. 409 POSSIBLE_DUPLICATE unless confirmNotDuplicate is sent.' })
  create(@Body() body: CustomerDto) {
    return this.customers.create(body);
  }
  @Permissions('customer.create', 'customer.update', 'customer.merge')
  @Post('duplicates/check')
  @HttpCode(200)
  @ApiOperation({ summary: 'Possible duplicates for the given details (reports only, never merges)' })
  checkDuplicates(@Body() body: DuplicateCheckDto) {
    return this.duplicates.check(body);
  }
  @Permissions('customer.merge')
  @Post('merge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Merge the source record into the target record (typed confirmation + reason)' })
  merge(@Body() body: MergeDto) {
    return this.merging.merge(body);
  }

  @Permissions('customer.read')
  @Get(':id')
  @ApiOperation({ summary: 'Customer overview: masked profile, tags, pinned notes, counters, last activity' })
  get(@ID() id: string) {
    return this.customers.get(id);
  }
  @Permissions('customer.update')
  @Patch(':id')
  update(@ID() id: string, @Body() body: UpdateCustomerDto) {
    return this.customers.update(id, body);
  }
  @Permissions('customer.sensitive.read')
  @RateLimit({ name: 'customer-identity', limit: 60, windowSeconds: 60 })
  @Get(':id/identity')
  @ApiOperation({ summary: 'Full identity numbers. Every call is audited.' })
  identity(@ID() id: string) {
    return this.customers.revealIdentity(id);
  }
  @Permissions('customer.archive')
  @Post(':id/archive')
  @HttpCode(200)
  archive(@ID() id: string, @Body() body: ArchiveDto) {
    return this.customers.archive(id, body.reason);
  }
  @Permissions('customer.archive')
  @Post(':id/restore')
  @HttpCode(200)
  restore(@ID() id: string) {
    return this.customers.restore(id);
  }
  @Permissions('customer.read')
  @Get(':id/activity')
  @ApiOperation({ summary: 'Activity history of one customer (audit trail)' })
  activity(@ID() id: string, @Query() query: PageQueryDto) {
    return this.customers.activity(id, query);
  }
  @Permissions('customer.update')
  @Post(':id/portal-invitation')
  @ApiOperation({ summary: 'Invite the customer to the portal (also re-sends a pending invitation)' })
  invite(@ID() id: string, @Body() body: InvitePortalDto) {
    return this.portal.invite(id, body);
  }

  // ---- notes (internal)
  @Permissions('customer.read')
  @Get(':id/notes')
  notes(@ID() id: string, @Query() query: PageQueryDto) {
    return this.records.listNotes(id, query);
  }
  @Permissions('customer.update')
  @Post(':id/notes')
  addNote(@ID() id: string, @Body() body: NoteDto) {
    return this.records.addNote(id, body);
  }
  @Permissions('customer.update')
  @Patch(':id/notes/:noteId')
  updateNote(@ID() id: string, @sub('noteId') noteId: string, @Body() body: UpdateNoteDto) {
    return this.records.updateNote(id, noteId, body);
  }
  @Permissions('customer.update')
  @Delete(':id/notes/:noteId')
  removeNote(@ID() id: string, @sub('noteId') noteId: string) {
    return this.records.removeNote(id, noteId);
  }

  // ---- tags
  @Permissions('customer.update')
  @Put(':id/tags')
  @ApiOperation({ summary: 'Replace the tags of a customer' })
  setTags(@ID() id: string, @Body() body: TagIdsDto) {
    return this.records.setTags(id, body.tagIds);
  }
  @Permissions('customer.update')
  @Post(':id/tags/:tagId')
  @HttpCode(200)
  assignTag(@ID() id: string, @sub('tagId') tagId: string) {
    return this.records.assignTag(id, tagId);
  }
  @Permissions('customer.update')
  @Delete(':id/tags/:tagId')
  unassignTag(@ID() id: string, @sub('tagId') tagId: string) {
    return this.records.unassignTag(id, tagId);
  }

  // ---- contacts
  @Permissions('customer.read')
  @Get(':id/contacts')
  contacts(@ID() id: string) {
    return this.records.listContacts(id);
  }
  @Permissions('customer.update')
  @Post(':id/contacts')
  addContact(@ID() id: string, @Body() body: ContactDto) {
    return this.records.addContact(id, body);
  }
  @Permissions('customer.update')
  @Patch(':id/contacts/:contactId')
  updateContact(@ID() id: string, @sub('contactId') contactId: string, @Body() body: UpdateContactDto) {
    return this.records.updateContact(id, contactId, body);
  }
  @Permissions('customer.update')
  @Delete(':id/contacts/:contactId')
  removeContact(@ID() id: string, @sub('contactId') contactId: string) {
    return this.records.removeContact(id, contactId);
  }

  // ---- consents
  @Permissions('customer.read')
  @Get(':id/consents')
  @ApiOperation({ summary: 'Current consent per purpose and the full history' })
  consentState(@ID() id: string) {
    return this.consents.forCustomer(id);
  }
  @Permissions('customer.update')
  @Put(':id/consents')
  @ApiOperation({ summary: 'Record a consent decision given to staff' })
  recordConsent(@ID() id: string, @Body() body: StaffConsentDto) {
    return this.consents.recordByStaff(id, body);
  }
}

@ApiTags('My profile')
@ApiBearerAuth()
@Controller('me')
export class OwnCustomerController {
  constructor(
    private readonly portal: CustomerPortalService,
    private readonly consents: ConsentsService,
  ) {}

  @TenantMember({ kinds: ['CUSTOMER'], any: ['self.profile'] })
  @Get('customer')
  @ApiOperation({ summary: 'My customer profile' })
  profile() {
    return this.portal.ownProfile();
  }
  @TenantMember({ kinds: ['CUSTOMER'], any: ['self.profile'] })
  @Patch('customer')
  @ApiOperation({ summary: 'Change my name, language, address or communication preferences; fill in or correct my phone, nationality and date of birth while the centre has not confirmed them' })
  updateProfile(@Body() body: UpdateOwnCustomerDto) {
    return this.portal.updateOwnProfile(body);
  }
  @TenantMember({ kinds: ['CUSTOMER'], any: ['self.privacy'] })
  @Get('consents')
  myConsents() {
    return this.consents.own();
  }
  @TenantMember({ kinds: ['CUSTOMER'], any: ['self.privacy'] })
  @Put('consents')
  setMyConsents(@Body() body: OwnConsentsDto) {
    return this.consents.setOwn(body.consents);
  }
}
