import './styles/main.scss';
import { mountSlotGame } from './app';
import { toSeed } from './core/legacy-rng.js';

/** `?seed=1234` (or any string) makes the spin sequence reproducible. */
function resolveSeed(): number {
  const param = new URLSearchParams(window.location.search).get('seed');
  return param ? toSeed(param) : toSeed(Date.now() % 0xffffffff);
}

function boot(): void {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('Missing #app root');

  const app = mountSlotGame(root, { seed: resolveSeed() });

  // HMR: tear down listeners, loop and generated DOM so the next module instance starts clean.
  import.meta.hot?.dispose(() => app.dispose());
}

try {
  boot();
} catch (err) {
  console.error(err);
  const status = document.querySelector('[data-ref="status"]');
  if (status) status.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
}
