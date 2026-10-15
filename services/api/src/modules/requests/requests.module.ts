import { StageLimitsService } from './stage-limits.service';
import { Module } from '@nestjs/common';
import { WorkflowsModule } from '../workflows/workflows.module';
import { AssignmentService } from './assignment.service';
import { ExternalProcessingService } from './external-processing.service';
import { RequestAccess } from './request-access';
import { RequestActionsService } from './request-actions.service';
import { RequestGuards } from './request-guards.service';
import { RequestReader } from './request-reader.service';
import { RequestStateMachine } from './request-state-machine.service';
import { RequestViews } from './request-view.service';
import { PublicTrackingController, RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';
import { TrackingService } from './tracking.service';
import { WorkflowEngine } from './workflow-engine.service';
import { RequestsErasure } from './requests.erasure';

/**
 * Service requests (cases): the state machine, its guards, the workflow
 * execution engine and the case actions. Other modules talk to it through domain events; the renewal
 * autopilot (modules/renewals) is the one exception: it opens renewal requests through RequestsService.
 */
@Module({
  imports: [WorkflowsModule],
  controllers: [RequestsController, PublicTrackingController],
  providers: [StageLimitsService, RequestAccess, RequestReader, RequestGuards, RequestStateMachine, WorkflowEngine, RequestViews, RequestsService, RequestActionsService, AssignmentService, ExternalProcessingService, TrackingService, RequestsErasure],
  // Used by the automation engine (phase 2): status changes only through the state machine, assignment through its own service.
  exports: [RequestStateMachine, AssignmentService, WorkflowEngine, RequestReader, RequestsService, RequestActionsService],
})
export class RequestsModule {}
