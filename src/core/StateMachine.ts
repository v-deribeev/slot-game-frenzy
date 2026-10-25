/**
 * Game finite state machine.
 *
 * - States are a TypeScript discriminated union keyed on `type`.
 * - The current state lives inside a `Proxy`-guarded store: every write goes through the
 *   `set` trap, which consults the strict transition map and payload validators. Invalid
 *   writes throw `InvalidTransitionError` and leave the state untouched.
 * - Subscribers are notified (pub/sub) after every successful transition.
 */

export type GameState =
  | { readonly type: 'IDLE' }
  | { readonly type: 'SPINNING'; readonly betAmount: number }
  | { readonly type: 'SHOWING_WIN'; readonly winAmount: number; readonly winningSymbols: string[] }
  | { readonly type: 'ERROR'; readonly errorCode: string };

export type GameStateType = GameState['type'];

/** Narrow helper: `StateOf<'SPINNING'>` -> `{ type: 'SPINNING'; betAmount: number }`. */
export type StateOf<K extends GameStateType> = Extract<GameState, { type: K }>;

/**
 * Strict transition map. Anything not listed is rejected, including self-transitions
 * such as SPINNING -> SPINNING (double spin) or IDLE -> IDLE.
 *
 * SPINNING -> IDLE covers losing spins and slam-stops that skip the win presentation.
 */
export const TRANSITIONS: Readonly<Record<GameStateType, readonly GameStateType[]>> = Object.freeze({
  IDLE: Object.freeze(['SPINNING', 'ERROR'] as const),
  SPINNING: Object.freeze(['SHOWING_WIN', 'IDLE', 'ERROR'] as const),
  SHOWING_WIN: Object.freeze(['IDLE', 'ERROR'] as const),
  ERROR: Object.freeze(['IDLE'] as const),
});

export class InvalidTransitionError extends Error {
  readonly from: GameStateType;
  readonly to: string;
  constructor(from: GameStateType, to: string, reason?: string) {
    super(`Invalid transition ${from} -> ${to}${reason ? `: ${reason}` : ''}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export type StateListener = (next: GameState, previous: GameState) => void;

/** Frozen state constructors (avoid hand-writing object literals at call sites). */
export const GameStates = Object.freeze({
  idle: (): StateOf<'IDLE'> => IDLE_STATE,
  spinning: (betAmount: number): StateOf<'SPINNING'> => Object.freeze({ type: 'SPINNING', betAmount }),
  showingWin: (winAmount: number, winningSymbols: readonly string[]): StateOf<'SHOWING_WIN'> =>
    Object.freeze({ type: 'SHOWING_WIN', winAmount, winningSymbols: Object.freeze([...winningSymbols]) as string[] }),
  error: (errorCode: string): StateOf<'ERROR'> => Object.freeze({ type: 'ERROR', errorCode }),
});

const IDLE_STATE: StateOf<'IDLE'> = Object.freeze({ type: 'IDLE' });

const STATE_TYPES: ReadonlySet<string> = new Set<GameStateType>(['IDLE', 'SPINNING', 'SHOWING_WIN', 'ERROR']);

/** Returns a reason string if the payload is malformed, otherwise `null`. */
function validatePayload(state: GameState): string | null {
  switch (state.type) {
    case 'IDLE':
      return null;
    case 'SPINNING':
      return Number.isFinite(state.betAmount) && state.betAmount > 0 ? null : 'betAmount must be a positive number';
    case 'SHOWING_WIN':
      if (!Number.isFinite(state.winAmount) || state.winAmount < 0) return 'winAmount must be a number >= 0';
      if (!Array.isArray(state.winningSymbols)) return 'winningSymbols must be an array';
      return state.winningSymbols.every((s) => typeof s === 'string') ? null : 'winningSymbols must be strings';
    case 'ERROR':
      return typeof state.errorCode === 'string' && state.errorCode.length > 0
        ? null
        : 'errorCode must be a non-empty string';
  }
}

function freezeState(state: GameState): GameState {
  if (Object.isFrozen(state) && (state.type !== 'SHOWING_WIN' || Object.isFrozen(state.winningSymbols))) {
    return state;
  }
  switch (state.type) {
    case 'IDLE':
      return IDLE_STATE;
    case 'SPINNING':
      return GameStates.spinning(state.betAmount);
    case 'SHOWING_WIN':
      return GameStates.showingWin(state.winAmount, state.winningSymbols);
    case 'ERROR':
      return GameStates.error(state.errorCode);
  }
}

export function isValidTransition(from: GameStateType, to: GameStateType): boolean {
  return TRANSITIONS[from].includes(to);
}

interface StateStore {
  current: GameState;
}

export class StateMachine {
  /** Raw backing object; only `reset()` writes to it directly. */
  private readonly target: StateStore;
  /** Proxy-guarded view of `target`; all normal writes go through its `set` trap. */
  private readonly store: StateStore;
  private readonly listeners = new Set<StateListener>();
  /** Pending notifications, so re-entrant transitions are delivered in order. */
  private readonly queue: Array<readonly [GameState, GameState]> = [];
  private dispatching = false;

  constructor(initial: GameState = IDLE_STATE) {
    const initialReason = STATE_TYPES.has(initial.type) ? validatePayload(initial) : 'unknown state';
    if (initialReason) throw new InvalidTransitionError(initial.type, initial.type, initialReason);

    const target: StateStore = { current: freezeState(initial) };
    this.target = target;
    // The Proxy is the single write gate for the state: every assignment is validated here.
    this.store = new Proxy(target, {
      set(t, prop, value: unknown): boolean {
        if (prop !== 'current') {
          throw new TypeError(`StateMachine store has no writable property "${String(prop)}"`);
        }
        const from = t.current.type;
        if (typeof value !== 'object' || value === null || !STATE_TYPES.has((value as GameState).type)) {
          throw new InvalidTransitionError(from, String((value as { type?: unknown } | null)?.type), 'unknown state');
        }
        const next = value as GameState;
        if (!isValidTransition(from, next.type)) throw new InvalidTransitionError(from, next.type);
        const reason = validatePayload(next);
        if (reason) throw new InvalidTransitionError(from, next.type, reason);
        t.current = freezeState(next);
        return true;
      },
      deleteProperty(): boolean {
        throw new TypeError('StateMachine store properties cannot be deleted');
      },
      defineProperty(): boolean {
        throw new TypeError('StateMachine store properties cannot be redefined');
      },
    });
  }

  /** The current (frozen) state. */
  get state(): GameState {
    return this.store.current;
  }

  /** Type guard: `fsm.is('SPINNING')` narrows `fsm.state`. */
  is<K extends GameStateType>(type: K): this is { readonly state: StateOf<K> } {
    return this.store.current.type === type;
  }

  canTransition(to: GameStateType): boolean {
    return isValidTransition(this.store.current.type, to);
  }

  /**
   * Transitions to `next`, notifying subscribers. Throws `InvalidTransitionError` when the
   * transition map or the payload validators reject it.
   */
  transition(next: GameState): GameState {
    const previous = this.store.current;
    this.store.current = next; // validated by the Proxy `set` trap
    const current = this.store.current;
    this.notify(current, previous);
    return current;
  }

  /** Non-throwing variant of {@link transition}. Returns `true` on success. */
  tryTransition(next: GameState): boolean {
    try {
      this.transition(next);
      return true;
    } catch (err) {
      if (err instanceof InvalidTransitionError) return false;
      throw err;
    }
  }

  /**
   * Hard reset to IDLE, bypassing the transition map (recovery / tests). Notifies subscribers
   * if the state actually changed.
   */
  reset(): void {
    const previous = this.store.current;
    if (previous.type === 'IDLE') return;
    this.target.current = IDLE_STATE; // deliberate bypass of the Proxy guard
    this.notify(IDLE_STATE, previous);
  }

  /** Subscribe to transitions. Returns an unsubscribe function. */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.unsubscribe(listener);
  }

  unsubscribe(listener: StateListener): boolean {
    return this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  private notify(next: GameState, previous: GameState): void {
    this.queue.push([next, previous]);
    if (this.dispatching) return; // drained by the outer dispatch loop, preserving order
    this.dispatching = true;
    try {
      for (let entry = this.queue.shift(); entry; entry = this.queue.shift()) {
        // Snapshot so listeners may (un)subscribe during dispatch without skipping anyone.
        const snapshot = Array.from(this.listeners);
        for (const listener of snapshot) {
          try {
            listener(entry[0], entry[1]);
          } catch (err) {
            // A faulty subscriber must never corrupt the FSM or block other subscribers.
            console.error('[StateMachine] listener threw', err);
          }
        }
      }
    } finally {
      this.dispatching = false;
    }
  }
}
