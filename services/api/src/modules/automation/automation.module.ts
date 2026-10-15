import { Module } from '@nestjs/common';
import { RemindersModule } from '../reminders/reminders.module';
import { RequestsModule } from '../requests/requests.module';
import { TasksModule } from '../tasks/tasks.module';
import { AutomationActions } from './actions.service';
import { AutomationController } from './automation.controller';
import { AutomationEngine } from './engine.service';
import { EventContextService } from './event-context.service';
import { AutomationRulesService } from './rules.service';

/**
 * Event-driven automation: rules (trigger + conditions + ordered actions), the
 * execution engine with retries and a dead-letter list, the template gallery
 * and the management API. Actions call the services of the modules that own
 * the data; this module writes only its own two tables.
 */
@Module({
  imports: [RequestsModule, TasksModule, RemindersModule],
  controllers: [AutomationController],
  providers: [EventContextService, AutomationActions, AutomationEngine, AutomationRulesService],
})
export class AutomationModule {}
