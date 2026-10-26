/**
 * Pre-built lookup tables of CSS value strings, so per-frame DOM writes reuse interned strings
 * instead of formatting new ones (`toFixed`, template literals) on every frame.
 *
 * A value is quantised to `step`, clamped to `[min, max]`, and mapped to an integer slot; the
 * view compares slots to skip unchanged writes and reads the string from the table.
 */
export class QuantizedStrings {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  private readonly table: readonly string[];

  constructor(min: number, max: number, step: number, format: (value: number) => string) {
    if (!(step > 0) || !(max >= min)) throw new RangeError('QuantizedStrings: invalid range');
    this.min = min;
    this.max = max;
    this.step = step;
    const count = Math.round((max - min) / step) + 1;
    const table: string[] = [];
    for (let i = 0; i < count; i++) table.push(format(min + i * step));
    this.table = table;
  }

  get size(): number {
    return this.table.length;
  }

  /** Slot for `value` (clamped). Allocation-free. */
  slot(value: number): number {
    const i = Math.round((value - this.min) / this.step);
    return i < 0 ? 0 : i >= this.table.length ? this.table.length - 1 : i;
  }

  at(slot: number): string {
    return this.table[slot];
  }

  /** True if `text` is one of the table's interned strings (for tests). */
  contains(text: string): boolean {
    return this.table.includes(text);
  }
}

function trim(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

let coinTables: { px: QuantizedStrings; deg: QuantizedStrings; scale: QuantizedStrings; unit: QuantizedStrings } | null =
  null;

/** Shared coin tables (built once, on first use, outside the frame loop). */
export function coinStrings(): NonNullable<typeof coinTables> {
  coinTables ??= {
    px: new QuantizedStrings(-1024, 4096, 0.5, (v) => `${trim(v, 1)}px`),
    deg: new QuantizedStrings(0, 359, 1, (v) => `${v}deg`),
    scale: new QuantizedStrings(0, 4, 0.01, (v) => trim(v, 2)),
    unit: new QuantizedStrings(0, 1, 0.01, (v) => trim(v, 2)),
  };
  return coinTables;
}
