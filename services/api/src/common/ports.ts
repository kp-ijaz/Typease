/**
 * Ports: small interfaces through which one module uses a capability owned by
 * another, without importing it. The owning module registers the provider in a
 * @Global() module; consumers inject it with @Optional() and handle absence
 * with a clear error instead of pretending the capability exists.
 */

export interface GeneratedDocumentInput {
  /** Customer who owns the document (optional for request-only documents). */
  customerId?: string | null;
  corporateAccountId?: string | null;
  requestId?: string | null;
  documentTypeKey: string;
  title: string;
  filename: string;
  mime: string;
  content: Buffer;
  /** Marks the file as a deliverable of the request. */
  isCompletionDocument?: boolean;
  customerVisible?: boolean;
  /**
   * Makes the file a module-owned, staff-only document (for example `scheduled-report`). Such a file is
   * invisible to the general document endpoints - list, get, download, share, edit, delete - whoever holds
   * `document.read`, and it is never customer visible. The owning module authorises every access with its
   * own rule and hands out the bytes through `DocumentStorePort.restrictedDownloadLink()`.
   */
  restrictedTo?: string;
}

export interface RestrictedDownloadLink {
  url: string;
  expiresAt: Date;
  filename: string;
  mime: string;
  sizeBytes: number;
  disposition: 'attachment';
}

/** Implemented by the documents module: stores a system-generated file in the encrypted vault. */
export abstract class DocumentStorePort {
  /** Must be called inside the caller's tenant transaction context. Returns the new document id. */
  abstract storeGenerated(input: GeneratedDocumentInput): Promise<{ documentId: string; versionId: string }>;
  /**
   * Short-lived download link for a restricted file of `owner` (see `GeneratedDocumentInput.restrictedTo`).
   * THE CALLER HAS ALREADY AUTHORISED THE ACTOR; the access is still written to the document access log.
   * 404 when the document is not a restricted file of that owner in the current tenant.
   */
  abstract restrictedDownloadLink(documentId: string, owner: string): Promise<RestrictedDownloadLink>;
  /**
   * Turns platform-generated files that the owning module can prove are its own (and that were stored before
   * `restrictedTo` existed) into restricted files of `owner`. Only unowned, system-generated documents are
   * touched. Returns how many documents changed. Idempotent.
   */
  abstract restrictGenerated(documentIds: string[], owner: string): Promise<number>;
}
