import { Module } from '@nestjs/common';
import { FinanceMetrics } from './finance-metrics.service';
import { ReportsController, ScheduledReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ScheduledReportsService } from './scheduled-reports.service';

/**
 * Reporting: the report registry, drill-downs, file exports and scheduled
 * reports. Read-only towards every other module's tables; it writes only
 * `scheduled_reports` (and files generated reports through DocumentStorePort).
 * FinanceMetrics is exported so the dashboard shows exactly the same figures.
 */
@Module({
  // Order matters: "/reports/scheduled" must be registered before "/reports/:key".
  controllers: [ScheduledReportsController, ReportsController],
  providers: [FinanceMetrics, ReportsService, ScheduledReportsService],
  exports: [FinanceMetrics, ReportsService],
})
export class ReportsModule {}
