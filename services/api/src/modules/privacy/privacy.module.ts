import { Module } from '@nestjs/common';
import { DataSubjectRequestService } from './dsr.service';
import { ErasureSystemService } from './erasure-system.service';
import { IncidentService } from './incident.service';
import { PrivacyOverviewService } from './overview.service';
import { MyPrivacyController, PlatformPrivacyController, PrivacyController } from './privacy.controller';
import { RetentionPolicyService } from './retention-policy.service';

/**
 * Privacy controls: data subject requests, retention policies, consent
 * overview, incident and processor registers. Uses the vault (global
 * DocumentsModule) to store exports and to delete documents on erasure.
 */
@Module({
  controllers: [MyPrivacyController, PrivacyController, PlatformPrivacyController],
  providers: [DataSubjectRequestService, ErasureSystemService, RetentionPolicyService, IncidentService, PrivacyOverviewService],
})
export class PrivacyModule {}
