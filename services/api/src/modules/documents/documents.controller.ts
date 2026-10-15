import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  documentAccessLogQuery, documentChecklistAssistQuery, documentDownloadLinkSchema, documentLegalHoldSchema, documentListQuery, documentMultipartFieldsSchema,
  documentShareSchema, documentUpdateSchema, documentUploadIntentSchema, documentVerifySchema,
} from '@typease/validation';
import { env } from '../../config/env';
import { Permissions, Public } from '../../common/auth/access';
import { SupportSessionRead } from '../../common/auth/support-session';
import { RateLimit } from '../../common/rate-limit';
import { dto } from '../../common/zod';
import { ChecklistAssistService } from './checklist-assist.service';
import { DocumentsService } from './documents.service';
import { DocumentScanService } from './scan.service';
import { DocumentSharesService } from './shares.service';

class UploadIntentDto extends dto(documentUploadIntentSchema) {}
class ListQueryDto extends dto(documentListQuery) {}
class UpdateDto extends dto(documentUpdateSchema) {}
class DownloadLinkDto extends dto(documentDownloadLinkSchema) {}
class VerifyDto extends dto(documentVerifySchema) {}
class ShareDto extends dto(documentShareSchema) {}
class LegalHoldDto extends dto(documentLegalHoldSchema) {}
class ChecklistQueryDto extends dto(documentChecklistAssistQuery) {}
class AccessLogQueryDto extends dto(documentAccessLogQuery) {}

/** Who may add documents: staff, customers (own record), corporate administrators (own company). */
const CanUpload = () => Permissions('document.upload', 'self.documents', 'corp.employees.manage', 'corp.requests.create');
/** Who may see documents. Which ones is decided per document by DocumentAccess. */
const CanRead = () => Permissions('document.read', 'self.documents', 'corp.employees.read', 'corp.requests.read', 'corp.account.read');

@ApiTags('Documents')
@ApiBearerAuth()
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly shares: DocumentSharesService,
    private readonly scans: DocumentScanService,
    private readonly checklist: ChecklistAssistService,
  ) {}

  // ---- upload
  @CanUpload()
  @Post('upload-intents')
  @ApiOperation({ summary: 'Step 1: declare a file and receive a one-time upload URL' })
  createIntent(@Body() body: UploadIntentDto) {
    return this.documents.createIntent(body);
  }

  @CanUpload()
  @Post('upload')
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Single-request upload for simple clients (multipart, field "file")' })
  // The limit is enforced while the request is read: an oversized file is refused with 413.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: env().UPLOAD_MAX_BYTES, files: 1, fields: 20 } }))
  upload(@UploadedFile() file: Express.Multer.File, @Body() body: Record<string, unknown>) {
    return this.documents.uploadMultipart(documentMultipartFieldsSchema.parse(body), file);
  }

  @CanUpload()
  @Post(':id/versions/:versionId/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Step 3: confirm the upload; the file is checked and queued for the malware scan' })
  complete(@Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string) {
    return this.documents.completeUpload(id, versionId);
  }

  // ---- read
  @CanRead()
  @Get()
  list(@Query() query: ListQueryDto) {
    return this.documents.list(query);
  }

  @CanRead()
  @Get('checklist-assist')
  @ApiOperation({ summary: 'Per checklist line of a request: missing / present / expiring / expired / unverified (read-only)' })
  checklistAssist(@Query() query: ChecklistQueryDto) {
    return this.checklist.forRequest(query.requestId);
  }

  @CanRead()
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.get(id);
  }

  @CanRead()
  @SupportSessionRead('Returns a short-lived link; reading the file needs the document.read scope and is recorded in the document access log.')
  @Post(':id/download-link')
  @HttpCode(200)
  @ApiOperation({ summary: 'Short-lived download URL (never a permanent or public link)' })
  downloadLink(@Param('id', ParseUUIDPipe) id: string, @Body() body: DownloadLinkDto) {
    return this.documents.downloadLink(id, body);
  }

  @CanRead()
  @SupportSessionRead('Returns a short-lived link; reading the file needs the document.read scope and is recorded in the document access log.')
  @Post(':id/preview-link')
  @HttpCode(200)
  @ApiOperation({ summary: 'Short-lived URL for in-browser preview (PDF and images; other types download)' })
  previewLink(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.downloadLink(id, { disposition: 'inline' });
  }

  @Permissions('audit.read', 'privacy.manage')
  @Get(':id/access-logs')
  @ApiOperation({ summary: 'Who viewed, downloaded, shared or changed this document' })
  accessLogs(@Param('id', ParseUUIDPipe) id: string, @Query() query: AccessLogQueryDto) {
    return this.documents.accessLogs(id, query);
  }

  // ---- staff actions
  @Permissions('document.upload', 'document.verify')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateDto) {
    return this.documents.update(id, body);
  }

  @Permissions('document.verify')
  @Post(':id/verify')
  @HttpCode(200)
  verify(@Param('id', ParseUUIDPipe) id: string, @Body() body: VerifyDto) {
    return this.documents.verify(id, body);
  }

  @Permissions('document.verify')
  @Post(':id/rescan')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retry the malware scan after a scanner outage' })
  rescan(@Param('id', ParseUUIDPipe) id: string) {
    return this.scans.rescan(id);
  }

  @Permissions('document.delete')
  @Delete(':id')
  @ApiOperation({ summary: 'Soft delete. Files are removed after the grace period by the purge job' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.remove(id);
  }

  @Permissions('document.delete')
  @Post(':id/restore')
  @HttpCode(200)
  restore(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.restore(id);
  }

  @Permissions('privacy.manage')
  @Put(':id/legal-hold')
  legalHold(@Param('id', ParseUUIDPipe) id: string, @Body() body: LegalHoldDto) {
    return this.documents.setLegalHold(id, body);
  }

  // ---- secure sharing
  @Permissions('document.share')
  @Get(':id/shares')
  listShares(@Param('id', ParseUUIDPipe) id: string) {
    return this.shares.list(id);
  }

  @Permissions('document.share')
  @Post(':id/shares')
  @ApiOperation({ summary: 'Create a time-limited, download-capped share link (token shown once)' })
  createShare(@Param('id', ParseUUIDPipe) id: string, @Body() body: ShareDto) {
    return this.shares.create(id, body);
  }

  @Permissions('document.share')
  @Delete(':id/shares/:shareId')
  revokeShare(@Param('id', ParseUUIDPipe) id: string, @Param('shareId', ParseUUIDPipe) shareId: string) {
    return this.shares.revoke(id, shareId);
  }
}

@ApiTags('Documents')
@Controller('public/shared-documents')
export class PublicSharedDocumentsController {
  constructor(private readonly shares: DocumentSharesService) {}

  @Public()
  @RateLimit({ name: 'shared-document', limit: 30, windowSeconds: 60 })
  @Get(':token')
  @ApiOperation({ summary: 'Exchange a share token for a fresh short-lived download link (counts as one download)' })
  redeem(@Param('token') token: string) {
    return this.shares.redeem(token);
  }
}
