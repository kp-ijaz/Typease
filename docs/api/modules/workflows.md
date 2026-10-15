# Workflows module

Workflow definitions, their versions and the builder API. The execution of a workflow for a request is part of
the requests module; see `docs/workflows/REQUEST_LIFECYCLE.md` for the engine and `docs/api/modules/requests.md`
for the case endpoints.

Code: `services/api/src/modules/workflows`. Validation schemas: `packages/validation/src/workflows.ts`.
Base path: `/api/v1`. All endpoints need a staff session of the centre.

## Concepts

- A **definition** (`workflow_definitions`) is a named workflow of one centre, identified by a `key` that is
  unique per centre.
- A definition has **versions** (`workflow_versions`): `DRAFT` -> `PUBLISHED` -> `ARCHIVED`. At most one version
  is published (database index) and at most one is a draft (API rule).
- A version has ordered **steps** (`workflow_steps`). The order of the `steps` array is the step order
  (`position` 1..n is assigned by the server).
- Published and archived versions are immutable. Every change is a new version.
- Requests are pinned to a version id. Publishing, rolling back or archiving never changes a running case.
- The centre's **default workflow** is stored in `tenant.settings.defaultWorkflowDefinitionId`; services
  without a `workflowDefinitionId` use it.

## Endpoints

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/workflows` | `workflow.manage` or `service.manage` | Definitions with their published and draft version. Query: `includeArchived=true` |
| GET | `/workflows/templates` | `workflow.manage` | The code-defined templates (`standard`, `walk-in-express`, `pay-on-completion`) with their steps |
| GET | `/workflows/builder-meta` | `workflow.manage` | Step types, rule facts, operators, staff roles, timeout range, default definition id |
| POST | `/workflows/validate` | `workflow.manage` | Dry run: `{ steps }` -> `{ valid, errors[] }`. Saves nothing. Always 200 |
| POST | `/workflows` | `workflow.manage` | Create a definition from a template or from scratch |
| GET | `/workflows/:id` | `workflow.manage` or `service.manage` | One definition with the steps of its published and draft version |
| PATCH | `/workflows/:id` | `workflow.manage` | Rename / describe: `{ name?, description? }` |
| POST | `/workflows/:id/archive` | `workflow.manage` | Retire the workflow for new requests |
| DELETE | `/workflows/:id` | `workflow.manage` | Delete a workflow that has no published version and was never used. `{ id, status: "DELETED" }` |
| POST | `/workflows/:id/set-default` | `workflow.manage` | Make it the centre default (needs a published version) |
| GET | `/workflows/:id/versions` | `workflow.manage` | All versions, newest first, with `stepCount` and `casesUsing` |
| POST | `/workflows/:id/versions` | `workflow.manage` | Start a draft as a copy of the published version. Body: `{ notes? }` |
| GET | `/workflows/:id/versions/:versionId` | `workflow.manage` | One version with its steps |
| PUT | `/workflows/:id/versions/:versionId/steps` | `workflow.manage` | Replace all steps of a draft: `{ steps, notes? }` |
| DELETE | `/workflows/:id/versions/:versionId` | `workflow.manage` | Discard a draft |
| POST | `/workflows/:id/versions/:versionId/publish` | `workflow.manage` | Publish a draft; the previously published version becomes `ARCHIVED` |
| POST | `/workflows/:id/versions/:versionId/rollback` | `workflow.manage` | Create and publish a new version that is a copy of this older one |

A definition or version of another centre is always 404.

### Step

```json
{
  "key": "review",
  "name": "Review approval",
  "nameAr": "موافقة المدقق",
  "type": "INTERNAL_APPROVAL",
  "config": {},
  "conditions": { "all": [{ "fact": "service.requiresApproval", "op": "truthy" }] },
  "branches": null,
  "nextStepKey": null,
  "onRejectStepKey": "prepare",
  "assigneeRoleKey": "reviewer",
  "timeoutHours": 24,
  "escalateToRoleKey": "manager",
  "customerVisible": false
}
```

| Field | Notes |
| --- | --- |
| `key` | 2-40 characters: lowercase letters, digits, `-`, `_`; starts with a letter; unique in the version. Keep keys stable across versions: migration matches the current step by key |
| `type` | `CUSTOMER_FORM`, `DOCUMENT_UPLOAD`, `STAFF_VERIFICATION`, `QUOTATION`, `CUSTOMER_APPROVAL`, `PAYMENT`, `STAFF_TASK`, `INTERNAL_APPROVAL`, `EXTERNAL_PROCESSING`, `NOTIFICATION`, `DOCUMENT_GENERATION`, `CONDITIONAL_BRANCH`, `COMPLETION` |
| `config` | Type-specific JSON (max 4000 bytes). `NOTIFICATION`: `{ message }`. `DOCUMENT_GENERATION`: `{ optional?, title?, documentTypeKey?, customerVisible? }` |
| `conditions` | Rule. The step is skipped when it is false |
| `branches` | `CONDITIONAL_BRANCH` only: `[{ when: Rule, goTo: stepKey }]`, first match wins, otherwise `nextStepKey` / the next step |
| `nextStepKey` | Default: the following step. Must point forward |
| `onRejectStepKey` | Approval steps only. `INTERNAL_APPROVAL` -> an earlier `STAFF_TASK`; `CUSTOMER_APPROVAL` -> an earlier `QUOTATION` |
| `assigneeRoleKey`, `escalateToRoleKey` | Keys of staff roles of the centre (system or custom) |
| `timeoutHours` | 1..2160. After that the step is escalated by the `workflows.scan` job |
| `customerVisible` | Whether customers see the step in the progress view (default true) |

Rule: `{ "all": [Condition], "any": [Condition] }`, `Condition = { fact, op, value }`; operators and facts are
listed by `GET /workflows/builder-meta`.

### POST /workflows

```json
{ "key": "attestation", "name": "Attestation", "description": null, "templateKey": "standard", "publish": false }
```

Send either `templateKey` or `steps` (at least one step). The definition is created with version 1 as a
`DRAFT`; `publish: true` publishes it at once. Response (201):

```json
{ "id": "…", "tenantId": "…", "key": "attestation", "name": "Attestation", "templateKey": "standard",
  "publishedVersionId": null, "versionId": "…", "versionStatus": "DRAFT" }
```

### GET /workflows

```json
[{ "id": "…", "key": "standard", "name": "Standard service request", "templateKey": "standard",
   "isDefault": true, "archived": false, "servicesUsing": 4, "versionCount": 2,
   "publishedVersion": { "id": "…", "version": 2, "publishedAt": "2026-10-09T08:00:00.000Z", "stepCount": 11 },
   "draftVersion": null }]
```

`archived` is derived: the definition has no published and no draft version (a definition without any version
counts as archived too).

### DELETE /workflows/:id

```json
{ "id": "…", "status": "DELETED" }
```

The definition, its versions (draft and archived) and their steps are removed. See business rule 5 for when this
is allowed.

### GET /workflows/:id/versions/:versionId

```json
{ "id": "…", "definitionId": "…", "version": 2, "status": "PUBLISHED", "notes": "Copy of version 1.",
  "publishedAt": "…", "publishedById": "…", "createdById": "…",
  "steps": [{ "id": "…", "position": 1, "key": "form", "name": "Application details", "type": "CUSTOMER_FORM", "…": "…" }] }
```

## Errors

| HTTP | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | Malformed body (unknown step type, bad key format, both `templateKey` and `steps`, empty `steps`) |
| 422 | `WORKFLOW_INVALID` | The steps break a workflow rule. `details` lists **all** problems as `{ code, stepKey?, message }` |
| 409 | `DUPLICATE` | The key is already used by another workflow of the centre |
| 409 | `DRAFT_EXISTS` | A draft already exists (`details.versionId`). Publish or discard it first |
| 409 | `VERSION_IMMUTABLE` | Editing, publishing or discarding a version that is not a draft |
| 409 | `LAST_VERSION` | Discarding the only version of a workflow (archive the workflow instead) |
| 409 | `VERSION_NOT_PUBLISHED` / `ALREADY_PUBLISHED` | Rolling back to a draft / to the version that is already in use |
| 409 | `WORKFLOW_IN_USE` | Archiving or deleting a workflow that a service still uses (the message names the services) |
| 409 | `DEFAULT_WORKFLOW` | Archiving or deleting the centre default |
| 409 | `WORKFLOW_PUBLISHED` | Deleting a workflow that has a published version (archive it first) |
| 409 | `WORKFLOW_HAS_REQUESTS` | Deleting a workflow one of whose versions was used by a request (`details.requests`); it can only be archived |
| 409 | `WORKFLOW_NOT_PUBLISHED` | `set-default` on a workflow without a published version |

Problem codes inside `WORKFLOW_INVALID.details` (also returned by `POST /workflows/validate`):

`NO_STEPS`, `DUPLICATE_KEY`, `COMPLETION_COUNT`, `COMPLETION_NOT_LAST`, `COMPLETION_CONDITIONAL`,
`UNKNOWN_STEP_REFERENCE`, `UNKNOWN_ROLE`, `INVALID_TIMEOUT`, `UNKNOWN_FACT`, `INVALID_RULE`,
`BRANCHES_REQUIRED`, `BRANCHES_NOT_ALLOWED`, `CYCLE`, `ON_REJECT_NOT_ALLOWED`, `QUOTATION_REQUIRED`,
`PAYMENT_REQUIRES_QUOTATION`, `EXTERNAL_REQUIRES_STAFF_TASK`, `APPROVAL_REQUIRES_STAFF_TASK`,
`COMPLETION_REQUIRES_STAFF_TASK`, `DEAD_END`, `UNREACHABLE_STEP`, `COMPLETION_UNREACHABLE`.

## Business rules

1. **Validation** runs when a workflow is created, when a draft is saved, when it is published and when a
   version is rolled back to (roles may have been deleted since). The rules are listed in
   `docs/workflows/REQUEST_LIFECYCLE.md`, section 5.
2. **Publishing** archives the previously published version and updates
   `workflow_definitions.publishedVersionId`. Running cases keep the version they started with.
3. **Rollback** never rewrites history: version N+1 is created as a copy of the chosen version, with the note
   "Rollback to version X.", and published.
4. **Archive**: all published / draft versions become `ARCHIVED` (an unused draft is deleted) and the
   definition is hidden from `GET /workflows` unless `includeArchived=true`. Cases already running on one of
   its versions continue. Creating and publishing a new draft brings the workflow back.
5. **Delete** is for mistakes and leftovers: a workflow that was created and never published, or one that was
   archived before any request used it. It is refused while a version is published (`WORKFLOW_PUBLISHED`), while
   a service that is not deleted points at the workflow (`WORKFLOW_IN_USE`), for the centre default
   (`DEFAULT_WORKFLOW`), and for good once any request or workflow execution ran on (or was migrated from) one
   of its versions (`WORKFLOW_HAS_REQUESTS`): the history of those requests refers to the steps. The definition
   row is locked by the delete, the audit entry `workflow.deleted` keeps key, name, template and the list of
   versions. The key becomes free for a new workflow.
6. **What a workflow can not do**: remove a compliance rule. A service that requires review can not reach
   submission or completion without an approved review, a service that the centre may not submit is never
   submitted, and the payment policy of the service applies, whatever the steps say. These rules live in the
   request state machine (`docs/workflows/REQUEST_LIFECYCLE.md`, sections 4 and 7).
7. **Templates** are installed for every centre by the provisioning step `workflows.templates` (idempotent:
   an existing definition with the template's key is left alone, a missing one is created with a published
   version 1, and the default is set only when the centre has none).

## Events and jobs

The module emits and consumes no domain events and registers no jobs. Every write is audited:
`workflow.created`, `workflow.updated`, `workflow.draft_created`, `workflow.draft_saved`,
`workflow.draft_discarded`, `workflow.published`, `workflow.rolled_back`, `workflow.archived`,
`workflow.deleted`, `workflow.default_changed`.

## Pure functions (unit-tested, no database)

- `validateWorkflow(steps, { roleKeys })` - `workflow-validator.ts`
- `evaluateRule(rule, facts)`, `checkRule(rule, allowedFacts)` - `rule-evaluator.ts`
