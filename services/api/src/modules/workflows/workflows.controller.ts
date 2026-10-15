import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createWorkflowSchema, replaceWorkflowStepsSchema, updateWorkflowSchema, validateWorkflowStepsSchema, workflowListQuery, workflowVersionNotesSchema,
} from '@typease/validation';
import { Permissions } from '../../common/auth/access';
import { dto } from '../../common/zod';
import { WorkflowsService } from './workflows.service';

class CreateWorkflowDto extends dto(createWorkflowSchema) {}
class UpdateWorkflowDto extends dto(updateWorkflowSchema) {}
class ReplaceStepsDto extends dto(replaceWorkflowStepsSchema) {}
class ValidateStepsDto extends dto(validateWorkflowStepsSchema) {}
class VersionNotesDto extends dto(workflowVersionNotesSchema) {}
class WorkflowListDto extends dto(workflowListQuery) {}

@ApiTags('Workflows')
@ApiBearerAuth()
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Permissions('workflow.manage', 'service.manage')
  @Get()
  @ApiOperation({ summary: 'Workflow definitions with their published and draft versions' })
  list(@Query() query: WorkflowListDto) {
    return this.workflows.list(query);
  }

  @Permissions('workflow.manage')
  @Get('templates')
  @ApiOperation({ summary: 'Code-defined templates a new workflow can start from' })
  templates() {
    return this.workflows.templates();
  }

  @Permissions('workflow.manage')
  @Get('builder-meta')
  @ApiOperation({ summary: 'Step types, rule facts, operators and roles for the builder' })
  builderMeta() {
    return this.workflows.builderMeta();
  }

  @Permissions('workflow.manage')
  @Post('validate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check a list of steps without saving it' })
  validate(@Body() body: ValidateStepsDto) {
    return this.workflows.validate(body.steps);
  }

  @Permissions('workflow.manage')
  @Post()
  @ApiOperation({ summary: 'Create a workflow from a template or from scratch' })
  create(@Body() body: CreateWorkflowDto) {
    return this.workflows.create(body);
  }

  @Permissions('workflow.manage', 'service.manage')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.get(id);
  }

  @Permissions('workflow.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateWorkflowDto) {
    return this.workflows.update(id, body);
  }

  @Permissions('workflow.manage')
  @Post(':id/archive')
  @HttpCode(200)
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.archive(id);
  }

  @Permissions('workflow.manage')
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a workflow that has no published version and was never used by a service or a request' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.remove(id);
  }

  @Permissions('workflow.manage')
  @Post(':id/set-default')
  @HttpCode(200)
  @ApiOperation({ summary: 'Use this workflow for services that have none of their own' })
  setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.setDefault(id);
  }

  @Permissions('workflow.manage')
  @Get(':id/versions')
  versions(@Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.listVersions(id);
  }

  @Permissions('workflow.manage')
  @Post(':id/versions')
  @ApiOperation({ summary: 'Start a draft (copy of the published version)' })
  createDraft(@Param('id', ParseUUIDPipe) id: string, @Body() body: VersionNotesDto) {
    return this.workflows.createDraft(id, body.notes);
  }

  @Permissions('workflow.manage')
  @Get(':id/versions/:versionId')
  version(@Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string) {
    return this.workflows.getVersion(id, versionId);
  }

  @Permissions('workflow.manage')
  @Put(':id/versions/:versionId/steps')
  @ApiOperation({ summary: 'Replace the steps of a draft' })
  replaceSteps(@Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string, @Body() body: ReplaceStepsDto) {
    return this.workflows.replaceSteps(id, versionId, body);
  }

  @Permissions('workflow.manage')
  @Delete(':id/versions/:versionId')
  @ApiOperation({ summary: 'Discard a draft' })
  discard(@Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string) {
    return this.workflows.discardDraft(id, versionId);
  }

  @Permissions('workflow.manage')
  @Post(':id/versions/:versionId/publish')
  @HttpCode(200)
  publish(@Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string) {
    return this.workflows.publish(id, versionId);
  }

  @Permissions('workflow.manage')
  @Post(':id/versions/:versionId/rollback')
  @HttpCode(200)
  @ApiOperation({ summary: 'Publish a new version that is a copy of an older one' })
  rollback(@Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string) {
    return this.workflows.rollback(id, versionId);
  }
}
