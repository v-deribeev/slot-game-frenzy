/**
 * Pure, DOM-free payline evaluation driven by symbol behaviours.
 *
 * Rules (3-reel, 3-of-a-kind lines):
 * - The line symbol is the first non-wild symbol on the line (all wilds -> pays as the wild).
 * - Every symbol must `matches()` the line symbol (identity or wild substitution).
 * - Payout = lineSymbol.pay * lineBet * product(multiplier behaviours), lineBet = bet / lines.
 */

import type { WinData, WinLine } from './legacy-rng.js';
import type { SlotSymbol, SymbolRegistry } from '../entities/SlotSymbol';

export interface GridPosition {
  readonly reel: number;
  readonly row: number;
}

export interface LineEvaluation {
  readonly symbol: SlotSymbol;
  readonly multiplier: number;
}

export function roundCredits(value: number): number {
  return Math.round(value * 100) / 100;
}

export class PayoutEvaluator {
  private readonly symbols: SymbolRegistry;
  private readonly paylines: readonly (readonly number[])[];

  constructor(symbols: SymbolRegistry, paylines: readonly (readonly number[])[]) {
    if (paylines.length === 0) throw new RangeError('At least one payline is required');
    this.symbols = symbols;
    this.paylines = paylines;
  }

  get lineCount(): number {
    return this.paylines.length;
  }

  /** Evaluates one line of symbol ids (one per reel). Returns null for a non-winning line. */
  evaluateLine(ids: readonly string[]): LineEvaluation | null {
    if (ids.length === 0) return null;
    const line: SlotSymbol[] = ids.map((id) => this.lookup(id));
    const lineSymbol = line.find((s) => !s.isWild) ?? line[0];
    let multiplier = 1;
    for (const symbol of line) {
      if (!symbol.matches(lineSymbol)) return null;
    }
    for (const symbol of line) {
      multiplier = symbol.applyLineModifiers(multiplier, {
        lineSymbol,
        substituting: symbol.id !== lineSymbol.id,
      });
    }
    return { symbol: lineSymbol, multiplier };
  }

  /** Signature-compatible with the legacy server's `WinEvaluator`. `grid` is `grid[reel][row]`. */
  evaluate(grid: readonly (readonly string[])[], bet: number): WinData {
    const lineBet = bet / this.paylines.length;
    const lines: WinLine[] = [];
    const winningSymbols: string[] = [];
    let totalWin = 0;

    this.paylines.forEach((rows, lineIndex) => {
      if (rows.length !== grid.length) {
        throw new RangeError(`Payline ${lineIndex} has ${rows.length} entries for ${grid.length} reels`);
      }
      const ids = rows.map((row, reel) => {
        const id = grid[reel]?.[row];
        if (id === undefined) throw new RangeError(`Grid has no symbol at reel ${reel}, row ${row}`);
        return id;
      });
      const result = this.evaluateLine(ids);
      if (!result || result.symbol.pay <= 0) return;
      const payout = roundCredits(result.symbol.pay * lineBet * result.multiplier);
      if (payout <= 0) return;
      lines.push({ lineIndex, symbolId: result.symbol.id, rows: [...rows], multiplier: result.multiplier, payout });
      if (!winningSymbols.includes(result.symbol.id)) winningSymbols.push(result.symbol.id);
      totalWin += payout;
    });

    return { totalWin: roundCredits(totalWin), lines, winningSymbols };
  }

  private lookup(id: string): SlotSymbol {
    const symbol = this.symbols.get(id);
    if (!symbol) throw new RangeError(`Unknown symbol "${id}"`);
    return symbol;
  }
}

/** Unique grid cells covered by the winning lines (for highlight frames). */
export function winningPositions(win: WinData): GridPosition[] {
  const seen = new Set<string>();
  const positions: GridPosition[] = [];
  for (const line of win.lines) {
    line.rows.forEach((row, reel) => {
      const key = `${reel}:${row}`;
      if (seen.has(key)) return;
      seen.add(key);
      positions.push({ reel, row });
    });
  }
  return positions;
}
