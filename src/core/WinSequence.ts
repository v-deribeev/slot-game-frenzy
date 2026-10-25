/**
 * Async win choreography: HIGHLIGHT -> COUNT_UP -> COIN_FOUNTAIN.
 *
 * Each step is a Promise that is advanced by `update(dt)` from the game loop (so timings are
 * frame-rate independent) and can be cut short by a native `AbortSignal`. On abort the
 * sequence immediately snaps the win counter to its final value, releases every pooled
 * particle, clears highlights and *resolves* `{ status: 'aborted' }` -- it never rejects and
 * never leaves a dangling promise.
 */

import type { WinSequenceConfig } from './GameConfig';
import type { GridPosition } from './PayoutEvaluator';
import type { ParticleEmitter } from '../entities/CoinFountain';

export type WinStep = 'HIGHLIGHT' | 'COUNT_UP' | 'COIN_FOUNTAIN';

export interface WinPresentation {
  readonly amount: number;
  readonly positions: readonly GridPosition[];
}

/** View adapter (DOM in the browser, no-op or spy in tests). */
export interface WinSequenceView {
  highlight(positions: readonly GridPosition[]): void;
  clearHighlight(): void;
  setWinAmount(amount: number): void;
  /** Optional hook for step-specific styling. `null` = sequence finished. */
  setStep?(step: WinStep | null): void;
}

export interface WinSequenceResult {
  readonly status: 'completed' | 'aborted';
  readonly finalAmount: number;
  /** Last step that started before completion/abort (null if aborted before starting). */
  readonly lastStep: WinStep | null;
}

export const NULL_WIN_VIEW: WinSequenceView = Object.freeze({
  highlight: () => {},
  clearHighlight: () => {},
  setWinAmount: () => {},
});

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

export class WinSequence {
  private readonly timings: WinSequenceConfig;
  private readonly view: WinSequenceView;
  private readonly emitter: ParticleEmitter;

  private playing = false;
  private step: WinStep | null = null;
  private amount = 0;
  private displayed = 0;
  /** Cancels the in-flight `play()` (used when a new play pre-empts an old one). */
  private cancelCurrent: (() => void) | null = null;
  /** Incremented per play(); a pre-empted run must not touch shared view/emitter state. */
  private generation = 0;

  // Current step promise state, advanced by update(dt).
  private stepResolve: ((completed: boolean) => void) | null = null;
  private stepDuration = 0;
  private stepElapsed = 0;
  private stepTicksCounter = false;

  constructor(timings: WinSequenceConfig, view: WinSequenceView, emitter: ParticleEmitter) {
    this.timings = timings;
    this.view = view;
    this.emitter = emitter;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentStep(): WinStep | null {
    return this.step;
  }

  /** Value currently shown by the counter. */
  get displayedAmount(): number {
    return this.displayed;
  }

  async play(win: WinPresentation, signal?: AbortSignal): Promise<WinSequenceResult> {
    this.cancelCurrent?.(); // pre-empt any previous sequence; it resolves as aborted
    const generation = ++this.generation;
    const amount = Math.max(0, win.amount);
    this.amount = amount;
    this.playing = true;
    this.step = null;
    this.setDisplayed(0);

    let aborted = false;
    let lastStep: WinStep | null = null;
    const abort = (): void => {
      aborted = true;
      this.finishStep(false);
    };
    this.cancelCurrent = abort;
    if (signal?.aborted) aborted = true;
    else signal?.addEventListener('abort', abort, { once: true });

    try {
      if (!aborted) {
        lastStep = this.enter('HIGHLIGHT');
        this.view.highlight(win.positions);
        aborted = !(await this.runStep(this.timings.highlightMs, false)) || aborted;
      }
      if (!aborted) {
        lastStep = this.enter('COUNT_UP');
        aborted = !(await this.runStep(this.timings.countUpMs, true)) || aborted;
        if (!aborted) this.setDisplayed(amount);
      }
      if (!aborted) {
        lastStep = this.enter('COIN_FOUNTAIN');
        this.emitter.startEmitting(this.timings.coinsPerSecond);
        aborted = !(await this.runStep(this.timings.fountainMs, false)) || aborted;
        this.emitter.stopEmitting();
        if (!aborted) aborted = !(await this.runStep(this.timings.settleMs, false)) || aborted;
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.cancelCurrent === abort) this.cancelCurrent = null;
    }

    if (generation !== this.generation) {
      // Pre-empted by a newer play(): it now owns the counter, highlights and particles.
      return { status: 'aborted', finalAmount: amount, lastStep };
    }
    // Final state is identical for completed and aborted runs: counter snapped, pool empty.
    this.setDisplayed(amount);
    this.emitter.releaseAll();
    this.view.clearHighlight();
    this.view.setStep?.(null);
    this.step = null;
    this.playing = false;
    return { status: aborted ? 'aborted' : 'completed', finalAmount: amount, lastStep };
  }

  /** Aborts the current sequence without needing the caller's AbortController. */
  skip(): void {
    this.cancelCurrent?.();
  }

  /** Advance the active step by `dt` seconds. Allocation-free. */
  update(dt: number): void {
    if (!this.stepResolve || !(dt > 0)) return;
    this.stepElapsed += dt;
    const progress = this.stepDuration > 0 ? Math.min(1, this.stepElapsed / this.stepDuration) : 1;
    if (this.stepTicksCounter) this.setDisplayed(Math.round(this.amount * easeOutQuad(progress) * 100) / 100);
    if (progress >= 1) this.finishStep(true);
  }

  private enter(step: WinStep): WinStep {
    this.step = step;
    this.view.setStep?.(step);
    return step;
  }

  /** Resolves `true` when the step runs to completion, `false` if it was aborted. */
  private runStep(durationMs: number, ticksCounter: boolean): Promise<boolean> {
    this.finishStep(false); // defensive: never orphan a previous step promise
    if (durationMs <= 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      this.stepResolve = resolve;
      this.stepDuration = durationMs / 1000;
      this.stepElapsed = 0;
      this.stepTicksCounter = ticksCounter;
    });
  }

  private finishStep(completed: boolean): void {
    const resolve = this.stepResolve;
    if (!resolve) return;
    this.stepResolve = null;
    this.stepTicksCounter = false;
    resolve(completed);
  }

  private setDisplayed(value: number): void {
    if (value === this.displayed) return;
    this.displayed = value;
    this.view.setWinAmount(value);
  }
}
