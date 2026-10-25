/**
 * Composition root shared by the browser (`main.ts`) and headless tests.
 * Wires DSL config -> symbols -> evaluator -> legacy server -> reels -> fountain -> win
 * sequence -> game, with every view adapter optional.
 */

import type { GameConfig } from './GameConfig';
import { createSpinServer, type SpinServer } from './legacy-rng.js';
import { PayoutEvaluator } from './PayoutEvaluator';
import { SlotGame, type SlotGameHooks } from './SlotGame';
import { StateMachine } from './StateMachine';
import { NULL_WIN_VIEW, WinSequence, type WinSequenceView } from './WinSequence';
import { CoinFountain, type ParticleView } from '../entities/CoinFountain';
import { ReelSet } from '../entities/ReelSet';
import { createSymbolRegistry, type SymbolRegistry } from '../entities/SlotSymbol';

export interface CreateSlotGameOptions {
  readonly seed: number;
  /** Overrides `config.server.latencyMs` (use 0 in tests). */
  readonly latencyMs?: number;
  /** Overrides `config.server.failureRate`. */
  readonly failureRate?: number;
  readonly winView?: WinSequenceView;
  readonly particleViewFactory?: () => ParticleView | null;
  /** Random source for cosmetic particle motion (defaults to Math.random). */
  readonly particleRandom?: () => number;
  readonly hooks?: SlotGameHooks;
  /** Inject a custom server (e.g. a scripted stub). */
  readonly server?: SpinServer;
  readonly initialStops?: readonly number[];
  /** Reuse an existing registry (e.g. one already used to build the view). */
  readonly symbols?: SymbolRegistry;
}

export interface SlotEngine {
  readonly config: GameConfig;
  readonly symbols: SymbolRegistry;
  readonly evaluator: PayoutEvaluator;
  readonly server: SpinServer;
  readonly fsm: StateMachine;
  readonly reels: ReelSet;
  readonly fountain: CoinFountain;
  readonly winSequence: WinSequence;
  readonly game: SlotGame;
  /** Advances every simulated system by `dt` seconds (register this with the GameLoop). */
  readonly update: (dt: number) => void;
}

export function createSlotGame(config: GameConfig, options: CreateSlotGameOptions): SlotEngine {
  const symbols = options.symbols ?? createSymbolRegistry(config.symbols);
  const evaluator = new PayoutEvaluator(symbols, config.paylines);
  const server =
    options.server ??
    createSpinServer({
      reelStrips: config.reelStrips,
      rows: config.grid.rows,
      seed: options.seed,
      evaluate: (grid, bet) => evaluator.evaluate(grid, bet),
      latencyMs: options.latencyMs ?? config.server.latencyMs,
      failureRate: options.failureRate ?? config.server.failureRate,
    });
  const fsm = new StateMachine();
  const reels = new ReelSet(config.reelStrips, config.grid.rows, config.reels, options.initialStops);
  const fountain = new CoinFountain({
    ...config.particles,
    viewFactory: options.particleViewFactory,
    random: options.particleRandom,
  });
  const winSequence = new WinSequence(config.winSequence, options.winView ?? NULL_WIN_VIEW, fountain);
  const game = new SlotGame({ config, server, reels, winSequence, fsm, hooks: options.hooks });

  const update = (dt: number): void => {
    reels.update(dt);
    winSequence.update(dt);
    fountain.update(dt);
  };

  return { config, symbols, evaluator, server, fsm, reels, fountain, winSequence, game, update };
}
