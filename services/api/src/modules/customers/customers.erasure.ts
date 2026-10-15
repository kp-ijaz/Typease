import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@typease/database';
import { TenantDb, Tx } from '../../common/db/prisma.service';
import { ERASED_CUSTOMER_NAME } from '../../common/customer-ref';
import { ErasureRegistry, ErasureReport, ErasureSubject } from '../../common/erasure';

export { ERASED_CUSTOMER_NAME };

/**
 * Erasure step of the customers module: the profile of the person, on the record the request is
 * about and on every record that was merged into it (a merged record still holds a copy of the
 * name, the contact details and the identity numbers).
 */
@Injectable()
export class CustomersErasure implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly erasure: ErasureRegistry,
  ) {}

  onModuleInit() {
    this.erasure.register('customers', (tx, subject) => this.erase(tx, subject));
  }

  async erase(tx: Tx, subject: ErasureSubject): Promise<ErasureReport> {
    const tenantId = this.db.tenantId;
    const blank = {
      fullName: ERASED_CUSTOMER_NAME,
      fullNameAr: null,
      taxRegistrationNo: null,
      email: null,
      phone: null,
      nationality: null,
      dateOfBirth: null,
      address: Prisma.DbNull,
      emiratesIdEnc: null,
      emiratesIdHash: null,
      emiratesIdLast4: null,
      emiratesIdExpiry: null,
      passportNoEnc: null,
      passportNoHash: null,
      passportNoLast4: null,
      passportCountry: null,
      passportExpiry: null,
      marketingOptIn: false,
      communicationPrefs: { email: false, sms: false, whatsapp: false, push: false },
    };
    // The record itself becomes ANONYMISED. Records merged into it keep the status MERGED, so finance still
    // finds the invoices and payments that stayed on them, but they lose every personal field as well.
    const anonymised = await tx.customer.updateMany({
      where: { tenantId, id: subject.customerId, status: { not: 'ANONYMISED' } },
      data: { ...blank, status: 'ANONYMISED', deletedAt: new Date(), version: { increment: 1 } },
    });
    const merged = subject.customerIds.filter((id) => id !== subject.customerId);
    const mergedRecords = merged.length ? await tx.customer.updateMany({ where: { tenantId, id: { in: merged } }, data: { ...blank, version: { increment: 1 } } }) : { count: 0 };
    const where = { tenantId, customerId: { in: subject.customerIds } };
    const [contacts, notes, tags] = [await tx.customerContact.deleteMany({ where }), await tx.customerNote.deleteMany({ where }), await tx.customerTagAssignment.deleteMany({ where })];
    return { records: anonymised.count, mergedRecords: mergedRecords.count, contacts: contacts.count, notes: notes.count, tagAssignments: tags.count };
  }
}
