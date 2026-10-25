import './styles/main.scss';
import rawDsl from './core/game-dsl.json';
import { parseGameConfig } from './core/GameConfig';
import { createSlotGame } from './core/createSlotGame';
import { GameLoop } from './core/GameLoop';
import { toSeed } from './core/legacy-rng.js';
import { createSymbolRegistry } from './entities/SlotSymbol';
import { SlotView } from './ui/SlotView';

/** `?seed=1234` (or any string) makes the spin sequence reproducible. */
function resolveSeed(): number {
  const param = new URLSearchParams(window.location.search).get('seed');
  return param ? toSeed(param) : toSeed(Date.now() % 0xffffffff);
}

function boot(): void {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('Missing #app root');

  // 1. Declarative DSL, parsed and validated at runtime.
  const config = parseGameConfig(rawDsl as unknown);
  const symbols = createSymbolRegistry(config.symbols);
  const seed = resolveSeed();

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
  fsm.subscribe((state) => view.setState(state));

  const syncOrigin = (): void => {
    const origin = view.fountainOrigin();
    fountain.setOrigin(origin.x, origin.y);
  };
  syncOrigin();
  window.addEventListener('resize', syncOrigin);

  // 4. 60 FPS loop: simulate with dt, then render. The closure is created once.
  const loop = new GameLoop();
  const reelList = reels.reels;
  loop.add((dt) => {
    engine.update(dt);
    view.renderReels(reelList);
    fountain.render();
  });
  loop.start();

  // 5. Input: Space = spin (IDLE) / slam-stop (SPINNING) / skip (SHOWING_WIN) / ack (ERROR).
  const isSpace = (e: KeyboardEvent): boolean => e.code === 'Space' || e.key === ' ';
  window.addEventListener('keydown', (e) => {
    if (!isSpace(e)) return;
    e.preventDefault(); // no page scroll and no implicit activation of a focused button
    if (e.repeat) return;
    game.handlePrimaryAction();
  });
  window.addEventListener('keyup', (e) => {
    if (isSpace(e)) e.preventDefault();
  });

  view.hud.spin.addEventListener('click', () => {
    game.handlePrimaryAction();
    view.hud.spin.blur();
  });
  view.hud.betDown.addEventListener('click', () => game.changeBet(-1));
  view.hud.betUp.addEventListener('click', () => game.changeBet(1));

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      loop.stop();
      game.dispose();
    });
  }
}

try {
  boot();
} catch (err) {
  console.error(err);
  const status = document.querySelector('[data-ref="status"]');
  if (status) status.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
}
