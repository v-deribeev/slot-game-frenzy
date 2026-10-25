import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GameStates,
  InvalidTransitionError,
  StateMachine,
  TRANSITIONS,
  isValidTransition,
  type GameState,
  type GameStateType,
} from '../src/core/StateMachine';
import { ObjectPool } from '../src/core/ObjectPool';
import { WinSequence, type WinSequenceView } from '../src/core/WinSequence';
import { CoinFountain } from '../src/entities/CoinFountain';
import { SpinServerError } from '../src/core/legacy-rng.js';
import type { SpinOutcome } from '../src/core/SlotGame';
import {
  FRAME_30,
  FRAME_60,
  config,
  findStops,
  flushMicrotasks,
  headless,
  manualServer,
  responseFor,
  runUntil,
  scriptedServer,
  step,
  testRng,
  trackAbortListeners,
} from './helpers';

const ALL_TYPES: GameStateType[] = ['IDLE', 'SPINNING', 'SHOWING_WIN', 'ERROR'];

function sample(type: GameStateType): GameState {
  switch (type) {
    case 'IDLE':
      return GameStates.idle();
    case 'SPINNING':
      return GameStates.spinning(10);
    case 'SHOWING_WIN':
      return GameStates.showingWin(20, ['SEVEN']);
    case 'ERROR':
      return GameStates.error('E');
  }
}

/** Puts a fresh FSM into `type` via valid transitions. */
function fsmIn(type: GameStateType): StateMachine {
  const fsm = new StateMachine();
  if (type === 'SPINNING') fsm.transition(sample('SPINNING'));
  if (type === 'SHOWING_WIN') {
    fsm.transition(sample('SPINNING'));
    fsm.transition(sample('SHOWING_WIN'));
  }
  if (type === 'ERROR') fsm.transition(sample('ERROR'));
  return fsm;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------
// FSM
// ---------------------------------------------------------------------------------------

describe('StateMachine: transitions', () => {
  it('starts in IDLE', () => {
    expect(new StateMachine().state).toEqual({ type: 'IDLE' });
  });

  it('runs the happy path IDLE -> SPINNING -> SHOWING_WIN -> IDLE with payloads', () => {
    const fsm = new StateMachine();
    expect(fsm.transition(GameStates.spinning(10))).toEqual({ type: 'SPINNING', betAmount: 10 });
    expect(fsm.is('SPINNING') && fsm.state.betAmount).toBe(10);
    fsm.transition(GameStates.showingWin(40, ['SEVEN', 'BAR']));
    expect(fsm.state).toEqual({ type: 'SHOWING_WIN', winAmount: 40, winningSymbols: ['SEVEN', 'BAR'] });
    fsm.transition(GameStates.idle());
    expect(fsm.state.type).toBe('IDLE');
  });

  it('supports the losing path SPINNING -> IDLE and error recovery X -> ERROR -> IDLE', () => {
    const fsm = new StateMachine();
    fsm.transition(GameStates.spinning(5));
    fsm.transition(GameStates.idle());
    for (const from of ['IDLE', 'SPINNING', 'SHOWING_WIN'] as const) {
      const m = fsmIn(from);
      m.transition(GameStates.error('NETWORK_TIMEOUT'));
      expect(m.state).toEqual({ type: 'ERROR', errorCode: 'NETWORK_TIMEOUT' });
      m.transition(GameStates.idle());
      expect(m.state.type).toBe('IDLE');
    }
  });

  // Exhaustive 4x4 matrix against the spec table.
  const SPEC: Record<GameStateType, GameStateType[]> = {
    IDLE: ['SPINNING', 'ERROR'],
    SPINNING: ['SHOWING_WIN', 'IDLE', 'ERROR'],
    SHOWING_WIN: ['IDLE', 'ERROR'],
    ERROR: ['IDLE'],
  };
  for (const from of ALL_TYPES) {
    for (const to of ALL_TYPES) {
      const allowed = SPEC[from].includes(to);
      it(`${from} -> ${to} is ${allowed ? 'allowed' : 'blocked'}`, () => {
        expect(isValidTransition(from, to)).toBe(allowed);
        const fsm = fsmIn(from);
        const before = fsm.state;
        const listener = vi.fn();
        fsm.subscribe(listener);
        expect(fsm.canTransition(to)).toBe(allowed);
        if (allowed) {
          fsm.transition(sample(to));
          expect(fsm.state.type).toBe(to);
          expect(listener).toHaveBeenCalledTimes(1);
        } else {
          let err: unknown;
          try {
            fsm.transition(sample(to));
          } catch (e) {
            err = e;
          }
          expect(err).toBeInstanceOf(InvalidTransitionError);
          expect((err as InvalidTransitionError).from).toBe(from);
          expect((err as InvalidTransitionError).to).toBe(to);
          expect(fsm.state).toBe(before); // untouched
          expect(listener).not.toHaveBeenCalled();
          expect(fsm.tryTransition(sample(to))).toBe(false);
        }
      });
    }
  }

  it('exported TRANSITIONS map matches the spec and is frozen', () => {
    expect(TRANSITIONS).toEqual(SPEC);
    expect(Object.isFrozen(TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(TRANSITIONS.IDLE)).toBe(true);
  });

  it('blocks a double spin (SPINNING -> SPINNING) even with a different bet', () => {
    const fsm = new StateMachine();
    fsm.transition(GameStates.spinning(10));
    expect(() => fsm.transition(GameStates.spinning(25))).toThrow(InvalidTransitionError);
    expect(fsm.state).toEqual({ type: 'SPINNING', betAmount: 10 });
  });

  it.each([
    ['bet 0', GameStates.spinning(0)],
    ['negative bet', GameStates.spinning(-5)],
    ['NaN bet', GameStates.spinning(Number.NaN)],
    ['Infinite bet', GameStates.spinning(Number.POSITIVE_INFINITY)],
  ])('rejects invalid SPINNING payload: %s', (_, state) => {
    const fsm = new StateMachine();
    expect(() => fsm.transition(state)).toThrow(/betAmount/);
    expect(fsm.state.type).toBe('IDLE');
  });

  it.each([
    ['negative win', GameStates.showingWin(-1, [])],
    ['NaN win', GameStates.showingWin(Number.NaN, [])],
    ['non-array symbols', { type: 'SHOWING_WIN', winAmount: 1, winningSymbols: 'SEVEN' } as unknown as GameState],
    ['non-string symbol', { type: 'SHOWING_WIN', winAmount: 1, winningSymbols: [7] } as unknown as GameState],
  ])('rejects invalid SHOWING_WIN payload: %s', (_, state) => {
    const fsm = fsmIn('SPINNING');
    expect(() => fsm.transition(state)).toThrow(InvalidTransitionError);
    expect(fsm.state.type).toBe('SPINNING');
  });

  it('accepts a zero win and rejects an empty error code', () => {
    expect(() => fsmIn('SPINNING').transition(GameStates.showingWin(0, []))).not.toThrow();
    expect(() => new StateMachine().transition(GameStates.error(''))).toThrow(/errorCode/);
  });

  it('rejects unknown state types and non-objects', () => {
    const fsm = new StateMachine();
    expect(() => fsm.transition({ type: 'BONUS' } as unknown as GameState)).toThrow(InvalidTransitionError);
    expect(() => fsm.transition(null as unknown as GameState)).toThrow(InvalidTransitionError);
    expect(() => new StateMachine({ type: 'NOPE' } as unknown as GameState)).toThrow(InvalidTransitionError);
    expect(() => new StateMachine(GameStates.spinning(-1))).toThrow(InvalidTransitionError);
  });
});

describe('StateMachine: Proxy guard and immutability', () => {
  type Internals = { store: { current: GameState; other?: unknown } };

  it('validates direct writes to the proxied store', () => {
    const fsm = new StateMachine();
    const store = (fsm as unknown as Internals).store;
    expect(() => {
      store.current = GameStates.showingWin(1, []);
    }).toThrow(InvalidTransitionError);
    expect(() => {
      store.other = 1;
    }).toThrow(TypeError);
    expect(() => delete (store as { current?: GameState }).current).toThrow(TypeError);
    expect(() => Object.defineProperty(store, 'current', { value: GameStates.error('X') })).toThrow(TypeError);
    expect(fsm.state.type).toBe('IDLE');
  });

  it('commits frozen states and defensively copies winningSymbols', () => {
    const fsm = fsmIn('SPINNING');
    const symbols = ['SEVEN'];
    fsm.transition({ type: 'SHOWING_WIN', winAmount: 5, winningSymbols: symbols });
    symbols.push('BAR');
    const s = fsm.state;
    expect(Object.isFrozen(s)).toBe(true);
    expect(s.type === 'SHOWING_WIN' && s.winningSymbols).toEqual(['SEVEN']);
    expect(() => {
      (s as { type: string }).type = 'IDLE';
    }).toThrow(TypeError);
    expect(() => {
      if (s.type === 'SHOWING_WIN') s.winningSymbols.push('X');
    }).toThrow(TypeError);
  });

  it('reset() forces IDLE from any state and notifies only on change', () => {
    for (const type of ALL_TYPES) {
      const fsm = fsmIn(type);
      const listener = vi.fn();
      fsm.subscribe(listener);
      fsm.reset();
      expect(fsm.state.type).toBe('IDLE');
      expect(listener).toHaveBeenCalledTimes(type === 'IDLE' ? 0 : 1);
    }
  });
});

describe('StateMachine: pub/sub', () => {
  it('delivers (next, previous) and supports unsubscribe', () => {
    const fsm = new StateMachine();
    const calls: Array<[string, string]> = [];
    const off = fsm.subscribe((n, p) => calls.push([n.type, p.type]));
    expect(fsm.listenerCount).toBe(1);
    fsm.transition(GameStates.spinning(1));
    fsm.transition(GameStates.idle());
    off();
    off(); // idempotent
    fsm.transition(GameStates.spinning(1));
    expect(calls).toEqual([
      ['SPINNING', 'IDLE'],
      ['IDLE', 'SPINNING'],
    ]);
    expect(fsm.listenerCount).toBe(0);
    expect(fsm.unsubscribe(() => {})).toBe(false);
  });

  it('isolates a throwing listener from the FSM and other listeners', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fsm = new StateMachine();
    const good = vi.fn();
    fsm.subscribe(() => {
      throw new Error('boom');
    });
    fsm.subscribe(good);
    expect(() => fsm.transition(GameStates.spinning(1))).not.toThrow();
    expect(fsm.state.type).toBe('SPINNING');
    expect(good).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it('queues re-entrant transitions and delivers them in order to every listener', () => {
    const fsm = new StateMachine();
    const a: string[] = [];
    const b: string[] = [];
    fsm.subscribe((next) => {
      a.push(next.type);
      if (next.type === 'SPINNING') fsm.transition(GameStates.showingWin(1, []));
      if (next.type === 'SHOWING_WIN') fsm.transition(GameStates.idle());
    });
    fsm.subscribe((next, prev) => b.push(`${prev.type}>${next.type}`));
    fsm.transition(GameStates.spinning(1));
    expect(a).toEqual(['SPINNING', 'SHOWING_WIN', 'IDLE']);
    expect(b).toEqual(['IDLE>SPINNING', 'SPINNING>SHOWING_WIN', 'SHOWING_WIN>IDLE']);
    expect(fsm.state.type).toBe('IDLE');
  });

  it('does not skip listeners when one unsubscribes another during dispatch', () => {
    const fsm = new StateMachine();
    const seen: string[] = [];
    let offB: () => void = () => {};
    fsm.subscribe(() => {
      seen.push('A');
      offB();
    });
    offB = fsm.subscribe(() => seen.push('B'));
    fsm.subscribe(() => seen.push('C'));
    fsm.transition(GameStates.spinning(1));
    expect(seen).toEqual(['A', 'B', 'C']); // snapshot semantics
    seen.length = 0;
    fsm.transition(GameStates.idle());
    expect(seen).toEqual(['A', 'C']);
  });

  it('survives 1,000 rapid mixed cycles and always returns to IDLE', () => {
    const fsm = new StateMachine();
    const rnd = testRng(7);
    let notifications = 0;
    let expected = 0;
    fsm.subscribe(() => notifications++);
    for (let i = 0; i < 1000; i++) {
      fsm.transition(GameStates.spinning(1 + i));
      expect(fsm.tryTransition(GameStates.spinning(2))).toBe(false); // double spin blocked
      const r = rnd();
      if (r < 0.4) {
        fsm.transition(GameStates.showingWin(i, ['SEVEN']));
        fsm.transition(GameStates.idle());
        expected += 3;
      } else if (r < 0.8) {
        fsm.transition(GameStates.idle());
        expected += 2;
      } else {
        fsm.transition(GameStates.error('E'));
        expect(fsm.tryTransition(GameStates.spinning(1))).toBe(false);
        fsm.transition(GameStates.idle());
        expected += 3;
      }
      expect(fsm.state.type).toBe('IDLE');
    }
    expect(notifications).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------
// Object pool
// ---------------------------------------------------------------------------------------

describe('ObjectPool', () => {
  class Particle {
    x = 0;
  }

  it('pre-allocates exactly initialSize instances', () => {
    const factory = vi.fn(() => new Particle());
    const pool = new ObjectPool(factory, { initialSize: 100 });
    expect(factory).toHaveBeenCalledTimes(100);
    expect(pool.size).toBe(100);
    expect(pool.available).toBe(100);
    expect(pool.activeCount).toBe(0);
  });

  it('reuses the exact same 100 object references across acquire/release cycles', () => {
    const factory = vi.fn(() => new Particle());
    const pool = new ObjectPool(factory, { initialSize: 100 });
    const first: Particle[] = [];
    for (let i = 0; i < 100; i++) first.push(pool.acquire()!);
    expect(new Set(first).size).toBe(100);
    expect(pool.acquire()).toBeNull(); // exhausted, no growth
    for (const p of first) expect(pool.release(p)).toBe(true);

    const second: Particle[] = [];
    for (let i = 0; i < 100; i++) second.push(pool.acquire()!);
    const firstSet = new Set(first);
    for (const p of second) expect(firstSet.has(p)).toBe(true);
    expect(new Set(second).size).toBe(100);
    expect(factory).toHaveBeenCalledTimes(100); // nothing new was created

    // LIFO: the last released item is the next acquired.
    const firstObj = second[42];
    pool.release(firstObj);
    const reusedObj = pool.acquire();
    expect(reusedObj).toBe(firstObj);
  });

  it('survives 10,000 churn cycles without growth or leaks', () => {
    const factory = vi.fn(() => new Particle());
    const pool = new ObjectPool(factory, { initialSize: 160 });
    const rnd = testRng(1);
    const live: Particle[] = [];
    for (let i = 0; i < 10_000; i++) {
      if (live.length > 0 && (rnd() < 0.5 || live.length === 160)) {
        const idx = Math.floor(rnd() * live.length);
        expect(pool.release(live.splice(idx, 1)[0])).toBe(true);
      } else {
        live.push(pool.acquire()!);
      }
      expect(pool.activeCount).toBe(live.length);
      expect(pool.available).toBe(160 - live.length);
    }
    expect(pool.releaseAll()).toBe(live.length);
    expect(pool.activeCount).toBe(0);
    expect(factory).toHaveBeenCalledTimes(160);
  });

  it('rejects double and foreign releases without corrupting state', () => {
    const pool = new ObjectPool(() => new Particle(), { initialSize: 2 });
    const a = pool.acquire()!;
    expect(pool.release(a)).toBe(true);
    expect(pool.release(a)).toBe(false);
    expect(pool.release(new Particle())).toBe(false);
    expect(pool.activeCount).toBe(0);
    expect(pool.available).toBe(2);
    // Double release must not let the same object be handed out twice.
    const x = pool.acquire()!;
    const y = pool.acquire()!;
    expect(x).not.toBe(y);
  });

  it('runs reset on release and onAcquire on acquire', () => {
    const reset = vi.fn((p: Particle) => (p.x = 0));
    const onAcquire = vi.fn();
    const pool = new ObjectPool(() => new Particle(), { initialSize: 1, reset, onAcquire });
    const p = pool.acquire()!;
    expect(onAcquire).toHaveBeenCalledWith(p);
    p.x = 99;
    pool.release(p);
    expect(reset).toHaveBeenCalledWith(p);
    expect(p.x).toBe(0);
    expect(pool.isActive(p)).toBe(false);
    expect(pool.owns(p)).toBe(true);
  });

  it('grows lazily up to maxSize only', () => {
    const factory = vi.fn(() => new Particle());
    const pool = new ObjectPool(factory, { initialSize: 0, maxSize: 3 });
    expect(factory).not.toHaveBeenCalled();
    expect([pool.acquire(), pool.acquire(), pool.acquire()].every(Boolean)).toBe(true);
    expect(pool.acquire()).toBeNull();
    expect(pool.size).toBe(3);
  });

  it('allows releasing the current item from forEachActive', () => {
    const pool = new ObjectPool(() => new Particle(), { initialSize: 5 });
    for (let i = 0; i < 5; i++) pool.acquire();
    let visited = 0;
    pool.forEachActive((p) => {
      visited++;
      pool.release(p);
    });
    expect(visited).toBe(5);
    expect(pool.activeCount).toBe(0);
  });

  it('validates options and factory output', () => {
    expect(() => new ObjectPool(() => new Particle(), { initialSize: -1 })).toThrow(RangeError);
    expect(() => new ObjectPool(() => new Particle(), { initialSize: 1.5 })).toThrow(RangeError);
    expect(() => new ObjectPool(() => new Particle(), { initialSize: 4, maxSize: 2 })).toThrow(RangeError);
    expect(() => new ObjectPool(() => new Particle(), { initialSize: 0 })).toThrow(RangeError);
    const shared = new Particle();
    expect(() => new ObjectPool(() => shared, { initialSize: 2 })).toThrow(/new instance/);
  });
});

// ---------------------------------------------------------------------------------------
// WinSequence slam-stop (AbortController)
// ---------------------------------------------------------------------------------------

describe('WinSequence: AbortController slam-stop', () => {
  function setup() {
    const cfg = config();
    const fountain = new CoinFountain({ ...cfg.particles, random: () => 0.5 });
    const view = {
      highlight: vi.fn(),
      clearHighlight: vi.fn(),
      setWinAmount: vi.fn(),
      setStep: vi.fn(),
    } satisfies WinSequenceView;
    const ws = new WinSequence(cfg.winSequence, view, fountain);
    return { cfg, fountain, view, ws };
  }

  it('aborting after 50 ms resolves immediately, snaps the counter and leaves nothing pending', async () => {
    const { ws, view, fountain } = setup();
    const controller = new AbortController();
    let result: Awaited<ReturnType<WinSequence['play']>> | null = null;
    const playing = ws.play({ amount: 250, positions: [{ reel: 0, row: 1 }] }, controller.signal);
    playing.then((r) => (result = r));
    for (let t = 0; t < 0.05; t += FRAME_60) ws.update(FRAME_60);
    await flushMicrotasks();
    expect(result).toBeNull();
    expect(ws.currentStep).toBe('HIGHLIGHT');

    controller.abort();
    await flushMicrotasks(); // no frames advanced: must settle on microtasks alone
    expect(result).toEqual({ status: 'aborted', finalAmount: 250, lastStep: 'HIGHLIGHT' });
    expect(ws.isPlaying).toBe(false);
    expect(ws.displayedAmount).toBe(250);
    expect(view.setWinAmount).toHaveBeenLastCalledWith(250);
    expect(view.clearHighlight).toHaveBeenCalledTimes(1);
    expect(view.setStep).toHaveBeenLastCalledWith(null);
    expect(fountain.activeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// SlotGame integration
// ---------------------------------------------------------------------------------------

describe('SlotGame: spin pipeline', () => {
  it('debits the bet, lands the reels on the server stops and credits the win once', async () => {
    const balances: number[] = [];
    const results: number[] = [];
    const engine = headless(config(), {
      hooks: { onBalanceChange: (b) => balances.push(b), onSpinResult: (r) => results.push(r.win.totalWin) },
    });
    const { game, reels } = engine;
    const start = game.balance;
    const { value } = await runUntil(engine, game.spin());
    if (value.status !== 'completed') throw new Error(`unexpected ${value.status}`);
    expect(game.balance).toBe(start - game.bet + value.win);
    expect(reels.stops).toEqual(value.response.stops);
    expect(reels.getGrid()).toEqual(value.response.grid);
    expect(game.state.type).toBe('IDLE');
    expect(balances[0]).toBe(start - game.bet);
    expect(balances.length).toBe(value.win > 0 ? 2 : 1);
    expect(results).toEqual([value.win]);
  });

  it('rejects re-entrant spins while busy without double-debiting', async () => {
    const engine = headless();
    const { game } = engine;
    const start = game.balance;
    const first = game.spin();
    const second = await game.spin();
    expect(second.status).toBe('rejected');
    expect(game.balance).toBe(start - game.bet);
    expect(game.setBetIndex(0)).toBe(false); // bet locked while spinning
    await runUntil(engine, first);
  });

  it('goes to ERROR on insufficient funds without debiting, and Space acknowledges it', async () => {
    const engine = headless(config((r) => (r.startingBalance = 3)));
    const { game } = engine;
    expect(await game.spin()).toEqual({ status: 'error', errorCode: 'INSUFFICIENT_FUNDS' });
    expect(game.balance).toBe(3);
    expect(game.state).toEqual({ type: 'ERROR', errorCode: 'INSUFFICIENT_FUNDS' });
    expect(game.primaryAction).toBe('ACKNOWLEDGE_ERROR');
    expect((await game.spin()).status).toBe('rejected');
    expect(game.handlePrimaryAction()).toBe('ACKNOWLEDGE_ERROR');
    expect(game.state.type).toBe('IDLE');
    expect(game.acknowledgeError()).toBe(false);
  });

  it('refunds and enters ERROR when the server rejects, halting the reels', async () => {
    const engine = headless(config(), {
      server: scriptedServer(() => new SpinServerError('NETWORK_TIMEOUT', 'timeout')),
    });
    const { game, reels } = engine;
    const start = game.balance;
    const { value } = await runUntil(engine, game.spin());
    expect(value).toEqual({ status: 'error', errorCode: 'NETWORK_TIMEOUT' });
    expect(game.balance).toBe(start);
    expect(reels.isSpinning).toBe(false);
    expect(game.state.type).toBe('ERROR');
    expect(game.isBusy).toBe(false);
    game.acknowledgeError();
    expect(game.state.type).toBe('IDLE');
  });

  it('maps unknown server errors to SERVER_ERROR', async () => {
    const engine = headless(config(), { server: scriptedServer(() => new Error('weird')) });
    const { value } = await runUntil(engine, engine.game.spin());
    expect(value).toEqual({ status: 'error', errorCode: 'SERVER_ERROR' });
  });

  it('recovers from a malformed response (wrong stop count) via INTERNAL_ERROR', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ref = headless();
    const good = responseFor(ref, [0, 0, 0], 10);
    const engine = headless(config(), { server: scriptedServer(() => ({ ...good, stops: [0, 0] })) });
    const { value } = await runUntil(engine, engine.game.spin());
    expect(value).toEqual({ status: 'error', errorCode: 'INTERNAL_ERROR' });
    expect(engine.reels.isSpinning).toBe(false);
    expect(engine.game.acknowledgeError()).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });

  // Regression for finding F-01: a win the FSM refuses to show used to leave the game stuck in
  // SPINNING with no controller (primaryAction NONE, every spin() rejected forever).
  it.each([
    ['non-string winningSymbols', (w: number) => ({ totalWin: w, lines: [], winningSymbols: [42 as unknown as string] })],
    ['NaN totalWin', () => ({ totalWin: Number.NaN, lines: [], winningSymbols: [] })],
  ])('never soft-locks on a malformed win payload (%s)', async (_, makeWin) => {
    const ref = headless();
    const base = responseFor(ref, [0, 0, 0], 10);
    const engine = headless(config(), { server: scriptedServer(() => ({ ...base, win: makeWin(30) })) });
    const { game } = engine;
    await runUntil(engine, game.spin());
    expect(game.state.type).toBe('IDLE');
    expect(game.primaryAction).toBe('SPIN');
    expect(Number.isFinite(game.balance)).toBe(true);
    // The game must be able to keep playing.
    const next = await runUntil(engine, game.spin());
    expect(next.value.status).not.toBe('rejected');
  });

  // Regression for finding F-05: fail() notified ERROR while the busy flag was still set, so a
  // subscriber that acknowledged the error and re-spun (autoplay) saw IDLE + busy and was rejected.
  it('lets an ERROR subscriber acknowledge and immediately re-spin (autoplay after error)', async () => {
    let n = 0;
    const ref = headless();
    const ok = responseFor(ref, [0, 0, 0], 10);
    const engine = headless(config(), {
      server: scriptedServer(() => (n++ === 0 ? new SpinServerError('NETWORK_TIMEOUT', 'x') : ok)),
    });
    const { game, fsm } = engine;
    const seen: string[] = [];
    let respin: Promise<SpinOutcome> | null = null;
    fsm.subscribe((s) => {
      if (s.type === 'ERROR') {
        game.acknowledgeError();
      } else if (s.type === 'IDLE' && !respin) {
        seen.push(`busy=${game.isBusy} action=${game.primaryAction}`);
        respin = game.spin();
      }
    });
    await runUntil(engine, game.spin());
    expect(seen).toEqual(['busy=false action=SPIN']);
    const { value } = await runUntil(engine, respin!);
    expect(value.status).toBe('completed');
    expect(game.state.type).toBe('IDLE');
  });

  it('exposes the correct primary action per state', async () => {
    const engine = headless();
    const { game } = engine;
    expect(game.primaryAction).toBe('SPIN');
    const run = game.spin();
    expect(game.primaryAction).toBe('SLAM_STOP');
    game.slamStop();
    expect(game.primaryAction).toBe('NONE');
    await runUntil(engine, run);
    expect(game.primaryAction).toBe('SPIN');
  });

  it('is deterministic per seed, independent of frame rate and slam-stops', async () => {
    async function play(dt: number, slam: boolean): Promise<string[]> {
      const engine = headless(config(), { seed: 99 });
      const out: string[] = [];
      for (let i = 0; i < 25; i++) {
        const run = engine.game.spin();
        if (slam) engine.game.slamStop();
        const { value } = await runUntil(engine, run, { dt });
        if (value.status === 'completed' || value.status === 'slammed') {
          out.push(`${value.response.stops.join(',')}:${value.win}`);
        }
      }
      out.push(`balance=${engine.game.balance}`);
      return out;
    }
    const base = await play(FRAME_60, false);
    expect(await play(FRAME_30, false)).toEqual(base);
    expect(await play(FRAME_60, true)).toEqual(base);
  });
});

describe('SlotGame: AbortController slam-stop', () => {
  /** Engine whose server always returns a fixed winning (or losing) response. */
  function scripted(win: boolean) {
    const ref = headless();
    const bet = ref.game.bet;
    const stops = findStops(ref, bet, (w) => (win ? w.totalWin > 0 && w.lines.length > 0 : w.totalWin === 0));
    const response = responseFor(ref, stops, bet);
    const counter: number[] = [];
    const history: string[] = [];
    const engine = headless(config(), {
      server: scriptedServer(() => response),
      hooks: { onWinAmount: (a) => counter.push(a) },
      winView: {
        highlight: () => {},
        clearHighlight: () => {},
        setWinAmount: (a) => counter.push(a),
      },
    });
    engine.fsm.subscribe((s) => history.push(s.type));
    return { engine, response, counter, history };
  }

  it('slam during SPINNING snaps reels and counter to the result and skips SHOWING_WIN', async () => {
    const { engine, response, counter, history } = scripted(true);
    const { game, reels, fountain } = engine;
    const start = game.balance;
    const run = game.spin();
    await step(engine, 10); // reels moving, server answered
    expect(reels.isSpinning).toBe(true);
    expect(game.slamStop()).toBe(true);
    const { value, frames } = await runUntil(engine, run);
    expect(frames).toBe(0); // resolved without needing another frame
    expect(value.status).toBe('slammed');
    expect(game.state.type).toBe('IDLE');
    expect(history).toEqual(['SPINNING', 'IDLE']);
    expect(counter.at(-1)).toBe(response.win.totalWin);
    expect(reels.stops).toEqual(response.stops);
    expect(reels.isSpinning).toBe(false);
    expect(fountain.activeCount).toBe(0);
    expect(game.balance).toBe(start - response.bet + response.win.totalWin);
  });

  it.each(['HIGHLIGHT', 'COUNT_UP', 'COIN_FOUNTAIN'] as const)(
    'slam during SHOWING_WIN (%s) snaps the counter, releases all particles and returns to IDLE',
    async (target) => {
      const { engine, response, counter, history } = scripted(true);
      const { game, fountain, winSequence } = engine;
      const start = game.balance;
      const run = game.spin();
      let frames = 0;
      while (winSequence.currentStep !== target) {
        engine.update(FRAME_60);
        await flushMicrotasks();
        if (++frames > 2000) throw new Error(`never reached ${target}`);
      }
      await step(engine, 20); // let the step run a bit (coins in flight for COIN_FOUNTAIN)
      expect(game.state.type).toBe('SHOWING_WIN');
      if (target === 'COIN_FOUNTAIN') expect(fountain.activeCount).toBeGreaterThan(0);
      if (target === 'COUNT_UP') {
        expect(winSequence.displayedAmount).toBeGreaterThan(0);
        expect(winSequence.displayedAmount).toBeLessThan(response.win.totalWin);
      }

      expect(game.handlePrimaryAction()).toBe('SLAM_STOP');
      const { value, frames: after } = await runUntil(engine, run);
      expect(after).toBe(0);
      expect(value.status).toBe('slammed');
      if (value.status === 'slammed') expect(value.sequence).toMatchObject({ status: 'aborted', lastStep: target });
      expect(game.state.type).toBe('IDLE');
      expect(history).toEqual(['SPINNING', 'SHOWING_WIN', 'IDLE']);
      expect(winSequence.displayedAmount).toBe(response.win.totalWin);
      expect(counter.at(-1)).toBe(response.win.totalWin);
      expect(fountain.activeCount).toBe(0);
      expect(fountain.isEmitting).toBe(false);
      expect(winSequence.isPlaying).toBe(false);
      expect(game.balance).toBe(start - response.bet + response.win.totalWin); // credited exactly once
    },
  );

  it('slam-stop spam: only the first press aborts and the state machine never breaks', async () => {
    const { engine, response } = scripted(true);
    const { game } = engine;
    const start = game.balance;
    const run = game.spin();
    const results: boolean[] = [];
    for (let i = 0; i < 50; i++) results.push(game.slamStop());
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results[0]).toBe(true);
    for (let i = 0; i < 50; i++) game.handlePrimaryAction(); // spam Space on top
    await runUntil(engine, run);
    await flushMicrotasks();
    // Spamming Space after IDLE may legally start new spins; drain them.
    while (game.currentSpin) await runUntil(engine, game.currentSpin);
    expect(game.state.type).toBe('IDLE');
    const spins = engine.server.getSpinCount();
    expect(game.balance).toBe(start + spins * (response.win.totalWin - response.bet));
  });

  it('Space spam every frame across many spins never soft-locks or drifts balance', async () => {
    const { engine, response } = scripted(true);
    const { game, fountain } = engine;
    const start = game.balance;
    const rnd = testRng(3);
    for (let frame = 0; frame < 6000; frame++) {
      if (rnd() < 0.15) game.handlePrimaryAction();
      engine.update(FRAME_60);
      await flushMicrotasks();
    }
    while (game.currentSpin) await runUntil(engine, game.currentSpin);
    expect(game.state.type).toBe('IDLE');
    expect(fountain.activeCount).toBe(0);
    const spins = engine.server.getSpinCount();
    expect(spins).toBeGreaterThan(20);
    expect(game.balance).toBe(start + spins * (response.win.totalWin - response.bet));
  });

  it('slam while the server response is pending stays SPINNING, then resolves straight to IDLE', async () => {
    const ref = headless();
    const bet = ref.game.bet;
    const response = responseFor(ref, findStops(ref, bet, (w) => w.totalWin > 0), bet);
    const server = manualServer();
    const counter: number[] = [];
    const engine = headless(config(), { server, hooks: { onWinAmount: (a) => counter.push(a) } });
    const history: string[] = [];
    engine.fsm.subscribe((s) => history.push(s.type));
    const { game, reels } = engine;
    const start = game.balance;

    const run = game.spin();
    await step(engine, 5);
    expect(game.slamStop()).toBe(true);
    expect(game.slamStop()).toBe(false);
    expect(game.primaryAction).toBe('NONE');
    await step(engine, 120); // two seconds of "network latency"
    expect(game.state.type).toBe('SPINNING');
    expect(reels.isSpinning).toBe(true); // reels keep spinning until the outcome is known

    server.pending[0].resolve(response);
    const { frames } = await runUntil(engine, run);
    expect(frames).toBe(0);
    expect(history).toEqual(['SPINNING', 'IDLE']);
    expect(reels.stops).toEqual(response.stops);
    expect(counter.at(-1)).toBe(response.win.totalWin);
    expect(game.balance).toBe(start - bet + response.win.totalWin);
  });

  it('slam while pending followed by a server rejection refunds and enters ERROR', async () => {
    const server = manualServer();
    const engine = headless(config(), { server });
    const { game, reels } = engine;
    const start = game.balance;
    const run = game.spin();
    await step(engine, 5);
    game.slamStop();
    server.pending[0].reject(new SpinServerError('NETWORK_TIMEOUT', 'timeout'));
    await runUntil(engine, run);
    expect(game.state).toEqual({ type: 'ERROR', errorCode: 'NETWORK_TIMEOUT' });
    expect(game.balance).toBe(start);
    expect(reels.isSpinning).toBe(false);
    game.handlePrimaryAction();
    expect(game.state.type).toBe('IDLE');
  });

  it('slamStop is a no-op in IDLE and ERROR', () => {
    const engine = headless();
    expect(engine.game.slamStop()).toBe(false);
    engine.fsm.transition(GameStates.error('X'));
    expect(engine.game.slamStop()).toBe(false);
  });

  it('dispose() aborts an in-flight spin so it settles', async () => {
    const engine = headless();
    const run = engine.game.spin();
    engine.game.dispose();
    const { value } = await runUntil(engine, run);
    expect(value.status).toBe('slammed');
    expect(engine.game.state.type).toBe('IDLE');
  });
});

// ---------------------------------------------------------------------------------------
// Stress
// ---------------------------------------------------------------------------------------

describe('Stress', () => {
  it('1,000 spins with random bets, slam-stops and server failures: no soft-locks, no drift, no leaks', async () => {
    const VIEW_COUNT = { n: 0 };
    const cfg = config((r) => {
      r.startingBalance = 1_000_000;
    });
    const engine = headless(cfg, {
      seed: 20261025,
      failureRate: 0.03,
      particleViewFactory: () => {
        VIEW_COUNT.n++;
        return null;
      },
    });
    const { game, fsm, fountain, reels, winSequence } = engine;
    const tracker = trackAbortListeners();
    const rnd = testRng(42);
    const listenerBaseline = fsm.listenerCount;
    const poolSize = fountain.pool.size;
    const startBalance = game.balance;

    const m = {
      spins: 0,
      completed: 0,
      slammed: 0,
      errors: 0,
      wins: 0,
      winPresentations: 0,
      slamDuringSpin: 0,
      slamDuringWin: 0,
      totalBet: 0,
      totalWin: 0,
      totalFrames: 0,
      maxFrames: 0,
      peakParticles: 0,
      peakAbortListeners: 0,
    };
    const t0 = performance.now();
    try {
      for (let i = 0; i < 1000; i++) {
        expect(game.state.type).toBe('IDLE');
        if (rnd() < 0.2) game.setBetIndex(Math.floor(rnd() * cfg.bet.levels.length));
        const mode = rnd(); // < .34 none, < .67 slam while spinning, else slam during win
        const slamFrame = Math.floor(rnd() * 120);
        let slammedThisSpin = false;
        const run: Promise<SpinOutcome> = game.spin();
        m.spins++;
        const { value, frames } = await runUntil(engine, run, {
          maxFrames: 2000,
          onFrame: (f) => {
            m.peakParticles = Math.max(m.peakParticles, fountain.activeCount);
            m.peakAbortListeners = Math.max(m.peakAbortListeners, tracker.live());
            if (slammedThisSpin) return;
            const type = game.state.type;
            if (mode < 0.67 && mode >= 0.34 && type === 'SPINNING' && f >= slamFrame % 90) {
              slammedThisSpin = game.slamStop();
              if (slammedThisSpin) m.slamDuringSpin++;
            } else if (mode >= 0.67 && type === 'SHOWING_WIN' && f >= slamFrame + 90) {
              slammedThisSpin = game.slamStop();
              if (slammedThisSpin) m.slamDuringWin++;
            }
          },
        });
        m.totalFrames += frames;
        m.maxFrames = Math.max(m.maxFrames, frames);

        if (value.status === 'error') {
          m.errors++;
          expect(game.state.type).toBe('ERROR');
          expect(game.acknowledgeError()).toBe(true);
        } else {
          if (value.status === 'rejected') throw new Error(`spin ${i} rejected: ${value.reason}`);
          if (value.status === 'completed') m.completed++;
          else m.slammed++;
          m.totalBet += value.response.bet;
          m.totalWin += value.win;
          if (value.win > 0) m.wins++;
          if (value.sequence) m.winPresentations++;
          expect(reels.stops).toEqual(value.response.stops);
        }

        // Per-spin invariants.
        expect(game.state.type).toBe('IDLE');
        expect(game.isBusy).toBe(false);
        expect(game.primaryAction).toBe('SPIN');
        expect(reels.isSpinning).toBe(false);
        expect(reels.isStopping).toBe(false);
        expect(winSequence.isPlaying).toBe(false);
        expect(fountain.activeCount).toBe(0);
        expect(fountain.isEmitting).toBe(false);
        expect(fountain.pool.size).toBe(poolSize);
        expect(fsm.listenerCount).toBe(listenerBaseline);
        expect(tracker.live()).toBe(0);
        expect(Math.round((startBalance - m.totalBet + m.totalWin) * 100) / 100).toBe(game.balance);
      }
    } finally {
      tracker.restore();
    }
    const elapsed = performance.now() - t0;

    expect(m.spins).toBe(1000);
    expect(m.errors).toBeGreaterThan(0);
    expect(m.slamDuringSpin).toBeGreaterThan(0);
    expect(m.slamDuringWin).toBeGreaterThan(0);
    expect(m.winPresentations).toBeGreaterThan(0);
    expect(m.peakParticles).toBeGreaterThan(0);
    expect(m.peakAbortListeners).toBeGreaterThan(0); // proves the tracker is wired up
    expect(VIEW_COUNT.n).toBe(poolSize); // particle views created only at pre-allocation
    expect(game.balance).toBe(Math.round((startBalance - m.totalBet + m.totalWin) * 100) / 100);

    console.log(
      `[stress] ${JSON.stringify({ ...m, finalBalance: game.balance, startBalance, simSeconds: +(m.totalFrames / 60).toFixed(1), wallMs: Math.round(elapsed) })}`,
    );
  }, 120_000);

  it('autoplay from an IDLE subscriber (re-entrant spin) chains 300 spins without soft-lock', async () => {
    const engine = headless(config((r) => (r.startingBalance = 1_000_000)), { seed: 5 });
    const { game, fsm } = engine;
    let remaining = 300;
    const outcomes: SpinOutcome[] = [];
    const record = (p: Promise<SpinOutcome>) => p.then((o) => outcomes.push(o));
    fsm.subscribe((s) => {
      if (s.type === 'IDLE' && remaining > 0) {
        remaining--;
        const p = game.spin();
        record(p);
      }
    });
    remaining--;
    record(game.spin());
    let frames = 0;
    while (outcomes.length < 300) {
      engine.update(FRAME_60);
      await flushMicrotasks();
      if (++frames > 300 * 2000) throw new Error('autoplay soft-locked');
    }
    expect(outcomes.every((o) => o.status === 'completed')).toBe(true);
    expect(engine.server.getSpinCount()).toBe(300);
    let expected = 1_000_000;
    for (const o of outcomes) if (o.status === 'completed') expected += o.win - o.response.bet;
    expect(game.balance).toBe(Math.round(expected * 100) / 100);
    expect(game.state.type).toBe('IDLE');
  }, 60_000);
});
