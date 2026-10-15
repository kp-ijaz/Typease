import { Injectable } from '@nestjs/common';
import { DocumentStorePort, GeneratedDocumentInput, RestrictedDownloadLink } from '../../common/ports';
import { DocumentsService } from './documents.service';

/** DocumentStorePort implementation: other modules store generated files in the vault through it. */
@Injectable()
export class VaultDocumentStore extends DocumentStorePort {
  constructor(private readonly documents: DocumentsService) {
    super();
  }
  storeGenerated(input: GeneratedDocumentInput): Promise<{ documentId: string; versionId: string }> {
    return this.documents.storeGenerated(input);
  }
  restrictedDownloadLink(documentId: string, owner: string): Promise<RestrictedDownloadLink> {
    return this.documents.restrictedDownloadLink(documentId, owner);
  }
  restrictGenerated(documentIds: string[], owner: string): Promise<number> {
    return this.documents.restrictGenerated(documentIds, owner);
  }
}
