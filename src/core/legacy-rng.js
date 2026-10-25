// @ts-check
/**
 * legacy-rng.js -- pure Vanilla JS "legacy server" module.
 *
 * Simulates the remote game server: a seedable PRNG (mulberry32) picks reel stops,
 * builds the 3x3 symbol grid and returns a Promise resolving to a spin response
 * (grid + win data) after a configurable network latency.
 *
 * Payout evaluation is injected (`evaluate`) so the TypeScript engine owns the
 * symbol-behaviour rules while this module stays dependency-free. All types are
 * declared with JSDoc and consumed by TypeScript via `allowJs`.
 *
 * Determinism: the same `seed` always yields the same sequence of responses,
 * independent of latency, because the outcome is computed synchronously at call time.
 */

/**
 * @typedef {Object} Rng
 * @property {() => number} next Uniform float in [0, 1).
 * @property {(maxExclusive: number) => number} nextInt Uniform integer in [0, maxExclusive).
 * @property {() => number} getState Current 32-bit internal state (for snapshots/debugging).
 */

/**
 * @typedef {Object} WinLine
 * @property {number} lineIndex Index into the payline table.
 * @property {string} symbolId Paying symbol (wilds resolved to the substituted symbol).
 * @property {number[]} rows Row index per reel that forms this line.
 * @property {number} multiplier Product of all multiplier behaviours applied.
 * @property {number} payout Credits paid by this line.
 */

/**
 * @typedef {Object} WinData
 * @property {number} totalWin Sum of all line payouts (credits).
 * @property {WinLine[]} lines Winning lines only.
 * @property {string[]} winningSymbols Unique paying symbol ids, in line order.
 */

/**
 * @typedef {Object} SpinResponse
 * @property {number} spinId 1-based sequence number of this spin.
 * @property {number} bet Total bet for the spin.
 * @property {number[]} stops Top-row strip index for each reel.
 * @property {string[][]} grid Column-major symbol grid: `grid[reel][row]`.
 * @property {WinData} win
 */

/** @typedef {(grid: string[][], bet: number) => WinData} WinEvaluator */

/**
 * @typedef {Object} SpinServerOptions
 * @property {ReadonlyArray<ReadonlyArray<string>>} reelStrips One strip of symbol ids per reel.
 * @property {number} rows Visible rows per reel.
 * @property {number} seed 32-bit seed; identical seeds give identical spin sequences.
 * @property {WinEvaluator} evaluate Payout evaluator (owned by the TS engine).
 * @property {number} [latencyMs] Simulated network latency (default 0 => next microtask).
 * @property {number} [failureRate] Probability in [0, 1] of a simulated NETWORK_TIMEOUT.
 * @property {(callback: () => void, ms: number) => unknown} [schedule] Timer injection (default setTimeout).
 */

/**
 * @typedef {Object} SpinServer
 * @property {(bet: number) => Promise<SpinResponse>} spin Request one spin outcome.
 * @property {() => number} getSeed
 * @property {() => number} getSpinCount
 */

/** Error codes the legacy server can reject with. */
export const SERVER_ERROR_CODES = Object.freeze({
  INVALID_BET: 'INVALID_BET',
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
});

export class SpinServerError extends Error {
  /**
   * @param {string} code Machine-readable error code.
   * @param {string} message Human readable description.
   */
  constructor(code, message) {
    super(message);
    this.name = 'SpinServerError';
    /** @readonly */
    this.code = code;
  }
}

/**
 * Mulberry32 seedable PRNG. Fast, 32-bit state, good enough for game simulation.
 * @param {number} seed
 * @returns {Rng}
 */
export function createRng(seed) {
  let state = seed >>> 0;

  /** @returns {number} */
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * @param {number} maxExclusive
   * @returns {number}
   */
  function nextInt(maxExclusive) {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`nextInt expects a positive integer, got ${maxExclusive}`);
    }
    return Math.floor(next() * maxExclusive);
  }

  return { next, nextInt, getState: () => state };
}

/**
 * Hashes an arbitrary string (e.g. a `?seed=` URL param) into a 32-bit seed (FNV-1a).
 * Numeric strings are used verbatim.
 * @param {string | number} input
 * @returns {number}
 */
export function toSeed(input) {
  if (typeof input === 'number') return input >>> 0;
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) >>> 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < trimmed.length; i++) {
    hash ^= trimmed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Builds the column-major visible grid for the given stops.
 * @param {ReadonlyArray<ReadonlyArray<string>>} reelStrips
 * @param {ReadonlyArray<number>} stops
 * @param {number} rows
 * @returns {string[][]}
 */
export function buildGrid(reelStrips, stops, rows) {
  if (stops.length !== reelStrips.length) {
    throw new RangeError(`expected ${reelStrips.length} stops, got ${stops.length}`);
  }
  return reelStrips.map((strip, reel) => {
    /** @type {string[]} */
    const column = [];
    for (let row = 0; row < rows; row++) {
      column.push(strip[(((stops[reel] + row) % strip.length) + strip.length) % strip.length]);
    }
    return column;
  });
}

/**
 * Creates the simulated legacy spin server.
 * @param {SpinServerOptions} options
 * @returns {SpinServer}
 */
export function createSpinServer(options) {
  const { reelStrips, rows, seed, evaluate } = options;
  const latencyMs = Math.max(0, options.latencyMs ?? 0);
  const failureRate = Math.min(1, Math.max(0, options.failureRate ?? 0));
  const schedule = options.schedule ?? ((cb, ms) => setTimeout(cb, ms));
  const rng = createRng(seed);
  let spinCount = 0;

  /**
   * @template T
   * @param {() => T} produce
   * @returns {Promise<T>}
   */
  function deliver(produce) {
    return new Promise((resolve, reject) => {
      const run = () => {
        try {
          resolve(produce());
        } catch (err) {
          reject(err);
        }
      };
      if (latencyMs === 0) queueMicrotask(run);
      else schedule(run, latencyMs);
    });
  }

  /**
   * @param {number} bet
   * @returns {Promise<SpinResponse>}
   */
  function spin(bet) {
    if (typeof bet !== 'number' || !Number.isFinite(bet) || bet <= 0) {
      return deliver(() => {
        throw new SpinServerError(SERVER_ERROR_CODES.INVALID_BET, `Invalid bet: ${bet}`);
      });
    }

    // Outcome is decided synchronously so latency never affects determinism.
    const spinId = ++spinCount;
    const failed = failureRate > 0 && rng.next() < failureRate;
    if (failed) {
      return deliver(() => {
        throw new SpinServerError(SERVER_ERROR_CODES.NETWORK_TIMEOUT, `Spin #${spinId} timed out`);
      });
    }

    const stops = reelStrips.map((strip) => rng.nextInt(strip.length));
    /** @type {SpinResponse} */
    let response;
    try {
      const grid = buildGrid(reelStrips, stops, rows);
      response = { spinId, bet, stops, grid, win: evaluate(grid, bet) };
    } catch (err) {
      // Never throw synchronously from an async API: surface as a rejection.
      return deliver(() => {
        throw err;
      });
    }
    const result = response;
    return deliver(() => result);
  }

  return {
    spin,
    getSeed: () => seed >>> 0,
    getSpinCount: () => spinCount,
  };
}
