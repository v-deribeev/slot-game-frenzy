import { describe, expect, it, vi } from 'vitest';
import { GameLoop, MAX_DELTA_TIME, computeDeltaTime } from '../src/core/GameLoop';
import { WinSequence, NULL_WIN_VIEW } from '../src/core/WinSequence';
import { CoinFountain } from '../src/entities/CoinFountain';
import { Reel, easeOutBack, mod } from '../src/entities/Reel';
import { ReelSet } from '../src/entities/ReelSet';
import { FRAME_30, FRAME_60, config, flushMicrotasks, headless, runUntil } from './helpers';

/** Manual requestAnimationFrame driver. */
function fakeRaf(start = 0) {
  let now = start;
  let nextHandle = 1;
  const queue = new Map<number, FrameRequestCallback>();
  const requestFrame = vi.fn((cb: FrameRequestCallback) => {
    const h = nextHandle++;
    queue.set(h, cb);
    return h;
  });
  const cancelFrame = vi.fn((h: number) => {
    queue.delete(h);
  });
  return {
    requestFrame,
    cancelFrame,
    now: () => now,
    get pending() {
      return queue.size;
    },
    /** Advances the clock by `ms` and fires every queued callback once. */
    frame(ms: number) {
      now += ms;
      const cbs = [...queue.values()];
      queue.clear();
      for (const cb of cbs) cb(now);
    },
  };
}

describe('computeDeltaTime', () => {
  it('converts ms timestamps to seconds', () => {
    expect(computeDeltaTime(1016, 1000)).toBeCloseTo(0.016, 10);
    expect(computeDeltaTime(1033.3, 1000)).toBeCloseTo(0.0333, 10);
  });

  it('caps at MAX_DELTA_TIME = 0.1 s (tab switch)', () => {
    expect(MAX_DELTA_TIME).toBe(0.1);
    expect(computeDeltaTime(1100, 1000)).toBeCloseTo(0.1, 12);
    expect(computeDeltaTime(61_000, 1000)).toBe(0.1);
    expect(computeDeltaTime(2000, 1000, 0.25)).toBe(0.25);
  });

  it('returns 0 for non-positive or NaN gaps', () => {
    expect(computeDeltaTime(1000, 1000)).toBe(0);
    expect(computeDeltaTime(900, 1000)).toBe(0);
    expect(computeDeltaTime(Number.NaN, 1000)).toBe(0);
  });
});

describe('GameLoop', () => {
  it('uses requestAnimationFrame by default', () => {
    const raf = vi.fn(() => 7);
    const caf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);
    try {
      const loop = new GameLoop();
      loop.start();
      expect(raf).toHaveBeenCalledTimes(1);
      loop.stop();
      expect(caf).toHaveBeenCalledWith(7);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('passes capped dt (seconds) and the frame time to every callback', () => {
    const raf = fakeRaf(1000);
    const loop = new GameLoop(raf);
    const seen: Array<[number, number]> = [];
    loop.add((dt, time) => seen.push([dt, time]));
    loop.start();
    expect(loop.isRunning).toBe(true);
    raf.frame(16);
    raf.frame(33);
    raf.frame(5000); // tab was hidden
    raf.frame(16);
    expect(seen.map(([dt]) => dt)).toEqual([0.016, 0.033, 0.1, 0.016].map((v) => expect.closeTo(v, 10)));
    expect(seen[0][1]).toBe(1016);
    expect(loop.frameCount).toBe(4);
  });

  it('schedules exactly one frame at a time and stop() cancels it', () => {
    const raf = fakeRaf();
    const loop = new GameLoop(raf);
    const cb = vi.fn();
    loop.add(cb);
    loop.start();
    loop.start(); // idempotent
    expect(raf.requestFrame).toHaveBeenCalledTimes(1);
    raf.frame(16);
    expect(raf.pending).toBe(1);
    loop.stop();
    loop.stop();
    expect(raf.cancelFrame).toHaveBeenCalledTimes(1);
    expect(raf.pending).toBe(0);
    raf.frame(16);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(loop.isRunning).toBe(false);
  });

  it('keeps running when a system throws', () => {
    const raf = fakeRaf();
    const loop = new GameLoop(raf);
    loop.add(() => {
      throw new Error('system crashed');
    });
    loop.start();
    expect(() => raf.frame(16)).toThrow('system crashed');
    expect(raf.pending).toBe(1); // next frame was scheduled before dispatch
  });

  it('dedupes callbacks, supports unsubscribe, and is copy-on-write during dispatch', () => {
    const raf = fakeRaf();
    const loop = new GameLoop(raf);
    const late = vi.fn();
    const a = vi.fn(() => {
      loop.add(late);
    });
    const off = loop.add(a);
    loop.add(a);
    loop.start();
    raf.frame(16);
    expect(a).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled(); // added mid-frame: runs from next frame
    raf.frame(16);
    expect(late).toHaveBeenCalledTimes(1);
    off();
    expect(loop.remove(a)).toBe(false);
    raf.frame(16);
    expect(a).toHaveBeenCalledTimes(2);
  });

  it('advance(dt) steps manually with the same cap', () => {
    const loop = new GameLoop(fakeRaf());
    const dts: number[] = [];
    loop.add((dt) => dts.push(dt));
    loop.advance(0.016);
    loop.advance(3);
    loop.advance(-1);
    expect(dts).toEqual([0.016, 0.1, 0]);
    expect(() => new GameLoop({ maxDeltaTime: 0 })).toThrow(RangeError);
  });

  it('delivers the same total simulated time at 30 and 60 FPS', () => {
    function total(fps: number): { time: number; frames: number } {
      const raf = fakeRaf();
      const loop = new GameLoop(raf);
      let time = 0;
      loop.add((dt) => (time += dt));
      loop.start();
      for (let i = 0; i < 2 * fps; i++) raf.frame(1000 / fps);
      return { time, frames: loop.frameCount };
    }
    const at30 = total(30);
    const at60 = total(60);
    expect(at30.frames).toBe(60);
    expect(at60.frames).toBe(120);
    expect(at30.time).toBeCloseTo(2, 9);
    expect(at60.time).toBeCloseTo(2, 9);
  });
});

// ---------------------------------------------------------------------------------------
// Reels: dt-scaled motion and frame-rate independence
// ---------------------------------------------------------------------------------------

const STRIP = Array.from({ length: 20 }, (_, i) => `S${i}`);
const TIMINGS = { spinSpeed: 18, stopDurationMs: 420, stopOvershoot: 1.25 };

describe('Reel', () => {
  it('spins downward at spinSpeed * dt', () => {
    const reel = new Reel(0, STRIP, TIMINGS, 0);
    reel.startSpin();
    reel.update(0.5);
    expect(reel.position).toBeCloseTo(mod(-9, 20), 9);
    expect(reel.phase).toBe('SPINNING');
  });

  it('covers the same distance in 1 s at 30 and 60 FPS', () => {
    const a = new Reel(0, STRIP, TIMINGS, 3);
    const b = new Reel(0, STRIP, TIMINGS, 3);
    a.startSpin();
    b.startSpin();
    for (let i = 0; i < 30; i++) a.update(FRAME_30);
    for (let i = 0; i < 60; i++) b.update(FRAME_60);
    expect(a.position).toBeCloseTo(b.position, 9);
    expect(a.spinTime).toBeCloseTo(1, 9);
  });

  it('lands exactly on the requested stop after the reported landing delay + stopDuration and fires onStopped once', () => {
    for (const target of [0, 7, 19, 23, -1]) {
      const reel = new Reel(0, STRIP, TIMINGS, 0);
      const stopped = vi.fn();
      reel.onStopped = stopped;
      reel.startSpin();
      reel.update(0.2);
      const landingIn = reel.requestStop(target, 0.3);
      // Honours the delay, and never waits more than one extra strip revolution.
      expect(landingIn).toBeGreaterThanOrEqual(0.3);
      expect(landingIn).toBeLessThan(0.3 + STRIP.length / TIMINGS.spinSpeed);
      let t = 0;
      while (reel.isSpinning && t < 5) {
        reel.update(FRAME_60);
        t += FRAME_60;
      }
      expect(reel.phase).toBe('IDLE');
      expect(reel.stopIndex).toBe(mod(target, 20));
      expect(reel.position).toBe(mod(target, 20));
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(t).toBeGreaterThanOrEqual(landingIn + 0.42 - 1e-9);
      expect(t).toBeLessThan(landingIn + 0.42 + FRAME_60 + 1e-9);
    }
  });

  it('snapTo / halt land on whole symbols and only notify when moving', () => {
    const reel = new Reel(0, STRIP, TIMINGS, 0);
    const stopped = vi.fn();
    reel.onStopped = stopped;
    reel.snapTo(4);
    expect(stopped).not.toHaveBeenCalled();
    reel.startSpin();
    reel.update(0.123);
    reel.halt();
    expect(Number.isInteger(reel.position)).toBe(true);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(() => reel.snapTo(Number.NaN)).toThrow(RangeError);
    expect(() => new Reel(0, [], TIMINGS)).toThrow(RangeError);
  });

  it('easeOutBack hits 0 and 1 at the ends', () => {
    expect(easeOutBack(0, 1.25)).toBeCloseTo(0, 12);
    expect(easeOutBack(1, 1.25)).toBeCloseTo(1, 12);
    expect(easeOutBack(0.5, 0)).toBeCloseTo(1 - 0.125, 12); // cubic ease-out
  });

  it('never reverses direction at the start of the landing tween', () => {
    for (let target = 0; target < 20; target++) {
      const reel = new Reel(0, STRIP, TIMINGS, 0);
      reel.startSpin();
      reel.update(0.05);
      reel.requestStop(target, 0);
      reel.update(1 / 600); // begins landing
      const p0 = reel.position;
      reel.update(1 / 600);
      expect(reel.position).toBeLessThan(p0); // still moving downward
    }
  });

  // F-02 (SPEC section 4): the landing must begin at spin speed and never exceed it.
  function maxLandingSpeed(target: number, startOffset: number, dt: number) {
    const reel = new Reel(0, STRIP, TIMINGS, 0);
    reel.startSpin();
    reel.update(startOffset);
    reel.requestStop(target, 0);
    let maxSpeed = 0;
    let firstLandingSpeed = Number.NaN;
    let prev = reel.position;
    let prevPhase = reel.phase;
    for (let i = 0; i < 1000 && reel.isSpinning; i++) {
      reel.update(dt);
      // Unwrap the strip modulo so a wrap-around isn't mistaken for a jump.
      const step = mod(prev - reel.position + STRIP.length / 2, STRIP.length) - STRIP.length / 2;
      const speed = Math.abs(step) / dt;
      if (reel.phase === 'STOPPING' && prevPhase === 'SPINNING') firstLandingSpeed = speed;
      maxSpeed = Math.max(maxSpeed, speed);
      prev = reel.position;
      prevPhase = reel.phase;
    }
    expect(reel.stopIndex).toBe(mod(target, STRIP.length));
    return { maxSpeed, firstLandingSpeed };
  }

  it('landing begins at spin speed and never exceeds it, for every target and phase [F-02]', () => {
    for (const dt of [FRAME_30, FRAME_60, 1 / 144]) {
      for (let target = 0; target < STRIP.length; target++) {
        for (const offset of [0.01, 0.05, 0.137, 0.5]) {
          const { maxSpeed, firstLandingSpeed } = maxLandingSpeed(target, offset, dt);
          expect(maxSpeed).toBeLessThanOrEqual(TIMINGS.spinSpeed * (1 + 1e-6));
          // The frame that crosses into the landing is continuous with the spin speed.
          expect(firstLandingSpeed).toBeGreaterThan(TIMINGS.spinSpeed * 0.8);
        }
      }
    }
  });

  it('carries residual frame time from spinning into the landing tween (30 vs 60 FPS land identically)', () => {
    function landedAt(dt: number): number {
      const reel = new Reel(0, STRIP, TIMINGS, 0);
      reel.startSpin();
      const landingIn = reel.requestStop(11, 0.25);
      let t = 0;
      while (reel.isSpinning) {
        reel.update(dt);
        t += dt;
      }
      return t - (landingIn + TIMINGS.stopDurationMs / 1000);
    }
    // Overshoot past the exact end is bounded by a single frame, not one frame per phase.
    for (const dt of [FRAME_30, FRAME_60]) {
      const over = landedAt(dt);
      expect(over).toBeGreaterThanOrEqual(-1e-9);
      expect(over).toBeLessThan(dt + 1e-9);
    }
  });
});

describe('ReelSet', () => {
  const cfg = config();

  async function landTime(dt: number, stops: number[]): Promise<{ time: number; reels: ReelSet }> {
    const reels = new ReelSet(cfg.reelStrips, cfg.grid.rows, cfg.reels);
    reels.startSpin();
    let done = false;
    reels.stopAt(stops).then(() => (done = true));
    let time = 0;
    while (!done) {
      reels.update(dt);
      time += dt;
      await flushMicrotasks(2);
      if (time > 10) throw new Error('reels never landed');
    }
    return { time, reels };
  }

  it('lands on the requested stops honouring minSpin + stagger + stopDuration', async () => {
    const { time, reels } = await landTime(FRAME_60, [3, 11, 17]);
    expect(reels.stops).toEqual([3, 11, 17]);
    expect(reels.isSpinning).toBe(false);
    const nominal = (cfg.reels.minSpinMs + 2 * cfg.reels.stopStaggerMs + cfg.reels.stopDurationMs) / 1000;
    // Each reel may spin up to one extra strip revolution so it can land at spin speed.
    const revolution = cfg.reelStrips[0].length / cfg.reels.spinSpeed;
    expect(time).toBeGreaterThanOrEqual(nominal - 1e-9);
    expect(time).toBeLessThan(nominal + cfg.reelStrips.length * revolution + 2 * FRAME_60);
  });

  it('takes the same wall-clock time at 30 and 60 FPS (within frame quantisation)', async () => {
    const a = await landTime(FRAME_30, [5, 5, 5]);
    const b = await landTime(FRAME_60, [5, 5, 5]);
    expect(a.reels.stops).toEqual(b.reels.stops);
    expect(Math.abs(a.time - b.time)).toBeLessThanOrEqual(3 * FRAME_30 + 1e-9);
  });

  it('stops reels in stagger order', async () => {
    const reels = new ReelSet(cfg.reelStrips, cfg.grid.rows, cfg.reels);
    const order: number[] = [];
    reels.reels.forEach((r) => {
      const prev = r.onStopped!;
      r.onStopped = (reel) => {
        order.push(reel.index);
        prev(reel);
      };
    });
    reels.startSpin();
    // Exhaustive over target combinations whose extra-revolution waits differ wildly.
    for (const stops of [[1, 2, 3], [19, 0, 1], [0, 19, 10], [5, 5, 5], [12, 3, 18]]) {
      order.length = 0;
      reels.startSpin();
      const p = reels.stopAt(stops);
      for (let i = 0; i < 600 && reels.isSpinning; i++) reels.update(FRAME_60);
      await p;
      expect(order).toEqual([0, 1, 2]);
      expect(reels.stops).toEqual(stops);
    }
  });

  it('snaps every reel immediately on abort and removes its abort listener', async () => {
    const reels = new ReelSet(cfg.reelStrips, cfg.grid.rows, cfg.reels);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    reels.startSpin();
    let done = false;
    reels.stopAt([4, 8, 12], controller.signal).then(() => (done = true));
    reels.update(FRAME_60);
    controller.abort();
    await flushMicrotasks();
    expect(done).toBe(true);
    expect(reels.stops).toEqual([4, 8, 12]);
    expect(reels.isStopping).toBe(false);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('resolves immediately with a pre-aborted signal', async () => {
    const reels = new ReelSet(cfg.reelStrips, cfg.grid.rows, cfg.reels);
    reels.startSpin();
    const c = new AbortController();
    c.abort();
    await reels.stopAt([1, 1, 1], c.signal);
    expect(reels.stops).toEqual([1, 1, 1]);
  });

  it('rejects a wrong stop count and settles stale stops on a new spin', async () => {
    const reels = new ReelSet(cfg.reelStrips, cfg.grid.rows, cfg.reels);
    await expect(reels.stopAt([1, 2])).rejects.toThrow(RangeError);
    reels.startSpin();
    let stale = false;
    reels.stopAt([1, 2, 3]).then(() => (stale = true));
    reels.startSpin(); // must not leave the old promise hanging
    await flushMicrotasks();
    expect(stale).toBe(true);
    expect(() => new ReelSet([], 3, cfg.reels)).toThrow(RangeError);
  });

  it('getGrid is column-major and wraps the strip', () => {
    const reels = new ReelSet(cfg.reelStrips, 3, cfg.reels, [19, 0, 18]);
    const grid = reels.getGrid();
    expect(grid[0]).toEqual([cfg.reelStrips[0][19], cfg.reelStrips[0][0], cfg.reelStrips[0][1]]);
    expect(grid[2]).toEqual([cfg.reelStrips[2][18], cfg.reelStrips[2][19], cfg.reelStrips[2][0]]);
  });

  it('a 5 s frame gap (tab switch) moves the reels by at most one capped step', () => {
    const raf = fakeRaf();
    const loop = new GameLoop(raf);
    const reels = new ReelSet(cfg.reelStrips, cfg.grid.rows, cfg.reels);
    loop.add((dt) => reels.update(dt));
    loop.start();
    reels.startSpin();
    const before = reels.reels[0].spinTime;
    raf.frame(5000);
    expect(reels.reels[0].spinTime - before).toBeCloseTo(0.1, 12);
  });
});

// ---------------------------------------------------------------------------------------
// WinSequence / fountain / full game timing at 30 vs 60 FPS
// ---------------------------------------------------------------------------------------

describe('Frame-rate independence', () => {
  const cfg = config();

  it('WinSequence takes the same wall-clock time at 30 and 60 FPS (within one frame overall)', async () => {
    async function duration(dt: number): Promise<number> {
      const fountain = new CoinFountain({ ...cfg.particles, random: () => 0.5 });
      const ws = new WinSequence(cfg.winSequence, NULL_WIN_VIEW, fountain);
      let done = false;
      ws.play({ amount: 100, positions: [] }).then(() => (done = true));
      let t = 0;
      while (!done) {
        ws.update(dt);
        fountain.update(dt);
        t += dt;
        await flushMicrotasks(4);
        if (t > 20) throw new Error('hung');
      }
      return t;
    }
    const nominal =
      (cfg.winSequence.highlightMs + cfg.winSequence.countUpMs + cfg.winSequence.fountainMs + cfg.winSequence.settleMs) /
      1000;
    const at30 = await duration(FRAME_30);
    const at60 = await duration(FRAME_60);
    expect(at60).toBeGreaterThanOrEqual(nominal - 1e-9);
    expect(at30).toBeGreaterThanOrEqual(nominal - 1e-9);
    // Residual dt is carried into the next step, so the overshoot is < 1 frame in total
    // rather than < 1 frame per step (F-06).
    expect(Math.abs(at30 - at60)).toBeLessThan(FRAME_30 + 1e-9);
    expect(at30 - nominal).toBeLessThan(FRAME_30 + 1e-9);
    expect(at60 - nominal).toBeLessThan(FRAME_60 + 1e-9);
  });

  it('CoinFountain emits the same number of coins per second at 30 and 60 FPS', () => {
    function emitted(dt: number): number {
      const f = new CoinFountain({ ...cfg.particles, random: () => 0.5 });
      f.startEmitting(cfg.winSequence.coinsPerSecond);
      for (let t = 0; t < 1 - 1e-9; t += dt) f.update(dt);
      return f.activeCount;
    }
    expect(emitted(FRAME_30)).toBe(emitted(FRAME_60));
    expect(Math.abs(emitted(FRAME_60) - cfg.winSequence.coinsPerSecond)).toBeLessThanOrEqual(1);
  });

  it('a full winning spin produces the same result and similar duration at 30 and 60 FPS', async () => {
    async function run(dt: number) {
      const engine = headless(config(), { seed: 7 });
      // Spin until the first win to exercise the whole pipeline.
      for (;;) {
        const { value, frames } = await runUntil(engine, engine.game.spin(), { dt });
        if (value.status === 'completed' && value.win > 0) return { value, seconds: frames * dt, balance: engine.game.balance };
      }
    }
    const a = await run(FRAME_30);
    const b = await run(FRAME_60);
    expect(a.balance).toBe(b.balance);
    expect(Math.abs(a.seconds - b.seconds)).toBeLessThanOrEqual(8 * FRAME_30);
  });
});
