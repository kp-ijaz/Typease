import { Injectable } from '@nestjs/common';

/**
 * The time SaaS billing believes it is. Everything in the subscriptions module
 * asks this clock instead of `new Date()`, so tests (and a support engineer
 * replaying an incident in a sandbox) can move time: a trial can end, a renewal
 * can fall due and a grace period can run out without waiting.
 */
@Injectable()
export class BillingClock {
  private offsetMs = 0;
  private frozenAt: number | null = null;

  now(): Date {
    return new Date(this.frozenAt ?? Date.now() + this.offsetMs);
  }
  /** Tests only: freeze the clock at an instant. */
  set(instant: Date): void {
    this.frozenAt = instant.getTime();
  }
  /** Tests only: move forward (or back) relative to the current billing time. */
  advance(ms: number): void {
    if (this.frozenAt !== null) this.frozenAt += ms;
    else this.offsetMs += ms;
  }
  advanceDays(days: number): void {
    this.advance(days * 86_400_000);
  }
  reset(): void {
    this.offsetMs = 0;
    this.frozenAt = null;
  }
}
