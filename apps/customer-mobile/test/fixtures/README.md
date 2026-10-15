# Test fixtures

Every `*.json` file in this folder is a **real response** of the TypEase API, captured with `curl` from the
local development server (`http://localhost:4000/api/v1`, build snapshot of this repository) while a test
centre (`mobile-fixture`) and a test customer went through the customer journey:

register -> verify email -> sign in (`app: "mobile"`) -> catalogue -> create draft -> save fields -> upload
documents (intent / PUT / complete) -> submit -> staff rejects a document -> re-upload -> resubmit ->
quotation -> approve -> invoice -> sandbox payment -> completion; plus appointments, support, reminders,
notifications, privacy and sessions.

The files were copied unchanged except for secrets, which were replaced with placeholders:

| Field | Replaced with |
| --- | --- |
| `accessToken` | `header.payload.signature` |
| `refreshToken` | 64 times `r` |
| `challengeToken` | `challenge-token-placeholder-…` |
| `trackingCode` | `ABCDE-FGHIJ` |
| signed tokens inside upload / download / checkout URLs | `signed-token-placeholder` |

Names, emails and phone numbers are invented test data.

`request_created.json` is the response of `POST /requests` (it carries `reuseCandidates`),
`request_submitted.json` the response of `POST /requests/:id/submit` (it carries `trackingCode`),
the other `request_*.json` files are `GET /requests/:id` in the named status.
