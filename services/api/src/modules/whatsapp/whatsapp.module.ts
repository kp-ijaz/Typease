import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OcrModule } from '../ocr/ocr.module';
import { RequestsModule } from '../requests/requests.module';
import { WhatsAppIntakeService } from './intake.service';
import { WhatsAppInboxController, WhatsAppWebhookController } from './whatsapp.controller';
import { WhatsAppInboxService } from './inbox.service';

/** WhatsApp team inbox and intake. */
@Module({
  imports: [NotificationsModule, DocumentsModule, RequestsModule, OcrModule],
  controllers: [WhatsAppInboxController, WhatsAppWebhookController],
  providers: [WhatsAppInboxService, WhatsAppIntakeService],
  exports: [WhatsAppInboxService],
})
export class WhatsAppModule {}
