# Appointments

Module folder: `services/api/src/modules/appointments`. Tables: `appointment_slot_configs`, `branch_closures`,
`appointments`. All paths are under `/api/v1`. Times are stored in UTC; calendars are defined and shown in the
branch time zone (`branches.timezone`, default `Asia/Dubai`).

## Endpoints

### Branch calendar (staff)

| Method | Path | Access | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | `/appointments/slot-configs` | `appointment.read` or `appointment.manage` | `branchId, weekday, includeInactive` | Slot configurations |
| POST | `/appointments/slot-configs` | `appointment.manage` | `{ branchId, serviceId?, weekday (0 = Sunday), startTime, endTime (HH:MM), slotMinutes = 30, capacity = 1, isActive = true }` | Configuration |
| PATCH | `/appointments/slot-configs/:id` | `appointment.manage` | any of `serviceId, weekday, startTime, endTime, slotMinutes, capacity, isActive` | Configuration |
| DELETE | `/appointments/slot-configs/:id` | `appointment.manage` | - | `{ id, deleted }` |
| GET | `/appointments/closures` | `appointment.read` or `appointment.manage` | `branchId, from, to` | `[{ id, branchId, date, reason }]` |
| POST | `/appointments/closures` | `appointment.manage` | `{ branchId, date, reason? }` | Closure + `affectedAppointments` (bookings already on that day) |
| DELETE | `/appointments/closures/:id` | `appointment.manage` | - | `{ id, deleted }` |
| GET | `/appointments/settings` | `appointment.read` or `appointment.manage` | - | Settings |
| PUT | `/appointments/settings` | `appointment.manage` | any of the settings below | Settings |

Settings (stored in `tenant.settings.appointments`, other settings keys are never touched):

```json
{ "guestBookingEnabled": false, "noShowAfterMinutes": 30, "customerCancelCutoffMinutes": 0,
  "reminderHoursBefore": [24, 2], "maxDaysAhead": 60, "limitToStaffOnDuty": false }
```

### Availability and bookings (staff)

| Method | Path | Access | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | `/appointments/availability` | `appointment.read`, `appointment.manage` or `self.appointments` | `branchId, date (YYYY-MM-DD, branch calendar), serviceId?, staffId?` | Slots of the day |
| GET | `/appointments` | `appointment.read` or `appointment.manage` | `page, pageSize, sort (startsAt, createdAt, status), q (name / guest phone), branchId, status, customerId, staffId, serviceId, date (one branch day) or from / to` | Paged appointments |
| POST | `/appointments` | `appointment.manage` | `{ branchId, startsAt (ISO with offset), customerId? or guestName (+ guestPhone?), serviceId?, staffId?, requestId?, notes? }` | Appointment |
| GET | `/appointments/:id` | `appointment.read` or `appointment.manage` | - | Appointment + `queueToken` |
| PATCH | `/appointments/:id` | `appointment.manage` | `{ notes?, staffId?, requestId? }` | Appointment |
| POST | `/appointments/:id/confirm` | `appointment.manage` | - | Appointment |
| POST | `/appointments/:id/check-in` | `appointment.manage` | `{ issueToken = true }` | Appointment + `queueToken { id, tokenNo, status, counter }` |
| POST | `/appointments/:id/start` | `appointment.manage` | - | Appointment |
| POST | `/appointments/:id/complete` | `appointment.manage` | - | Appointment |
| POST | `/appointments/:id/cancel` | `appointment.manage` | `{ reason? }` | Appointment |
| POST | `/appointments/:id/no-show` | `appointment.manage` | - | Appointment |
| POST | `/appointments/:id/reschedule` | `appointment.manage` | `{ startsAt, branchId?, reason? }` | The NEW appointment |

Availability (staff view; customers and the public page get only `startsAt, endsAt, localStart, localEnd,
available, remaining`, and `closedReason` is null):

```json
{
  "branchId": "…", "branchName": "Main Branch", "date": "2026-10-12", "timezone": "Asia/Dubai",
  "serviceId": null, "closed": false, "closedReason": null, "bookableUntil": "2026-12-08",
  "slots": [
    { "startsAt": "2026-10-12T05:00:00.000Z", "endsAt": "2026-10-12T05:30:00.000Z", "localStart": "09:00", "localEnd": "09:30",
      "available": true, "remaining": 2, "capacity": 2, "booked": 0, "staffOnDuty": 1 }
  ]
}
```

Appointment (staff view):

```json
{
  "id": "…", "branchId": "…", "branchName": "Main Branch", "customerId": "…", "customerName": "Fatima Al Mansoori",
  "customerPhone": "+971501234567", "guestName": null, "guestPhone": null, "serviceId": "…", "serviceName": "Emirates ID renewal",
  "requestId": null, "staffId": null, "staffName": null,
  "startsAt": "2026-10-12T06:00:00.000Z", "endsAt": "2026-10-12T06:30:00.000Z",
  "localDate": "2026-10-12", "localTime": "10:00", "localEndTime": "10:30", "timezone": "Asia/Dubai",
  "status": "BOOKED", "source": "STAFF", "notes": "Bring the old card", "cancelledReason": null,
  "rescheduledFromId": null, "rescheduledToId": null, "checkedInAt": null, "reminderSentAt": null,
  "createdAt": "…", "customerNoShowCount": 0
}
```

### Customers (`self.appointments`, own appointments only)

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/me/appointments` | `page, pageSize, upcoming` | Paged own appointments |
| POST | `/me/appointments` | `{ branchId, startsAt, serviceId?, notes? }` | Appointment (customer view) |
| GET | `/me/appointments/:id` | - | Appointment (customer view) |
| POST | `/me/appointments/:id/cancel` | `{ reason? }` | Appointment |
| POST | `/me/appointments/:id/reschedule` | `{ startsAt, branchId? }` | The NEW appointment |

Customer view: `{ id, branchId, branchName, branchNameAr, serviceId, serviceName, serviceNameAr, startsAt, endsAt,
localDate, localTime, localEndTime, timezone, status, cancelledReason, rescheduledFromId, rescheduledToId,
canCancel, canReschedule }`. Staff notes, staff names and other customers are never included.

### Public guest booking (no authentication, rate limited)

The centre is chosen with `tenant=<slug>` (query or body) or by the portal host.

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/public/appointments/options` | `tenant` | `{ guestBookingEnabled, maxDaysAhead, branches[], services[] }` (empty lists while disabled) |
| GET | `/public/appointments/availability` | `tenant, branchId, date, serviceId?` | Reduced availability |
| POST | `/public/appointments` | `{ tenant?, branchId, startsAt, guestName, guestPhone, serviceId?, notes? }` | `{ id, status, branchName, serviceName, startsAt, endsAt, localDate, localTime, manageToken }` |
| POST | `/public/appointments/cancel` | `{ token, reason? }` | `{ id, status: "CANCELLED" }` |

Guest booking answers 403 `GUEST_BOOKING_DISABLED` until the centre sets `guestBookingEnabled`. `manageToken` is a
signed token valid until one day after the appointment; it only allows cancelling that appointment.

## Events and jobs

| Kind | Name | Details |
| --- | --- | --- |
| Emitted | `appointment.created` `{ appointmentId, customerId?, branchId, startsAt }` | Every new booking, including the new appointment of a reschedule. The notifications module sends `appointment.confirmation` (guests get an SMS). |
| Emitted | `appointment.reminder_due` `{ appointmentId, customerId?, branchId, startsAt, hoursBefore }` | By job `appointments.reminders`; notifications sends `appointment.reminder`. |
| Job | `appointments.reminders` (every 15 minutes) | For BOOKED / CONFIRMED appointments entering a reminder window (`reminderHoursBefore`, default 24 h and 2 h). One reminder per window (`reminderSentAt`); no reminder for a window that was already open when the appointment was booked. Payload `{ now? }` for tests. |
| Job | `appointments.no_shows` (every 15 minutes) | BOOKED / CONFIRMED appointments whose start passed `noShowAfterMinutes` ago become NO_SHOW (audited as the system). |

## Business rules

- Slots: a configuration cuts `startTime`-`endTime` into slots of `slotMinutes` (a partial last slot is dropped).
  Several configurations for a weekday are joined (morning and evening shift); overlapping ones add up their
  capacity. A configuration with a `serviceId` is that service's own calendar with its own capacity; services
  without one use the branch's general calendar.
- A booking must start exactly on a slot, in the future, on a day without a closure and within `maxDaysAhead`:
  422 `SLOT_UNAVAILABLE`, `SLOT_IN_PAST`, `BRANCH_CLOSED`, `TOO_FAR_AHEAD`.
- Capacity is enforced inside the booking transaction: the slot configurations of that branch and weekday are
  locked (`FOR UPDATE`), then the places already taken are counted. The loser of a race gets 409 `SLOT_FULL`.
  Places are held by BOOKED, CONFIRMED, CHECKED_IN, IN_SERVICE and COMPLETED appointments.
- One person cannot hold two overlapping appointments (409 `ALREADY_BOOKED`). A guest phone number can have at
  most two upcoming guest bookings (409 `TOO_MANY_BOOKINGS`).
- Staff: `staffId` is optional. The member must be active, marked available, belong to the branch, be on
  schedule for the whole slot (only checked when they have `staff_schedules` rows) and have no overlapping
  appointment, else 409 `STAFF_UNAVAILABLE`. `staffOnDuty` in the availability counts available members whose
  schedule covers the slot. With `limitToStaffOnDuty` a slot's capacity is capped by that number.
- Statuses: `BOOKED -> CONFIRMED -> CHECKED_IN -> IN_SERVICE -> COMPLETED`; `CANCELLED` from BOOKED, CONFIRMED,
  CHECKED_IN; `NO_SHOW` from BOOKED, CONFIRMED, CHECKED_IN (manually only after the start time, 422 `TOO_EARLY`);
  `NO_SHOW -> CHECKED_IN` for a late arrival; `RESCHEDULED` from BOOKED, CONFIRMED. Anything else is 409
  `INVALID_TRANSITION`. COMPLETED, CANCELLED and RESCHEDULED appointments cannot be edited (409 `APPOINTMENT_CLOSED`).
- Check-in is possible on the day of the appointment only (422 `CHECK_IN_WRONG_DAY`) and issues a queue token
  in the same transaction unless `issueToken` is false. Queue actions keep the appointment in step: start
  serving -> IN_SERVICE, complete -> COMPLETED, token no-show -> NO_SHOW. Cancelling an appointment cancels its
  waiting token.
- Reschedule = a new appointment (`rescheduledFromId`) for the same person and service; the old one becomes
  RESCHEDULED and frees its place. A failed reschedule changes nothing.
- Customers can cancel or reschedule only BOOKED / CONFIRMED appointments, never after the start and not within
  `customerCancelCutoffMinutes` of it (409 `TOO_LATE_TO_CHANGE`). `canCancel` / `canReschedule` tell the portal.
- No-show tracking: `customerNoShowCount` on every staff view is the number of earlier NO_SHOW appointments of
  that customer.
- Staff limited to branches see and handle only appointments, calendars and closures of their branches
  (403 `BRANCH_FORBIDDEN`). Rows of another centre are 404.
- Audit actions: `appointment.booked`, `appointment.rescheduled`, `appointment.updated`,
  `appointment.<status>` (confirmed, checked_in, in_service, completed, cancelled, no_show, rescheduled),
  `appointment.slot_config_created | updated | deleted`, `appointment.closure_added | removed`,
  `appointment.settings_updated`.
