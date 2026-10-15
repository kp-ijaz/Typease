import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { auditExportQuery, auditLogQuery } from '@typease/validation';
import { Permissions } from '../../common/auth/access';
import { dto } from '../../common/zod';
import { AuditViewerService } from './audit.service';

class AuditLogQueryDto extends dto(auditLogQuery) {}
class AuditExportQueryDto extends dto(auditExportQuery) {}

/**
 * The centre's audit trail. `audit.read` is held by the owner and the manager
 * by default; customers and corporate users never hold it.
 */
@ApiTags('Audit logs')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly viewer: AuditViewerService) {}

  @Permissions('audit.read')
  @Get()
  @ApiOperation({ summary: 'Audit trail of this centre, newest first' })
  list(@Query() query: AuditLogQueryDto) {
    return this.viewer.list(query);
  }

  @Permissions('audit.read')
  @Get('export')
  @ApiOperation({ summary: 'CSV export of the filtered audit trail (capped; the export is audited)' })
  @ApiProduces('text/csv')
  async export(@Query() query: AuditExportQueryDto, @Res() res: Response) {
    const file = await this.viewer.exportCsv(query);
    res
      .status(200)
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Export-Rows': String(file.rows),
        'X-Export-Truncated': String(file.truncated),
      })
      .send(file.csv);
  }

  @Permissions('audit.read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.viewer.get(id);
  }
}
