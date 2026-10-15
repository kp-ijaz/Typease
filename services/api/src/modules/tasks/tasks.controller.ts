import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { assignTaskSchema, createTaskSchema, taskListQuery, taskStatusSchema, updateTaskSchema } from '@typease/validation';
import { Permissions, TenantMember } from '../../common/auth/access';
import { dto } from '../../common/zod';
import { TasksService } from './tasks.service';

class ListDto extends dto(taskListQuery) {}
class CreateDto extends dto(createTaskSchema) {}
class UpdateDto extends dto(updateTaskSchema) {}
class AssignDto extends dto(assignTaskSchema) {}
class StatusDto extends dto(taskStatusSchema) {}

@ApiTags('Tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Permissions('task.read', 'task.manage')
  @Get()
  @ApiOperation({ summary: 'Tasks (filters: status, open, overdue, assigneeId, unassigned, requestId, customerId, type, roleKey, priority, branchId, source)' })
  list(@Query() query: ListDto) {
    return this.tasks.list(query);
  }
  /** Every staff member has their own task list, whatever their permissions. */
  @TenantMember({ kinds: ['STAFF'] })
  @Get('mine')
  @ApiOperation({ summary: 'Tasks assigned to me and unassigned tasks in the queue of my role' })
  mine(@Query() query: ListDto) {
    return this.tasks.mine(query);
  }
  @Permissions('task.manage')
  @Post()
  create(@Body() body: CreateDto) {
    return this.tasks.create(body);
  }
  @TenantMember({ kinds: ['STAFF'] })
  @Get(':id')
  @ApiOperation({ summary: 'A task I may see (permission, assignment or my role queue); 404 otherwise' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.get(id);
  }
  @Permissions('task.manage')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateDto) {
    return this.tasks.update(id, body);
  }
  @Permissions('task.manage')
  @Put(':id/assignees')
  @ApiOperation({ summary: 'Assign, reassign or unassign (replaces the list of assignees; audited)' })
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() body: AssignDto) {
    return this.tasks.assign(id, body);
  }
  @TenantMember({ kinds: ['STAFF'] })
  @Post(':id/claim')
  @HttpCode(200)
  @ApiOperation({ summary: 'Take an unassigned task from the queue of my role' })
  claim(@Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.claim(id);
  }
  @TenantMember({ kinds: ['STAFF'] })
  @Post(':id/status')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start, complete, cancel or reopen (assignees may start and complete their own tasks)' })
  status(@Param('id', ParseUUIDPipe) id: string, @Body() body: StatusDto) {
    return this.tasks.setStatus(id, body);
  }
}
