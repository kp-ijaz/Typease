import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { dashboardQuery, dashboardTrendsQuery } from '@typease/validation';
import { TenantMember } from '../../common/auth/access';
import { dto } from '../../common/zod';
import { DashboardService } from './dashboard.service';

class DashboardDto extends dto(dashboardQuery) {}
class TrendsDto extends dto(dashboardTrendsQuery) {}

/**
 * Every staff member has a dashboard. What it shows follows their permissions:
 * a widget they may not see is `null` (see docs/api/modules/dashboard.md).
 */
@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @TenantMember({ kinds: ['STAFF'] })
  @Get()
  @ApiOperation({ summary: 'All dashboard widgets in one response, scoped to the viewer (branches, own cases, permissions)' })
  overview(@Query() query: DashboardDto) {
    return this.dashboard.overview(query);
  }
  @TenantMember({ kinds: ['STAFF'] })
  @Get('trends')
  @ApiOperation({ summary: 'Requests created / completed and service revenue per day (default: the last 30 days)' })
  trends(@Query() query: TrendsDto) {
    return this.dashboard.trends(query);
  }
}
