import { describe, expect, it } from 'vitest';
import { PayoutEvaluator, roundCredits, winningPositions } from '../src/core/PayoutEvaluator';
import {
  MultiplierBehavior,
  SlotSymbol,
  WildBehavior,
  createBehavior,
  createSymbolRegistry,
  type SymbolBehavior,
} from '../src/entities/SlotSymbol';
import { buildGrid } from '../src/core/legacy-rng.js';
import { config } from './helpers';

const cfg = config();
const symbols = createSymbolRegistry(cfg.symbols);
const evaluator = new PayoutEvaluator(symbols, cfg.paylines);
const S = (id: string) => symbols.get(id)!;

/** grid[reel][row] with every row of a reel set to the given ids (rows top->bottom). */
function grid(...columns: string[][]): string[][] {
  return columns;
}

describe('SlotSymbol composition', () => {
  it('uses a single class with behaviour components (no inheritance)', () => {
    expect(Object.getPrototypeOf(SlotSymbol.prototype)).toBe(Object.prototype);
    const wild = S('WILD');
    expect(wild).toBeInstanceOf(SlotSymbol);
    expect(wild.behaviors.map((b) => b.type)).toEqual(['wild', 'multiplier']);
    expect(wild.getBehavior('wild')).toBeInstanceOf(WildBehavior);
    expect(wild.getBehavior<MultiplierBehavior>('multiplier')?.value).toBe(2);
    expect(wild.isWild).toBe(true);
    expect(S('SEVEN').isWild).toBe(false);
    expect(S('SEVEN').hasBehavior('wild')).toBe(false);
    expect(Object.isFrozen(wild.behaviors)).toBe(true);
  });

  it('matches by identity or substitution, honouring wild excludes', () => {
    expect(S('SEVEN').matches(S('SEVEN'))).toBe(true);
    expect(S('SEVEN').matches(S('BAR'))).toBe(false);
    expect(S('WILD').matches(S('BAR'))).toBe(true);
    const picky = new SlotSymbol({ id: 'W2', name: 'w', glyph: 'w', color: '#fff', pay: 1, behaviors: [new WildBehavior(['SEVEN'])] });
    expect(picky.matches(S('SEVEN'))).toBe(false);
    expect(picky.matches(S('BAR'))).toBe(true);
  });

  it('withBehaviors composes a new immutable symbol and leaves the original intact', () => {
    const base = S('BAR');
    const boosted = base.withBehaviors(new MultiplierBehavior(3, false));
    expect(boosted).not.toBe(base);
    expect(boosted.id).toBe('BAR');
    expect(base.behaviors).toHaveLength(0);
    expect(boosted.applyLineModifiers(1, { lineSymbol: base, substituting: false })).toBe(3);
  });

  it('MultiplierBehavior applies only while substituting by default and validates value', () => {
    const m = new MultiplierBehavior(2);
    expect(m.modifyLinePayout(5, { lineSymbol: S('SEVEN'), substituting: true })).toBe(10);
    expect(m.modifyLinePayout(5, { lineSymbol: S('SEVEN'), substituting: false })).toBe(5);
    expect(new MultiplierBehavior(2, false).modifyLinePayout(5, { lineSymbol: S('WILD'), substituting: false })).toBe(10);
    expect(() => new MultiplierBehavior(0.5)).toThrow(RangeError);
    expect(() => new MultiplierBehavior(Number.NaN)).toThrow(RangeError);
  });

  it('supports custom behaviours through the interface alone', () => {
    const bonus: SymbolBehavior = { type: 'plus-ten', modifyLinePayout: (p) => p + 10 };
    const sym = S('CLUB').withBehaviors(bonus);
    expect(sym.hasBehavior('plus-ten')).toBe(true);
    expect(sym.applyLineModifiers(1, { lineSymbol: sym, substituting: false })).toBe(11);
  });

  it('createBehavior maps DSL configs and the registry rejects duplicates', () => {
    expect(createBehavior({ type: 'wild', excludes: [] })).toBeInstanceOf(WildBehavior);
    expect(createBehavior({ type: 'multiplier', value: 3, onlyWhenSubstituting: false })).toBeInstanceOf(MultiplierBehavior);
    expect(() => createSymbolRegistry([cfg.symbols[1], cfg.symbols[1]])).toThrow(/Duplicate/);
  });
});

describe('PayoutEvaluator.evaluateLine', () => {
  it.each([
    [['SEVEN', 'SEVEN', 'SEVEN'], 'SEVEN', 1],
    [['WILD', 'SEVEN', 'SEVEN'], 'SEVEN', 2],
    [['SEVEN', 'WILD', 'SEVEN'], 'SEVEN', 2],
    [['WILD', 'WILD', 'BAR'], 'BAR', 4],
    [['WILD', 'WILD', 'WILD'], 'WILD', 1], // all-wild pays as WILD, not substituting
  ])('%j pays as %s x%d', (ids, symbol, multiplier) => {
    const r = evaluator.evaluateLine(ids);
    expect(r?.symbol.id).toBe(symbol);
    expect(r?.multiplier).toBe(multiplier);
  });

  it.each([[['SEVEN', 'BAR', 'SEVEN']], [['WILD', 'SEVEN', 'BAR']], [['CLUB', 'CLUB', 'HEART']], [[]]])(
    '%j does not pay',
    (ids) => {
      expect(evaluator.evaluateLine(ids)).toBeNull();
    },
  );

  it('throws on unknown symbols', () => {
    expect(() => evaluator.evaluateLine(['SEVEN', 'NOPE', 'SEVEN'])).toThrow(/Unknown symbol/);
  });
});

describe('PayoutEvaluator.evaluate', () => {
  it('pays symbol.pay * (bet / lines) * multiplier for a middle-row line', () => {
    const g = grid(['CLUB', 'SEVEN', 'HEART'], ['BAR', 'SEVEN', 'CLUB'], ['HEART', 'SEVEN', 'DIAMOND']);
    const win = evaluator.evaluate(g, 10);
    expect(win.lines).toEqual([{ lineIndex: 1, symbolId: 'SEVEN', rows: [1, 1, 1], multiplier: 1, payout: 100 }]);
    expect(win.totalWin).toBe(100);
    expect(win.winningSymbols).toEqual(['SEVEN']);
  });

  it('sums multiple lines, dedupes winningSymbols and applies wild multipliers', () => {
    // Top row SEVEN, middle row WILD-SEVEN-SEVEN, bottom row CLUB x3, diagonals mixed.
    const g = grid(['SEVEN', 'WILD', 'CLUB'], ['SEVEN', 'SEVEN', 'CLUB'], ['SEVEN', 'SEVEN', 'CLUB']);
    const win = evaluator.evaluate(g, 5);
    const lineBet = 1;
    const byLine = Object.fromEntries(win.lines.map((l) => [l.lineIndex, l]));
    expect(byLine[0]).toMatchObject({ symbolId: 'SEVEN', multiplier: 1, payout: 50 * lineBet });
    expect(byLine[1]).toMatchObject({ symbolId: 'SEVEN', multiplier: 2, payout: 100 * lineBet });
    expect(byLine[2]).toMatchObject({ symbolId: 'CLUB', payout: 3 * lineBet });
    expect(win.totalWin).toBe(win.lines.reduce((s, l) => s + l.payout, 0));
    expect(win.winningSymbols).toEqual([...new Set(win.lines.map((l) => l.symbolId))]);
  });

  it('rounds fractional line bets to cents', () => {
    const g = grid(['CLUB', 'CLUB', 'CLUB'], ['CLUB', 'CLUB', 'CLUB'], ['CLUB', 'CLUB', 'CLUB']);
    const win = evaluator.evaluate(g, 1); // line bet 0.2 -> 0.6 per line, 5 lines
    expect(win.totalWin).toBe(3);
    expect(roundCredits(0.1 + 0.2)).toBe(0.3);
  });

  it('validates grid and payline shapes', () => {
    expect(() => evaluator.evaluate([['SEVEN'], ['SEVEN']], 10)).toThrow(RangeError);
    expect(() => evaluator.evaluate([['SEVEN'], ['SEVEN'], ['SEVEN']], 10)).toThrow(/no symbol/);
    expect(() => new PayoutEvaluator(symbols, [])).toThrow(RangeError);
    expect(evaluator.lineCount).toBe(5);
  });

  it('winningPositions returns unique cells of all winning lines', () => {
    const g = grid(['SEVEN', 'SEVEN', 'SEVEN'], ['SEVEN', 'SEVEN', 'SEVEN'], ['SEVEN', 'SEVEN', 'SEVEN']);
    const win = evaluator.evaluate(g, 5);
    expect(win.lines).toHaveLength(5);
    const pos = winningPositions(win);
    expect(pos).toHaveLength(9);
    expect(new Set(pos.map((p) => `${p.reel}:${p.row}`)).size).toBe(9);
    expect(winningPositions({ totalWin: 0, lines: [], winningSymbols: [] })).toEqual([]);
  });

  it('exhaustive scan of all reel-stop combinations: invariants hold and RTP is reported', () => {
    const bet = 10;
    const [a, b, c] = cfg.reelStrips.map((s) => s.length);
    let totalWin = 0;
    let hits = 0;
    let combos = 0;
    let maxWin = 0;
    for (let i = 0; i < a; i++)
      for (let j = 0; j < b; j++)
        for (let k = 0; k < c; k++) {
          const win = evaluator.evaluate(buildGrid(cfg.reelStrips, [i, j, k], cfg.grid.rows), bet);
          combos++;
          expect(win.totalWin).toBeGreaterThanOrEqual(0);
          expect(win.totalWin).toBeCloseTo(win.lines.reduce((s, l) => s + l.payout, 0), 9);
          for (const l of win.lines) expect(l.payout).toBeGreaterThan(0);
          totalWin += win.totalWin;
          maxWin = Math.max(maxWin, win.totalWin);
          if (win.totalWin > 0) hits++;
        }
    const rtp = totalWin / (combos * bet);
    console.log(`[rtp] combos=${combos} hitRate=${(hits / combos).toFixed(4)} RTP=${(rtp * 100).toFixed(2)}% maxWin=${maxWin}x${bet}`);
    expect(combos).toBe(8000);
    // Finding F-03 (open, game math): the shipped DSL pays out more than it takes.
    expect(rtp).toBeGreaterThan(1);
  });
});
