/**
 * requestAnimationFrame game loop with normalised, capped delta time.
 *
 *   deltaTime = (currentTime - lastTime) / 1000   // seconds
 *   deltaTime = clamp(deltaTime, 0, maxDeltaTime) // default cap 0.1 s (tab switches)
 *
 * Every system receives `dt` in seconds and must scale motion by it, so 30 FPS and 60 FPS
 * cover the same distance in the same wall-clock time. The per-frame path allocates nothing:
 * `tick` is bound once and the callback list is copy-on-write (copied only on add/remove).
 */

export type FrameCallback = (dt: number, time: number) => void;

export interface GameLoopOptions {
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly now?: () => number;
  /** Upper bound for dt in seconds. Defaults to {@link MAX_DELTA_TIME}. */
  readonly maxDeltaTime?: number;
}

export const MAX_DELTA_TIME = 0.1;

/** Pure delta-time computation (ms timestamps in, capped seconds out). */
export function computeDeltaTime(currentTime: number, lastTime: number, maxDeltaTime = MAX_DELTA_TIME): number {
  const dt = (currentTime - lastTime) / 1000;
  if (!(dt > 0)) return 0; // also handles NaN and clock going backwards
  return dt > maxDeltaTime ? maxDeltaTime : dt;
}

export class GameLoop {
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly now: () => number;
  readonly maxDeltaTime: number;

  private callbacks: readonly FrameCallback[] = [];
  private running = false;
  private handle: number | null = null;
  private lastTime = 0;
  private frames = 0;

  constructor(options: GameLoopOptions = {}) {
    this.requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = options.cancelFrame ?? ((h) => cancelAnimationFrame(h));
    this.now = options.now ?? (() => performance.now());
    this.maxDeltaTime = options.maxDeltaTime ?? MAX_DELTA_TIME;
    if (!(this.maxDeltaTime > 0)) throw new RangeError('maxDeltaTime must be > 0');
  }

  get isRunning(): boolean {
    return this.running;
  }

  get frameCount(): number {
    return this.frames;
  }

  /** Registers a per-frame callback. Returns an unsubscribe function. */
  add(callback: FrameCallback): () => void {
    if (!this.callbacks.includes(callback)) this.callbacks = [...this.callbacks, callback];
    return () => this.remove(callback);
  }

  remove(callback: FrameCallback): boolean {
    const before = this.callbacks.length;
    this.callbacks = this.callbacks.filter((cb) => cb !== callback);
    return this.callbacks.length !== before;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = this.now();
    this.handle = this.requestFrame(this.tick);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.handle !== null) this.cancelFrame(this.handle);
    this.handle = null;
  }

  /**
   * Manually advances all systems by `dt` seconds (capped). Useful for tests and for
   * deterministic fixed-step simulation without a browser.
   */
  advance(dt: number, time = this.lastTime): void {
    const capped = dt > this.maxDeltaTime ? this.maxDeltaTime : dt > 0 ? dt : 0;
    this.dispatch(capped, time);
  }

  private readonly tick = (time: number): void => {
    if (!this.running) return;
    const dt = computeDeltaTime(time, this.lastTime, this.maxDeltaTime);
    this.lastTime = time;
    // Schedule first so a throwing system cannot kill the loop.
    this.handle = this.requestFrame(this.tick);
    this.dispatch(dt, time);
  };

  private dispatch(dt: number, time: number): void {
    this.frames++;
    const list = this.callbacks; // copy-on-write snapshot, no allocation
    for (let i = 0; i < list.length; i++) list[i](dt, time);
  }
}
