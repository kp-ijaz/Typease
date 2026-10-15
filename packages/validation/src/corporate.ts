import { z } from 'zod';
import { countryCode, email, isoDate, moneyAmount, optionalText, pageQuery, phone, trimmed, uuid } from './common';

// ----------------------------------------------------------------------------
// Corporate accounts (companies that are customers of the centre)
// ----------------------------------------------------------------------------

export const CORPORATE_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;

const billingAddress = z.object({ line1: optionalText(200), city: optionalText(80), emirate: optionalText(40), country: countryCode.nullish(), poBox: optionalText(20) });
const paymentTermsDays = z.number().int().min(0).max(365);

/**
 * Verification, status and credit approval are deliberately absent: they are
 * decided through their own actions, by people holding `corporate.verify`.
 */
export const corporateAccountSchema = z.object({
  companyName: trimmed(160, 2),
  companyNameAr: optionalText(160),
  tradeLicenceNo: optionalText(60),
  tradeLicenceAuthority: optionalText(120),
  tradeLicenceExpiry: isoDate.nullish(),
  taxRegistrationNo: optionalText(30),
  billingEmail: email.nullish(),
  billingAddress: billingAddress.nullish(),
  /** Proposed terms. They only count once credit has been approved. */
  paymentTermsDays: paymentTermsDays.default(0),
  creditLimit: moneyAmount.nullish(),
  notes: optionalText(2000),
});
export const updateCorporateAccountSchema = corporateAccountSchema.partial();
export const corporateAccountListQuery = pageQuery.extend({ status: z.enum([...CORPORATE_STATUSES, 'ALL']).optional() });

export const verifyCorporateAccountSchema = z.object({
  /** What was checked, e.g. "Trade licence and signatory authorisation letter seen". */
  note: trimmed(500, 5),
});
export const corporateCreditDecisionSchema = z.object({
  approved: z.boolean(),
  creditLimit: moneyAmount.optional(),
  paymentTermsDays: paymentTermsDays.optional(),
  note: trimmed(500, 5),
});
export const corporateStatusReasonSchema = z.object({ reason: trimmed(500, 3) });

// ----------------------------------------------------------------------------
// Members: people authorised to act for the company in the corporate portal
// ----------------------------------------------------------------------------

export const corporateMemberSchema = z.object({
  fullName: trimmed(120, 2),
  email,
  phone: phone.nullish(),
  isAuthorisedSignatory: z.boolean().default(false),
});
export const updateCorporateMemberSchema = z.object({
  fullName: trimmed(120, 2).optional(),
  phone: phone.nullish(),
  isAuthorisedSignatory: z.boolean().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
});

// ----------------------------------------------------------------------------
// Employees: each one is backed by a customer record of the centre
// ----------------------------------------------------------------------------

const employeeFields = {
  fullName: trimmed(160, 2).transform((v) => v.replace(/\s+/g, ' ')),
  fullNameAr: optionalText(160),
  email: email.nullish(),
  phone: phone.nullish(),
  nationality: countryCode.nullish(),
  dateOfBirth: isoDate.nullish(),
  emiratesId: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^784\d{12}$/, 'Emirates ID has 15 digits starting with 784'))
    .nullish(),
  emiratesIdExpiry: isoDate.nullish(),
  passportNo: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{5,12}$/, 'Passport number has 5-12 letters or digits')
    .nullish(),
  passportCountry: countryCode.nullish(),
  passportExpiry: isoDate.nullish(),
  /** The company's own staff number. */
  employeeNo: optionalText(40),
  designation: optionalText(120),
};
export const corporateEmployeeSchema = z.object(employeeFields);
export const CORPORATE_EMPLOYEE_BULK_MAX = 200;
export const bulkCorporateEmployeesSchema = z.object({ employees: z.array(corporateEmployeeSchema).min(1).max(CORPORATE_EMPLOYEE_BULK_MAX) });
export const updateCorporateEmployeeSchema = z
  .object(employeeFields)
  .partial()
  .extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() });
export const corporateEmployeeListQuery = pageQuery.extend({ status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).optional() });

// ----------------------------------------------------------------------------
// Agreements and contract prices
// ----------------------------------------------------------------------------

export const CORPORATE_AGREEMENT_STATUSES = ['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED'] as const;
const agreementFields = {
  title: trimmed(160, 2),
  terms: optionalText(10000),
  startsOn: isoDate,
  endsOn: isoDate.nullish(),
  status: z.enum(CORPORATE_AGREEMENT_STATUSES).default('ACTIVE'),
};
export const corporateAgreementSchema = z.object(agreementFields).refine((v) => !v.endsOn || v.endsOn >= v.startsOn, { path: ['endsOn'], message: 'The end date cannot be before the start date' });
export const updateCorporateAgreementSchema = z.object(agreementFields).partial();

/** Contract price: replaces the catalogue SERVICE FEE of one service for one company. Government and third-party amounts are never part of it. */
export const corporatePriceSchema = z.object({ serviceId: uuid, serviceFee: moneyAmount });

export type CorporateAccountInput = z.infer<typeof corporateAccountSchema>;
export type UpdateCorporateAccountInput = z.infer<typeof updateCorporateAccountSchema>;
export type CorporateAccountListQuery = z.infer<typeof corporateAccountListQuery>;
export type CorporateCreditDecisionInput = z.infer<typeof corporateCreditDecisionSchema>;
export type CorporateMemberInput = z.infer<typeof corporateMemberSchema>;
export type UpdateCorporateMemberInput = z.infer<typeof updateCorporateMemberSchema>;
export type CorporateEmployeeInput = z.infer<typeof corporateEmployeeSchema>;
export type UpdateCorporateEmployeeInput = z.infer<typeof updateCorporateEmployeeSchema>;
export type CorporateEmployeeListQuery = z.infer<typeof corporateEmployeeListQuery>;
export type CorporateAgreementInput = z.infer<typeof corporateAgreementSchema>;
export type UpdateCorporateAgreementInput = z.infer<typeof updateCorporateAgreementSchema>;
export type CorporatePriceInput = z.infer<typeof corporatePriceSchema>;

// ----------------------------------------------------------------------------
// Employee logins: portal access for one employee (role corporate_employee)
// ----------------------------------------------------------------------------

/** Without an address the invitation goes to the email on the employee's record. */
export const corporateEmployeeLoginSchema = z.object({ email: email.nullish() });
export type CorporateEmployeeLoginInput = z.infer<typeof corporateEmployeeLoginSchema>;

// ----------------------------------------------------------------------------
// The company's own roles (corporate portal, company administrator only)
// ----------------------------------------------------------------------------

export const corporateRoleSchema = z.object({
  name: trimmed(80, 2),
  description: optionalText(300),
  permissions: z.array(z.string().max(80)).max(50),
});
export type CorporateRoleInput = z.infer<typeof corporateRoleSchema>;
export const updateCorporateRoleSchema = corporateRoleSchema.partial();
export type UpdateCorporateRoleInput = z.infer<typeof updateCorporateRoleSchema>;
export const corporateUserRoleSchema = z.object({ roleId: uuid });
