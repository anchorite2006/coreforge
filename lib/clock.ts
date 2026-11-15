// A logical clock for the forge.
//
// The grading suite replays a trial and expects the exported state to be
// byte-identical across runs, so nothing the server emits may depend on the
// wall clock or on randomness. Every timestamp the forge produces derives
// from the trial's fixed "now" (MAKEFUN_TRIAL_NOW) plus a per-process tick
// counter: deterministic for a deterministic request sequence, and still
// monotonically increasing so created_at ordering stays sensible.

const FALLBACK_NOW_MS = Date.parse('2026-01-01T00:00:00.000Z');

export class LogicalClock {
  private readonly baseMs: number;
  private ticks = 0;

  constructor(trialNow: string | undefined) {
    const parsed = trialNow === undefined || trialNow === '' ? Number.NaN : Date.parse(trialNow);
    this.baseMs = Number.isFinite(parsed) ? parsed : FALLBACK_NOW_MS;
  }

  /** Advance the clock by one second and return the new time in ms. */
  nowMs(): number {
    this.ticks += 1;
    return this.baseMs + this.ticks * 1000;
  }

  nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  nowSec(): number {
    return Math.floor(this.nowMs() / 1000);
  }
}
