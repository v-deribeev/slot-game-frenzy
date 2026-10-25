import { describe, expect, it } from 'vitest';
import rawDsl from '../src/core/game-dsl.json';
import { DslValidationError, parseGameConfig } from '../src/core/GameConfig';
import {
  SERVER_ERROR_CODES,
  SpinServerError,
  buildGrid,
  createRng,
  createSpinServer,
  toSeed,
  type SpinResponse,
} from '../src/core/legacy-rng.js';
import { PayoutEvaluator } from '../src/core/PayoutEvaluator';
import { createSymbolRegistry } from '../src/entities/SlotSymbol';
import { rawConfig } from './helpers';

function expectPath(mutate: (raw: Record<string, any>) => void, path: string): void {
  const raw = rawConfig();
  mutate(raw);
  let err: unknown;
  try {
    parseGameConfig(raw);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(DslValidationError);
  expect((err as DslValidationError).path).toBe(path);
}

describe('DSL parsing (game-dsl.json)', () => {
  it('parses the shipped DSL into a deeply frozen config', () => {
    const cfg = parseGameConfig(rawDsl as unknown);
    expect(cfg.grid).toEqual({ reels: 3, rows: 3 });
    expect(cfg.symbols.map((s) => s.id)).toContain('WILD');
    expect(cfg.paylines).toHaveLength(5);
    expect(cfg.reelStrips).toHaveLength(3);
    for (const v of [cfg, cfg.grid, cfg.bet, cfg.bet.levels, cfg.symbols, cfg.symbols[0], cfg.symbols[0].behaviors,
      cfg.symbols[0].behaviors[0], cfg.paylines, cfg.paylines[0], cfg.reelStrips, cfg.reelStrips[0], cfg.reels,
      cfg.winSequence, cfg.particles, cfg.server]) {
      expect(Object.isFrozen(v)).toBe(true);
    }
  });

  it('defaults optional fields (behaviors, wild excludes, onlyWhenSubstituting)', () => {
    const raw = rawConfig();
    delete raw.symbols[1].behaviors;
    raw.symbols[0].behaviors = [{ type: 'wild' }, { type: 'multiplier', value: 3 }];
    const cfg = parseGameConfig(raw);
    expect(cfg.symbols[1].behaviors).toEqual([]);
    expect(cfg.symbols[0].behaviors).toEqual([
      { type: 'wild', excludes: [] },
      { type: 'multiplier', value: 3, onlyWhenSubstituting: true },
    ]);
  });

  it.each<[string, (r: Record<string, any>) => void, string]>([
    ['root not an object', () => {}, '$'],
    ['version 0', (r) => (r.version = 0), 'version'],
    ['version fractional', (r) => (r.version = 1.5), 'version'],
    ['empty name', (r) => (r.name = ''), 'name'],
    ['negative balance', (r) => (r.startingBalance = -1), 'startingBalance'],
    ['grid rows 0', (r) => (r.grid.rows = 0), 'grid.rows'],
    ['no bet levels', (r) => (r.bet.levels = []), 'bet.levels'],
    ['zero bet level', (r) => (r.bet.levels = [0, 5]), 'bet.levels[0]'],
    ['non-ascending bets', (r) => (r.bet.levels = [5, 5, 10]), 'bet.levels[1]'],
    ['defaultIndex out of range', (r) => (r.bet.defaultIndex = 9), 'bet.defaultIndex'],
    ['no symbols', (r) => (r.symbols = []), 'symbols'],
    ['bad colour (CSS injection)', (r) => (r.symbols[2].color = 'red;}body{display:none'), 'symbols[2].color'],
    ['negative pay', (r) => (r.symbols[1].pay = -1), 'symbols[1].pay'],
    ['unknown behaviour', (r) => (r.symbols[0].behaviors[0].type = 'scatter'), 'symbols[0].behaviors[0].type'],
    ['multiplier < 1', (r) => (r.symbols[0].behaviors[1].value = 0.5), 'symbols[0].behaviors[1].value'],
    ['onlyWhenSubstituting not boolean', (r) => (r.symbols[0].behaviors[1].onlyWhenSubstituting = 'yes'), 'symbols[0].behaviors[1].onlyWhenSubstituting'],
    ['unknown wild exclude', (r) => (r.symbols[0].behaviors[0].excludes = ['GHOST']), 'symbols[0].behaviors[0].excludes[0]'],
    ['duplicate symbol id', (r) => (r.symbols[2].id = 'SEVEN'), 'symbols[2].id'],
    ['payline wrong length', (r) => (r.paylines[1] = [1, 1]), 'paylines[1]'],
    ['payline row out of range', (r) => (r.paylines[0][2] = 3), 'paylines[0][2]'],
    ['wrong strip count', (r) => r.reelStrips.pop(), 'reelStrips'],
    ['strip too short', (r) => (r.reelStrips[0] = ['SEVEN', 'BAR', 'CLUB']), 'reelStrips[0]'],
    ['unknown strip symbol', (r) => (r.reelStrips[1][4] = 'GHOST'), 'reelStrips[1][4]'],
    ['spinSpeed 0', (r) => (r.reels.spinSpeed = 0), 'reels.spinSpeed'],
    ['stopDuration 0', (r) => (r.reels.stopDurationMs = 0), 'reels.stopDurationMs'],
    ['negative highlight', (r) => (r.winSequence.highlightMs = -1), 'winSequence.highlightMs'],
    ['string timing', (r) => (r.winSequence.countUpMs = '1400'), 'winSequence.countUpMs'],
    ['pool size 0', (r) => (r.particles.poolSize = 0), 'particles.poolSize'],
    ['speedMax < speedMin', (r) => (r.particles.speedMax = 1), 'particles.speedMax'],
    ['failureRate > 1', (r) => (r.server.failureRate = 1.5), 'server.failureRate'],
    ['missing section', (r) => delete r.particles, 'particles'],
  ])('rejects %s at the exact path', (name, mutate, path) => {
    if (name === 'root not an object') {
      for (const bad of [null, [], 'x', 3]) {
        expect(() => parseGameConfig(bad)).toThrow(DslValidationError);
      }
      expect(() => parseGameConfig(null)).toThrow(/"\$"/);
      return;
    }
    expectPath(mutate, path);
  });

  it('rejects non-finite numbers', () => {
    expectPath((r) => (r.startingBalance = Number.POSITIVE_INFINITY), 'startingBalance');
  });
});

describe('legacy RNG (mulberry32)', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = createRng(123);
    const b = createRng(123);
    const c = createRng(124);
    const sa = Array.from({ length: 50 }, () => a.next());
    expect(Array.from({ length: 50 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 50 }, () => c.next())).not.toEqual(sa);
    expect(a.getState()).toBe(b.getState());
  });

  it('produces floats in [0, 1) and roughly uniform integers', () => {
    const rng = createRng(2026);
    const buckets = new Array(20).fill(0);
    for (let i = 0; i < 20_000; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      buckets[rng.nextInt(20)]++;
    }
    // Chi-square, 19 dof: p=0.001 critical value ~43.8.
    const expected = 1000;
    const chi = buckets.reduce((s, o) => s + ((o - expected) ** 2) / expected, 0);
    expect(chi).toBeLessThan(43.8);
  });

  it('nextInt validates its argument', () => {
    const rng = createRng(1);
    for (const bad of [0, -1, 2.5, Number.NaN]) expect(() => rng.nextInt(bad)).toThrow(RangeError);
  });

  it('toSeed: numbers and numeric strings verbatim, other strings hashed deterministically', () => {
    expect(toSeed(42)).toBe(42);
    expect(toSeed(-1)).toBe(0xffffffff);
    expect(toSeed(' 1234 ')).toBe(1234);
    expect(toSeed('amaze')).toBe(toSeed('amaze'));
    expect(toSeed('amaze')).not.toBe(toSeed('amazf'));
    expect(toSeed('amaze')).toBeGreaterThanOrEqual(0);
  });

  it('buildGrid is column-major with wrap-around', () => {
    const strips = [['A', 'B', 'C', 'D'], ['E', 'F', 'G', 'H']];
    expect(buildGrid(strips, [3, 0], 3)).toEqual([['D', 'A', 'B'], ['E', 'F', 'G']]);
    expect(() => buildGrid(strips, [0], 3)).toThrow(RangeError);
  });
});

describe('legacy spin server', () => {
  const cfg = parseGameConfig(rawDsl as unknown);
  const evaluator = new PayoutEvaluator(createSymbolRegistry(cfg.symbols), cfg.paylines);
  const base = { reelStrips: cfg.reelStrips, rows: cfg.grid.rows, evaluate: evaluator.evaluate.bind(evaluator) };

  async function sequence(seed: number, n: number, latencyMs = 0): Promise<SpinResponse[]> {
    const timers: Array<() => void> = [];
    const server = createSpinServer({ ...base, seed, latencyMs, schedule: (cb) => timers.push(cb) });
    const promises = Array.from({ length: n }, () => server.spin(10));
    timers.forEach((t) => t());
    return Promise.all(promises);
  }

  it('returns grid-consistent responses with 1-based spin ids', async () => {
    const [r1, r2] = await sequence(9, 2);
    expect(r1.spinId).toBe(1);
    expect(r2.spinId).toBe(2);
    expect(r1.grid).toEqual(buildGrid(cfg.reelStrips, r1.stops, cfg.grid.rows));
    expect(r1.win).toEqual(evaluator.evaluate(r1.grid, 10));
    expect(r1.bet).toBe(10);
  });

  it('is deterministic per seed regardless of latency', async () => {
    const instant = await sequence(77, 30, 0);
    const delayed = await sequence(77, 30, 250);
    expect(delayed).toEqual(instant);
    expect(await sequence(78, 30)).not.toEqual(instant);
  });

  it('honours injected latency via schedule()', async () => {
    const timers: Array<{ cb: () => void; ms: number }> = [];
    const server = createSpinServer({ ...base, seed: 1, latencyMs: 280, schedule: (cb, ms) => timers.push({ cb, ms }) });
    let done = false;
    server.spin(10).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    expect(timers[0].ms).toBe(280);
    timers[0].cb();
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('rejects invalid bets with INVALID_BET (async, without consuming a spin)', async () => {
    const server = createSpinServer({ ...base, seed: 1 });
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '10' as unknown as number]) {
      const p = server.spin(bad);
      await expect(p).rejects.toBeInstanceOf(SpinServerError);
      await expect(p).rejects.toMatchObject({ code: SERVER_ERROR_CODES.INVALID_BET });
    }
    expect(server.getSpinCount()).toBe(0);
  });

  it('simulates NETWORK_TIMEOUT at failureRate 1 and never at 0', async () => {
    const failing = createSpinServer({ ...base, seed: 1, failureRate: 1 });
    await expect(failing.spin(10)).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT', name: 'SpinServerError' });
    const ok = createSpinServer({ ...base, seed: 1, failureRate: 0 });
    await expect(ok.spin(10)).resolves.toHaveProperty('stops');
    expect(failing.getSeed()).toBe(1);
  });

  it('surfaces evaluator exceptions as rejections, never synchronous throws', async () => {
    const server = createSpinServer({ ...base, seed: 1, evaluate: () => { throw new Error('eval broke'); } });
    let p: Promise<SpinResponse> | undefined;
    expect(() => (p = server.spin(10))).not.toThrow();
    await expect(p).rejects.toThrow('eval broke');
  });
});
