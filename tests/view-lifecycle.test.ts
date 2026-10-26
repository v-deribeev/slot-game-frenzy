import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSlotGame, type MountedSlotGame } from '../src/app';
import { CoinParticle } from '../src/entities/CoinFountain';
import { Reel } from '../src/entities/Reel';
import { QuantizedStrings, coinStrings } from '../src/ui/StringCache';
import { DomCoinView } from '../src/ui/SlotView';
import indexHtml from '../index.html?raw';

const BODY = /<body>([\s\S]*)<\/body>/.exec(indexHtml)![1].replace(/<script[\s\S]*?<\/script>/g, '');

function fakeLoop() {
  return { requestFrame: vi.fn(() => 1), cancelFrame: vi.fn(), now: () => 0 };
}

function root(): HTMLElement {
  return document.querySelector<HTMLElement>('#app')!;
}

function space(type: 'keydown' | 'keyup' = 'keydown'): KeyboardEvent {
  const e = new KeyboardEvent(type, { code: 'Space', key: ' ', cancelable: true });
  window.dispatchEvent(e);
  return e;
}

describe('mountSlotGame lifecycle / Vite HMR [F-09]', () => {
  const mounted: MountedSlotGame[] = [];
  const mount = (seed = 1): MountedSlotGame => {
    const app = mountSlotGame(root(), { seed, loop: fakeLoop() });
    mounted.push(app);
    return app;
  };

  beforeEach(() => {
    document.body.innerHTML = BODY;
    document.head.querySelectorAll('style[data-generated]').forEach((n) => n.remove());
  });
  afterEach(() => {
    for (const app of mounted.splice(0)) app.dispose();
  });

  it('Space drives the mounted game and is detached by dispose()', () => {
    const app = mount();
    const action = vi.spyOn(app.engine.game, 'handlePrimaryAction');
    expect(space().defaultPrevented).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);

    app.dispose();
    expect(space().defaultPrevented).toBe(false);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('after dispose + re-mount only the new game reacts to Space and the HUD buttons', () => {
    const first = mount(1);
    const firstAction = vi.spyOn(first.engine.game, 'handlePrimaryAction');
    const firstBet = vi.spyOn(first.engine.game, 'changeBet');
    first.dispose();

    const second = mount(2);
    const secondAction = vi.spyOn(second.engine.game, 'handlePrimaryAction');
    space();
    second.view.hud.spin.click();
    second.view.hud.betUp.click();

    expect(firstAction).not.toHaveBeenCalled();
    expect(firstBet).not.toHaveBeenCalled();
    expect(secondAction).toHaveBeenCalledTimes(2);
  });

  it('dispose() stops the loop, aborts the spin and removes all generated DOM', () => {
    const cfgLoop = fakeLoop();
    const app = mountSlotGame(root(), { seed: 3, loop: cfgLoop });
    const reels = root().querySelector('[data-ref="reels"]')!;
    const frames = root().querySelector('[data-ref="frames"]')!;
    const fx = root().querySelector('[data-ref="fx"]')!;
    expect(reels.children.length).toBe(3);
    expect(fx.children.length).toBeGreaterThan(0);
    expect(document.head.querySelectorAll('style[data-generated]').length).toBe(1);

    space(); // start a spin so dispose has something to abort
    app.dispose();
    app.dispose(); // idempotent

    expect(cfgLoop.cancelFrame).toHaveBeenCalled();
    expect(app.loop.isRunning).toBe(false);
    expect(reels.children.length).toBe(0);
    expect(frames.children.length).toBe(0);
    expect(fx.children.length).toBe(0);
    expect(document.head.querySelectorAll('style[data-generated]').length).toBe(0);
    expect(app.engine.fountain.activeCount).toBe(0);
  });

  it('repeated HMR cycles never accumulate DOM nodes', () => {
    for (let i = 0; i < 20; i++) mount(i).dispose();
    const app = mount(99);
    expect(root().querySelector('[data-ref="reels"]')!.children.length).toBe(3);
    expect(root().querySelector('[data-ref="fx"]')!.children.length).toBe(app.engine.fountain.pool.size);
    expect(document.head.querySelectorAll('style[data-generated]').length).toBe(1);
  });
});

describe('per-frame rendering uses interned strings [F-08]', () => {
  beforeEach(() => {
    document.body.innerHTML = BODY;
  });
  afterEach(() => vi.restoreAllMocks());

  it('QuantizedStrings clamps, quantises and is fixed-size', () => {
    const q = new QuantizedStrings(0, 1, 0.25, (v) => `${v}`);
    expect(q.size).toBe(5);
    expect(q.at(q.slot(0.3))).toBe('0.25');
    expect(q.at(q.slot(-9))).toBe('0');
    expect(q.at(q.slot(9))).toBe('1');
    expect(() => new QuantizedStrings(1, 0, 1, String)).toThrow(RangeError);
  });

  it('ReelView renders without formatting numbers and skips unchanged frames', () => {
    const app = mountSlotGame(root(), { seed: 5, loop: fakeLoop() });
    const reels = app.engine.reels.reels as readonly Reel[];
    const strip = root().querySelector<HTMLElement>('.reel__strip')!;
    const toFixed = vi.spyOn(Number.prototype, 'toFixed');

    reels[0].startSpin();
    for (let i = 0; i < 500; i++) {
      reels[0].update(1 / 60);
      app.view.renderReels(reels);
      expect(strip.style.transform).toMatch(/^translate3d\(0, -?[\d.]+%, 0\)$/);
    }
    expect(toFixed).not.toHaveBeenCalled();

    // Same position again -> no DOM write (sentinel survives).
    strip.style.transform = 'none';
    app.view.renderReels(reels);
    expect(strip.style.transform).toBe('none');
    app.dispose();
  });

  it('DomCoinView writes only table strings, without formatting, and only when a slot changes', () => {
    const tables = coinStrings(); // built once, outside the frame loop
    const parent = document.createElement('div');
    const view = new DomCoinView(parent);
    const p = new CoinParticle(view);
    p.lifetime = 1;
    view.show();
    const toFixed = vi.spyOn(Number.prototype, 'toFixed');
    const setProperty = vi.spyOn(view.element.style, 'setProperty');

    for (let i = 0; i < 300; i++) {
      p.x = 100 + i * 3.3;
      p.y = 50 - i * 1.7;
      p.rotation = i * 7.9;
      p.scale = 0.5 + (i % 50) / 50;
      p.age = i / 300;
      view.render(p);
    }
    expect(toFixed).not.toHaveBeenCalled();
    const s = view.element.style;
    expect(tables.px.contains(s.getPropertyValue('--coin-x'))).toBe(true);
    expect(tables.px.contains(s.getPropertyValue('--coin-y'))).toBe(true);
    expect(tables.deg.contains(s.getPropertyValue('--coin-r'))).toBe(true);
    expect(tables.scale.contains(s.getPropertyValue('--coin-s'))).toBe(true);

    const writes = setProperty.mock.calls.length;
    view.render(p); // unchanged particle -> zero writes
    expect(setProperty.mock.calls.length).toBe(writes);

    view.hide();
    view.show();
    view.render(p); // recycled node -> full rewrite
    expect(setProperty.mock.calls.length).toBe(writes + 4);
  });
});
