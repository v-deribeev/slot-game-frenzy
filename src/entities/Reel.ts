/**
 * DOM-free reel simulation.
 *
 * `position` is measured in symbols: the top visible row shows
 * `strip[floor(position) mod length]`, row r shows `strip[(floor(position) + r) mod length]`,
 * and the fractional part is the sub-symbol scroll offset. Spinning *decreases* position so
 * symbols travel downwards on screen.
 *
 * All motion is `speed * dt` (spinning) or elapsed-time-based easing (landing), so the
 * result is frame-rate independent. `update()` allocates nothing.
 *
 * Landing never exceeds `spinSpeed`: the eased tween always covers exactly the distance whose
 * initial slope equals the spin speed, and the reel keeps spinning (up to one strip length)
 * until its target is exactly that far away. Residual frame time is carried into the tween.
 */

export type ReelPhase = 'IDLE' | 'SPINNING' | 'STOPPING';

export interface ReelTimings {
  /** Symbols per second. */
  readonly spinSpeed: number;
  readonly stopDurationMs: number;
  /** easeOutBack overshoot; 0 = plain cubic ease-out. */
  readonly stopOvershoot: number;
}

export function mod(value: number, length: number): number {
  return ((value % length) + length) % length;
}

/** easeOutBack; with s = 0 it degenerates to easeOutCubic. */
export function easeOutBack(t: number, s: number): number {
  const u = t - 1;
  return 1 + (s + 1) * u * u * u + s * u * u;
}

/** d/dt easeOutBack at t = 0, used to match landing speed to spin speed. */
function easeOutBackInitialSlope(s: number): number {
  return 3 * (s + 1) - 2 * s;
}

export class Reel {
  readonly index: number;
  readonly strip: readonly string[];
  private readonly timings: ReelTimings;

  position: number;
  phase: ReelPhase = 'IDLE';
  /** Seconds since the current spin started. */
  spinTime = 0;
  /** Invoked (synchronously) whenever the reel comes to rest. */
  onStopped: ((reel: Reel) => void) | null = null;

  private pendingStop = -1;
  private stopDelay = 0;
  private tweenFrom = 0;
  private tweenTo = 0;
  private tweenElapsed = 0;
  private finalStop = 0;

  constructor(index: number, strip: readonly string[], timings: ReelTimings, initialStop = 0) {
    if (strip.length === 0) throw new RangeError('Reel strip must not be empty');
    this.index = index;
    this.strip = strip;
    this.timings = timings;
    this.position = mod(Math.round(initialStop), strip.length);
    this.finalStop = this.position;
  }

  get length(): number {
    return this.strip.length;
  }

  get isSpinning(): boolean {
    return this.phase !== 'IDLE';
  }

  /** Strip index currently at the top row (only meaningful when IDLE). */
  get stopIndex(): number {
    return this.phase === 'IDLE' ? this.finalStop : mod(Math.floor(this.position), this.strip.length);
  }

  /** True once a stop target has been requested for the current spin. */
  get hasPendingStop(): boolean {
    return this.pendingStop >= 0 || this.phase === 'STOPPING';
  }

  startSpin(): void {
    if (this.phase !== 'IDLE') return;
    this.phase = 'SPINNING';
    this.spinTime = 0;
    this.pendingStop = -1;
    this.stopDelay = 0;
  }

  /** Symbols travelled by the landing tween; chosen so it starts at exactly `spinSpeed`. */
  get landingDistance(): number {
    const { spinSpeed, stopDurationMs, stopOvershoot } = this.timings;
    return (spinSpeed * (stopDurationMs / 1000)) / easeOutBackInitialSlope(stopOvershoot);
  }

  /**
   * Schedules a decelerating stop at `stop`, spinning for at least `delaySeconds` more and then
   * until the target is exactly `landingDistance` away (at most one extra strip length).
   * Returns the seconds from now until the landing tween begins (0 if not spinning).
   */
  requestStop(stop: number, delaySeconds = 0): number {
    const target = this.normalizeStop(stop);
    if (this.phase === 'IDLE') {
      this.snapTo(target);
      return 0;
    }
    if (this.phase === 'STOPPING') return 0; // already landing
    const { spinSpeed } = this.timings;
    const len = this.strip.length;
    const delay = Math.max(0, delaySeconds);
    const positionAtDelay = this.position - spinSpeed * delay;
    let gap = mod(positionAtDelay - target - this.landingDistance, len);
    if (len - gap < 1e-9) gap = 0; // float noise: already aligned, don't add a revolution
    this.pendingStop = target;
    this.stopDelay = delay + gap / spinSpeed;
    return this.stopDelay;
  }

  /** Instantly lands on `stop` (slam-stop). Fires `onStopped` if the reel was moving. */
  snapTo(stop: number): void {
    const target = this.normalizeStop(stop);
    const wasMoving = this.phase !== 'IDLE';
    this.finish(target);
    if (wasMoving) this.onStopped?.(this);
  }

  /** Stops on the nearest whole symbol (e.g. after a server error). */
  halt(): void {
    this.snapTo(Math.round(this.position));
  }

  update(dt: number): void {
    if (this.phase === 'IDLE' || !(dt > 0)) return;

    if (this.phase === 'SPINNING') {
      const landing = this.pendingStop >= 0 && this.stopDelay <= dt;
      const spun = landing ? Math.max(0, this.stopDelay) : dt;
      this.spinTime += spun;
      this.position = mod(this.position - this.timings.spinSpeed * spun, this.strip.length);
      if (!landing) {
        if (this.pendingStop >= 0) this.stopDelay -= dt;
        return;
      }
      this.beginLanding();
      dt -= spun; // residual frame time advances the tween (frame-rate independence)
      if (!(dt > 0)) return;
    }

    // STOPPING: time-based easing toward the target.
    this.spinTime += dt;
    this.tweenElapsed += dt;
    const duration = this.timings.stopDurationMs / 1000;
    const t = duration > 0 ? Math.min(1, this.tweenElapsed / duration) : 1;
    if (t >= 1) {
      this.finish(this.finalStop);
      this.onStopped?.(this);
      return;
    }
    this.position = this.tweenFrom + (this.tweenTo - this.tweenFrom) * easeOutBack(t, this.timings.stopOvershoot);
  }

  /** Symbol id at a visible row for the current (integer) position. */
  symbolAt(row: number): string {
    return this.strip[mod(Math.floor(this.position) + row, this.strip.length)];
  }

  private beginLanding(): void {
    // requestStop() timed this so the target is `landingDistance` ahead; snap out float noise.
    const len = this.strip.length;
    const k = Math.round((this.position - this.landingDistance - this.pendingStop) / len);
    this.tweenFrom = this.position;
    this.tweenTo = this.pendingStop + k * len;
    this.tweenElapsed = 0;
    this.finalStop = this.pendingStop;
    this.pendingStop = -1;
    this.phase = 'STOPPING';
  }

  private finish(stop: number): void {
    this.phase = 'IDLE';
    this.position = stop;
    this.finalStop = stop;
    this.pendingStop = -1;
    this.stopDelay = 0;
    this.tweenElapsed = 0;
  }

  private normalizeStop(stop: number): number {
    if (!Number.isFinite(stop)) throw new RangeError(`Invalid reel stop ${stop}`);
    return mod(Math.round(stop), this.strip.length);
  }
}
