# Walk-in queue

Module folder: `services/api/src/modules/queue`. Table: `queue_tokens`. All paths are under `/api/v1`.

## Endpoints

### Staff (`queue.manage` unless noted)

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/queue/tokens` | `branchId, date? (default today in the branch time zone), status?, categoryId?` | `{ branchId, date, summary, tokens[] }` |
| POST | `/queue/tokens` | `{ branchId, categoryId? or serviceId?, customerId?, appointmentId? }` | Token |
| POST | `/queue/call-next` | `{ branchId, counter, categoryId? }` | `{ token, message }` (`token: null` when nobody is waiting) |
| POST | `/queue/tokens/:id/recall` | `{ counter? }` | Token |
| POST | `/queue/tokens/:id/start` | - | Token |
| POST | `/queue/tokens/:id/complete` | - | Token |
| POST | `/queue/tokens/:id/no-show` | - | Token |
| POST | `/queue/tokens/:id/cancel` | - | Token |
| GET | `/queue/counters` | `branchId` | `{ branchId, date, counters[] }` |
| GET | `/queue/stats` (`queue.manage` or `report.operational`) | `branchId, from?, to?` (default: last 30 days) | Statistics |
| POST | `/queue/display-tokens` | `{ branchId, validDays = 90 (max 365) }` | `{ token, branchId, expiresAt, displayUrl, streamUrl }` |
| POST | `/queue/display-tokens/revoke` | `{ branchId }` | `{ branchId, revoked }` |

Token (staff view):

```json
{
  "id": "…", "tokenNo": "A-002", "branchId": "…", "queueDate": "2026-10-09", "categoryId": "…",
  "categoryName": "Typing & Documentation", "customerId": "…", "customerName": "Fatima Al Mansoori",
  "appointmentId": null, "status": "CALLED", "counter": "3", "servedById": "…", "servedByName": "Omar Khalid",
  "issuedAt": "…", "calledAt": "…", "servedAt": null, "completedAt": null, "waitSeconds": 240
}
```

`summary`: `{ waiting, called, serving, completed, noShow, cancelled }`.
Counter entry: `{ counter, current: { id, tokenNo, status, calledAt, servedByName } | null, servedToday, noShowsToday }`.

Statistics:

```json
{
  "branchId": "…", "from": "2026-09-10", "to": "2026-10-09", "timezone": "Asia/Dubai",
  "tokens": { "total": 7, "completed": 2, "noShows": 2, "cancelled": 1, "daysWithTokens": 1 },
  "waitSeconds": { "average": 240, "median": 180, "p90": 456 },
  "serviceSeconds": { "average": 450, "median": 450, "p90": 570 },
  "noShowRate": 0.333,
  "tokensPerHour": [{ "hour": 10, "count": 3, "averagePerDay": 3 }]
}
```

Wait = issue to call; service = "start serving" to "complete" (completed tokens only); percentiles are
interpolated (`percentile_cont`). `noShowRate` = no-shows / (all tokens - cancelled). `tokensPerHour` uses the
hour of issue in the branch time zone. Periods without data return `null` times.

### Public display (no authentication, rate limited, signed display token required)

| Method | Path | Query | Response |
| --- | --- | --- | --- |
| GET | `/public/queue/display` | `token` | Display state |
| GET | `/public/queue/display/stream` | `token` | `text/event-stream` |

Display state - the complete payload:

```json
{
  "branch": { "name": "Main Branch", "nameAr": null },
  "date": "2026-10-09", "language": "en",
  "nowServing": [{ "tokenNo": "D-002", "counter": "6", "status": "CALLED" }, { "tokenNo": "D-001", "counter": "5", "status": "SERVING" }],
  "nextUp": ["D-003", "D-004"],
  "waitingCount": 2,
  "generatedAt": "2026-10-09T08:00:00.000Z"
}
```

It contains token numbers, counters and statuses only: no names, phone numbers, services, staff or ids (the
query selects only those columns; a test asserts the payload). `nowServing` holds up to 12 called / serving
tokens (latest call first), `nextUp` the next 8 waiting tokens. `language` is `tenant.settings.queueDisplayLanguage`.

Stream: `retry: 5000`, then an event `queue` with the display state immediately and again whenever the state
changes; `: keep-alive` comments every 20 s; event `expired` followed by the end of the stream when the link was
revoked or ran out. The server re-reads the state every 3 seconds (plus an immediate refresh for changes made on
the same API instance), stops as soon as the client disconnects, and closes every stream after one hour (the
browser's `EventSource` reconnects by itself). An invalid token gets a normal 401 JSON response instead of a
stream.

## Events and jobs

None. The queue is driven by the endpoints above; appointment check-in issues tokens through this module.

## Business rules

- Token numbers are per branch and day: `<letter>-<3 digits>`, e.g. `A-001`. The number comes from
  `sequences.nextValue(tx, 'queue:<branchId>:<yyyy-mm-dd>')`, so it is gap-free and never duplicated, also under
  concurrent requests and across categories. The letter shows the service category (A = first category in sort
  order, B = second ...; `W` when no category was chosen). The day is the branch's local date.
- A token can be linked to a customer and / or to a CHECKED_IN appointment at the same branch (409
  `APPOINTMENT_NOT_CHECKED_IN`, `TOKEN_EXISTS`; 422 `APPOINTMENT_BRANCH_MISMATCH`). The category defaults from
  the service or the appointment's service.
- Call next takes the longest-waiting token of today (optionally of one category) with a row lock and
  `SKIP LOCKED`: two counters pressing "next" together always get different tokens.
- Statuses: `WAITING -> CALLED -> SERVING -> COMPLETED`; `CALLED -> COMPLETED` (quick service); `CALLED -> NO_SHOW`;
  `WAITING | CALLED -> CANCELLED`; recall only while CALLED (it can move the token to another counter). Other
  steps are 409 `INVALID_TRANSITION`.
- Linked appointments follow the token: start -> IN_SERVICE, complete -> COMPLETED, no-show -> NO_SHOW.
- Display links are signed tokens (HMAC, `signPayload`) bound to tenant and branch. They cannot be listed;
  `POST /queue/display-tokens/revoke` invalidates every link issued so far for the branch (version counter in
  `tenant.settings.queue.displayVersions`). A link also stops working when the branch is deactivated or the
  centre is suspended.
- Staff limited to branches can only work the queues of their branches (403 `BRANCH_FORBIDDEN`).
- Audit: `queue.token_cancelled`, `queue.token_no_show`, `queue.display_token_issued`,
  `queue.display_tokens_revoked`. Issuing, calling and serving are recorded on the token itself
  (`issuedAt`, `calledAt`, `servedAt`, `completedAt`, `servedById`, `counter`).
