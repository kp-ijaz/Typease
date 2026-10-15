# Catalogue module

Service categories, document types, services, prices, document requirements, dynamic forms, the portal
catalogue and the public catalogue.

Source: `services/api/src/modules/catalogue/` · schemas: `packages/validation/src/catalogue.ts`
Tables written: `service_categories`, `document_types`, `services`, `service_branches`, `service_prices`,
`service_requirements`, `service_form_definitions`.
Tables read: `branches`, `roles`, `workflow_definitions`, `integration_credentials_metadata`, `corporate_accounts`,
`corporate_prices`, `service_requests`, `documents`, `tenants`, `branding_settings`.

All paths are below `/api/v1`. Money is a decimal string. Errors use the common shape
`{ statusCode, code, message, details?, requestId }`.

## Endpoints (38)

### Categories

| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/service-categories` | `service.read` | `?includeInactive=true` | Array of categories ordered by `sortOrder`, each with `serviceCount` (not-deleted services) |
| POST | `/service-categories` | `service.manage` | `{ name, nameAr?, description?, icon?, key?, sortOrder?, isActive? }` | The category (201). `key` is derived from the name when omitted (`notary-help-desk`, then `-2` ...) |
| PUT | `/service-categories/order` | `service.manage` | `{ ids: uuid[] }` | All categories in the new order. Ids not listed keep their relative order after the listed ones |
| PATCH | `/service-categories/:id` | `service.manage` | Any of `name, nameAr, description, icon, sortOrder, isActive` | The category |
| DELETE | `/service-categories/:id` | `service.manage` | - | `{ status: "DELETED" }`; `409 CATEGORY_IN_USE` while any service (also a deleted one) belongs to it |

### Document types

| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/document-types` | any member of the centre (staff, customer, corporate) | `?includeInactive=true` | Platform defaults merged with the centre's own types |
| POST | `/document-types` | `service.manage` | `{ key, name, nameAr?, hasExpiry?, ocrProfile?, reminderEnabled?, isActive? }` | The type (201) |
| PATCH | `/document-types/:id` | `service.manage` | Any field except `key` | The type; `409 PLATFORM_DEFAULT` for a platform default |
| DELETE | `/document-types/:id` | `service.manage` | - | `{ status: "DELETED", revertedToPlatformDefault }`; `409 DOCUMENT_TYPE_IN_USE` |

List item:

```json
{ "id": "…", "key": "passport", "name": "Passport", "nameAr": "جواز السفر", "hasExpiry": true, "ocrProfile": "PASSPORT",
  "reminderEnabled": true, "isActive": true, "source": "PLATFORM", "overridesPlatformDefault": false }
```

`ocrProfile` is one of `NONE | PASSPORT | EMIRATES_ID | TRADE_LICENCE`.

### Services

| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/services` | `service.read` | `page, pageSize, sort, q, categoryId, branchId, isActive, isPublic, onlineAvailable, complianceCapability, deleted` | Page of services |
| POST | `/services` | `service.manage` | Service body (below) incl. `price` | The service (201) |
| POST | `/services/starter-catalogue` | `service.manage` | - | `{ created: string[], skipped: string[], createdCount, skippedCount }` |
| PUT | `/services/order` | `service.manage` | `{ ids: uuid[] }` | `{ status: "REORDERED", count }` (`sortOrder` = position) |
| GET | `/services/:id` | `service.read` | - | Service + `activePrices`, `requirements`, `workflowDefinition`, `form: { published, draft }` (also for a deleted service) |
| GET | `/services/:id/full` | `service.read` | `?branchId=&corporateAccountId=` | Service + `category`, effective `price` (or `null`), `requirements`, published `form` (or `null`) |
| PATCH | `/services/:id` | `service.manage` | Any service field + optional `version` | The service |
| DELETE | `/services/:id` | `service.manage` | - | `{ status: "DELETED" }` (soft delete) |
| POST | `/services/:id/restore` | `service.manage` | - | The service (still inactive) |

`sort` accepts `sortOrder | name | code | createdAt | updatedAt` (default `sortOrder:asc`). `q` searches name,
Arabic name and code.

Create body:

```json
{
  "categoryId": "…", "code": "TEN-001", "name": "Tenancy contract typing", "nameAr": "طباعة عقد الإيجار",
  "description": "…", "descriptionAr": "…", "eligibilityGuidance": "…",
  "complianceCapability": "DOCUMENT_PREPARATION_ONLY",
  "estimatedProcessingHours": 4, "requiresApproval": false,
  "paymentPolicy": "DEPOSIT", "depositPercent": 40, "taxMode": "SERVICE_FEE_ONLY",
  "onlineAvailable": true, "isPublic": true, "isActive": true,
  "allBranches": false, "branchIds": ["…"],
  "staffGroupRoleKey": "operator", "workflowDefinitionId": "…", "sortOrder": 0,
  "price": { "serviceFee": "120.50", "governmentFeeEstimate": "30.00", "thirdPartyFeeEstimate": "10.00" }
}
```

Only `categoryId`, `code`, `name` and `price.serviceFee` are required. Response (list items have the same shape):

```json
{
  "id": "…", "tenantId": "…", "categoryId": "…", "code": "TEN-001", "name": "Tenancy contract typing", "nameAr": "…",
  "complianceCapability": "DOCUMENT_PREPARATION_ONLY", "estimatedProcessingHours": 4, "requiresApproval": false,
  "paymentPolicy": "DEPOSIT", "depositPercent": "40", "taxMode": "SERVICE_FEE_ONLY", "onlineAvailable": true,
  "isPublic": true, "isActive": true, "allBranches": false, "staffGroupRoleKey": "operator",
  "workflowDefinitionId": "…", "sortOrder": 0, "version": 1, "deletedAt": null, "createdAt": "…", "updatedAt": "…",
  "category": { "id": "…", "key": "typing", "name": "Typing & Documentation", "nameAr": "…", "icon": "file-text", "isActive": true },
  "branchIds": ["…"],
  "price": { "id": "…", "serviceId": "…", "branchId": null, "serviceFee": "120.5", "governmentFeeEstimate": "30",
             "thirdPartyFeeEstimate": "10", "currency": "AED", "validFrom": "…", "validTo": null, "isActive": true }
}
```

`price` is the active default price, or `null` for a service that was created outside this API and has none yet.

### Prices

| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/services/:id/price` | `service.read` | `?branchId=&corporateAccountId=` | Effective price (below); `422 PRICE_NOT_SET` |
| GET | `/services/:id/prices` | `service.read` | - | Full history, newest first, each with `branch` |
| POST | `/services/:id/prices` | `service.manage` | `{ serviceFee, governmentFeeEstimate?, thirdPartyFeeEstimate?, branchId? }` | The new price row (201) |
| DELETE | `/services/:id/prices/:priceId` | `service.manage` | - | `{ status: "ENDED" }` - branch prices only |

Effective price:

```json
{
  "serviceId": "…", "priceId": "…", "source": "BRANCH", "branchId": "…", "corporateAccountId": "…", "currency": "AED",
  "validFrom": "…",
  "serviceFee": "70.00", "serviceFeeSource": "CORPORATE_CONTRACT", "listServiceFee": "100.00",
  "governmentFeeEstimate": "350.00", "thirdPartyFeeEstimate": "50.00",
  "taxMode": "SERVICE_FEE_ONLY", "taxRatePercent": "5.00",
  "components": [
    { "component": "SERVICE_FEE", "amount": "70.00", "isEstimate": false, "taxable": true, "taxAmount": "3.50", "total": "73.50" },
    { "component": "GOVERNMENT_FEE", "amount": "350.00", "isEstimate": true, "taxable": false, "taxAmount": "0.00", "total": "350.00" },
    { "component": "THIRD_PARTY_FEE", "amount": "50.00", "isEstimate": true, "taxable": false, "taxAmount": "0.00", "total": "50.00" }
  ],
  "subtotal": "470.00", "taxableAmount": "70.00", "taxAmount": "3.50", "total": "473.50",
  "paymentPolicy": "BEFORE_PROCESSING", "depositPercent": null, "dueBeforeProcessing": "473.50",
  "containsEstimates": true
}
```

### Requirements (document checklist)

| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/services/:id/requirements` | `service.read` | - | Array ordered by `sortOrder` |
| POST | `/services/:id/requirements` | `service.manage` | `{ documentTypeKey, label, labelAr?, description?, isMandatory?, allowReuse?, maxAgeDays? }` | The item (201), appended at the end |
| PUT | `/services/:id/requirements/order` | `service.manage` | `{ ids: uuid[] }` | All items in the new order |
| PATCH | `/services/:id/requirements/:requirementId` | `service.manage` | Any field | The item |
| DELETE | `/services/:id/requirements/:requirementId` | `service.manage` | - | `{ status: "DELETED" }` |

### Dynamic forms

| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/services/:id/forms` | `service.read` | - | Versions, newest first: `{ id, version, status, publishedAt, steps, fields, … }` (no schema) |
| POST | `/services/:id/forms` | `service.manage` | `{ schema? }` | New DRAFT (201); `409 DRAFT_EXISTS` |
| GET | `/services/:id/forms/:formId` | `service.read` | - | One version with its `schema` |
| PUT | `/services/:id/forms/:formId` | `service.manage` | `{ schema }` | The draft; `409 FORM_VERSION_IMMUTABLE` |
| DELETE | `/services/:id/forms/:formId` | `service.manage` | - | `{ status: "DELETED" }` - drafts only |
| POST | `/services/:id/forms/:formId/publish` | `service.manage` | - | The published version; `422 FORM_EMPTY` / `FORM_INVALID` |
| POST | `/services/:id/forms/:formId/archive` | `service.manage` | - | The archived version (the service then has no form) |

### Portal catalogue (signed-in customers and corporate users)

| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/catalogue` | member of kind `CUSTOMER` or `CORPORATE` | `?branchId=&categoryKey=&q=` | `{ categories: [{ key, name, nameAr, icon, serviceCount }], services: [...] }` |
| GET | `/catalogue/:id` | member of kind `CUSTOMER` or `CORPORATE` | `?branchId=` | One service + `requirements` + published `form` |

```json
{ "id": "…", "name": "Open service", "nameAr": "…", "description": "…", "descriptionAr": null, "eligibilityGuidance": null,
  "category": { "key": "typing", "name": "Typing & Documentation", "nameAr": "…", "icon": "file-text" },
  "complianceCapability": "DOCUMENT_PREPARATION_ONLY", "estimatedProcessingHours": 4, "paymentPolicy": "BEFORE_PROCESSING",
  "onlineAvailable": true, "allBranches": true, "branchIds": [],
  "price": { "…effective price as above…" },
  "requirements": [{ "id": "…", "documentTypeKey": "passport", "label": "Passport copy", "labelAr": null, "description": null,
                     "isMandatory": true, "allowReuse": true, "maxAgeDays": null }],
  "form": { "id": "…", "version": 1, "schema": { "steps": [] } } }
```

Never returned to portal users: `code`, `staffGroupRoleKey`, `workflowDefinitionId`, `requiresApproval`, `isPublic`,
`sortOrder`, `version`, `tenantId`.

### Public catalogue (no authentication, rate-limited: 120 requests / minute / IP)

| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/public/services` | public | `?slug=&categoryKey=&q=` | `{ centre: { slug, name, currency }, categories, services }` |
| GET | `/public/services/:id` | public | `?slug=` | `{ centre, service }` |

```json
{ "id": "…", "name": "Visa application typing (document preparation)", "nameAr": "…", "description": "…", "descriptionAr": null,
  "eligibilityGuidance": "…", "category": { "key": "visa", "name": "Visa Assistance", "nameAr": "…", "icon": "plane" },
  "complianceCapability": "DOCUMENT_PREPARATION_ONLY", "estimatedProcessingHours": 24, "onlineAvailable": true,
  "requiredDocuments": [{ "label": "Passport copy", "labelAr": null, "description": "Valid 6 months", "isMandatory": true }],
  "feeEstimate": { "currency": "AED", "serviceFee": "120.00", "governmentFeeEstimate": "350.00", "thirdPartyFeeEstimate": "30.00",
                   "taxEstimate": "6.00", "totalEstimate": "506.00", "isEstimate": true } }
```

## Business rules

### Categories and document types
- The 12 default categories are created when a centre is provisioned. Categories are a way to group the centre's
  own business services; they are not a statement that the centre is authorised by any authority.
- An inactive category cannot receive new services, and its services disappear from the portal and public
  catalogues (staff still see them).
- Document types: the list is the platform defaults (`source: "PLATFORM"`) merged with the centre's own
  (`source: "TENANT"`). A centre type with the same `key` as a default replaces it for that centre
  (`overridesPlatformDefault: true`); deleting it brings the default back. An inactive centre type hides the key
  for that centre. Platform defaults can never be edited through this API.
- `reminderEnabled` requires `hasExpiry` (`422 REMINDER_NEEDS_EXPIRY`).
- A centre's own type that is referenced by requirements or documents, and has no platform default to fall back to,
  cannot be deleted (`409 DOCUMENT_TYPE_IN_USE`); deactivate it instead.

### Services
- `code` is unique per centre, stored upper-case, and stays reserved by a deleted service
  (`409 DUPLICATE_CODE`, `details: { serviceId, deleted }`): restore that service or choose another code.
- `paymentPolicy: "DEPOSIT"` requires `depositPercent` (>0 to 100). For the other policies `depositPercent` is
  always stored as `null`.
- `allBranches: false` requires at least one branch (`422 BRANCH_REQUIRED`). Switching back to `allBranches: true`
  clears the branch list.
- `staffGroupRoleKey` must be the key of a STAFF role of the centre (`422 UNKNOWN_STAFF_GROUP`).
  `workflowDefinitionId` and `categoryId` must belong to the centre (404 otherwise).
- Optimistic concurrency: send the `version` you loaded with PATCH. If the service changed in the meantime the
  API answers `409 VERSION_CONFLICT`. Every successful change increases `version` by one. Without `version` the
  change is applied to the latest state.
- Delete is a soft delete (`deletedAt`, and `isActive` becomes false). A service with open requests cannot be
  deleted (`409 SERVICE_HAS_OPEN_REQUESTS`) - deactivate it instead. Deleted services are listed with
  `?deleted=true` and brought back with `POST /services/:id/restore` (they stay inactive until activated).

### Compliance capability
`complianceCapability` describes what the centre itself does for a service. It is a business category, never a
claim that the centre or TypEase is a government-authorised platform.

| Value | Meaning | Precondition |
| --- | --- | --- |
| `DOCUMENT_PREPARATION_ONLY` (default) | Staff prepare the paperwork; the customer or sponsor submits it | none |
| `INFORMATIONAL_ONLY` | General information only | none |
| `PARTNER_COORDINATION` | Handled together with a partner | the centre has an `Integration` row with category `PARTNER` and status `ACTIVE` or `CONFIGURED` |
| `DIRECT_AUTHORISED` | The centre processes the case under its own authorisation | the centre has an `Integration` row with category `GOVERNMENT`, status `ACTIVE` and `authorisationVerifiedAt` set |

When the precondition is not met the API answers `422 CAPABILITY_NOT_PERMITTED` with a message that says what to
configure first and `details.requires`. The check runs on create, when the capability is changed, and when an
inactive service is switched back on. Integrations of other centres and platform-level rows never count.

### Prices
- Prices are never edited. `POST /services/:id/prices` closes the current price of the same scope (default, or one
  branch: `isActive=false`, `validTo=now`) and creates the new one (`validFrom=now`). The history therefore shows
  what applied when.
- A new price takes effect at once; prices cannot be scheduled for a future date. The price in force is the
  active row (`isActive`, not ended); `validFrom` / `validTo` are the history.
- A service has exactly one active default price (`branchId: null`). It can be replaced but not removed
  (`409 DEFAULT_PRICE_REQUIRED`). A branch price needs a default price first and a branch at which the service is
  offered (`422 SERVICE_NOT_AT_BRANCH`). Ending a branch price makes the branch fall back to the default price.
- The currency is always the centre's `defaultCurrency`.
- Effective price (`GET /services/:id/price`, also embedded in `/full`, `/catalogue`, `/public/services`):
  1. the active branch price wins over the active default price;
  2. a corporate contract price (`corporate_prices`) replaces the service fee only - government and third-party
     estimates are untouched (`serviceFeeSource: "CORPORATE_CONTRACT"`, `listServiceFee` keeps the catalogue fee);
  3. tax uses the centre's `taxRatePercent` and the service `taxMode`: `SERVICE_FEE_ONLY` taxes the service fee,
     `ALL_COMPONENTS` every component, `NONE` nothing. Tax is calculated per component and rounded half-up to two
     decimals, then added up, so the component totals always add up to `total`;
  4. `dueBeforeProcessing` follows the payment policy: the total (`BEFORE_PROCESSING`), `0.00`
     (`AFTER_COMPLETION`) or `depositPercent` of the total, rounded half-up (`DEPOSIT`).
- `governmentFeeEstimate` and `thirdPartyFeeEstimate` are estimates. The amounts a customer must pay are fixed on
  the quotation / invoice (finance module), not here.
- The calculation is the pure function `calculatePrice` / `selectPriceRow` in
  `services/api/src/modules/catalogue/pricing.ts` (unit-tested in `pricing.unit.spec.ts`). The finance module is
  expected to apply the same rule per line.

### Requirements
- `documentTypeKey` must be a document type that is valid and active for the centre
  (`422 UNKNOWN_DOCUMENT_TYPE` / `DOCUMENT_TYPE_INACTIVE`).
- `allowReuse` says whether a valid document already on the customer's file may satisfy the item; `maxAgeDays`
  limits how old such a document may be. This module only stores the rule.

### Dynamic forms
- Life cycle: `DRAFT -> PUBLISHED -> ARCHIVED`. There is at most one draft and at most one published version per
  service. Version numbers increase by one.
- A published or archived version can never be changed or deleted (`409 FORM_VERSION_IMMUTABLE`), because
  requests refer to the exact version that was filled in. To edit: `POST /services/:id/forms` (without `schema`
  the draft is a copy of the published version), `PUT` the draft, then publish it. Publishing archives the
  previously published version.
- A draft without fields cannot be published (`422 FORM_EMPTY`).
- The schema is `FormSchema` from `packages/types/src/catalogue.ts`, validated by `serviceFormSchema`:
  step keys and field keys are unique (field keys across the whole form); `select`, `multiselect` and `radio` need
  options with unique values, other types must not have options; `showIf.field` must be a field that comes
  earlier, and for a field with options `showIf.in` must list existing option values; `prefillFrom` must be one of
  `PREFILL_SOURCES`; `min <= max`; `pattern` (text fields only) must be a valid regular expression and is matched
  against the whole value; unknown properties are rejected. Limits: 20 steps, 60 fields per step, 200 fields.
- Validating what a customer submits: `buildFormValidator(schema, { partial?, unknownKeys? })` exported from
  `@typease/validation` returns a Zod schema. Required fields must be filled (a required checkbox must be ticked);
  values are checked and normalised per type; a field hidden by `showIf` (directly or because the field it depends
  on is hidden) is not required and its value is dropped; empty values are dropped. `partial: true` skips the
  required check (draft saving). `visibleFormFieldKeys(schema, values)` gives the web apps the same visibility
  decision. For `text` / `textarea` fields `min` / `max` are length bounds, for `multiselect` the number of
  choices, for `number` the value.

### Portal and public catalogue
- `/catalogue` shows services that are active, not deleted, `onlineAvailable`, in an active category and
  `isPublic`. Corporate users additionally see non-public services for which their own company has a contract
  price, and all their prices use their company's contract price. `branchId` restricts to services offered there
  and selects that branch's price.
- `/public/services` is served only when the centre's tenant-wide branding has `publicCatalogueEnabled` and the
  centre is `TRIAL`, `ACTIVE` or `PAST_DUE`. Otherwise - and for an unknown slug - the answer is 404. The centre is
  taken from `slug`, or from the portal host (`x-tenant-host` header / `Origin`) when `slug` is omitted. Only
  services with `isPublic && isActive` (not deleted, active category) are returned. A bearer token, if present,
  does not change what is returned.
- Fees in the public catalogue are estimates and are named as such (`feeEstimate`, `isEstimate: true`).

### Starter catalogue
- `POST /services/starter-catalogue` installs 13 neutral starter services across the default categories, each
  with a default price, a document checklist and (for 12 of them) a published form. It is meant for onboarding
  and is never run automatically.
- It is idempotent: a service whose code (`ST-…`) already exists - even edited or deleted - is skipped and left
  exactly as it is. A default category that the centre removed is created again when a starter service needs it.
- All starter services are `DOCUMENT_PREPARATION_ONLY` or `INFORMATIONAL_ONLY`. Fees and estimates are
  illustrative and must be reviewed by the centre.
- Other code can call `installStarterCatalogue(tx, tenantId)` from `starter-catalogue.ts` inside a transaction of
  that tenant.

## Events and jobs
- Events emitted: none. Events consumed: none.
- Background jobs: none.
- Every create / update / delete writes an audit entry (`service.*`, `service_category.*`, `document_type.*`,
  `service_price.*`, `service_requirement.*`, `service_form.*`) with resource type `Service`, `ServiceCategory`
  or `DocumentType`.

## Exports for other modules
- `@typease/validation`: `serviceFormSchema`, `buildFormValidator`, `visibleFormFieldKeys`, `formFields`,
  `compileFormPattern` and the request schemas.
- `services/api/src/modules/catalogue/pricing.ts`: `calculatePrice`, `selectPriceRow`, `taxOn` (pure).
- `services/api/src/modules/catalogue/starter-catalogue.ts`: `installStarterCatalogue`, `STARTER_SERVICES`.
