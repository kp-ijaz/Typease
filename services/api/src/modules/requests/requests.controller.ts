import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  addChecklistItemSchema, assignRequestSchema, completeWorkflowStepSchema, createServiceRequestSchema, decideRequestApprovalSchema, linkChecklistDocumentSchema,
  markRequestDuplicateSchema, publicTrackRequestSchema, recordExternalReferenceSchema, recordExternalResultSchema, requestCommentSchema, requestInformationSchema,
  requestNoteSchema, requestReasonSchema, requestTransitionSchema, saveRequestFieldsSchema, serviceRequestCountsQuery, serviceRequestListQuery,
  updateExternalReferenceSchema, updateServiceRequestSchema, boardTimeLimitsSchema,
} from '@typease/validation';
import { Permissions, Public } from '../../common/auth/access';
import { RateLimit } from '../../common/rate-limit';
import { dto } from '../../common/zod';
import { AssignmentService } from './assignment.service';
import { StageLimitsService } from './stage-limits.service';
import { ExternalProcessingService } from './external-processing.service';
import { RequestActionsService } from './request-actions.service';
import { RequestsService } from './requests.service';
import { TrackingService } from './tracking.service';

class CreateRequestDto extends dto(createServiceRequestSchema) {}
class UpdateRequestDto extends dto(updateServiceRequestSchema) {}
class SaveFieldsDto extends dto(saveRequestFieldsSchema) {}
class ListRequestsDto extends dto(serviceRequestListQuery) {}
class CountRequestsDto extends dto(serviceRequestCountsQuery) {}
class TransitionDto extends dto(requestTransitionSchema) {}
class ReasonDto extends dto(requestReasonSchema) {}
class NoteDto extends dto(requestNoteSchema) {}
class AssignDto extends dto(assignRequestSchema) {}
class RequestInformationDto extends dto(requestInformationSchema) {}
class ChecklistItemDto extends dto(addChecklistItemSchema) {}
class LinkDocumentDto extends dto(linkChecklistDocumentSchema) {}
class DecideApprovalDto extends dto(decideRequestApprovalSchema) {}
class CommentDto extends dto(requestCommentSchema) {}
class DuplicateDto extends dto(markRequestDuplicateSchema) {}
class ExternalReferenceDto extends dto(recordExternalReferenceSchema) {}
class UpdateExternalReferenceDto extends dto(updateExternalReferenceSchema) {}
class ExternalResultDto extends dto(recordExternalResultSchema) {}
class CompleteStepDto extends dto(completeWorkflowStepSchema) {}
class TrackDto extends dto(publicTrackRequestSchema) {}

const Id = () => Param('id', ParseUUIDPipe);

/**
 * Route permissions only say who may call an endpoint at all. Which requests
 * the caller reaches (branch, assignment, own customer record, own company)
 * and which status changes are possible is decided in the services and in the
 * state machine.
 */
class BoardLimitsDto extends dto(boardTimeLimitsSchema) {}

@ApiTags('Requests')
@ApiBearerAuth()
@Controller('requests')
export class RequestsController {
  constructor(
    private readonly requests: RequestsService,
    private readonly actions: RequestActionsService,
    private readonly assignments: AssignmentService,
    private readonly external: ExternalProcessingService,
    private readonly stageLimits: StageLimitsService,
  ) {}

  // ---- creation and reading
  @Permissions('request.create', 'self.requests', 'corp.requests.create')
  @Post()
  @ApiOperation({ summary: 'Create a request (always as a draft)' })
  create(@Body() body: CreateRequestDto) {
    return this.requests.create(body);
  }

  @Permissions('request.read.all', 'request.read.assigned', 'self.requests', 'corp.requests.read')
  @Get()
  @ApiOperation({ summary: 'Requests the caller may see, with filters and dashboard buckets' })
  list(@Query() query: ListRequestsDto) {
    return this.requests.list(query);
  }

  @Permissions('request.read.all', 'request.read.assigned')
  @Get('board/limits')
  @ApiOperation({ summary: 'Time limits per board column (minutes per status)' })
  boardLimits() {
    return this.stageLimits.limits();
  }
  @Permissions('request.assign')
  @Put('board/limits')
  updateBoardLimits(@Body() body: BoardLimitsDto) {
    return this.stageLimits.update(body);
  }

  @Permissions('request.read.all', 'request.read.assigned', 'self.requests', 'corp.requests.read')
  @Get('counts')
  @ApiOperation({ summary: 'Number of requests per dashboard bucket' })
  counts(@Query() query: CountRequestsDto) {
    return this.requests.counts(query);
  }

  @Permissions('request.read.all', 'request.read.assigned', 'self.requests', 'corp.requests.read')
  @Get(':id')
  @ApiOperation({ summary: 'The full case, shaped for the caller' })
  get(@Id() id: string) {
    return this.requests.get(id);
  }

  // ---- drafts
  @Permissions('request.update', 'self.requests', 'corp.requests.create')
  @Patch(':id')
  @ApiOperation({ summary: 'Instructions (anyone who may edit); priority and target date (staff)' })
  update(@Id() id: string, @Body() body: UpdateRequestDto) {
    return this.requests.update(id, body);
  }

  @Permissions('request.update', 'request.process', 'request.create', 'self.requests', 'corp.requests.create')
  @Put(':id/fields')
  @ApiOperation({ summary: 'Save form values (partial while the request is a draft)' })
  saveFields(@Id() id: string, @Body() body: SaveFieldsDto) {
    return this.requests.saveFields(id, body);
  }

  // ---- status changes
  @Permissions('request.create', 'request.update', 'self.requests', 'corp.requests.create')
  @Post(':id/submit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit a draft. The response contains the tracking code once.' })
  submit(@Id() id: string) {
    return this.requests.submit(id);
  }

  @Permissions(
    'request.create', 'request.update', 'request.process', 'request.review', 'request.submit_external', 'request.cancel', 'request.reopen',
    'document.verify', 'quotation.manage', 'self.requests', 'corp.requests.create',
  )
  @Post(':id/transition')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change the status along an edge of the state machine' })
  transition(@Id() id: string, @Body() body: TransitionDto) {
    return this.requests.transition(id, body);
  }

  @Permissions('request.cancel', 'self.requests', 'corp.requests.create')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Id() id: string, @Body() body: ReasonDto) {
    return this.actions.cancel(id, body.reason);
  }

  @Permissions('request.reopen')
  @Post(':id/reopen')
  @HttpCode(200)
  reopen(@Id() id: string, @Body() body: ReasonDto) {
    return this.actions.reopen(id, body.reason);
  }

  @Permissions('request.review', 'request.reopen')
  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Final review passed: complete the request' })
  complete(@Id() id: string) {
    return this.actions.complete(id);
  }

  @Permissions('request.cancel')
  @Post(':id/mark-duplicate')
  @HttpCode(200)
  markDuplicate(@Id() id: string, @Body() body: DuplicateDto) {
    return this.actions.markDuplicate(id, body.duplicateOfId);
  }

  // ---- customer interaction
  @Permissions('document.verify', 'request.process', 'request.update')
  @Post(':id/request-information')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ask the customer for information or documents' })
  requestInformation(@Id() id: string, @Body() body: RequestInformationDto) {
    return this.actions.requestInformation(id, body);
  }

  @Permissions('document.verify', 'request.update', 'request.process', 'self.requests', 'corp.requests.create')
  @Post(':id/resubmit')
  @HttpCode(200)
  @ApiOperation({ summary: 'The customer answered: back to review or preparation' })
  resubmit(@Id() id: string, @Body() body: NoteDto) {
    return this.actions.resubmit(id, body.note);
  }

  @Permissions('request.read.all', 'request.read.assigned', 'self.requests', 'corp.requests.read')
  @Get(':id/comments')
  comments(@Id() id: string) {
    return this.actions.listComments(id);
  }

  @Permissions('request.comment.internal', 'request.update', 'request.process', 'request.review', 'self.requests', 'corp.requests.read')
  @Post(':id/comments')
  addComment(@Id() id: string, @Body() body: CommentDto) {
    return this.actions.addComment(id, body);
  }

  // ---- assignment
  @Permissions('request.assign')
  @Post(':id/assign')
  @HttpCode(200)
  assign(@Id() id: string, @Body() body: AssignDto) {
    return this.assignments.assign(id, body);
  }

  @Permissions('request.assign')
  @Post(':id/auto-assign')
  @HttpCode(200)
  autoAssign(@Id() id: string) {
    return this.assignments.autoAssign(id);
  }

  // ---- checklist
  @Permissions('request.update', 'request.process', 'document.verify')
  @Post(':id/checklist')
  @ApiOperation({ summary: 'Add an ad-hoc checklist line (INPUT) or a completion document line' })
  addChecklistItem(@Id() id: string, @Body() body: ChecklistItemDto) {
    return this.actions.addChecklistItem(id, body);
  }

  @Permissions('document.verify')
  @Post(':id/checklist/:itemId/waive')
  @HttpCode(200)
  waive(@Id() id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() body: ReasonDto) {
    return this.actions.waiveChecklistItem(id, itemId, body.reason);
  }

  @Permissions('request.update', 'request.process', 'request.create', 'document.verify', 'self.requests', 'corp.requests.create')
  @Put(':id/checklist/:itemId/document')
  @ApiOperation({ summary: 'Link an existing document to a checklist line (reuse, or a completed document)' })
  linkDocument(@Id() id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() body: LinkDocumentDto) {
    return this.actions.linkDocument(id, itemId, body.documentId);
  }

  @Permissions('request.update', 'request.process', 'request.create', 'document.verify', 'self.requests', 'corp.requests.create')
  @Delete(':id/checklist/:itemId/document')
  unlinkDocument(@Id() id: string, @Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.actions.unlinkDocument(id, itemId);
  }

  // ---- review
  @Permissions('request.review')
  @Post(':id/approvals/:approvalId/decide')
  @HttpCode(200)
  decide(@Id() id: string, @Param('approvalId', ParseUUIDPipe) approvalId: string, @Body() body: DecideApprovalDto) {
    return this.actions.decideApproval(id, approvalId, body);
  }

  // ---- external processing
  @Permissions('request.read.all', 'request.read.assigned', 'self.requests', 'corp.requests.read')
  @Get(':id/external-references')
  externalReferences(@Id() id: string) {
    return this.external.list(id);
  }

  @Permissions('request.submit_external')
  @Post(':id/external-references')
  @ApiOperation({ summary: 'Record a submission made through a permitted channel' })
  recordSubmission(@Id() id: string, @Body() body: ExternalReferenceDto) {
    return this.external.recordSubmission(id, body);
  }

  @Permissions('request.submit_external', 'request.process')
  @Patch(':id/external-references/:refId')
  @ApiOperation({ summary: 'Update the status reported by the authority or partner (always labelled with its source)' })
  updateReference(@Id() id: string, @Param('refId', ParseUUIDPipe) refId: string, @Body() body: UpdateExternalReferenceDto) {
    return this.external.updateReference(id, refId, body);
  }

  @Permissions('request.process')
  @Post(':id/external-result')
  @HttpCode(200)
  recordResult(@Id() id: string, @Body() body: ExternalResultDto) {
    return this.external.recordResult(id, body);
  }

  // ---- workflow
  @Permissions('request.process')
  @Post(':id/workflow/complete-step')
  @HttpCode(200)
  @ApiOperation({ summary: 'Preparation done: let the workflow decide what comes next' })
  completeStep(@Id() id: string, @Body() body: CompleteStepDto) {
    return this.actions.completeStep(id, body);
  }

  @Permissions('workflow.manage')
  @Post(':id/workflow/migrate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move this one case to the currently published version of its workflow' })
  migrate(@Id() id: string) {
    return this.actions.migrateWorkflow(id);
  }
}

@ApiTags('Public')
@Controller('public')
export class PublicTrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Public()
  // Strict: per IP and request number, so a tracking code cannot be guessed by trying.
  @RateLimit({ name: 'public-track', limit: 10, windowSeconds: 900, bodyKeys: ['requestNo'] })
  @Post('track')
  @HttpCode(200)
  @ApiOperation({ summary: 'Track a request with its number and tracking code' })
  track(@Body() body: TrackDto) {
    return this.tracking.track(body);
  }
}
