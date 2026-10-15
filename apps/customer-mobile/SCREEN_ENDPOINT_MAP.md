# Screen → endpoint map

Every screen of the customer app, the route it lives on, the Dart file, and the REST endpoints
(prefix `/api/v1`) it calls. "On open" calls load the screen; the others follow a user action.

All calls go through `lib/core/network/api_client.dart` and carry `X-Client-App: mobile`,
`Accept-Language` and (white-label builds) `X-Tenant-Host`. Calls marked *public* are sent without a
bearer token.

The last column says how the response shape used by the screen was checked:

- **live** – the response was captured from the running local API and the Dart model was written
  against it; a sanitised copy is in `test/fixtures/` and is parsed by `test/unit/models_test.dart`;
- **live (no fixture)** – the call was made against the local API while writing the app, but no fixture
  file was kept;
- **docs** – written from `docs/api/modules/*.md` / `packages/types` only.

None of this replaces running the app: **this app has not been compiled or run.**

## Start-up and sign-in

| Screen | Route | File (`lib/features/…`) | Endpoints | Shape checked |
| --- | --- | --- | --- | --- |
| Splash | `/splash` | `auth/presentation/splash_screen.dart` (work in `auth/application/bootstrap.dart`) | On open: `GET /public/tenant-config?slug=` *(public; refreshes the cached centre, or loads the locked centre of a white-label build)*; `POST /auth/refresh` *(only when a refresh token is stored)* | live (`tenant_config`, `refresh`) |
| Configuration error | `/config-error` | `auth/presentation/splash_screen.dart` (`ConfigErrorScreen`) | none (release build without `API_BASE_URL`) | – |
| Onboarding | `/onboarding` | `auth/presentation/onboarding_screen.dart` | none | – |
| Centre selection | `/centre` | `tenant/presentation/centre_selection_screen.dart` | `GET /public/tenant-config?slug=` *(public)*; for a pasted portal link without `?tenant=`: `GET /public/tenant-config?host=` *(public)* | live (`tenant_config`) |
| Explore (guest) | `/explore` | `home/presentation/explore_screen.dart` | `GET /public/services?slug=` *(public; categories, popular services, fee estimates)*; centre contact from the cached tenant config | live (`public_catalogue`) |
| Track a request (guest) | `/track` | `tracking/presentation/track_screen.dart` | `POST /public/track` *(public; request number + tracking code)* | live (no fixture) |
| Login (email + password) | `/login` | `auth/presentation/login_screen.dart`, `login_flow.dart` | `POST /auth/login` *(public)*; when the account belongs to several centres: `POST /auth/select-tenant` *(public)* | live (`login`, `login_mfa_required`, `error_login`); `SELECT_TENANT` shape from docs |
| Login with phone code | `/login/otp` | `auth/presentation/otp_login_screen.dart` | `POST /auth/otp/request` *(public)*; `POST /auth/otp/verify` *(public)* | live (no fixture; verify response = `login`) |
| Registration | `/register` | `auth/presentation/register_screen.dart` | `POST /auth/register` *(public)* | live (`error_validation`; success ack no fixture) |
| Email verification pending | `/verify-email?email=` | `auth/presentation/verify_email_screen.dart` | `POST /auth/resend-verification` *(public)*; `POST /auth/verify-email` *(public; also called from `lib/app.dart` when a verification link opens the app)* | live (no fixture) |
| MFA challenge | `/mfa` | `auth/presentation/mfa_screen.dart` | `POST /auth/mfa/verify` *(public, with the challenge token)* | live (`login_mfa_required`; verify response = `login`) |
| Forgot password | `/forgot-password` | `auth/presentation/password_screens.dart` (`ForgotPasswordScreen`) | `POST /auth/password/forgot` *(public)* | live (no fixture) |
| Reset password | `/reset-password?token=` | `auth/presentation/password_screens.dart` (`ResetPasswordScreen`) | `POST /auth/password/reset` *(public)* | docs |
| Accept invitation | `/accept-invitation?token=` | `auth/presentation/accept_invitation_screen.dart` | On open: `GET /auth/invitations/preview` *(public)*; `POST /auth/invitations/accept` *(public)* | docs |

After every successful sign-in `AuthController.acceptLogin` may call `GET /public/tenant-config?slug=`
once more (when the session belongs to a centre other than the cached one) and, when push is
configured, `POST /me/devices`.

## Main tabs

| Screen | Route | File | Endpoints | Shape checked |
| --- | --- | --- | --- | --- |
| Home | `/home` | `home/presentation/home_screen.dart` | On open: `GET /catalogue`; `GET /requests?status=AWAITING_CUSTOMER,QUOTED,AWAITING_PAYMENT`; `GET /requests?status=<active statuses>&pageSize=5`; `GET /requests/counts`; `GET /me/notifications?unreadOnly=true&pageSize=1` (bell counter) | live (`catalogue`, `requests_list`, `request_counts`, `notifications`) |
| Request history ("My requests") | `/requests` | `requests/presentation/request_history_screen.dart` | On open and on "load more": `GET /requests?status=&page=&pageSize=` | live (`requests_list`) |
| Quotations & payments | `/payments` | `finance/presentation/payments_screen.dart` | On open: `GET /quotations`; `GET /invoices`; `GET /payments` | live (`quotations_list`, `invoices_list`, `payments_list`) |
| Profile | `/profile` | `profile/presentation/profile_screen.dart` | On open: `GET /me/customer`. Sign out: `DELETE /me/devices` (when a push token was registered), `POST /auth/logout` | live (`me_customer`) |

## Catalogue and new request

| Screen | Route | File | Endpoints | Shape checked |
| --- | --- | --- | --- | --- |
| Catalogue | `/catalogue?category=&renewalOf=` | `catalogue/presentation/catalogue_screen.dart` | On open: `GET /catalogue`; filter / search: `GET /catalogue?categoryKey=&q=`. Signed out (guest): `GET /public/services?slug=&categoryKey=&q=` *(public)* | live (`catalogue`, `public_catalogue`) |
| Service details | `/catalogue/service/:id` | `catalogue/presentation/service_details_screen.dart` | On open: `GET /catalogue/:id` (guest: `GET /public/services/:id?slug=` *(public)*, answer wrapped in `{centre, service}`; the button becomes "Sign in to request"). "Start request": `GET /requests?status=DRAFT&serviceId=` (offer to continue a draft), `POST /requests` | live (`service_detail`, `request_created`) |
| New request wizard (form → documents → review) | `/requests/:id/wizard` | `requests/presentation/request_wizard_screen.dart`, `dynamic_form_field.dart`, `checklist_tile.dart` | On open: `GET /requests/:id`. Each step / "Save draft": `PUT /requests/:id/fields`. Instructions: `PATCH /requests/:id`. Documents step: `GET /documents/checklist-assist?requestId=`, `PUT /requests/:id/checklist/:itemId/document` (reuse a document on file), `POST /documents/:id/preview-link` or `/download-link` (view). Submit: `POST /requests/:id/submit` | live (`request_draft`, `request_submitted`, `checklist_assist`, `error_fields`, `error_form_invalid`, `download_link`) |
| Document upload | `/requests/:id/upload?item=` | `documents/presentation/document_upload_screen.dart`, `documents/application/upload_queue.dart` | On open: `GET /requests/:id`; `GET /document-types` (free uploads). Per file: `POST /documents/upload-intents` → `PUT <signed upload URL>` (bytes, with exactly the headers the API returned) → `POST /documents/:id/versions/:versionId/complete` | live (`upload_intent`, `upload_complete`); `document-types` live (no fixture) |
| Camera capture | `/capture` | `documents/presentation/camera_capture_screen.dart` | none (device camera / gallery through `image_picker`; returns the picture to the upload screen) | – |

## Requests

| Screen | Route | File | Endpoints | Shape checked |
| --- | --- | --- | --- | --- |
| Request details | `/requests/:id` | `requests/presentation/request_details_screen.dart` | On open: `GET /requests/:id`; `GET /documents/checklist-assist?requestId=`. Actions: `POST /requests/:id/comments`; `POST /requests/:id/cancel`; `POST /requests/:id/resubmit`; `PUT /requests/:id/checklist/:itemId/document`; `POST /quotations/:id/approve`; `POST /quotations/:id/reject`; `POST /documents/:id/preview-link` / `download-link`; `POST /me/feedback` (rating after completion) | live (`request_awaiting_customer`, `request_quoted`, `request_completed`, `request_external`, `quotation_approved`, `download_link`); comment / cancel / resubmit / link document / feedback live (no fixture); `preview-link` and quotation reject from docs |
| Status timeline | `/requests/:id/timeline` | `requests/presentation/status_timeline_screen.dart`, `timeline_builder.dart`, `core/widgets/status_timeline.dart` | On open: `GET /requests/:id` (history, workflow steps, `externalStatus` with its `sourceLabel`) | live (`request_external` and the other `request_*` fixtures) |

## Quotations, invoices, payment

| Screen | Route | File | Endpoints | Shape checked |
| --- | --- | --- | --- | --- |
| Quotation | `/quotations/:id` | `finance/presentation/quotation_screen.dart`, `finance_actions.dart` | On open: `GET /quotations/:id`. `POST /quotations/:id/approve`; `POST /quotations/:id/reject` | live (`quotation_detail`, `quotation_approved`); reject from docs |
| Invoice and payment | `/invoices/:id` | `finance/presentation/invoice_screen.dart`, `finance_actions.dart` | On open and when the app returns to the foreground: `GET /invoices/:id`. "Pay now": `POST /invoices/:id/pay`, then the gateway's `checkoutUrl` is opened in the browser. Sandbox gateway only (`gateway: "sandbox"`, `testMode: true`): `POST <checkoutUrl>/complete` or `/fail` from an in-app test dialog | live (`invoice_detail`, `invoice_pay`, `invoice_paid`) |

## Notifications, appointments, support, reminders

| Screen | Route | File | Endpoints | Shape checked |
| --- | --- | --- | --- | --- |
| Notifications | `/notifications` | `notifications/presentation/notifications_screen.dart`, `notifications/application/inbox_controller.dart` | On open / load more: `GET /me/notifications?page=`. `POST /me/notifications/:id/read`; `POST /me/notifications/read-all` | live (`notifications`; read live, no fixture); read-all from docs |
| Appointments | `/appointments` | `appointments/presentation/appointments_screen.dart` | On open: `GET /me/appointments`. `POST /me/appointments/:id/cancel` | live (`appointments_list`); cancel from docs |
| Book / reschedule appointment | `/appointments/book?reschedule=` | `appointments/presentation/book_appointment_screen.dart`, `appointments/application/appointments_providers.dart` | On open: `GET /public/appointments/options?tenant=` *(public, optional)*, `GET /me/appointments`, and - only if both give no branch - `GET /requests` + `GET /appointments/availability` (to learn the branch name); `GET /catalogue` (optional service). Per day: `GET /appointments/availability?branchId=&date=&serviceId=`. `POST /me/appointments`; `POST /me/appointments/:id/reschedule` | live (`availability`, `appointment`, `appointments_list`; reschedule and `public/appointments/options` live, no fixture) |
| Support | `/support` | `support/presentation/support_screen.dart` | On open: `GET /me/tickets` | live (`tickets_list`) |
| New ticket | `/support/new?requestId=` | `support/presentation/new_ticket_screen.dart`, `attachment_picker.dart` | On open: `GET /requests` (to link a request). Attachments: `GET /documents`, or the three upload calls. `POST /me/tickets` | live (`ticket_detail`, `documents_list`) |
| Ticket conversation | `/support/ticket/:id` | `support/presentation/ticket_screen.dart`, `rating_dialog.dart` | On open: `GET /me/tickets/:id`. `POST /me/tickets/:id/messages`; `POST /me/feedback`; attachments as above; `POST /documents/:id/preview-link` / `download-link` | live (`ticket_detail`) |
| Reminders | `/reminders` | `reminders/presentation/reminders_screen.dart` | On open: `GET /me/reminders`. "Renew" opens the catalogue with `renewalOf=<reminder id>`; the request is then created with `POST /requests { renewalOfScheduleId }` | live (`reminders`, `request_created`) |

## Profile and settings

| Screen | Route | File | Endpoints | Shape checked |
| --- | --- | --- | --- | --- |
| Edit profile | `/profile/edit` | `profile/presentation/edit_profile_screen.dart` | On open: `GET /me/customer`. Save: `PATCH /me/customer`; `PATCH /auth/me` (name / language of the account); then `GET /auth/me` | live (`me_customer`) |
| Verify phone | `/profile/verify-phone` | `profile/presentation/verify_phone_screen.dart` | `POST /auth/phone/request-verification`; `POST /auth/phone/verify`; then `GET /auth/me` | live (no fixture) |
| Communication preferences | `/profile/communication` | `profile/presentation/preferences_screens.dart` (`CommunicationScreen`) | On open: `GET /me/customer`. `PATCH /me/customer { communicationPrefs, marketingOptIn }` | live (`me_customer`) |
| Consents | `/profile/consents` | `profile/presentation/preferences_screens.dart` (`ConsentsScreen`) | On open: `GET /me/consents`. `PUT /me/consents` | live (`me_consents`) |
| Settings | `/settings` | `settings/presentation/settings_screen.dart` | Language / theme: none (device). Enable push: `POST /me/devices`. Sign out: `DELETE /me/devices`, `POST /auth/logout` | live (no fixture) |
| Signed-in devices | `/settings/sessions` | `settings/presentation/security_screens.dart` (`SessionsScreen`) | On open: `GET /auth/sessions`. `DELETE /auth/sessions/:id`; `POST /auth/sessions/revoke-others` | live (`sessions`; revoke-others live, no fixture); delete by id from docs |
| Change password | `/settings/change-password` | `settings/presentation/security_screens.dart` (`ChangePasswordScreen`) | `POST /auth/password/change` | live (no fixture) |
| Notification preferences | `/settings/notifications` | `settings/presentation/notification_prefs_screen.dart` | On open: `GET /me/notification-preferences`. `PUT /me/notification-preferences` | live (`notification_prefs_updated`) |
| Privacy and data | `/settings/privacy` | `settings/presentation/privacy_screen.dart` | On open: `GET /privacy/my/requests`. `POST /privacy/my/requests`; export file: `POST /documents/:id/download-link` | live (`privacy_request`) |

## Calls that belong to no single screen

| Where | Endpoint | When |
| --- | --- | --- |
| `core/network/api_client.dart` | `POST /auth/refresh { refreshToken, app: "mobile" }` | Before a request when the access token is missing or about to expire, and after a `401 TOKEN_INVALID`. Single-flight: one call for any number of waiting requests (`test/unit/token_refresh_test.dart`). |
| `features/notifications/application/push_controller.dart` | `POST /me/devices`, `DELETE /me/devices`, `GET /me/notifications?pageSize=30` | Device registration after sign-in / token refresh; removal before sign-out; resolving a tapped push (the payload carries only `notificationId`) to its screen. Only when the build has `FIREBASE_ENABLED=true`. |
| `lib/app.dart` | `POST /auth/verify-email` | A verification link opened the app. |

## Customer-relevant endpoints the app does not use (yet)

| Endpoint | Why not |
| --- | --- |
| `GET /quotations/:id/pdf`, `GET /invoices/:id/pdf`, `GET /payments/:id/receipt/pdf` (PDF downloads) | Need an authenticated binary download and a file viewer / share sheet; not implemented. Amounts and lines are shown on screen. |
| `DELETE /requests/:id/checklist/:itemId/document` | Present in `RequestsRepository.unlinkDocument`, no button uses it. |
| `GET /requests/:id/comments` | Comments arrive inside `GET /requests/:id`; the separate call exists in the repository only. |
| MFA enrolment (`POST /auth/mfa/setup`, `/enable`, `/disable`) | Only the sign-in challenge is implemented. An account with an authenticator can sign in; switching it on or off is not offered in the app. |
| Corporate-account endpoints (`/corporate-accounts/...`, `/corporate/...`) | The app has no company-account screens. A company user can sign in (membership kind `CORPORATE` is accepted) and sees whatever the request, finance and document endpoints above return for that account; this path was not exercised. |
