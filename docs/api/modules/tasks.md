# Tasks

Module folder: `services/api/src/modules/tasks`. Tables: `tasks`, `task_assignments`. All paths are under `/api/v1`.

## Endpoints

| Method | Path | Access | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | `/tasks` | `task.read` or `task.manage` | `page, pageSize, sort (createdAt, dueAt, priority, status, updatedAt), q, status, open, overdue, assigneeId, unassigned, requestId, customerId, type, roleKey, priority, branchId, source` | Paged tasks |
| GET | `/tasks/mine` | Any staff member | same filters; open tasks unless `status` is given | Paged tasks + `overdueCount` |
| POST | `/tasks` | `task.manage` | `{ title, description?, type = GENERAL, priority = NORMAL, branchId?, requestId?, customerId?, dueAt?, assigneeIds = [], roleKey? }` | Task |
| GET | `/tasks/:id` | Any staff member who may see the task | - | Task (404 when not visible) |
| PATCH | `/tasks/:id` | `task.manage` | `{ title?, description?, type?, priority?, dueAt?, roleKey? }` | Task |
| PUT | `/tasks/:id/assignees` | `task.manage` | `{ assigneeIds: [membershipId], reason? }` | Task |
| POST | `/tasks/:id/claim` | Any staff member | - | Task |
| POST | `/tasks/:id/status` | Any staff member (rules below) | `{ status: OPEN | IN_PROGRESS | DONE | CANCELLED, reason? }` | Task |

Task:

```json
{
  "id": "…", "title": "Call the customer", "description": "Ask for the missing passport copy",
  "type": "FOLLOW_UP", "priority": "HIGH", "status": "OPEN", "source": "MANUAL", "workflowManaged": false,
  "stepKey": null, "roleKey": null, "branchId": "…", "requestId": "…", "requestNo": "TE-000123",
  "customerId": "…", "customerName": "Fatima Al Mansoori", "dueAt": "2026-10-10T08:00:00.000Z", "overdue": false,
  "completedAt": null, "completedById": null, "createdById": "…", "createdAt": "…", "updatedAt": "…",
  "assignees": [{ "membershipId": "…", "userId": "…", "name": "Omar Khalid", "assignedAt": "…" }],
  "assignedToMe": false, "claimable": false
}
```

`type`: `GENERAL | FOLLOW_UP | DOCUMENT_REVIEW | APPROVAL | ESCALATION | WORKFLOW_STEP`.
`source`: `MANUAL` (this API), `WORKFLOW` (workflow engine), `AUTOMATION`, `ESCALATION` (e.g. support SLA breaches).
`overdue` is computed on every read: the task is OPEN or IN_PROGRESS and `dueAt` is in the past.
`customerName` is null for callers without `customer.read`.

## Events and jobs

No events are emitted or consumed.

| Job | Schedule | What it does |
| --- | --- | --- |
| `tasks.overdue_scan` | every 30 minutes, all tenants | Writes one audit entry `task.overdue` per task and due date when an open task passes its due date. It changes no task and emits no event; payload `{ now? }` for tests. |

## Business rules

- **Who sees a task**
  - assignees always see their tasks, whatever their permissions or branches;
  - members whose role equals the task's `roleKey` see it while it is open and unassigned (the "role queue");
  - holders of `task.read` / `task.manage` see all tasks of their branches (tasks without a branch are
    centre-wide);
  - staff without `request.read.all` do not see tasks linked to requests that are not assigned to them;
  - everything else is 404, exactly like a task of another centre.
- **Creating**: with a `requestId` the branch and customer default from the request. The branch must be one of
  the caller's branches (403 `BRANCH_FORBIDDEN`). `roleKey` must be a staff role of the centre (422
  `UNKNOWN_ROLE`).
- **Assigning**: `PUT /tasks/:id/assignees` replaces the list (send `[]` to unassign). Assignees must be active
  staff of the centre (404 otherwise, 422 `ASSIGNEE_INACTIVE`) who work at the task's branch (422
  `ASSIGNEE_BRANCH`). Every change writes an audit entry `task.assigned` / `task.reassigned` with the assignees
  before and after, who was added and removed, and the reason. Earlier assignments stay in `task_assignments`
  with `unassignedAt` set.
- **Role queue / claim**: `POST /tasks/:id/claim` assigns an open, unassigned task to the caller when it is in
  the queue of the caller's role (or the caller has `task.manage`): 403 `NOT_IN_ROLE_QUEUE`, 409
  `ALREADY_ASSIGNED`. The row is locked, so two people cannot both claim it. `claimable` in the task tells the UI.
- **Status**: `OPEN -> IN_PROGRESS -> DONE`, `OPEN -> DONE`, `IN_PROGRESS -> OPEN` (put back),
  `OPEN | IN_PROGRESS -> CANCELLED`, `DONE | CANCELLED -> OPEN` (reopen). Other changes: 409
  `INVALID_TRANSITION`; same status: 409 `NO_CHANGE`.
  - Assignees may start, put back and complete their own tasks without `task.manage`.
  - Cancelling and reopening need `task.manage`; others get 403. Changing a task that is neither yours nor
    manageable by you: 403 `NOT_YOUR_TASK`.
  - `DONE` stores `completedAt` and `completedById`; reopening clears them.
  - There is no delete: a task that is no longer needed is cancelled.
- **Workflow tasks** (`source = WORKFLOW`, `workflowManaged: true`) are created and closed by the workflow
  engine. Here they can be listed, shown, assigned, claimed and set to IN_PROGRESS (or back to OPEN). Marking
  them DONE or CANCELLED, reopening them or editing them answers 409 `WORKFLOW_TASK`:
  "This task completes automatically when the request moves on".
- Closed tasks (DONE / CANCELLED) cannot be edited or reassigned (409 `TASK_CLOSED`).
- Audit actions: `task.created`, `task.updated`, `task.assigned`, `task.reassigned`, `task.claimed`,
  `task.in_progress`, `task.open`, `task.done`, `task.cancelled`, `task.reopened`, `task.overdue`.
