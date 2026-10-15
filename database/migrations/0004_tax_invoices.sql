-- Bilingual tax invoices: the TRN of a business customer (individuals and companies with a
-- corporate account already have what the invoice needs). UAE TRNs are 15 digits.
ALTER TABLE "customers" ADD COLUMN "taxRegistrationNo" TEXT;
ALTER TABLE "customers" ADD CONSTRAINT "customers_trn_format"
  CHECK ("taxRegistrationNo" IS NULL OR "taxRegistrationNo" ~ '^[0-9]{15}$');
