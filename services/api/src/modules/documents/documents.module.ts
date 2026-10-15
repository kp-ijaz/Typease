import { Global, Module } from '@nestjs/common';
import { DocumentStorePort } from '../../common/ports';
import { StorageModule } from '../storage/storage.module';
import { DocumentAccess } from './access';
import { ChecklistAssistService } from './checklist-assist.service';
import { VaultDocumentStore } from './document-store';
import { DocumentsController, PublicSharedDocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { MalwareScanService } from './malware';
import { DocumentRetentionService } from './retention.service';
import { DocumentScanService } from './scan.service';
import { DocumentSharesService } from './shares.service';
import { DocumentsErasure } from './documents.erasure';

/**
 * The secure document vault. Global so that other modules can inject
 * DocumentStorePort (and nothing else) to file generated PDFs.
 */
@Global()
@Module({
  imports: [StorageModule],
  controllers: [DocumentsController, PublicSharedDocumentsController],
  providers: [
    DocumentAccess,
    DocumentsService,
    MalwareScanService,
    DocumentScanService,
    DocumentSharesService,
    DocumentRetentionService,
    ChecklistAssistService,
    VaultDocumentStore,
    DocumentsErasure,
    { provide: DocumentStorePort, useExisting: VaultDocumentStore },
  ],
  exports: [DocumentStorePort, DocumentsService, DocumentAccess, DocumentRetentionService, StorageModule],
})
export class DocumentsModule {}
