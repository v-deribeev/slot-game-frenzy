/**
 * Pooled coin particle fountain.
 *
 * Every `CoinParticle` (and its optional view, e.g. a DOM node) is created up-front by an
 * `ObjectPool`; emission and physics in `update(dt)` only acquire/release pooled objects and
 * mutate numeric fields, so the frame loop performs zero object allocations.
 */

import { ObjectPool } from '../core/ObjectPool';
import type { ParticleConfig } from '../core/GameConfig';

/** Rendering adapter for a particle (DOM, canvas, or `null` for headless/tests). */
export interface ParticleView {
  show(): void;
  hide(): void;
  render(particle: CoinParticle): void;
}

export class CoinParticle {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  rotation = 0;
  angularVelocity = 0;
  age = 0;
  lifetime = 1;
  scale = 1;
  readonly view: ParticleView | null;

  constructor(view: ParticleView | null) {
    this.view = view;
  }

  /** 1 -> 0 over the particle's life. */
  get lifeRemaining(): number {
    return this.lifetime > 0 ? Math.max(0, 1 - this.age / this.lifetime) : 0;
  }

  reset(): void {
    this.x = this.y = this.vx = this.vy = this.rotation = this.angularVelocity = this.age = 0;
    this.lifetime = 1;
    this.scale = 1;
  }
}

export interface CoinFountainOptions extends ParticleConfig {
  /** Factory for each particle's view; called only during pre-allocation. */
  readonly viewFactory?: () => ParticleView | null;
  /** Random source in [0, 1). Defaults to Math.random. */
  readonly random?: () => number;
  readonly originX?: number;
  readonly originY?: number;
}

/** Minimal emitter contract used by the win sequence. */
export interface ParticleEmitter {
  startEmitting(ratePerSecond: number): void;
  stopEmitting(): void;
  releaseAll(): number;
  readonly activeCount: number;
}

const DEG_TO_RAD = Math.PI / 180;

export class CoinFountain implements ParticleEmitter {
  readonly pool: ObjectPool<CoinParticle>;
  private readonly options: CoinFountainOptions;
  private readonly random: () => number;
  private originX: number;
  private originY: number;
  private emitRate = 0;
  private emitAccumulator = 0;
  private frameDt = 0;

  constructor(options: CoinFountainOptions) {
    this.options = options;
    this.random = options.random ?? Math.random;
    this.originX = options.originX ?? 0;
    this.originY = options.originY ?? 0;
    const viewFactory = options.viewFactory ?? (() => null);
    this.pool = new ObjectPool<CoinParticle>(() => new CoinParticle(viewFactory()), {
      initialSize: options.poolSize,
      maxSize: options.poolSize,
      reset: (p) => {
        p.reset();
        p.view?.hide();
      },
      onAcquire: (p) => p.view?.show(),
    });
  }

  get activeCount(): number {
    return this.pool.activeCount;
  }

  get isEmitting(): boolean {
    return this.emitRate > 0;
  }

  setOrigin(x: number, y: number): void {
    this.originX = x;
    this.originY = y;
  }

  startEmitting(ratePerSecond: number): void {
    this.emitRate = Math.max(0, ratePerSecond);
    this.emitAccumulator = 0;
  }

  stopEmitting(): void {
    this.emitRate = 0;
    this.emitAccumulator = 0;
  }

  /** Spawns up to `count` coins immediately. Returns how many were spawned. */
  burst(count: number): number {
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      if (!this.spawn()) break;
      spawned++;
    }
    return spawned;
  }

  /** Stops emission and returns every live coin to the pool. */
  releaseAll(): number {
    this.stopEmitting();
    return this.pool.releaseAll();
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    if (this.emitRate > 0) {
      this.emitAccumulator += this.emitRate * dt;
      while (this.emitAccumulator >= 1) {
        this.emitAccumulator -= 1;
        if (!this.spawn()) {
          this.emitAccumulator = 0; // pool exhausted: drop the backlog
          break;
        }
      }
    }
    if (this.pool.activeCount === 0) return;
    this.frameDt = dt;
    this.pool.forEachActive(this.stepParticle);
  }

  /** Pushes particle state to views. Call once per frame after `update`. */
  render(): void {
    if (this.pool.activeCount === 0) return;
    this.pool.forEachActive(this.renderParticle);
  }

  private spawn(): boolean {
    const p = this.pool.acquire();
    if (!p) return false;
    const { speedMin, speedMax, spreadDeg, lifetimeMs } = this.options;
    const r = this.random;
    const angle = (-90 + (r() - 0.5) * spreadDeg) * DEG_TO_RAD; // -90deg = straight up
    const speed = speedMin + (speedMax - speedMin) * r();
    p.x = this.originX + (r() - 0.5) * 40;
    p.y = this.originY;
    p.vx = Math.cos(angle) * speed;
    p.vy = Math.sin(angle) * speed;
    p.rotation = r() * 360;
    p.angularVelocity = (r() - 0.5) * 900;
    p.age = 0;
    p.lifetime = (lifetimeMs / 1000) * (0.75 + 0.5 * r());
    p.scale = 0.7 + 0.6 * r();
    return true;
  }

  private readonly stepParticle = (p: CoinParticle): void => {
    const dt = this.frameDt;
    p.age += dt;
    if (p.age >= p.lifetime) {
      this.pool.release(p);
      return;
    }
    p.vy += this.options.gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rotation += p.angularVelocity * dt;
  };

  private readonly renderParticle = (p: CoinParticle): void => {
    p.view?.render(p);
  };
}
