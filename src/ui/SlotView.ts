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
import { QuantizedStrings, coinStrings } from './StringCache';

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
  /** `translate3d(...)` strings per 0.01% of sub-symbol offset, built once. */
  private readonly offsets: QuantizedStrings;
  private lastOffset = -1;
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
    this.offsets = new QuantizedStrings(0, this.percentPerCell, 0.01, (v) => `translate3d(0, ${-Number(v.toFixed(2))}%, 0)`);
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
    const offset = this.offsets.slot(frac * this.percentPerCell);
    if (offset !== this.lastOffset) {
      this.lastOffset = offset;
      this.strip.style.transform = this.offsets.at(offset);
    }
    const spinning = reel.phase === 'SPINNING';
    if (spinning !== this.lastSpinning) {
      this.lastSpinning = spinning;
      this.element.classList.toggle('reel--spinning', spinning);
    }
  }
}

/**
 * A pre-allocated DOM coin; shown/hidden by the object pool. Renders through CSS custom
 * properties fed from interned string tables, writing only the slots that changed.
 */
export class DomCoinView implements ParticleView {
  readonly element: HTMLElement;
  private readonly strings = coinStrings();
  private lastX = -1;
  private lastY = -1;
  private lastRotation = -1;
  private lastScale = -1;
  private lastOpacity = -1;

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
    // Force a full write on the next show(): the pool may hand this node to a new coin.
    this.lastX = this.lastY = this.lastRotation = this.lastScale = this.lastOpacity = -1;
  }

  render(p: CoinParticle): void {
    const s = this.element.style;
    const { px, deg, scale, unit } = this.strings;
    const x = px.slot(p.x);
    if (x !== this.lastX) s.setProperty('--coin-x', px.at((this.lastX = x)));
    const y = px.slot(p.y);
    if (y !== this.lastY) s.setProperty('--coin-y', px.at((this.lastY = y)));
    const r = deg.slot(mod(Math.round(p.rotation), 360));
    if (r !== this.lastRotation) s.setProperty('--coin-r', deg.at((this.lastRotation = r)));
    const k = scale.slot(p.scale);
    if (k !== this.lastScale) s.setProperty('--coin-s', scale.at((this.lastScale = k)));
    const o = unit.slot(p.lifeRemaining < 0.25 ? p.lifeRemaining * 4 : 1);
    if (o !== this.lastOpacity) s.opacity = unit.at((this.lastOpacity = o));
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
  private lastWinValue = Number.NaN;
  private readonly coinViews: DomCoinView[] = [];
  private symbolStyle: HTMLStyleElement | null = null;

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
    const coin = new DomCoinView(this.fxLayer);
    this.coinViews.push(coin);
    return coin;
  }

  /** Removes every node this view created, so a re-mount (Vite HMR) starts from clean markup. */
  destroy(): void {
    this.clearHighlight();
    for (const view of this.reelViews) view.element.remove();
    this.reelViews.length = 0;
    for (const column of this.frames) for (const frame of column) frame.remove();
    this.frames.length = 0;
    for (const coin of this.coinViews) coin.element.remove();
    this.coinViews.length = 0;
    this.symbolStyle?.remove();
    this.symbolStyle = null;
    delete this.root.dataset.winStep;
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
    if (amount === this.lastWinValue) return; // skip formatting on unchanged frames
    this.lastWinValue = amount;
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
    this.symbolStyle = style;
  }
}
