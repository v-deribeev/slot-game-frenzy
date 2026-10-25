/**
 * Runtime parser + validator for the declarative game DSL (`game-dsl.json`).
 *
 * The JSON is imported as `unknown` data and narrowed field by field, so a malformed
 * config fails fast with a precise path (e.g. `reelStrips[1][4]`) instead of producing
 * undefined behaviour deep inside the engine.
 */

export type BehaviorConfig =
  | { readonly type: 'wild'; readonly excludes: readonly string[] }
  | { readonly type: 'multiplier'; readonly value: number; readonly onlyWhenSubstituting: boolean };

export interface SymbolConfig {
  readonly id: string;
  readonly name: string;
  readonly glyph: string;
  readonly color: string;
  /** Pay for 3-of-a-kind on a line, expressed as a multiple of the line bet. */
  readonly pay: number;
  readonly behaviors: readonly BehaviorConfig[];
}

export interface ReelTimingConfig {
  /** Symbols per second while spinning at full speed. */
  readonly spinSpeed: number;
  readonly minSpinMs: number;
  readonly stopStaggerMs: number;
  readonly stopDurationMs: number;
  /** easeOutBack overshoot factor used for the landing bounce (0 = no bounce). */
  readonly stopOvershoot: number;
}

export interface WinSequenceConfig {
  readonly highlightMs: number;
  readonly countUpMs: number;
  readonly fountainMs: number;
  readonly settleMs: number;
  readonly coinsPerSecond: number;
}

export interface ParticleConfig {
  readonly poolSize: number;
  readonly gravity: number;
  readonly lifetimeMs: number;
  readonly speedMin: number;
  readonly speedMax: number;
  readonly spreadDeg: number;
}

export interface ServerConfig {
  readonly latencyMs: number;
  readonly failureRate: number;
}

export interface GameConfig {
  readonly version: number;
  readonly name: string;
  readonly currency: string;
  readonly startingBalance: number;
  readonly grid: { readonly reels: number; readonly rows: number };
  readonly bet: { readonly levels: readonly number[]; readonly defaultIndex: number };
  readonly symbols: readonly SymbolConfig[];
  readonly paylines: readonly (readonly number[])[];
  readonly reelStrips: readonly (readonly string[])[];
  readonly reels: ReelTimingConfig;
  readonly winSequence: WinSequenceConfig;
  readonly particles: ParticleConfig;
  readonly server: ServerConfig;
}

export class DslValidationError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`Invalid game DSL at "${path}": ${message}`);
    this.name = 'DslValidationError';
    this.path = path;
  }
}

type Json = Record<string, unknown>;

function obj(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DslValidationError(path, 'expected an object');
  }
  return value as Json;
}

function arr(value: unknown, path: string, minLength = 0): unknown[] {
  if (!Array.isArray(value)) throw new DslValidationError(path, 'expected an array');
  if (value.length < minLength) {
    throw new DslValidationError(path, `expected at least ${minLength} item(s), got ${value.length}`);
  }
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DslValidationError(path, 'expected a non-empty string');
  }
  return value;
}

interface NumOpts {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

function num(value: unknown, path: string, opts: NumOpts = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DslValidationError(path, 'expected a finite number');
  }
  if (opts.integer === true && !Number.isInteger(value)) {
    throw new DslValidationError(path, 'expected an integer');
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new DslValidationError(path, `expected >= ${opts.min}, got ${value}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new DslValidationError(path, `expected <= ${opts.max}, got ${value}`);
  }
  return value;
}

function bool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new DslValidationError(path, 'expected a boolean');
  return value;
}

/** Colours are injected into generated CSS, so only plain hex literals are accepted. */
function hexColor(value: unknown, path: string): string {
  const s = str(value, path);
  if (!/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) {
    throw new DslValidationError(path, `expected a hex colour like #ff00aa, got "${s}"`);
  }
  return s;
}

function parseBehavior(raw: unknown, path: string): BehaviorConfig {
  const o = obj(raw, path);
  const type = str(o.type, `${path}.type`);
  switch (type) {
    case 'wild': {
      const excludes = o.excludes === undefined ? [] : arr(o.excludes, `${path}.excludes`);
      return Object.freeze({
        type: 'wild',
        excludes: Object.freeze(excludes.map((e, i) => str(e, `${path}.excludes[${i}]`))),
      });
    }
    case 'multiplier':
      return Object.freeze({
        type: 'multiplier',
        value: num(o.value, `${path}.value`, { min: 1 }),
        onlyWhenSubstituting: bool(o.onlyWhenSubstituting, `${path}.onlyWhenSubstituting`, true),
      });
    default:
      throw new DslValidationError(`${path}.type`, `unknown behavior type "${type}"`);
  }
}

function parseSymbol(raw: unknown, path: string): SymbolConfig {
  const o = obj(raw, path);
  const behaviors = o.behaviors === undefined ? [] : arr(o.behaviors, `${path}.behaviors`);
  return Object.freeze({
    id: str(o.id, `${path}.id`),
    name: str(o.name, `${path}.name`),
    glyph: str(o.glyph, `${path}.glyph`),
    color: hexColor(o.color, `${path}.color`),
    pay: num(o.pay, `${path}.pay`, { min: 0 }),
    behaviors: Object.freeze(behaviors.map((b, i) => parseBehavior(b, `${path}.behaviors[${i}]`))),
  });
}

/**
 * Validates arbitrary JSON against the game DSL schema and returns a deeply frozen,
 * fully typed {@link GameConfig}. Throws {@link DslValidationError} on the first problem.
 */
export function parseGameConfig(raw: unknown): GameConfig {
  const root = obj(raw, '$');

  const version = num(root.version, 'version', { integer: true, min: 1 });
  const name = str(root.name, 'name');
  const currency = str(root.currency, 'currency');
  const startingBalance = num(root.startingBalance, 'startingBalance', { min: 0 });

  const gridRaw = obj(root.grid, 'grid');
  const grid = Object.freeze({
    reels: num(gridRaw.reels, 'grid.reels', { integer: true, min: 1 }),
    rows: num(gridRaw.rows, 'grid.rows', { integer: true, min: 1 }),
  });

  const betRaw = obj(root.bet, 'bet');
  const levels = arr(betRaw.levels, 'bet.levels', 1).map((v, i) =>
    num(v, `bet.levels[${i}]`, { min: Number.MIN_VALUE }),
  );
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] <= levels[i - 1]) {
      throw new DslValidationError(`bet.levels[${i}]`, 'bet levels must be strictly ascending');
    }
  }
  const bet = Object.freeze({
    levels: Object.freeze(levels),
    defaultIndex: num(betRaw.defaultIndex, 'bet.defaultIndex', {
      integer: true,
      min: 0,
      max: levels.length - 1,
    }),
  });

  const symbols = Object.freeze(
    arr(root.symbols, 'symbols', 1).map((s, i) => parseSymbol(s, `symbols[${i}]`)),
  );
  const ids = new Set<string>();
  symbols.forEach((s, i) => {
    if (ids.has(s.id)) throw new DslValidationError(`symbols[${i}].id`, `duplicate symbol id "${s.id}"`);
    ids.add(s.id);
  });
  symbols.forEach((s, i) =>
    s.behaviors.forEach((b, j) => {
      if (b.type !== 'wild') return;
      b.excludes.forEach((ex, k) => {
        if (!ids.has(ex)) {
          throw new DslValidationError(`symbols[${i}].behaviors[${j}].excludes[${k}]`, `unknown symbol "${ex}"`);
        }
      });
    }),
  );

  const paylines = Object.freeze(
    arr(root.paylines, 'paylines', 1).map((line, i) => {
      const rows = arr(line, `paylines[${i}]`);
      if (rows.length !== grid.reels) {
        throw new DslValidationError(`paylines[${i}]`, `expected ${grid.reels} entries (one per reel)`);
      }
      return Object.freeze(
        rows.map((r, j) => num(r, `paylines[${i}][${j}]`, { integer: true, min: 0, max: grid.rows - 1 })),
      );
    }),
  );

  const stripsRaw = arr(root.reelStrips, 'reelStrips');
  if (stripsRaw.length !== grid.reels) {
    throw new DslValidationError('reelStrips', `expected ${grid.reels} strips (one per reel), got ${stripsRaw.length}`);
  }
  const reelStrips = Object.freeze(
    stripsRaw.map((strip, i) =>
      Object.freeze(
        arr(strip, `reelStrips[${i}]`, grid.rows + 1).map((id, j) => {
          const sid = str(id, `reelStrips[${i}][${j}]`);
          if (!ids.has(sid)) throw new DslValidationError(`reelStrips[${i}][${j}]`, `unknown symbol "${sid}"`);
          return sid;
        }),
      ),
    ),
  );

  const reelsRaw = obj(root.reels, 'reels');
  const reels: ReelTimingConfig = Object.freeze({
    spinSpeed: num(reelsRaw.spinSpeed, 'reels.spinSpeed', { min: Number.MIN_VALUE }),
    minSpinMs: num(reelsRaw.minSpinMs, 'reels.minSpinMs', { min: 0 }),
    stopStaggerMs: num(reelsRaw.stopStaggerMs, 'reels.stopStaggerMs', { min: 0 }),
    stopDurationMs: num(reelsRaw.stopDurationMs, 'reels.stopDurationMs', { min: 1 }),
    stopOvershoot: num(reelsRaw.stopOvershoot, 'reels.stopOvershoot', { min: 0, max: 5 }),
  });

  const wsRaw = obj(root.winSequence, 'winSequence');
  const winSequence: WinSequenceConfig = Object.freeze({
    highlightMs: num(wsRaw.highlightMs, 'winSequence.highlightMs', { min: 0 }),
    countUpMs: num(wsRaw.countUpMs, 'winSequence.countUpMs', { min: 0 }),
    fountainMs: num(wsRaw.fountainMs, 'winSequence.fountainMs', { min: 0 }),
    settleMs: num(wsRaw.settleMs, 'winSequence.settleMs', { min: 0 }),
    coinsPerSecond: num(wsRaw.coinsPerSecond, 'winSequence.coinsPerSecond', { min: 0 }),
  });

  const pRaw = obj(root.particles, 'particles');
  const speedMin = num(pRaw.speedMin, 'particles.speedMin', { min: 0 });
  const particles: ParticleConfig = Object.freeze({
    poolSize: num(pRaw.poolSize, 'particles.poolSize', { integer: true, min: 1 }),
    gravity: num(pRaw.gravity, 'particles.gravity'),
    lifetimeMs: num(pRaw.lifetimeMs, 'particles.lifetimeMs', { min: 1 }),
    speedMin,
    speedMax: num(pRaw.speedMax, 'particles.speedMax', { min: speedMin }),
    spreadDeg: num(pRaw.spreadDeg, 'particles.spreadDeg', { min: 0, max: 360 }),
  });

  const sRaw = obj(root.server, 'server');
  const server: ServerConfig = Object.freeze({
    latencyMs: num(sRaw.latencyMs, 'server.latencyMs', { min: 0 }),
    failureRate: num(sRaw.failureRate, 'server.failureRate', { min: 0, max: 1 }),
  });

  return Object.freeze({
    version,
    name,
    currency,
    startingBalance,
    grid,
    bet,
    symbols,
    paylines,
    reelStrips,
    reels,
    winSequence,
    particles,
    server,
  });
}
