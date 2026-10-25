/**
 * DOM rendering adapters. All DOM nodes (reel cells, highlight frames, pooled coins) are
 * created once at startup; per-frame rendering only writes cached strings/transforms when a
 * value actually changed.
 */

import type { GameConfig } from '../core/GameConfig';
import type { GridPosition } from '../core/PayoutEvaluator';
import type { GameState } from '../core/StateMachine';
import type { WinSequenceView, WinStep } from '../core/WinSequence';
import type { CoinParticle, ParticleView } from '../entities/CoinFountain';
import { mod, type Reel } from '../entities/Reel';
import type { SymbolRegistry } from '../entities/SlotSymbol';

function ref<T extends HTMLElement>(root: ParentNode, name: string): T {
  const el = root.querySelector<T>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`Missing DOM node [data-ref="${name}"]`);
  return el;
}

function cssIdent(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

/** Renders one reel column: rows + 1 cells inside a strip translated by the sub-symbol offset. */
export class ReelView {
  readonly element: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly cells: HTMLElement[] = [];
  private readonly glyphs: HTMLElement[] = [];
  private readonly cellIndex: Int32Array;
  /** Pre-computed per strip index, so rendering never builds strings. */
  private readonly glyphText: string[];
  private readonly cellClass: string[];
  private readonly percentPerCell: number;
  private lastOffset = Number.NaN;
  private lastSpinning = false;

  constructor(parent: HTMLElement, strip: readonly string[], rows: number, symbols: SymbolRegistry) {
    this.element = document.createElement('div');
    this.element.className = 'reel';
    this.strip = document.createElement('div');
    this.strip.className = 'reel__strip';
    this.strip.style.setProperty('--reel-cells', String(rows + 1));
    this.element.appendChild(this.strip);
    parent.appendChild(this.element);

    this.percentPerCell = 100 / (rows + 1);
    this.cellIndex = new Int32Array(rows + 1).fill(-1);
    this.glyphText = strip.map((id) => symbols.get(id)?.glyph ?? id);
    this.cellClass = strip.map((id) => {
      const glyph = symbols.get(id)?.glyph ?? id;
      return `reel__cell symbol--${cssIdent(id)}${glyph.length > 1 ? ' reel__cell--text' : ''}`;
    });

    for (let i = 0; i <= rows; i++) {
      const cell = document.createElement('div');
      const glyph = document.createElement('span');
      glyph.className = 'reel__glyph';
      cell.appendChild(glyph);
      this.strip.appendChild(cell);
      this.cells.push(cell);
      this.glyphs.push(glyph);
    }
  }

  render(reel: Reel): void {
    const base = Math.floor(reel.position);
    const frac = reel.position - base;
    const len = reel.length;
    for (let i = 0; i < this.cells.length; i++) {
      const idx = mod(base + i, len);
      if (this.cellIndex[i] !== idx) {
        this.cellIndex[i] = idx;
        this.cells[i].className = this.cellClass[idx];
        this.glyphs[i].textContent = this.glyphText[idx];
      }
    }
    const offset = Math.round(frac * this.percentPerCell * 1000) / 1000;
    if (offset !== this.lastOffset) {
      this.lastOffset = offset;
      this.strip.style.transform = `translate3d(0, ${-offset}%, 0)`;
    }
    const spinning = reel.phase === 'SPINNING';
    if (spinning !== this.lastSpinning) {
      this.lastSpinning = spinning;
      this.element.classList.toggle('reel--spinning', spinning);
    }
  }
}

/** A pre-allocated DOM coin; shown/hidden by the object pool. */
export class DomCoinView implements ParticleView {
  readonly element: HTMLElement;

  constructor(parent: HTMLElement) {
    this.element = document.createElement('span');
    this.element.className = 'coin';
    this.element.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.element);
  }

  show(): void {
    this.element.classList.add('coin--active');
  }

  hide(): void {
    this.element.classList.remove('coin--active');
    this.element.style.transform = '';
  }

  render(p: CoinParticle): void {
    const s = this.element.style;
    s.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) rotate(${p.rotation.toFixed(0)}deg) scale(${p.scale.toFixed(2)})`;
    s.opacity = p.lifeRemaining < 0.25 ? (p.lifeRemaining * 4).toFixed(2) : '1';
  }
}

export interface HudElements {
  readonly balance: HTMLElement;
  readonly bet: HTMLElement;
  readonly win: HTMLElement;
  readonly status: HTMLElement;
  readonly spin: HTMLButtonElement;
  readonly spinLabel: HTMLElement;
  readonly betDown: HTMLButtonElement;
  readonly betUp: HTMLButtonElement;
  readonly seed: HTMLElement;
}

const STATUS_TEXT: Record<GameState['type'], string> = {
  IDLE: 'Place your bet',
  SPINNING: 'Spinning...',
  SHOWING_WIN: 'Winner!',
  ERROR: 'Error',
};

const SPIN_LABEL: Record<GameState['type'], string> = {
  IDLE: 'Spin',
  SPINNING: 'Stop',
  SHOWING_WIN: 'Skip',
  ERROR: 'OK',
};

export class SlotView implements WinSequenceView {
  readonly root: HTMLElement;
  readonly hud: HudElements;
  readonly reelViews: ReelView[] = [];
  readonly windowEl: HTMLElement;
  readonly fxLayer: HTMLElement;
  private readonly frames: HTMLElement[][] = [];
  private readonly formatter: Intl.NumberFormat;
  private readonly currency: string;
  private lastWinText = '';

  constructor(root: HTMLElement, config: GameConfig, symbols: SymbolRegistry) {
    this.root = root;
    this.currency = config.currency;
    this.formatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    this.windowEl = ref(root, 'window');
    this.fxLayer = ref(root, 'fx');
    this.hud = {
      balance: ref(root, 'balance'),
      bet: ref(root, 'bet'),
      win: ref(root, 'win'),
      status: ref(root, 'status'),
      spin: ref<HTMLButtonElement>(root, 'spin'),
      spinLabel: ref(root, 'spinLabel'),
      betDown: ref<HTMLButtonElement>(root, 'betDown'),
      betUp: ref<HTMLButtonElement>(root, 'betUp'),
      seed: ref(root, 'seed'),
    };
    ref(root, 'title').textContent = config.name;

    this.injectSymbolStyles(symbols);

    const { reels, rows } = config.grid;
    root.style.setProperty('--grid-reels', String(reels));
    root.style.setProperty('--grid-rows', String(rows));

    const reelsEl = ref(root, 'reels');
    config.reelStrips.forEach((strip) => this.reelViews.push(new ReelView(reelsEl, strip, rows, symbols)));

    const framesEl = ref(root, 'frames');
    for (let reel = 0; reel < reels; reel++) {
      const column: HTMLElement[] = [];
      for (let row = 0; row < rows; row++) {
        const frame = document.createElement('div');
        frame.className = 'win-frame';
        frame.style.gridColumn = String(reel + 1);
        frame.style.gridRow = String(row + 1);
        framesEl.appendChild(frame);
        column.push(frame);
      }
      this.frames.push(column);
    }
  }

  createCoinView(): DomCoinView {
    return new DomCoinView(this.fxLayer);
  }

  /** Fountain origin in fx-layer coordinates: horizontally centred, at the reel window's base. */
  fountainOrigin(): { x: number; y: number } {
    const fx = this.fxLayer.getBoundingClientRect();
    const win = this.windowEl.getBoundingClientRect();
    return { x: win.left - fx.left + win.width / 2, y: win.bottom - fx.top - 8 };
  }

  renderReels(reels: readonly Reel[]): void {
    for (let i = 0; i < this.reelViews.length; i++) this.reelViews[i].render(reels[i]);
  }

  formatCredits(value: number): string {
    return this.formatter.format(value);
  }

  setBalance(value: number): void {
    this.hud.balance.textContent = this.formatCredits(value);
  }

  setBet(value: number, index: number, levels: number): void {
    this.hud.bet.textContent = this.formatCredits(value);
    this.hud.betDown.disabled = index <= 0;
    this.hud.betUp.disabled = index >= levels - 1;
  }

  setSeed(seed: number): void {
    this.hud.seed.textContent = `Seed ${seed}`;
  }

  setState(state: GameState): void {
    this.root.dataset.state = state.type;
    this.hud.spinLabel.textContent = SPIN_LABEL[state.type];
    this.hud.status.textContent =
      state.type === 'ERROR'
        ? `Error: ${state.errorCode} (press Space)`
        : state.type === 'SHOWING_WIN'
          ? `${STATUS_TEXT.SHOWING_WIN} ${state.winningSymbols.join(' + ')}`
          : STATUS_TEXT[state.type];
    const idle = state.type === 'IDLE';
    this.hud.betDown.toggleAttribute('data-locked', !idle);
    this.hud.betUp.toggleAttribute('data-locked', !idle);
  }

  // --- WinSequenceView ---------------------------------------------------------------

  highlight(positions: readonly GridPosition[]): void {
    this.clearHighlight();
    for (const { reel, row } of positions) this.frames[reel]?.[row]?.classList.add('win-frame--active');
    this.windowEl.classList.add('machine__window--win');
  }

  clearHighlight(): void {
    for (const column of this.frames) for (const frame of column) frame.classList.remove('win-frame--active');
    this.windowEl.classList.remove('machine__window--win');
  }

  setWinAmount(amount: number): void {
    const text = this.formatCredits(amount);
    if (text === this.lastWinText) return;
    this.lastWinText = text;
    this.hud.win.textContent = text;
    this.hud.win.classList.toggle('hud__value--hot', amount > 0);
  }

  setStep(step: WinStep | null): void {
    if (step) this.root.dataset.winStep = step;
    else delete this.root.dataset.winStep;
  }

  showFatal(message: string): void {
    this.hud.status.textContent = message;
    this.root.dataset.state = 'ERROR';
  }

  get currencyCode(): string {
    return this.currency;
  }

  private injectSymbolStyles(symbols: SymbolRegistry): void {
    const rules: string[] = [];
    symbols.forEach((symbol) => {
      rules.push(`.symbol--${cssIdent(symbol.id)} { --symbol-color: ${symbol.color}; }`);
    });
    const style = document.createElement('style');
    style.dataset.generated = 'symbols';
    style.textContent = rules.join('\n');
    document.head.appendChild(style);
  }
}
