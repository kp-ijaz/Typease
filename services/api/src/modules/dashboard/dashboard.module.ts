import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/** The centre dashboard. Read-only; shares the financial definitions of the reports module. */
@Module({ imports: [ReportsModule], controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
