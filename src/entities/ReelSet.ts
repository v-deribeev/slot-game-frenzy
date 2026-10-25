/**
 * Coordinates the reels of the grid: synchronous start, staggered stop, slam-stop via
 * AbortSignal, and a Promise that resolves once every reel is at rest.
 */

import { Reel, type ReelTimings } from './Reel';

export interface ReelSetTimings extends ReelTimings {
  readonly minSpinMs: number;
  readonly stopStaggerMs: number;
}

interface PendingStop {
  readonly resolve: () => void;
  readonly signal: AbortSignal | null;
  readonly onAbort: () => void;
}

export class ReelSet {
  readonly reels: readonly Reel[];
  readonly rows: number;
  private readonly timings: ReelSetTimings;
  private pending: PendingStop | null = null;
  private spinElapsed = 0;

  constructor(
    strips: readonly (readonly string[])[],
    rows: number,
    timings: ReelSetTimings,
    initialStops: readonly number[] = [],
  ) {
    if (strips.length === 0) throw new RangeError('At least one reel strip is required');
    this.rows = rows;
    this.timings = timings;
    this.reels = Object.freeze(strips.map((strip, i) => new Reel(i, strip, timings, initialStops[i] ?? 0)));
    for (const reel of this.reels) reel.onStopped = this.handleReelStopped;
  }

  get isSpinning(): boolean {
    for (const reel of this.reels) if (reel.isSpinning) return true;
    return false;
  }

  /** True while a `stopAt()` promise is outstanding. */
  get isStopping(): boolean {
    return this.pending !== null;
  }

  get stops(): number[] {
    return this.reels.map((r) => r.stopIndex);
  }

  startSpin(): void {
    this.settle(); // a stale stop request must never leak into a new spin
    this.spinElapsed = 0;
    for (const reel of this.reels) reel.startSpin();
  }

  /**
   * Lands each reel on `stops[i]`, respecting `minSpinMs` and `stopStaggerMs`. If `signal`
   * aborts (or is already aborted) every reel snaps instantly. Always resolves, never rejects.
   */
  stopAt(stops: readonly number[], signal?: AbortSignal): Promise<void> {
    if (stops.length !== this.reels.length) {
      return Promise.reject(new RangeError(`Expected ${this.reels.length} stops, got ${stops.length}`));
    }
    this.settle();
    return new Promise<void>((resolve) => {
      const onAbort = (): void => this.snapTo(stops);
      this.pending = { resolve, signal: signal ?? null, onAbort };

      if (signal?.aborted) {
        this.snapTo(stops);
        this.checkComplete();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      const minRemaining = Math.max(0, this.timings.minSpinMs / 1000 - this.spinElapsed);
      const stagger = this.timings.stopStaggerMs / 1000;
      this.reels.forEach((reel, i) => {
        if (reel.isSpinning) reel.requestStop(stops[i], minRemaining + i * stagger);
        else reel.snapTo(stops[i]);
      });
      this.checkComplete();
    });
  }

  /** Instantly lands all reels (slam-stop). Resolves any pending `stopAt()`. */
  snapTo(stops: readonly number[]): void {
    this.reels.forEach((reel, i) => reel.snapTo(stops[i] ?? reel.stopIndex));
    this.checkComplete();
  }

  /** Stops all reels on the nearest whole symbol (error recovery). */
  halt(): void {
    for (const reel of this.reels) reel.halt();
    this.settle();
  }

  update(dt: number): void {
    if (this.isSpinning) this.spinElapsed += dt;
    for (let i = 0; i < this.reels.length; i++) this.reels[i].update(dt);
  }

  /** Column-major visible grid `grid[reel][row]` (allocates; not for the frame loop). */
  getGrid(): string[][] {
    return this.reels.map((reel) => {
      const column: string[] = [];
      for (let row = 0; row < this.rows; row++) column.push(reel.symbolAt(row));
      return column;
    });
  }

  private readonly handleReelStopped = (): void => {
    this.checkComplete();
  };

  private checkComplete(): void {
    if (this.pending && !this.isSpinning) this.settle();
  }

  private settle(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.signal?.removeEventListener('abort', pending.onAbort);
    pending.resolve();
  }
}
