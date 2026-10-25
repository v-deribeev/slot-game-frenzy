/**
 * DOM-free game orchestrator: balance/bet bookkeeping, the spin pipeline and slam-stop.
 *
 * Pipeline (one AbortController per spin):
 *   IDLE --spin()--> SPINNING --(server result, reels landed)--> SHOWING_WIN --> IDLE
 *                              \--(no win | slam-stop)----------------------> IDLE
 *                              \--(server error)--> ERROR --acknowledgeError()--> IDLE
 *
 * `slamStop()` (Spacebar) aborts the spin's controller: reels snap to the result, the win
 * sequence snaps its counter and releases particles, and the FSM returns to IDLE as soon as
 * the outcome is known (immediately if the server already answered).
 */

import type { GameConfig } from './GameConfig';
import { GameStates, StateMachine, type GameState } from './StateMachine';
import type { SpinResponse, SpinServer } from './legacy-rng.js';
import { winningPositions } from './PayoutEvaluator';
import type { WinSequence, WinSequenceResult } from './WinSequence';
import type { ReelSet } from '../entities/ReelSet';

export const GAME_ERROR_CODES = Object.freeze({
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  SERVER_ERROR: 'SERVER_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

export interface SlotGameHooks {
  onBalanceChange?(balance: number): void;
  onBetChange?(bet: number, betIndex: number): void;
  /** Direct writes to the win counter (reset on spin, snap on slam-stop / no-win). */
  onWinAmount?(amount: number): void;
  onSpinResult?(response: SpinResponse): void;
  onError?(errorCode: string): void;
}

export interface SlotGameOptions {
  readonly config: GameConfig;
  readonly server: SpinServer;
  readonly reels: ReelSet;
  readonly winSequence: WinSequence;
  readonly fsm?: StateMachine;
  readonly hooks?: SlotGameHooks;
}

export type SpinOutcome =
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'error'; readonly errorCode: string }
  | {
      readonly status: 'completed' | 'slammed';
      readonly response: SpinResponse;
      readonly win: number;
      readonly sequence: WinSequenceResult | null;
    };

export type PrimaryAction = 'SPIN' | 'SLAM_STOP' | 'ACKNOWLEDGE_ERROR' | 'NONE';

function errorCodeOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return GAME_ERROR_CODES.SERVER_ERROR;
}

export class SlotGame {
  readonly fsm: StateMachine;
  private readonly config: GameConfig;
  private readonly server: SpinServer;
  private readonly reels: ReelSet;
  private readonly winSequence: WinSequence;
  private readonly hooks: SlotGameHooks;

  private balanceValue: number;
  private betIdx: number;
  private controller: AbortController | null = null;
  private inFlight: Promise<SpinOutcome> | null = null;
  private last: SpinResponse | null = null;

  constructor(options: SlotGameOptions) {
    this.config = options.config;
    this.server = options.server;
    this.reels = options.reels;
    this.winSequence = options.winSequence;
    this.fsm = options.fsm ?? new StateMachine();
    this.hooks = options.hooks ?? {};
    this.balanceValue = options.config.startingBalance;
    this.betIdx = options.config.bet.defaultIndex;
  }

  get state(): GameState {
    return this.fsm.state;
  }

  get balance(): number {
    return this.balanceValue;
  }

  get bet(): number {
    return this.config.bet.levels[this.betIdx];
  }

  get betIndex(): number {
    return this.betIdx;
  }

  get lastResult(): SpinResponse | null {
    return this.last;
  }

  /** True while a spin pipeline is running (including its win presentation). */
  get isBusy(): boolean {
    return this.inFlight !== null;
  }

  /** Promise of the running spin pipeline, if any (handy for tests). */
  get currentSpin(): Promise<SpinOutcome> | null {
    return this.inFlight;
  }

  setBetIndex(index: number): boolean {
    const levels = this.config.bet.levels;
    if (!Number.isInteger(index) || index < 0 || index >= levels.length) return false;
    if (this.fsm.state.type !== 'IDLE' || this.isBusy) return false;
    if (index === this.betIdx) return true;
    this.betIdx = index;
    this.hooks.onBetChange?.(this.bet, index);
    return true;
  }

  changeBet(delta: number): boolean {
    return this.setBetIndex(this.betIdx + delta);
  }

  /** What the Spacebar / main button does in the current state. */
  get primaryAction(): PrimaryAction {
    switch (this.fsm.state.type) {
      case 'IDLE':
        return this.isBusy ? 'NONE' : 'SPIN';
      case 'SPINNING':
      case 'SHOWING_WIN':
        return this.controller && !this.controller.signal.aborted ? 'SLAM_STOP' : 'NONE';
      case 'ERROR':
        return 'ACKNOWLEDGE_ERROR';
    }
  }

  /** Performs the primary action (Spacebar). Returns the action taken. */
  handlePrimaryAction(): PrimaryAction {
    const action = this.primaryAction;
    switch (action) {
      case 'SPIN':
        void this.spin();
        break;
      case 'SLAM_STOP':
        this.slamStop();
        break;
      case 'ACKNOWLEDGE_ERROR':
        this.acknowledgeError();
        break;
      case 'NONE':
        break;
    }
    return action;
  }

  /** Starts a spin. Never rejects; re-entrant calls while busy resolve `{ status: 'rejected' }`. */
  spin(): Promise<SpinOutcome> {
    if (this.inFlight || this.fsm.state.type !== 'IDLE') {
      return Promise.resolve({ status: 'rejected', reason: `cannot spin in state ${this.fsm.state.type}` });
    }
    const bet = this.bet;
    if (bet > this.balanceValue) {
      this.fail(GAME_ERROR_CODES.INSUFFICIENT_FUNDS);
      return Promise.resolve({ status: 'error', errorCode: GAME_ERROR_CODES.INSUFFICIENT_FUNDS });
    }
    const controller = new AbortController();
    this.controller = controller;
    const run = this.runSpin(bet, controller).finally(() => {
      if (this.inFlight === run) this.inFlight = null;
      if (this.controller === controller) this.controller = null;
    });
    this.inFlight = run;
    return run;
  }

  /** Spacebar during SPINNING / SHOWING_WIN. Returns true if an abort was triggered. */
  slamStop(): boolean {
    const type = this.fsm.state.type;
    if (type !== 'SPINNING' && type !== 'SHOWING_WIN') return false;
    const controller = this.controller;
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  acknowledgeError(): boolean {
    if (this.fsm.state.type !== 'ERROR') return false;
    return this.fsm.tryTransition(GameStates.idle());
  }

  /** Aborts any running spin and detaches nothing else (owner disposes loop/DOM). */
  dispose(): void {
    this.controller?.abort();
  }

  private async runSpin(bet: number, controller: AbortController): Promise<SpinOutcome> {
    const { signal } = controller;
    this.setBalance(this.balanceValue - bet);
    this.hooks.onWinAmount?.(0);

    if (!this.fsm.tryTransition(GameStates.spinning(bet))) {
      this.setBalance(this.balanceValue + bet);
      return { status: 'rejected', reason: 'state machine rejected SPINNING' };
    }
    this.reels.startSpin();

    let response: SpinResponse;
    try {
      response = await this.server.spin(bet);
    } catch (err) {
      this.reels.halt();
      this.setBalance(this.balanceValue + bet); // refund: the round never happened
      const code = errorCodeOf(err);
      this.fail(code);
      return { status: 'error', errorCode: code };
    }

    try {
      this.last = response;
      this.hooks.onSpinResult?.(response);
      await this.reels.stopAt(response.stops, signal);

      const win = response.win.totalWin;
      if (win > 0) this.setBalance(this.balanceValue + win);

      if (win <= 0 || signal.aborted) {
        this.hooks.onWinAmount?.(win);
        this.toIdle();
        return { status: signal.aborted ? 'slammed' : 'completed', response, win, sequence: null };
      }

      if (!this.fsm.tryTransition(GameStates.showingWin(win, response.win.winningSymbols))) {
        // Malformed win payload rejected by the FSM: skip the presentation but never stay
        // stuck in SPINNING (QA finding F-01: soft-lock).
        this.hooks.onWinAmount?.(win);
        this.toIdle();
        return { status: 'slammed', response, win, sequence: null };
      }
      const sequence = await this.winSequence.play({ amount: win, positions: winningPositions(response.win) }, signal);
      this.toIdle();
      return { status: sequence.status === 'aborted' ? 'slammed' : 'completed', response, win, sequence };
    } catch (err) {
      console.error('[SlotGame] spin pipeline failed', err);
      this.reels.halt();
      this.fail(GAME_ERROR_CODES.INTERNAL_ERROR);
      return { status: 'error', errorCode: GAME_ERROR_CODES.INTERNAL_ERROR };
    }
  }

  private toIdle(): void {
    // Release the busy flag *before* notifying IDLE so subscribers (e.g. autoplay) can spin.
    this.inFlight = null;
    this.controller = null;
    const type = this.fsm.state.type;
    if (type === 'SPINNING' || type === 'SHOWING_WIN') this.fsm.tryTransition(GameStates.idle());
  }

  private fail(code: string): void {
    // Same contract as toIdle(): release the busy flag *before* notifying ERROR, so a
    // subscriber can acknowledge and re-spin synchronously (QA finding F-05).
    this.inFlight = null;
    this.controller = null;
    this.hooks.onError?.(code);
    if (!this.fsm.tryTransition(GameStates.error(code))) {
      // Defensive: unknown state combination -- force a recoverable state.
      this.fsm.reset();
      this.fsm.tryTransition(GameStates.error(code));
    }
  }

  private setBalance(value: number): void {
    this.balanceValue = Math.round(value * 100) / 100;
    this.hooks.onBalanceChange?.(this.balanceValue);
  }
}
