/**
 * Shared helpers for the headless engine tests. Not a test file itself (no `.test.ts`).
 */

import rawDsl from '../src/core/game-dsl.json';
import { parseGameConfig, type GameConfig } from '../src/core/GameConfig';
import { createSlotGame, type CreateSlotGameOptions, type SlotEngine } from '../src/core/createSlotGame';
import type { SpinResponse, SpinServer, WinData } from '../src/core/legacy-rng.js';

export const FRAME_60 = 1 / 60;
export const FRAME_30 = 1 / 30;

/** Deep clone of the shipped DSL (mutable, for building invalid/variant configs). */
export function rawConfig(): Record<string, any> {
  return JSON.parse(JSON.stringify(rawDsl));
}

export function config(overrides: (raw: Record<string, any>) => void = () => {}): GameConfig {
  const raw = rawConfig();
  overrides(raw);
  return parseGameConfig(raw);
}

/** Drains pending microtasks (promise continuations). Cheap, timer-free. */
export async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

export function headless(cfg: GameConfig = config(), options: Partial<CreateSlotGameOptions> = {}): SlotEngine {
  return createSlotGame(cfg, { seed: 1234, latencyMs: 0, particleRandom: () => 0.5, ...options });
}

/**
 * Steps the engine at a fixed dt until `promise` settles. Returns frames used. Throws if
 * the promise is still pending after `maxFrames` (i.e. a soft-lock / hung promise).
 */
export async function runUntil<T>(
  engine: SlotEngine,
  promise: Promise<T>,
  { dt = FRAME_60, maxFrames = 5000, onFrame }: { dt?: number; maxFrames?: number; onFrame?: (frame: number) => void } = {},
): Promise<{ value: T; frames: number }> {
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  let failed = false;
  promise.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e) => {
      settled = true;
      failed = true;
      error = e;
    },
  );
  await flushMicrotasks();
  let frames = 0;
  while (!settled) {
    if (frames >= maxFrames) throw new Error(`promise still pending after ${maxFrames} frames (soft-lock)`);
    onFrame?.(frames);
    engine.update(dt);
    frames++;
    await flushMicrotasks();
  }
  if (failed) throw error;
  return { value: value as T, frames };
}

/** Steps `frames` frames regardless of state. */
export async function step(engine: SlotEngine, frames: number, dt = FRAME_60): Promise<void> {
  for (let i = 0; i < frames; i++) {
    engine.update(dt);
    await flushMicrotasks();
  }
}

/** Builds a grid-consistent response for the given stops using the engine's evaluator. */
export function responseFor(engine: SlotEngine, stops: number[], bet: number, spinId = 1): SpinResponse {
  const rows = engine.config.grid.rows;
  const grid = engine.config.reelStrips.map((strip, r) => {
    const col: string[] = [];
    for (let row = 0; row < rows; row++) col.push(strip[(stops[r] + row) % strip.length]);
    return col;
  });
  return { spinId, bet, stops, grid, win: engine.evaluator.evaluate(grid, bet) };
}

/** Finds the first stop combination (scanning reel strips) whose outcome satisfies `pred`. */
export function findStops(engine: SlotEngine, bet: number, pred: (win: WinData) => boolean): number[] {
  const [a, b, c] = engine.config.reelStrips.map((s) => s.length);
  for (let i = 0; i < a; i++)
    for (let j = 0; j < b; j++)
      for (let k = 0; k < c; k++) {
        const stops = [i, j, k];
        if (pred(responseFor(engine, stops, bet).win)) return stops;
      }
  throw new Error('no matching stops');
}

/** A manually-controlled server: each spin() returns a promise the test resolves/rejects. */
export interface ManualServer extends SpinServer {
  readonly pending: Array<{ bet: number; resolve: (r: SpinResponse) => void; reject: (e: unknown) => void }>;
}

export function manualServer(): ManualServer {
  const pending: ManualServer['pending'] = [];
  let count = 0;
  return {
    pending,
    spin: (bet: number) =>
      new Promise<SpinResponse>((resolve, reject) => {
        count++;
        pending.push({ bet, resolve, reject });
      }),
    getSeed: () => 0,
    getSpinCount: () => count,
  };
}

/** Server that always answers with the given response factory (microtask latency). */
export function scriptedServer(next: (bet: number, n: number) => SpinResponse | Error): SpinServer {
  let n = 0;
  return {
    spin: (bet: number) => {
      const r = next(bet, n++);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
    getSeed: () => 0,
    getSpinCount: () => n,
  };
}

/** Tiny deterministic PRNG for test-side decisions (independent of the game RNG). */
export function testRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Tracks live (signal, listener) registrations on AbortSignals so tests can assert no
 * abort listener outlives its owner. `once` listeners that fire are also counted as removed.
 */
export function trackAbortListeners(): { live: () => number; restore: () => void } {
  const proto = AbortSignal.prototype as unknown as EventTarget;
  const origAdd = proto.addEventListener;
  const origRemove = proto.removeEventListener;
  const live = new Map<EventTarget, Set<unknown>>();
  proto.addEventListener = function (this: EventTarget, type: string, listener: any, opts?: any) {
    if (type === 'abort' && listener) {
      let set = live.get(this);
      if (!set) live.set(this, (set = new Set()));
      set.add(listener);
      if (typeof opts === 'object' && opts?.once) {
        const self = this;
        origAdd.call(this, 'abort', () => live.get(self)?.delete(listener), { once: true });
      }
    }
    return origAdd.call(this, type, listener, opts);
  };
  proto.removeEventListener = function (this: EventTarget, type: string, listener: any, opts?: any) {
    if (type === 'abort') live.get(this)?.delete(listener);
    return origRemove.call(this, type, listener, opts);
  };
  return {
    live: () => {
      let n = 0;
      live.forEach((s) => (n += s.size));
      return n;
    },
    restore: () => {
      proto.addEventListener = origAdd;
      proto.removeEventListener = origRemove;
    },
  };
}
