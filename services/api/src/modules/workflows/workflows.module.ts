import { Module } from '@nestjs/common';
import { Clock } from './clock';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

/**
 * Workflow definitions, versions and the builder API. The execution engine
 * lives with the request state machine in the requests module, which imports
 * this one for the published step definitions, the rule evaluator and the clock.
 */
@Module({
  controllers: [WorkflowsController],
  providers: [WorkflowsService, Clock],
  exports: [WorkflowsService, Clock],
})
export class WorkflowsModule {}
