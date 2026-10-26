/**
 * Browser composition root: wires DSL -> engine -> DOM view -> game loop -> input.
 *
 * Everything it attaches (window/button listeners, the rAF loop, generated DOM) is released by
 * the returned `dispose()`, so Vite HMR can re-mount without duplicate Space handlers.
 */

import rawDsl from './core/game-dsl.json';
import { parseGameConfig } from './core/GameConfig';
import { createSlotGame, type SlotEngine } from './core/createSlotGame';
import { GameLoop, type GameLoopOptions } from './core/GameLoop';
import { createSymbolRegistry } from './entities/SlotSymbol';
import { SlotView } from './ui/SlotView';

export interface MountOptions {
  readonly seed: number;
  /** Injectable rAF/clock (tests). */
  readonly loop?: GameLoopOptions;
}

export interface MountedSlotGame {
  readonly engine: SlotEngine;
  readonly view: SlotView;
  readonly loop: GameLoop;
  dispose(): void;
}

export function mountSlotGame(root: HTMLElement, options: MountOptions): MountedSlotGame {
  // 1. Declarative DSL, parsed and validated at runtime.
  const config = parseGameConfig(rawDsl as unknown);
  const symbols = createSymbolRegistry(config.symbols);
  const { seed } = options;

  // 2. DOM view (all nodes created up-front).
  const view = new SlotView(root, config, symbols);

  // 3. Engine: FSM, legacy server, reels, pooled coin fountain, win sequence, game.
  const engine = createSlotGame(config, {
    seed,
    symbols,
    winView: view,
    particleViewFactory: () => view.createCoinView(), // runs only during pool pre-allocation
    hooks: {
      onBalanceChange: (balance) => view.setBalance(balance),
      onBetChange: (bet, index) => view.setBet(bet, index, config.bet.levels.length),
      onWinAmount: (amount) => view.setWinAmount(amount),
    },
  });
  const { game, fsm, reels, fountain } = engine;

  view.setBalance(game.balance);
  view.setBet(game.bet, game.betIndex, config.bet.levels.length);
  view.setWinAmount(0);
  view.setSeed(seed);
  view.setState(fsm.state);
  const unsubscribe = fsm.subscribe((state) => view.setState(state));

  // One signal detaches every DOM listener below on dispose().
  const listeners = new AbortController();
  const { signal } = listeners;

  const syncOrigin = (): void => {
    const origin = view.fountainOrigin();
    fountain.setOrigin(origin.x, origin.y);
  };
  syncOrigin();
  window.addEventListener('resize', syncOrigin, { signal });

  // 4. 60 FPS loop: simulate with dt, then render. The closure is created once.
  const loop = new GameLoop(options.loop);
  const reelList = reels.reels;
  loop.add((dt) => {
    engine.update(dt);
    view.renderReels(reelList);
    fountain.render();
  });
  loop.start();

  // 5. Input: Space = spin (IDLE) / slam-stop (SPINNING) / skip (SHOWING_WIN) / ack (ERROR).
  const isSpace = (e: KeyboardEvent): boolean => e.code === 'Space' || e.key === ' ';
  window.addEventListener(
    'keydown',
    (e) => {
      if (!isSpace(e)) return;
      e.preventDefault(); // no page scroll and no implicit activation of a focused button
      if (e.repeat) return;
      game.handlePrimaryAction();
    },
    { signal },
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (isSpace(e)) e.preventDefault();
    },
    { signal },
  );

  // The HUD buttons are static markup that survives HMR, so they must be detached as well.
  view.hud.spin.addEventListener(
    'click',
    () => {
      game.handlePrimaryAction();
      view.hud.spin.blur();
    },
    { signal },
  );
  view.hud.betDown.addEventListener('click', () => game.changeBet(-1), { signal });
  view.hud.betUp.addEventListener('click', () => game.changeBet(1), { signal });

  let disposed = false;
  return {
    engine,
    view,
    loop,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.abort();
      loop.stop();
      game.dispose();
      unsubscribe();
      fountain.releaseAll();
      view.destroy();
    },
  };
}
