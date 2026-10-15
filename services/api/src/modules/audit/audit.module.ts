import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditViewerService } from './audit.service';

/** Read-only viewer and CSV export of a centre's append-only audit trail. */
@Module({ controllers: [AuditController], providers: [AuditViewerService] })
export class AuditModule {}
