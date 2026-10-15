import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  automationExecutionListQuery, automationFromTemplateSchema, automationRuleListQuery, automationTestSchema, createAutomationRuleSchema, updateAutomationRuleSchema,
} from '@typease/validation';
import { Permissions } from '../../common/auth/access';
import { dto } from '../../common/zod';
import { AutomationRulesService } from './rules.service';

class RuleListDto extends dto(automationRuleListQuery) {}
class CreateRuleDto extends dto(createAutomationRuleSchema) {}
class UpdateRuleDto extends dto(updateAutomationRuleSchema) {}
class FromTemplateDto extends dto(automationFromTemplateSchema) {}
class TestDto extends dto(automationTestSchema) {}
class ExecutionListDto extends dto(automationExecutionListQuery) {}

/**
 * Automation management. Every route needs `automation.manage`; creating a
 * rule, creating one from a template and switching one on also need the plan
 * feature "automation". Routes with a fixed path are declared before `:id`.
 */
@ApiTags('Automations')
@ApiBearerAuth()
@Controller('automations')
export class AutomationController {
  constructor(private readonly rules: AutomationRulesService) {}

  @Permissions('automation.manage')
  @Get()
  @ApiOperation({ summary: 'Automation rules of the centre, with execution counters' })
  list(@Query() query: RuleListDto) {
    return this.rules.list(query);
  }

  @Permissions('automation.manage')
  @Get('meta')
  @ApiOperation({ summary: 'Triggers with their facts and variables, action types, and the statuses an automation may set' })
  meta() {
    return this.rules.meta();
  }

  @Permissions('automation.manage')
  @Get('templates')
  @ApiOperation({ summary: 'Gallery of ready-made automations' })
  templates() {
    return this.rules.templates();
  }

  @Permissions('automation.manage')
  @Post('from-template/:key')
  @ApiOperation({ summary: 'Create a DISABLED rule from a template (plan feature "automation")' })
  fromTemplate(@Param('key') key: string, @Body() body: FromTemplateDto) {
    return this.rules.fromTemplate(key, body);
  }

  @Permissions('automation.manage')
  @Get('summary')
  @ApiOperation({ summary: 'Counters: rules, executions by status, open dead letters' })
  summary() {
    return this.rules.summary();
  }

  @Permissions('automation.manage')
  @Get('executions')
  @ApiOperation({ summary: 'Execution log, filtered by rule, status, event and date' })
  executions(@Query() query: ExecutionListDto) {
    return this.rules.executions(query);
  }

  @Permissions('automation.manage')
  @Get('executions/:id')
  @ApiOperation({ summary: 'One execution with the result of every action' })
  execution(@Param('id', ParseUUIDPipe) id: string) {
    return this.rules.execution(id);
  }

  @Permissions('automation.manage')
  @Post('executions/:id/retry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Queue a dead-lettered execution again (finished actions are not repeated)' })
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.rules.retry(id);
  }

  @Permissions('automation.manage')
  @Post()
  @ApiOperation({ summary: 'Create a rule (plan feature "automation"); everything it refers to must belong to the centre' })
  create(@Body() body: CreateRuleDto) {
    return this.rules.create(body);
  }

  @Permissions('automation.manage')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.rules.get(id);
  }

  @Permissions('automation.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateRuleDto) {
    return this.rules.update(id, body);
  }

  @Permissions('automation.manage')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.rules.remove(id);
  }

  @Permissions('automation.manage')
  @Post(':id/enable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Switch a rule on (plan feature "automation"; the rule is validated again)' })
  enable(@Param('id', ParseUUIDPipe) id: string) {
    return this.rules.enable(id);
  }

  @Permissions('automation.manage')
  @Post(':id/disable')
  @HttpCode(200)
  disable(@Param('id', ParseUUIDPipe) id: string) {
    return this.rules.disable(id);
  }

  @Permissions('automation.manage')
  @Post(':id/test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Dry run against a recent event: conditions and the actions that WOULD run. Nothing is executed.' })
  test(@Param('id', ParseUUIDPipe) id: string, @Body() body: TestDto) {
    return this.rules.test(id, body);
  }
}
