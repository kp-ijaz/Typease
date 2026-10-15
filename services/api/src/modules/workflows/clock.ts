import { Injectable } from '@nestjs/common';

/**
 * The time source of the workflow engine (step deadlines, escalation, target
 * dates). Injectable so tests can move time forward instead of sleeping.
 */
@Injectable()
export class Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  /** Tests only: shift the clock by a number of hours (negative values move it back). */
  travelHours(hours: number): void {
    this.offsetMs += hours * 3_600_000;
  }
  /** Tests only: back to real time. */
  reset(): void {
    this.offsetMs = 0;
  }
}
