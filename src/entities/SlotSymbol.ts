/**
 * Slot symbols via composition (Strategy/Component pattern).
 *
 * There is exactly one `SlotSymbol` class; special abilities are plugged in as
 * `SymbolBehavior` components (e.g. `WildBehavior`, `MultiplierBehavior`). A symbol can hold
 * any combination of behaviours -- the DSL's WILD is both a wild and a x2 multiplier --
 * without a class hierarchy.
 */

import type { BehaviorConfig, SymbolConfig } from '../core/GameConfig';

export interface LineContext {
  /** The symbol the line pays as (first non-wild symbol on the line). */
  readonly lineSymbol: SlotSymbol;
  /** True when this symbol is standing in for `lineSymbol` (i.e. it is not the same symbol). */
  readonly substituting: boolean;
}

export interface SymbolBehavior {
  /** Stable identifier used for lookup (`symbol.hasBehavior('wild')`). */
  readonly type: string;
  /** Return true if the owning symbol may stand in for `target` on a payline. */
  canSubstitute?(target: SlotSymbol): boolean;
  /** Transform a line payout (or multiplier) the owning symbol participates in. */
  modifyLinePayout?(payout: number, context: LineContext): number;
}

export class WildBehavior implements SymbolBehavior {
  readonly type = 'wild';
  private readonly excludes: ReadonlySet<string>;

  constructor(excludes: Iterable<string> = []) {
    this.excludes = new Set(excludes);
  }

  canSubstitute(target: SlotSymbol): boolean {
    return !this.excludes.has(target.id);
  }
}

export class MultiplierBehavior implements SymbolBehavior {
  readonly type = 'multiplier';
  readonly value: number;
  readonly onlyWhenSubstituting: boolean;

  constructor(value: number, onlyWhenSubstituting = true) {
    if (!(value >= 1)) throw new RangeError(`multiplier must be >= 1, got ${value}`);
    this.value = value;
    this.onlyWhenSubstituting = onlyWhenSubstituting;
  }

  modifyLinePayout(payout: number, context: LineContext): number {
    if (this.onlyWhenSubstituting && !context.substituting) return payout;
    return payout * this.value;
  }
}

export interface SymbolDefinition {
  readonly id: string;
  readonly name: string;
  readonly glyph: string;
  readonly color: string;
  readonly pay: number;
  readonly behaviors?: readonly SymbolBehavior[];
}

export class SlotSymbol {
  readonly id: string;
  readonly name: string;
  readonly glyph: string;
  readonly color: string;
  readonly pay: number;
  readonly behaviors: readonly SymbolBehavior[];
  readonly isWild: boolean;

  constructor(definition: SymbolDefinition) {
    this.id = definition.id;
    this.name = definition.name;
    this.glyph = definition.glyph;
    this.color = definition.color;
    this.pay = definition.pay;
    this.behaviors = Object.freeze([...(definition.behaviors ?? [])]);
    this.isWild = this.behaviors.some((b) => b.canSubstitute !== undefined);
  }

  hasBehavior(type: string): boolean {
    return this.behaviors.some((b) => b.type === type);
  }

  getBehavior<B extends SymbolBehavior = SymbolBehavior>(type: string): B | undefined {
    return this.behaviors.find((b) => b.type === type) as B | undefined;
  }

  /** Returns a new symbol with extra behaviours composed in (symbols are immutable). */
  withBehaviors(...extra: SymbolBehavior[]): SlotSymbol {
    return new SlotSymbol({ ...this, behaviors: [...this.behaviors, ...extra] });
  }

  /** True if this symbol counts as `target` on a payline (identity or substitution). */
  matches(target: SlotSymbol): boolean {
    if (target.id === this.id) return true;
    for (const behavior of this.behaviors) {
      if (behavior.canSubstitute?.(target)) return true;
    }
    return false;
  }

  /** Runs every behaviour's payout modifier in order. */
  applyLineModifiers(payout: number, context: LineContext): number {
    let value = payout;
    for (const behavior of this.behaviors) {
      if (behavior.modifyLinePayout) value = behavior.modifyLinePayout(value, context);
    }
    return value;
  }
}

/** Maps a DSL behaviour config to a behaviour component. Extend here for new mechanics. */
export function createBehavior(config: BehaviorConfig): SymbolBehavior {
  switch (config.type) {
    case 'wild':
      return new WildBehavior(config.excludes);
    case 'multiplier':
      return new MultiplierBehavior(config.value, config.onlyWhenSubstituting);
  }
}

export type SymbolRegistry = ReadonlyMap<string, SlotSymbol>;

export function createSymbolRegistry(symbols: readonly SymbolConfig[]): SymbolRegistry {
  const registry = new Map<string, SlotSymbol>();
  for (const cfg of symbols) {
    if (registry.has(cfg.id)) throw new Error(`Duplicate symbol id "${cfg.id}"`);
    registry.set(
      cfg.id,
      new SlotSymbol({
        id: cfg.id,
        name: cfg.name,
        glyph: cfg.glyph,
        color: cfg.color,
        pay: cfg.pay,
        behaviors: cfg.behaviors.map(createBehavior),
      }),
    );
  }
  return registry;
}
