/**
 * Generic, pre-allocating object pool.
 *
 * All instances are created up-front (`initialSize`) so that `acquire()` / `release()`
 * inside the requestAnimationFrame loop never allocate: bookkeeping uses a fixed index
 * stack and a flag array. Growth (only if `maxSize > initialSize`) is the sole allocating
 * path and is opt-in.
 */

export interface ObjectPoolOptions<T> {
  /** Number of instances pre-allocated in the constructor. */
  readonly initialSize: number;
  /** Hard cap. Defaults to `initialSize` (no growth -> zero runtime allocation). */
  readonly maxSize?: number;
  /** Called on release to return the object to a neutral state. */
  readonly reset?: (item: T) => void;
  /** Called each time an item is handed out. */
  readonly onAcquire?: (item: T) => void;
}

export class ObjectPool<T extends object> {
  private readonly factory: () => T;
  private readonly resetFn: ((item: T) => void) | undefined;
  private readonly onAcquireFn: ((item: T) => void) | undefined;
  private readonly items: T[] = [];
  private readonly indexOf = new Map<T, number>();
  private readonly active: boolean[] = [];
  /** Stack of free indices; `freeTop` is the logical length. */
  private readonly freeStack: number[] = [];
  private freeTop = 0;
  private activeTotal = 0;
  readonly maxSize: number;

  constructor(factory: () => T, options: ObjectPoolOptions<T>) {
    const { initialSize } = options;
    const maxSize = options.maxSize ?? initialSize;
    if (!Number.isInteger(initialSize) || initialSize < 0) {
      throw new RangeError(`initialSize must be a non-negative integer, got ${initialSize}`);
    }
    if (!Number.isInteger(maxSize) || maxSize < initialSize || maxSize < 1) {
      throw new RangeError(`maxSize must be an integer >= max(1, initialSize), got ${maxSize}`);
    }
    this.factory = factory;
    this.resetFn = options.reset;
    this.onAcquireFn = options.onAcquire;
    this.maxSize = maxSize;
    for (let i = 0; i < initialSize; i++) this.create();
  }

  /** Total instances owned by the pool. */
  get size(): number {
    return this.items.length;
  }

  /** Instances currently ready to be acquired without growing. */
  get available(): number {
    return this.freeTop;
  }

  /** Instances currently handed out. */
  get activeCount(): number {
    return this.activeTotal;
  }

  /**
   * Returns a free instance, growing up to `maxSize` if needed. Returns `null` when the pool
   * is exhausted (callers such as particle emitters simply skip the spawn).
   */
  acquire(): T | null {
    let index: number;
    if (this.freeTop > 0) {
      index = this.freeStack[--this.freeTop];
    } else if (this.items.length < this.maxSize) {
      this.create();
      index = this.freeStack[--this.freeTop];
    } else {
      return null;
    }
    this.active[index] = true;
    this.activeTotal++;
    const item = this.items[index];
    this.onAcquireFn?.(item);
    return item;
  }

  /**
   * Returns an instance to the pool. Returns `false` (and does nothing) for double releases
   * or objects not owned by this pool, so pool state can never be corrupted.
   */
  release(item: T): boolean {
    const index = this.indexOf.get(item);
    if (index === undefined || !this.active[index]) return false;
    this.active[index] = false;
    this.activeTotal--;
    this.resetFn?.(item);
    this.freeStack[this.freeTop++] = index;
    return true;
  }

  /** Releases every active instance. Returns how many were released. */
  releaseAll(): number {
    let released = 0;
    for (let i = 0; i < this.items.length; i++) {
      if (this.active[i] && this.release(this.items[i])) released++;
    }
    return released;
  }

  isActive(item: T): boolean {
    const index = this.indexOf.get(item);
    return index !== undefined && this.active[index];
  }

  owns(item: T): boolean {
    return this.indexOf.has(item);
  }

  /**
   * Iterates active items without allocating. Releasing the current item from inside the
   * callback is safe.
   */
  forEachActive(callback: (item: T) => void): void {
    for (let i = 0; i < this.items.length; i++) {
      if (this.active[i]) callback(this.items[i]);
    }
  }

  private create(): void {
    const item = this.factory();
    if (this.indexOf.has(item)) throw new Error('ObjectPool factory must return a new instance each call');
    const index = this.items.length;
    this.items.push(item);
    this.indexOf.set(item, index);
    this.active.push(false);
    this.freeStack[this.freeTop++] = index;
  }
}
