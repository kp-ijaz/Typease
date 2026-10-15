# Authentication: sessions, passwords, support-session exchange

Module folder: `services/api/src/modules/auth` (+ `services/api/src/common/auth`). All paths are under `/api/v1`.
This page documents the parts of the module that have rules a client must know. The complete route list with
access rules is in `docs/api/ENDPOINTS.md` (tag "Authentication").

## Sessions

A sign-in creates a session: a short-lived access token (bearer, `JWT_ACCESS_TTL_SECONDS`) and a refresh token
(browser apps: HttpOnly cookie `te_rt_<app>` scoped to `/api/v1/auth`; the mobile app: in the response body).
A refresh rotates the session (the old row is closed, a new one takes its place in the same family); presenting
a rotated refresh token again ends the whole family (`401 SESSION_EXPIRED`, security event
`REFRESH_TOKEN_REUSE`, severity HIGH, filed under the person it belongs to: the event's `userId` column carries
the user id even though nobody is signed in at that moment, so `GET /platform/security-events?userId=` finds it).

**At most 20 live sessions per user and app** (`MAX_LIVE_SESSIONS_PER_APP`; apps: `centre`, `customer`,
`corporate`, `mobile`, `platform`). Every time a session is issued, the user's live sessions in that app beyond
the 20 most recent are ended (`revokedReason = "SESSION_LIMIT"`, security event `SESSION_LIMIT_REACHED`). The
session just created is never one of them. An ended session answers `401 SESSION_EXPIRED` on its next request
and cannot refresh. An account that accumulated more than 20 sessions before this rule existed is brought back
to 20 by its next sign-in. A refresh does not add a session.

| Method | Path | Access | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | `/auth/sessions` | signed in | `limit` = 20 (1-100), `app?` (`centre \| customer \| corporate \| mobile \| platform`) | array of sessions + header `X-Total-Count` |
| POST | `/auth/sessions/revoke-others` | signed in | - | `{ "revoked": 4 }` |
| DELETE | `/auth/sessions/:id` | signed in | - | `{ "status": "REVOKED" }` (own sessions only, otherwise `404`) |
| POST | `/auth/logout` | public (refresh cookie / token, or the bearer token) | `{ refreshToken?, app? }` | `{ "status": "SIGNED_OUT" }` |

```json
[
  { "id": "…", "app": "mobile", "tenantId": "…", "deviceName": "Aisha's iPhone", "userAgent": "…", "ip": "203.0.113.7",
    "createdAt": "2026-10-09T08:00:00.000Z", "lastUsedAt": "2026-10-09T08:00:00.000Z", "expiresAt": "2026-11-08T08:00:00.000Z",
    "supportSession": false, "current": true }
]
```

- `GET /auth/sessions` returns the user's **live** sessions (not revoked, not expired), **most recent first**,
  at most `limit`. The session that makes the call is always in the answer and has `current: true`; when it is
  not among the `limit` most recent ones it takes the last place. `X-Total-Count` is the number of live
  sessions that match (`app` filter included), so a client can show "and 12 more". `400 VALIDATION_FAILED` for
  a limit outside 1-100 or an unknown app. "Most recent" is `lastUsedAt`: it follows use - every
  authenticated request (also one refused for lack of permission) moves it forward, written **at most once a
  minute per session**; a refresh starts the replacing session at "now" and leaves the rotated row untouched.
  A revoked session is never touched.
- `POST /auth/sessions/revoke-others` ("sign out everywhere else") ends every other live session of the user
  **in every app** and keeps the one that asked. `revoked` is how many were ended; calling it again returns 0.
- None of these routes is open to a support session (`platform.md`, "What a support session can reach").

## Two-step verification (TOTP)

| Method | Path | Access | Body | Response |
| --- | --- | --- | --- | --- |
| POST | `/auth/mfa/setup` | signed in, MFA not yet enabled | - | `{ "secret": "JBSWY3DP…", "issuer": "TypEase", "otpauthUrl": "otpauth://totp/TypEase:aisha%40example.ae?secret=…&issuer=TypEase" }` |
| POST | `/auth/mfa/enable` | signed in | `{ code }` | `{ …, recoveryCodes: [10] }` (shown once; the user's other sessions end). `400 MFA_CODE_INVALID` |
| POST | `/auth/mfa/disable` | signed in (MFA verified) | `{ password, code }` (authenticator or recovery code) | `{ "status": "MFA_DISABLED" }` |

`issuer` is the name the authenticator app shows next to the code. For people of a **white-label centre**
(its plan includes `whiteLabel` AND the centre switched `mode: WHITE_LABEL` on - the same rule the portals use)
it is the centre's brand name (`brandingSettings.businessName`, or the centre name; colons and line breaks
replaced by spaces, at most 64 characters), for everybody else - platform staff, and every member of a centre
presented as TypEase - it is `TypEase`. The issuer is a label: it does not change the secret or the codes, and
an entry made while the centre was white-labelled keeps working after the brand is switched off.
`MFA_ALREADY_ENABLED` (409) when it is already on.

## Password policy

One function decides (`assertPasswordPolicy` in `services/api/src/common/password-policy.ts`): at least
`PASSWORD_MIN_LENGTH` characters (default 10; the variable cannot be set below 10 or above 128), at most 128,
with a lower-case letter, an upper-case letter and a digit. It is applied wherever a password is **set**:
`POST /auth/register`, `POST /public/signup`, `POST /auth/password/reset`, `POST /auth/password/change`,
`POST /auth/invitations/accept` and the `platform-admin` CLI (minimum 14 there). Sign-in never applies it, so
passwords chosen under an earlier, shorter minimum keep working.

A password that does not meet it is refused with the shape of a validation error, before anything is used up
(a reset link or an invitation stays valid):

```json
{ "statusCode": 400, "code": "VALIDATION_FAILED", "message": "Please check the highlighted fields.",
  "details": [ { "path": "password", "message": "Use at least 14 characters" } ] }
```

(`path` is `newPassword` for `POST /auth/password/change`.)

Where a client reads the policy before showing a form:

- `GET /public/tenant-config` -> `"passwordPolicy": { "minLength": 10, "maxLength": 128, "requires": ["lowercase", "uppercase", "digit"] }`
- `GET /auth/invitations/preview?token=…` -> the same object as `passwordPolicy`.

The shared schema `password` in `@typease/validation` is the floor (10 characters); `passwordWithMinLength(n)`
builds the same schema for the minimum the API published.

## Support-session exchange

`POST /auth/support-session/exchange { code }` turns the one-time code from the platform console into a
support session of the staff app. Request, response, errors and what the staff app must show are in
`platform.md`, section "Support session hand-off". `GET /auth/me` returns the same `session` object,
including `supportGrant`.
