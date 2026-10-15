import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TasksErasure } from './tasks.erasure';

/** Staff tasks: manual tasks, role queues, assignment with audit, progress, and the overdue scan. */
@Module({ controllers: [TasksController], providers: [TasksService, TasksErasure], exports: [TasksService] })
export class TasksModule {}
