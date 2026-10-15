import { z } from 'zod';
import { hhmm, isoDate, isoDateTime, optionalText, pageQuery, phone, queryBool, trimmed, uuid } from './common';

// ====================================================================== appointments
export const appointmentStatus = z.enum(['BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED']);

/** Bookable hours of a branch on one weekday (optionally for one service only). */
export const slotConfigSchema = z
  .object({
    branchId: uuid,
    /** Leave empty for the branch's general calendar. */
    serviceId: uuid.nullish(),
    /** 0 = Sunday ... 6 = Saturday */
    weekday: z.number().int().min(0).max(6),
    startTime: hhmm,
    endTime: hhmm,
    slotMinutes: z.number().int().min(5).max(480).default(30),
    /** How many people can be booked into the same slot. */
    capacity: z.number().int().min(1).max(200).default(1),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.startTime < v.endTime, { message: 'The end time must be after the start time', path: ['endTime'] });
export type SlotConfigInput = z.infer<typeof slotConfigSchema>;
export const updateSlotConfigSchema = z.object({
  serviceId: uuid.nullish(),
  weekday: z.number().int().min(0).max(6).optional(),
  startTime: hhmm.optional(),
  endTime: hhmm.optional(),
  slotMinutes: z.number().int().min(5).max(480).optional(),
  capacity: z.number().int().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateSlotConfigInput = z.infer<typeof updateSlotConfigSchema>;
export const slotConfigQuery = z.object({ branchId: uuid.optional(), weekday: z.coerce.number().int().min(0).max(6).optional(), includeInactive: queryBool });

export const closureSchema = z.object({ branchId: uuid, date: isoDate, reason: optionalText(200) });
export type ClosureInput = z.infer<typeof closureSchema>;
export const closureQuery = z.object({ branchId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional() });

export const appointmentSettingsSchema = z.object({
  /** Let people without an account book through the public page (name + phone). */
  guestBookingEnabled: z.boolean().optional(),
  /** Minutes after the start time at which an appointment nobody checked in for becomes a no-show. */
  noShowAfterMinutes: z.number().int().min(5).max(1440).optional(),
  /** Customers may cancel or reschedule until this many minutes before the start. */
  customerCancelCutoffMinutes: z.number().int().min(0).max(10080).optional(),
  /** Hours before the start at which a reminder is sent. */
  reminderHoursBefore: z.array(z.number().int().min(1).max(168)).max(4).optional(),
  /** How far ahead appointments can be booked. */
  maxDaysAhead: z.number().int().min(1).max(365).optional(),
  /** Limit each slot to the number of staff members scheduled at the branch at that time. */
  limitToStaffOnDuty: z.boolean().optional(),
});
export type AppointmentSettingsInput = z.infer<typeof appointmentSettingsSchema>;

export const availabilityQuery = z.object({ branchId: uuid, date: isoDate, serviceId: uuid.optional(), staffId: uuid.optional() });
export type AvailabilityQuery = z.infer<typeof availabilityQuery>;
export const publicAvailabilityQuery = availabilityQuery.omit({ staffId: true }).extend({ tenant: z.string().trim().max(60).optional() });

const bookingBase = {
  branchId: uuid,
  serviceId: uuid.nullish(),
  /** Start of the slot, ISO 8601 with offset (as returned by the availability endpoint). */
  startsAt: isoDateTime,
  notes: optionalText(500),
};
/** Staff books for a customer, or for a guest (name + phone). */
export const createAppointmentSchema = z
  .object({
    ...bookingBase,
    customerId: uuid.nullish(),
    guestName: optionalText(120),
    guestPhone: phone.nullish(),
    requestId: uuid.nullish(),
    staffId: uuid.nullish(),
  })
  .refine((v) => !!v.customerId || !!v.guestName, { message: 'Choose a customer or enter the visitor\'s name', path: ['customerId'] });
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
/** A customer books for themselves. */
export const selfAppointmentSchema = z.object(bookingBase);
export type SelfAppointmentInput = z.infer<typeof selfAppointmentSchema>;
/** Public guest booking (no account). */
export const guestAppointmentSchema = z.object({ ...bookingBase, tenant: z.string().trim().max(60).optional(), guestName: trimmed(120, 2), guestPhone: phone });
export type GuestAppointmentInput = z.infer<typeof guestAppointmentSchema>;
export const guestCancelSchema = z.object({ token: z.string().min(20).max(2000), reason: optionalText(300) });

export const updateAppointmentSchema = z.object({ notes: optionalText(500), staffId: uuid.nullish(), requestId: uuid.nullish() });
export type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>;
export const rescheduleAppointmentSchema = z.object({ startsAt: isoDateTime, branchId: uuid.optional(), reason: optionalText(300) });
export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentSchema>;
export const cancelAppointmentSchema = z.object({ reason: optionalText(300) });
export const checkInSchema = z.object({ issueToken: z.boolean().default(true) });

export const appointmentListQuery = pageQuery.extend({
  branchId: uuid.optional(),
  status: appointmentStatus.optional(),
  customerId: uuid.optional(),
  staffId: uuid.optional(),
  serviceId: uuid.optional(),
  /** One day in the branch calendar ... */
  date: isoDate.optional(),
  /** ... or a range (UTC days). */
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type AppointmentListQuery = z.infer<typeof appointmentListQuery>;
export const myAppointmentsQuery = pageQuery.extend({ upcoming: queryBool });
export type MyAppointmentsQuery = z.infer<typeof myAppointmentsQuery>;

// ====================================================================== walk-in queue
export const queueStatus = z.enum(['WAITING', 'CALLED', 'SERVING', 'COMPLETED', 'NO_SHOW', 'CANCELLED']);
const counter = z.string().trim().min(1).max(20);

export const issueTokenSchema = z.object({
  branchId: uuid,
  /** Service category (decides the token prefix letter). A service id may be given instead. */
  categoryId: uuid.nullish(),
  serviceId: uuid.nullish(),
  customerId: uuid.nullish(),
  /** A checked-in appointment this token belongs to. */
  appointmentId: uuid.nullish(),
});
export type IssueTokenInput = z.infer<typeof issueTokenSchema>;
export const callNextSchema = z.object({ branchId: uuid, counter, categoryId: uuid.nullish() });
export type CallNextInput = z.infer<typeof callNextSchema>;
export const recallTokenSchema = z.object({ counter: counter.optional() });
export const queueListQuery = z.object({ branchId: uuid, date: isoDate.optional(), status: queueStatus.optional(), categoryId: uuid.optional() });
export type QueueListQuery = z.infer<typeof queueListQuery>;
export const queueBranchQuery = z.object({ branchId: uuid });
export const queueStatsQuery = z.object({ branchId: uuid, from: isoDate.optional(), to: isoDate.optional() });
export type QueueStatsQuery = z.infer<typeof queueStatsQuery>;
export const displayTokenSchema = z.object({ branchId: uuid, validDays: z.number().int().min(1).max(365).default(90) });
export type DisplayTokenInput = z.infer<typeof displayTokenSchema>;
export const displayQuery = z.object({ token: z.string().min(20).max(2000) });

// ====================================================================== tasks
export const taskStatus = z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']);
export const taskPriority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export const taskType = z.enum(['GENERAL', 'FOLLOW_UP', 'DOCUMENT_REVIEW', 'APPROVAL', 'ESCALATION', 'WORKFLOW_STEP']);
const roleKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,40}$/);

export const createTaskSchema = z.object({
  title: trimmed(200, 2),
  description: optionalText(2000),
  type: taskType.default('GENERAL'),
  priority: taskPriority.default('NORMAL'),
  branchId: uuid.nullish(),
  requestId: uuid.nullish(),
  customerId: uuid.nullish(),
  dueAt: isoDateTime.nullish(),
  /** Staff members (membership ids) the task is assigned to. */
  assigneeIds: z.array(uuid).max(20).default([]),
  /** Role queue: members holding this role see the task and can claim it while nobody is assigned. */
  roleKey: roleKey.nullish(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export const updateTaskSchema = z.object({
  title: trimmed(200, 2).optional(),
  description: optionalText(2000),
  type: taskType.optional(),
  priority: taskPriority.optional(),
  dueAt: isoDateTime.nullish(),
  roleKey: roleKey.nullish(),
});
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export const assignTaskSchema = z.object({ assigneeIds: z.array(uuid).max(20), reason: optionalText(300) });
export type AssignTaskInput = z.infer<typeof assignTaskSchema>;
export const taskStatusSchema = z.object({ status: taskStatus, reason: optionalText(300) });
export type TaskStatusInput = z.infer<typeof taskStatusSchema>;
export const taskListQuery = pageQuery.extend({
  status: taskStatus.optional(),
  /** OPEN + IN_PROGRESS when true. */
  open: queryBool,
  overdue: queryBool,
  assigneeId: uuid.optional(),
  unassigned: queryBool,
  requestId: uuid.optional(),
  customerId: uuid.optional(),
  type: taskType.optional(),
  roleKey: roleKey.optional(),
  priority: taskPriority.optional(),
  branchId: uuid.optional(),
  source: z.enum(['MANUAL', 'WORKFLOW', 'AUTOMATION', 'ESCALATION']).optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuery>;
