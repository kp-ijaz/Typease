# AI document assistant (OCR and field extraction)

Source: `services/api/src/modules/ocr` (+ the checklist assistant in `services/api/src/modules/documents`).
Request shapes: `packages/validation/src/documents.ts`. All paths are below `/api/v1`.

The assistant reads a document that is already in the vault and **suggests** field values. It never decides
anything:

- Output is always unverified. Status `COMPLETED` means "waiting for a person", not "done".
- Nothing is written to a customer profile, a document or a request automatically. A person reviews the
  values (`review`), then explicitly chooses which reviewed values to copy (`apply`).
- A value that cannot be read is absent and reported as missing. Nothing is made up.
- It does not approve documents, does not touch request status and has no connection to any government system.

## 1. What was and was not verified (read this first)

| Part | Status |
| --- | --- |
| Extraction logic (MRZ parser, Emirates ID number, dates, classification, warnings) | Unit tested (65 tests) with the public ICAO Doc 9303 specimens, a public German specimen and invented data. Includes a regression corpus of lines actually produced by Tesseract |
| Pipeline (queue, job, storage, review, apply, usage, permissions, tenant isolation) | Integration tested with a deterministic fake OCR engine that exists only in the tests |
| `tesseract` provider | Starts and runs **offline** here. Tested on exactly one synthetic image: the ICAO specimen MRZ rendered as black text on white. **Not tested on photographs or scans of real documents**: expect noticeably worse recognition there, and review accordingly |
| `external-http` provider | Tested against a local stub HTTP server only. No real OCR vendor was called |
| Trade licence extraction | Label matching only. Layouts differ between emirates and free zones; treat every value as a hint |
| Arabic text | Not recognised: only the English Tesseract model is installed. Arabic labels are ignored, values are taken from the English text and the MRZ |
| PDF with the `tesseract` provider | Not supported (no PDF rasteriser is bundled): the request is refused with `OCR_UNSUPPORTED_FILE`. Images (JPG, PNG, WebP) only. `external-http` passes PDFs through |

## 2. Endpoints

| Method | Path | Permission | Body / query | Returns |
| --- | --- | --- | --- | --- |
| POST | `/documents/:id/extract` | `ocr.run` | `{ profile?: "AUTO" \| "PASSPORT" \| "EMIRATES_ID" \| "TRADE_LICENCE" }` (default AUTO = the document type's OCR profile) | `202` result summary with `status: "QUEUED"`. Repeating the call while a run is queued returns the same run |
| GET | `/documents/:id/extractions` | `ocr.run` or `ocr.review` | - | page of result summaries for the document; `404` for an unknown document, one of another centre or one outside the caller's scope (never an empty list) |
| GET | `/ocr/results` | `ocr.run` or `ocr.review` | `page, pageSize, sort (createdAt, completedAt), status, documentId` | page of result summaries (`?status=COMPLETED` = review queue). No field values |
| GET | `/ocr/results/:id` | `ocr.run` or `ocr.review` | - | review screen data (below) |
| POST | `/ocr/results/:id/review` | `ocr.review` | `{ fields: [{ key, value \| null }], note? }` | review screen data, `status: "REVIEWED"` |
| POST | `/ocr/results/:id/apply` | `ocr.review` | `{ fields: ["passportNumber", "expiryDate", ...] }` | review screen data with `applied[]` |
| GET | `/ocr/usage` | `ocr.review`, `settings.manage` or `report.operational` | `from?, to?` (YYYY-MM-DD; default: current month) | usage and estimated cost |

Customers and corporate users have no access to any of these. Staff only see extractions of documents they
may see (same branch / assignment rules as the vault); anything else is `404`.

Review screen data (`GET /ocr/results/:id`):

```json
{
  "id": "…", "documentId": "…", "versionId": "…", "customerId": "…",
  "provider": "tesseract", "profile": "PASSPORT", "status": "COMPLETED", "unverified": true,
  "notice": "Read automatically from the document. Not verified: compare every value with the document before using it.",
  "classification": "PASSPORT", "classificationConfidence": 0.99,
  "pages": 1, "costUnits": "0", "error": null,
  "fields": [
    { "key": "passportNumber", "label": "Passport number", "canApply": true,
      "extracted": { "value": "L898902C3", "confidence": 0.99, "source": "MRZ" },
      "onFile": { "value": "•••• 4321", "matches": false },
      "reviewed": null },
    { "key": "fullName", "label": "Full name", "canApply": true,
      "extracted": { "value": "ANNA MARIA ERIKSSON", "confidence": 0.9, "source": "MRZ" },
      "onFile": { "value": "Anna Eriksson", "matches": true },
      "reviewed": null }
  ],
  "warnings": [
    { "code": "DOCUMENT_NUMBER_MISMATCH", "severity": "HIGH", "field": "passportNumber",
      "message": "The passport number on the document differs from the one on file.",
      "suggestion": { "target": "customer.passportNo", "fieldKey": "passportNumber" } }
  ],
  "reviewNote": null, "applied": []
}
```

- `extracted.confidence` is 0..1. `source`: `MRZ` (machine readable zone, protected by check digits), `TEXT`
  (labelled printed text), `HEURISTIC` (loose pattern match, trade licences).
- `onFile.value` is what the customer profile / document currently holds. Identity numbers are shown masked
  (`•••• 4321`); `matches` is computed on the server from the decrypted value (`null` = nothing comparable on
  file). `onFile` is `null` for fields that have no counterpart on file.
- `suggestion` is a *suggested correction*: it points at the extracted field that could be applied after
  review. Warning texts never contain profile values or identity numbers.

Field keys: `passportNumber, cardNumber, emiratesIdNumber, surname, givenNames, fullName, nationality,
issuingState, dateOfBirth, sex, expiryDate, issueDate, personalNumber, licenceNumber, companyName`.
Dates are `YYYY-MM-DD`; nationality / issuing state are MRZ three-letter codes.

Usage (`GET /ocr/usage`):

```json
{
  "aiEnabled": true,
  "provider": { "name": "tesseract", "configured": true },
  "plan": { "includesAiAssistant": true, "monthlyPageLimit": 200 },
  "currentMonth": { "period": "2026-10", "pagesUsed": 4, "pagesRemaining": 196 },
  "range": { "from": "…", "to": "…" },
  "totals": { "extractions": 2, "failed": 0, "pages": 4, "costEstimate": "0.0600", "currency": "USD" },
  "byProvider": [ { "provider": "tesseract", "operation": "ocr.extract", "success": true, "count": 2, "pages": 4, "costEstimate": "0.0600" } ],
  "recent": [ { "id": "…", "provider": "tesseract", "documentId": "…", "pages": 3, "costEstimate": "0.0450", "currency": "USD", "success": true, "actorId": "…", "createdAt": "…" } ]
}
```

`costEstimate` = pages x `OCR_COST_PER_PAGE` as configured by the operator, in the currency recorded in
`ai_usage_logs` (default `USD`). It is an estimate for cost tracking, not a provider invoice.

## 3. Switches (all must be on)

| Check | Failure |
| --- | --- |
| `OCR_PROVIDER` is `tesseract` or `external-http` | `503 INTEGRATION_NOT_CONFIGURED` |
| Centre setting `aiEnabled` (`PATCH /tenant { "aiEnabled": true }`) | `403 AI_DISABLED` |
| Plan includes `aiAssistant` | `402 PLAN_LIMIT_REACHED` (`details.limit = "aiAssistant"`) |
| Monthly `aiPages` limit not reached | `402 PLAN_LIMIT_REACHED` (`details.limit = "aiPages"`) |
| The document is available (uploaded, scanned, not quarantined / deleted) | `409 DOCUMENT_*` |
| The engine can read the file type | `422 OCR_UNSUPPORTED_FILE` |
| Consent (below) | `403 AI_CONSENT_WITHDRAWN` |

The tenant switch, the plan and consent are checked again when the job runs; if one of them changed in the
meantime the run ends as `FAILED` without calling the engine.

**Consent rule.** Processing is refused when the document's customer (the document's `customerId`, else the
customer of its request) has a `customer_consents` row for purpose `AI_PROCESSING` with status `WITHDRAWN`.
If no row exists for that purpose, staff-initiated processing is carried out on the contract basis (the
customer asked the centre to handle the document). Whether that basis is sufficient for your centre is a
question for your legal adviser; a centre that wants explicit opt-in can simply keep `aiEnabled` off or record
consent before running extractions. Company documents without a customer are not subject to this check.

## 4. Providers

| `OCR_PROVIDER` | Where the document goes |
| --- | --- |
| `disabled` (default) | nowhere |
| `tesseract` | stays on the API / worker host: tesseract.js (WebAssembly) with the English model from the installed `@tesseract.js-data/eng` package. Nothing is downloaded at runtime |
| `external-http` | to `OCR_EXTERNAL_URL` and nowhere else (redirects are refused). Use only a service your centre has approved as a processor, and record it in the processor register (`privacy.md`) |

`external-http` contract:

```
POST <OCR_EXTERNAL_URL>
Authorization: Bearer <OCR_EXTERNAL_TOKEN>
Content-Type: multipart/form-data        parts: file (the document), mime (its media type)

200 application/json
{ "text": "line 1\nline 2", "pages": 1, "confidence": 0.93 }
```

`text` is required. `pages` defaults to 1. `confidence` is 0..1; when it is missing 0.5 is recorded. Any
other status code, a non-JSON body or a timeout (90 s) counts as a failure. `https` is required in production.

The recognised text is used in memory to extract fields and then discarded. It is **not** stored in the
database, not logged and not put into the audit trail.

## 5. Extraction rules a reviewer should know

- **MRZ (passports TD3, identity cards TD1 including the back of the Emirates ID).** Every field with a check
  digit is validated; the composite check digit is validated too. Confidence: `0.99` validated as read,
  `0.8` validated after a repair (marked), `0.3` when the check digit fails (the value is returned as read and
  a `CHECK_DIGIT_MISMATCH` warning is raised). Names and country codes have no check digit: `0.9` / `0.92`.
- **OCR confusions.** Digits and letters are normalised where only one kind can stand (dates, check digits,
  names, country codes). In document and personal numbers a look-alike (O/0, I/1, B/8, S/5, Z/2, G/6) is
  replaced only when the character is out of place, the check digit fails as read, and exactly one
  replacement makes it valid. `<` fillers read as `K`, `L`, `C` or `«` are repaired; line-length errors are
  realigned, and a stray extra character is removed only when all check digits then agree.
- **Limit of check digits.** The ICAO check digit works modulo 10 on character values, so it cannot detect a
  confusion between characters whose values differ by a multiple of ten: `1`/`L`, `6`/`G`, `8`/`S`, `0`/`K`.
  `L898902C3` and `1898902C3` both validate. A high confidence is strong evidence, not proof: always compare
  with the document.
- **Emirates ID number** (`784-YYYY-NNNNNNN-C`): found in the MRZ of the back side and in printed text of the
  front side; the last digit is checked with the Luhn algorithm. A number failing the check is still shown,
  with confidence `0.3` and an `EMIRATES_ID_CHECK_FAILED` warning.
- **Dates**: `dd/mm/yyyy` (also `-` and `.`), `yyyy-mm-dd`, `dd MMM yyyy`. Day-first is assumed (UAE usage);
  a date that could also be month-first gets a lower confidence. Two-digit MRZ years: a birth date is never in
  the future; an expiry date is 20YY unless that is more than 50 years ahead.
- **Classification**: `PASSPORT`, `EMIRATES_ID`, `TRADE_LICENCE` or `UNKNOWN` with a confidence. Weak or
  contradictory evidence gives `UNKNOWN`. When the upload's document type says otherwise a
  `CLASSIFICATION_MISMATCH` warning is raised.
- **Trade licence**: licence number, expiry / issue date and company name by English labels, confidence
  at most `0.5`.
- Values not protected by a check digit are additionally scaled by the engine's own confidence.

Warnings: `DOCUMENT_EXPIRED` (HIGH), `DOCUMENT_EXPIRING_SOON` (MEDIUM, within 6 months), `CHECK_DIGIT_MISMATCH`,
`COMPOSITE_CHECK_MISMATCH`, `EMIRATES_ID_CHECK_FAILED` (HIGH), `NAME_MISMATCH`, `DATE_OF_BIRTH_MISMATCH`,
`DOCUMENT_NUMBER_MISMATCH` (HIGH), `NATIONALITY_MISMATCH`, `EXPIRY_DATE_MISMATCH`, `CLASSIFICATION_MISMATCH`,
`MISSING_FIELD`, `INVALID_DATE`, `NAME_UNCERTAIN`, `LINE_LENGTH_REPAIRED`, `STRAY_CHARACTERS`,
`TRAILING_K_AMBIGUOUS` (MEDIUM), `NAME_PARTIAL_MATCH`, `NOT_ON_FILE`, `LOW_CONFIDENCE` (below 0.6),
`CHARACTER_REPAIRED`, `FILLER_REPAIRED`, `NAME_POSSIBLY_TRUNCATED`, `UNKNOWN_COUNTRY_CODE`, `INVALID_SEX` (LOW).

## 6. Review and apply

Status flow: `QUEUED -> PROCESSING -> COMPLETED -> REVIEWED`, or `-> FAILED`.

- `review` stores, per field, the value the reviewer read on the document: `CONFIRMED` (same as extracted),
  `CORRECTED`, `ADDED` (not extracted) or `REJECTED` (`value: null`). Values are validated (real dates,
  5-12 character passport numbers, `784` + 12 digits, country codes, `M` / `F` / `X`); invalid input is
  `422 INVALID_REVIEW_VALUE` with the offending paths. A result can be reviewed again.
- `apply` works on `REVIEWED` results only (`409 OCR_NOT_REVIEWED` otherwise) and only for the listed keys,
  each of which must have been confirmed in the review (`422 FIELD_NOT_REVIEWED`).

  | Key | Written to |
  | --- | --- |
  | `fullName`, `nationality`, `dateOfBirth` | customer profile |
  | `passportNumber` | customer `passportNoEnc` (AES-256-GCM), `passportNoHash` (blind index), `passportNoLast4` |
  | `emiratesIdNumber` | customer `emiratesIdEnc`, `emiratesIdHash`, `emiratesIdLast4` |
  | `issuingState` | customer `passportCountry` (passports only) |
  | `expiryDate` | document `expiryDate` with `expiryVerified = true`; and the customer's `passportExpiry` / `emiratesIdExpiry` when the document is a passport / Emirates ID. Emits `document.expiry_changed` (`source: "OCR"`), so the reminders module starts or moves the expiry reminders of the document |
  | `issueDate` | document `issuedDate` |

  Other keys are not applicable (`422 FIELD_NOT_APPLICABLE`). If another customer record already holds the
  same passport / Emirates ID number the call is refused with `409 IDENTITY_NUMBER_IN_USE`. A document without
  a customer accepts document fields only (`422 NO_CUSTOMER_FOR_DOCUMENT` for profile fields).
- Applying does not verify the document (`POST /documents/:id/verify` remains a separate decision) and does
  not emit a domain event.
- Identity numbers inside stored extraction and review data are encrypted at rest. Audit entries
  (`ocr.requested`, `ocr.completed`, `ocr.failed`, `ocr.reviewed`, `ocr.applied`,
  `customer.updated_from_document`) contain field names and decisions, never values of identity numbers.
- Extraction results are deleted together with the files when a document is purged.

## 7. Checklist assistance (missing-document detection)

`GET /documents/checklist-assist?requestId=` (documents module, permission as for reading documents; customers
and corporate users for their own requests). Deterministic, read-only, no OCR involved. It never changes the
checklist, which belongs to the requests module.

```json
{
  "requestId": "…", "generatedAt": "…", "expiringWithinDays": 183,
  "summary": { "total": 9, "missing": 2, "rejected": 1, "expired": 1, "expiring": 1, "unverified": 1,
               "present": 2, "waived": 1, "processing": 0, "mandatoryInputsProvided": false,
               "missingMandatory": ["<checklistItemId>", "…"] },
  "items": [
    { "checklistItemId": "…", "documentTypeKey": "trade_licence", "label": "Copy of trade licence",
      "kind": "INPUT", "isMandatory": true, "checklistStatus": "MISSING", "state": "MISSING",
      "hint": "No document has been provided for this line yet.", "documentId": null,
      "verificationStatus": null, "expiryDate": null, "expiryVerified": null, "daysToExpiry": null,
      "candidates": [ { "documentId": "…", "title": "Trade Licence", "verificationStatus": "VERIFIED", "expiryDate": "2027-11-12" } ] }
  ]
}
```

`state`: `MISSING`, `PROCESSING` (upload / scan running), `BLOCKED` (quarantined), `REJECTED`, `EXPIRED`,
`EXPIRING` (within 183 days), `UNVERIFIED`, `PRESENT`, `WAIVED`; the most serious finding wins. `candidates`
are other available, unexpired documents of the same customer and type that a person might reuse; nothing is
attached automatically. Customers do not see documents that staff hid from them.

## 8. Events and jobs

- Events emitted: `document.expiry_changed` when a reviewed `expiryDate` is applied (through the documents
  module, same payload as a manual change of the date, `source: "OCR"`, `expiryVerified: true`). Events
  consumed: none.
- Job `ocr.extract` (queued by `POST /documents/:id/extract`): loads the current version from storage, runs
  the engine, extracts, stores the suggestions, writes `ai_usage_logs` and adds the pages to the `aiPages`
  usage counter. Engine outages are retried 3 times with backoff; a finished result is never processed again.
  Failed runs are logged with `success = false` and are not counted against the page limit.
