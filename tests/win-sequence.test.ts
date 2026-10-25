import { describe, expect, it, vi } from 'vitest';
import { WinSequence, type WinSequenceResult, type WinSequenceView } from '../src/core/WinSequence';
import { CoinFountain, CoinParticle, type ParticleView } from '../src/entities/CoinFountain';
import type { WinSequenceConfig } from '../src/core/GameConfig';
import { FRAME_60, config, flushMicrotasks } from './helpers';

const cfg = config();

function setup(timings: WinSequenceConfig = cfg.winSequence) {
  const fountain = new CoinFountain({ ...cfg.particles, random: () => 0.5 });
  const log: string[] = [];
  const amounts: number[] = [];
  const view = {
    highlight: vi.fn(() => log.push('highlight')),
    clearHighlight: vi.fn(() => log.push('clear')),
    setWinAmount: vi.fn((a: number) => amounts.push(a)),
    setStep: vi.fn((s) => log.push(`step:${s}`)),
  } satisfies WinSequenceView;
  const ws = new WinSequence(timings, view, fountain);
  return { ws, fountain, view, log, amounts };
}

/** Drives update() until `p` settles; returns elapsed seconds and peak particle count. */
async function drive(ws: WinSequence, fountain: CoinFountain, p: Promise<WinSequenceResult>, dt = FRAME_60) {
  let result: WinSequenceResult | null = null;
  p.then((r) => (result = r));
  let t = 0;
  let peak = 0;
  await flushMicrotasks();
  while (!result) {
    ws.update(dt);
    fountain.update(dt);
    peak = Math.max(peak, fountain.activeCount);
    t += dt;
    await flushMicrotasks(4);
    if (t > 30) throw new Error('WinSequence hung');
  }
  return { result: result as WinSequenceResult, t, peak };
}

async function advanceTo(ws: WinSequence, fountain: CoinFountain, target: string, extraFrames = 10) {
  let frames = 0;
  while (ws.currentStep !== target) {
    ws.update(FRAME_60);
    fountain.update(FRAME_60);
    await flushMicrotasks(4);
    if (++frames > 1000) throw new Error(`never reached ${target}`);
  }
  for (let i = 0; i < extraFrames; i++) {
    ws.update(FRAME_60);
    fountain.update(FRAME_60);
    await flushMicrotasks(4);
  }
}

describe('WinSequence: completion', () => {
  it('runs HIGHLIGHT -> COUNT_UP -> COIN_FOUNTAIN and ends snapped, cleared and empty', async () => {
    const { ws, fountain, view, log, amounts } = setup();
    const positions = [{ reel: 0, row: 1 }, { reel: 1, row: 1 }];
    const { result, t, peak } = await drive(ws, fountain, ws.play({ amount: 120, positions }));
    expect(result).toEqual({ status: 'completed', finalAmount: 120, lastStep: 'COIN_FOUNTAIN' });
    expect(log).toEqual(['step:HIGHLIGHT', 'highlight', 'step:COUNT_UP', 'step:COIN_FOUNTAIN', 'clear', 'step:null']);
    expect(view.highlight).toHaveBeenCalledWith(positions);
    // Counter: starts at 0 (already 0 -> not re-written), monotonic count-up, ends at amount.
    expect(amounts.at(-1)).toBe(120);
    for (let i = 1; i < amounts.length; i++) expect(amounts[i]).toBeGreaterThanOrEqual(amounts[i - 1]);
    expect(amounts.length).toBeGreaterThan(10);
    expect(peak).toBeGreaterThan(50);
    expect(fountain.activeCount).toBe(0);
    expect(fountain.isEmitting).toBe(false);
    expect(ws.isPlaying).toBe(false);
    expect(ws.currentStep).toBeNull();
    const nominal = (700 + 1400 + 1500 + 1100) / 1000;
    expect(t).toBeGreaterThanOrEqual(nominal - 1e-9);
    expect(t).toBeLessThan(nominal + 5 * FRAME_60);
  });

  it('completes immediately with all-zero timings', async () => {
    const { ws, fountain } = setup({ highlightMs: 0, countUpMs: 0, fountainMs: 0, settleMs: 0, coinsPerSecond: 50 });
    let r: WinSequenceResult | null = null;
    ws.play({ amount: 5, positions: [] }).then((x) => (r = x));
    await flushMicrotasks();
    expect(r).toEqual({ status: 'completed', finalAmount: 5, lastStep: 'COIN_FOUNTAIN' });
    expect(fountain.activeCount).toBe(0);
  });

  it('clamps negative amounts to 0 and ignores non-positive dt', async () => {
    const { ws, fountain } = setup();
    const p = ws.play({ amount: -10, positions: [] });
    ws.update(0);
    ws.update(-1);
    ws.update(Number.NaN);
    expect(ws.currentStep).toBe('HIGHLIGHT');
    const { result } = await drive(ws, fountain, p);
    expect(result.finalAmount).toBe(0);
  });
});

describe('WinSequence: abort / slam-stop', () => {
  it.each(['HIGHLIGHT', 'COUNT_UP', 'COIN_FOUNTAIN'] as const)(
    'abort during %s resolves on microtasks with counter snapped and pool emptied',
    async (target) => {
      const { ws, fountain, view } = setup();
      const controller = new AbortController();
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
      let result: WinSequenceResult | null = null;
      ws.play({ amount: 300, positions: [{ reel: 2, row: 0 }] }, controller.signal).then((r) => (result = r));
      await advanceTo(ws, fountain, target);
      if (target === 'COIN_FOUNTAIN') expect(fountain.activeCount).toBeGreaterThan(0);
      if (target === 'COUNT_UP') expect(ws.displayedAmount).toBeLessThan(300);

      controller.abort();
      await flushMicrotasks();
      expect(result).toEqual({ status: 'aborted', finalAmount: 300, lastStep: target });
      expect(ws.displayedAmount).toBe(300);
      expect(view.setWinAmount).toHaveBeenLastCalledWith(300);
      expect(view.clearHighlight).toHaveBeenCalledTimes(1);
      expect(fountain.activeCount).toBe(0);
      expect(fountain.isEmitting).toBe(false);
      expect(ws.isPlaying).toBe(false);
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

      // Frames after the abort must not resurrect anything.
      for (let i = 0; i < 60; i++) {
        ws.update(FRAME_60);
        fountain.update(FRAME_60);
      }
      expect(fountain.activeCount).toBe(0);
      expect(ws.displayedAmount).toBe(300);
    },
  );

  it('a pre-aborted signal resolves aborted without starting any step', async () => {
    const { ws, view } = setup();
    const c = new AbortController();
    c.abort();
    const r = await ws.play({ amount: 50, positions: [{ reel: 0, row: 0 }] }, c.signal);
    expect(r).toEqual({ status: 'aborted', finalAmount: 50, lastStep: null });
    expect(view.highlight).not.toHaveBeenCalled();
    expect(ws.displayedAmount).toBe(50);
  });

  it('skip() aborts without an AbortController; aborting after completion is a no-op', async () => {
    const { ws, fountain } = setup();
    const p = ws.play({ amount: 10, positions: [] });
    await advanceTo(ws, fountain, 'COUNT_UP', 2);
    ws.skip();
    await expect(p).resolves.toMatchObject({ status: 'aborted', lastStep: 'COUNT_UP' });

    const c = new AbortController();
    const done = await drive(ws, fountain, ws.play({ amount: 7, positions: [] }, c.signal));
    expect(done.result.status).toBe('completed');
    expect(() => c.abort()).not.toThrow();
    ws.skip();
    expect(ws.displayedAmount).toBe(7);
  });

  it('abort exactly between steps (after a step resolved, before the next starts) still aborts', async () => {
    const { ws, fountain } = setup();
    const c = new AbortController();
    let result: WinSequenceResult | null = null;
    ws.play({ amount: 40, positions: [] }, c.signal).then((r) => (result = r));
    // Finish HIGHLIGHT in one capped frame, then abort before microtasks run.
    for (let i = 0; i < 7; i++) ws.update(0.1);
    expect(ws.currentStep).toBe('HIGHLIGHT');
    c.abort();
    await flushMicrotasks();
    expect(result).toMatchObject({ status: 'aborted', finalAmount: 40, lastStep: 'HIGHLIGHT' });
    expect(fountain.activeCount).toBe(0);
  });

  it('a new play() pre-empts the old one, which resolves aborted without touching the view', async () => {
    const { ws, fountain, view } = setup();
    let first: WinSequenceResult | null = null;
    ws.play({ amount: 11, positions: [] }).then((r) => (first = r));
    await advanceTo(ws, fountain, 'COIN_FOUNTAIN');
    const clearsBefore = view.clearHighlight.mock.calls.length;
    const second = ws.play({ amount: 22, positions: [] });
    await flushMicrotasks();
    expect(first).toMatchObject({ status: 'aborted', finalAmount: 11 });
    expect(view.clearHighlight.mock.calls.length).toBe(clearsBefore); // old run did not clear
    expect(ws.isPlaying).toBe(true);
    const { result } = await drive(ws, fountain, second);
    expect(result).toEqual({ status: 'completed', finalAmount: 22, lastStep: 'COIN_FOUNTAIN' });
    expect(fountain.activeCount).toBe(0);
  });

  it('100 back-to-back abort cycles leave no pending promises or particles', async () => {
    const { ws, fountain } = setup();
    const results: Promise<WinSequenceResult>[] = [];
    for (let i = 0; i < 100; i++) {
      const c = new AbortController();
      results.push(ws.play({ amount: i + 1, positions: [] }, c.signal));
      for (let f = 0; f < (i % 7) * 40; f++) {
        ws.update(FRAME_60);
        fountain.update(FRAME_60);
        if (f % 10 === 0) await flushMicrotasks(4);
      }
      c.abort();
      await flushMicrotasks();
    }
    const settled = await Promise.all(results);
    expect(settled).toHaveLength(100);
    expect(settled.every((r) => r.status === 'aborted' || r.status === 'completed')).toBe(true);
    expect(fountain.activeCount).toBe(0);
    expect(ws.isPlaying).toBe(false);
  });
});

describe('CoinFountain (pooled particles)', () => {
  it('pre-allocates poolSize particles and views, never more', () => {
    const factory = vi.fn((): ParticleView => ({ show: vi.fn(), hide: vi.fn(), render: vi.fn() }));
    const f = new CoinFountain({ ...cfg.particles, poolSize: 20, viewFactory: factory, random: () => 0.5 });
    expect(factory).toHaveBeenCalledTimes(20);
    f.startEmitting(1000);
    for (let i = 0; i < 120; i++) f.update(FRAME_60);
    expect(f.activeCount).toBeLessThanOrEqual(20);
    expect(f.pool.size).toBe(20);
    expect(factory).toHaveBeenCalledTimes(20);
  });

  it('drops the backlog when exhausted instead of bursting later', () => {
    const f = new CoinFountain({ ...cfg.particles, poolSize: 5, random: () => 0.5 });
    f.startEmitting(1000);
    f.update(0.1); // wants 100 coins
    expect(f.activeCount).toBe(5);
    f.stopEmitting();
    f.releaseAll();
    f.startEmitting(10);
    f.update(0.1);
    expect(f.activeCount).toBe(1); // no stale backlog
  });

  it('applies v += g*dt, x += v*dt and expires particles after their lifetime', () => {
    const f = new CoinFountain({ ...cfg.particles, poolSize: 1, random: () => 0.5, originX: 100, originY: 200 });
    expect(f.burst(3)).toBe(1);
    const p = (() => {
      let found: CoinParticle | null = null;
      f.pool.forEachActive((x) => (found = x));
      return found as unknown as CoinParticle;
    })();
    expect(p.x).toBe(100);
    expect(p.vy).toBeLessThan(0); // launched upward
    const vy0 = p.vy;
    f.update(0.01);
    expect(p.vy).toBeCloseTo(vy0 + cfg.particles.gravity * 0.01, 9);
    expect(p.y).toBeCloseTo(200 + p.vy * 0.01, 9);
    for (let i = 0; i < 200 && f.activeCount > 0; i++) f.update(FRAME_60);
    expect(f.activeCount).toBe(0);
    expect(p.age).toBe(0); // reset on release
  });

  it('shows on acquire, hides on release and renders only active particles', () => {
    const views: Array<{ show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn> }> = [];
    const f = new CoinFountain({
      ...cfg.particles,
      poolSize: 3,
      random: () => 0.5,
      viewFactory: () => {
        const v = { show: vi.fn(), hide: vi.fn(), render: vi.fn() };
        views.push(v);
        return v;
      },
    });
    f.burst(2);
    f.render();
    expect(views.filter((v) => v.show.mock.calls.length === 1)).toHaveLength(2);
    expect(views.filter((v) => v.render.mock.calls.length === 1)).toHaveLength(2);
    expect(f.releaseAll()).toBe(2);
    expect(views.filter((v) => v.hide.mock.calls.length === 1)).toHaveLength(2);
    f.render();
    expect(views.reduce((s, v) => s + v.render.mock.calls.length, 0)).toBe(2);
  });
});
