# Amaze Frenzy - Slot Engine Spec

3-reel x 3-row, 5-payline slot. Strict TS + one vanilla JS module (`legacy-rng.js`), Vite, SCSS.
Engine logic is DOM-free and lives in `src/core` + `src/entities`; DOM adapters live in `src/ui`.

## 1. Modules

| File | Responsibility |
| --- | --- |
| `src/core/game-dsl.json` | Declarative config: symbols, payouts, behaviours, paylines, reel strips, timings |
| `src/core/GameConfig.ts` | `parseGameConfig(unknown): GameConfig` - runtime validation, frozen output, `DslValidationError(path)` |
| `src/core/legacy-rng.js` | `// @ts-check` + JSDoc. Seedable mulberry32 RNG, `createSpinServer()` simulating the remote server (`Promise<SpinResponse>`) |
| `src/core/StateMachine.ts` | Discriminated-union FSM, Proxy-guarded writes, strict transition map, pub/sub |
| `src/core/GameLoop.ts` | `requestAnimationFrame` loop, capped `dt` in seconds |
| `src/core/ObjectPool.ts` | Generic pre-allocating `ObjectPool<T>` |
| `src/core/PayoutEvaluator.ts` | Pure payline evaluation using symbol behaviours |
| `src/core/WinSequence.ts` | Async HIGHLIGHT -> COUNT_UP -> COIN_FOUNTAIN, `AbortSignal` slam-stop |
| `src/core/SlotGame.ts` | Orchestrator: balance, bet, spin pipeline, slam-stop, error recovery |
| `src/core/createSlotGame.ts` | Composition root (browser and headless tests) |
| `src/entities/SlotSymbol.ts` | `SlotSymbol` + `SymbolBehavior[]` (`WildBehavior`, `MultiplierBehavior`) |
| `src/entities/Reel.ts`, `ReelSet.ts` | Reel motion (speed * dt, eased landing), staggered stops, snap |
| `src/entities/CoinFountain.ts` | Pooled coin particles (`ObjectPool<CoinParticle>`) |
| `src/ui/SlotView.ts` | DOM adapters: `ReelView`, `DomCoinView`, `SlotView` (implements `WinSequenceView`) |
| `src/main.ts` | Wires DSL, engine, view, loop, Space / button input |

## 2. Finite State Machine

```ts
type GameState =
  | { type: 'IDLE' }
  | { type: 'SPINNING'; betAmount: number }
  | { type: 'SHOWING_WIN'; winAmount: number; winningSymbols: string[] }
  | { type: 'ERROR'; errorCode: string };
```

Transition map (anything else throws `InvalidTransitionError`, including self-transitions):

| From | Allowed to |
| --- | --- |
| IDLE | SPINNING, ERROR |
| SPINNING | SHOWING_WIN, IDLE, ERROR |
| SHOWING_WIN | IDLE, ERROR |
| ERROR | IDLE |

- The state is stored in an object wrapped by a `Proxy`; its `set` trap validates the transition
  and the payload (bet > 0, win >= 0, non-empty error code) before committing a frozen state.
- `transition()` throws, `tryTransition()` returns `boolean`, `reset()` forces IDLE (recovery/tests).
- Pub/sub: `subscribe(listener) => unsubscribe`. Listeners get `(next, previous)`. Re-entrant
  transitions from inside a listener are queued and delivered in order; a throwing listener is
  logged and does not affect the FSM or other listeners.

Game flow (`SlotGame.spin()`):

```
IDLE -> SPINNING{bet}       debit bet, start reels, await server
     -> (server rejects)    halt reels, refund, ERROR{code}  -- Space/OK --> IDLE
     -> reels land          credit win
        win == 0 | aborted  -> IDLE        (counter snapped to final win)
        win  > 0            -> SHOWING_WIN{win, symbols} -> WinSequence.play() -> IDLE
```

Space: IDLE = spin, SPINNING/SHOWING_WIN = slam-stop (`AbortController.abort()`), ERROR = acknowledge.
Re-entrant `spin()` calls while busy resolve `{ status: 'rejected' }` and never throw.

## 3. Game Loop

`deltaTime = (now - last) / 1000`, clamped to `[0, 0.1]` s. Callbacks get `(dt, time)`. `tick` is
bound once; the callback list is copy-on-write, so frames allocate nothing. `advance(dt)` steps
systems manually, and `requestFrame`, `cancelFrame` and `now` can be injected for tests.
Per frame: `reels.update(dt) -> winSequence.update(dt) -> fountain.update(dt) -> render`.

## 4. 3x3 Reel Grid

- `grid[reel][row]` (column-major). Row `r` of reel `i` shows `strip[(stop_i + r) mod len]`.
- `Reel.position` is in symbol units. Spinning: `position -= spinSpeed * dt` (symbols move down).
  Landing: easeOutBack tween over `stopDurationMs` covering exactly `landingDistance`
  (`spinSpeed * duration / easeOutBack'(0)`), so it begins at spin speed and never exceeds it. The
  reel keeps spinning (at most one extra strip length) until its target is that far away; residual
  frame time carries into the tween.
- `ReelSet.stopAt(stops, signal)` waits `minSpinMs`, staggers reels by at least `stopStaggerMs`
  (each reel's earliest landing is chained off the previous one, preserving order), and resolves
  once every reel rests. If the signal aborts, all reels `snapTo()` the result at once. It never rejects.
- DOM: each reel renders `rows + 1` pre-created cells inside a strip, moved by
  `translate3d(0, -frac * 100/(rows+1) %, 0)`. Cell glyph/class strings are precomputed per strip
  index and written only when they change. The window has `overflow: hidden`.

## 5. Object Pool + Particles

`ObjectPool<T>(factory, { initialSize, maxSize = initialSize, reset, onAcquire })`. Bookkeeping uses a
free-index stack, an active-flag array and an item->index map, so `acquire()`/`release()` do
not allocate. `acquire()` returns `null` when the pool is exhausted. `release()` returns `false` for
double or foreign releases, and reuse is LIFO (the last released item is the next acquired).

`CoinFountain` pre-allocates `particles.poolSize` `CoinParticle`s, each with a pre-created DOM
coin (`DomCoinView`). Emission accumulates `coinsPerSecond * dt`. Physics is `v += g*dt; x += v*dt`.
Particles past their lifetime go back to the pool, and `releaseAll()` empties it in one call.

## 6. Symbols (composition)

`SlotSymbol { id, name, glyph, color, pay, behaviors: SymbolBehavior[] }`, with no subclasses.

```ts
interface SymbolBehavior {
  type: string;
  canSubstitute?(target: SlotSymbol): boolean;             // WildBehavior
  modifyLinePayout?(payout: number, ctx: LineContext): number; // MultiplierBehavior
}
```

Line rule: the line symbol is the first non-wild symbol (an all-wild line pays as WILD). Every
symbol must `matches()` it. `payout = pay * (bet / lines) * product(multipliers)`. The WILD in the
DSL has both `wild` and `multiplier x2` behaviours (by default the multiplier only applies while
the wild is substituting).

## 7. WinSequence (async choreography)

`play({ amount, positions }, signal) -> Promise<{ status: 'completed'|'aborted', finalAmount, lastStep }>`

1. HIGHLIGHT (`highlightMs`): win frames on winning cells.
2. COUNT_UP (`countUpMs`): counter = amount * easeOutQuad(progress).
3. COIN_FOUNTAIN (`fountainMs`): emit coins, then `settleMs` for them to fall.

Each step is a Promise advanced by `update(dt)`. On abort the active step resolves at once and
the sequence snaps the counter to `amount`, releases all pooled particles, clears highlights
and resolves `aborted`. It never rejects. Normal completion ends in the same state. A new
`play()` pre-empts the old one, and the old one resolves `aborted` without touching the shared
view.

## 8. Legacy server (`legacy-rng.js`)

`createSpinServer({ reelStrips, rows, seed, evaluate, latencyMs?, failureRate?, schedule? })`
returns `{ spin(bet): Promise<SpinResponse>, getSeed(), getSpinCount() }`.
`SpinResponse = { spinId, bet, stops[], grid[reel][row], win: { totalWin, lines[], winningSymbols[] } }`.
The outcome is computed synchronously from the RNG when `spin()` is called, so a given seed
always produces the same sequence whatever the latency. Failures reject with
`SpinServerError { code: 'INVALID_BET' | 'NETWORK_TIMEOUT' }`. Also exports `createRng`,
`toSeed` and `buildGrid`. In the browser, `?seed=<value>` makes a session reproducible.

## 9. DSL schema (`game-dsl.json`)

```jsonc
{
  "version": 1, "name": "string", "currency": "string", "startingBalance": 1000,
  "grid": { "reels": 3, "rows": 3 },
  "bet": { "levels": [5, 10, 25], "defaultIndex": 1 },        // strictly ascending
  "symbols": [{
    "id": "WILD", "name": "Wild", "glyph": "WILD", "color": "#ff3df2", // hex only
    "pay": 100,                                               // x line bet, 3-of-a-kind
    "behaviors": [
      { "type": "wild", "excludes": ["SYMBOL_ID"] },
      { "type": "multiplier", "value": 2, "onlyWhenSubstituting": true }
    ]
  }],
  "paylines": [[0, 0, 0], [1, 1, 1]],      // row index per reel, length == grid.reels
  "reelStrips": [["SEVEN", "CLUB"]],      // one per reel, length >= rows + 1, known ids
  "reels": { "spinSpeed": 18, "minSpinMs": 650, "stopStaggerMs": 240, "stopDurationMs": 420, "stopOvershoot": 1.25 },
  "winSequence": { "highlightMs": 700, "countUpMs": 1400, "fountainMs": 1500, "settleMs": 1100, "coinsPerSecond": 70 },
  "particles": { "poolSize": 160, "gravity": 1700, "lifetimeMs": 1500, "speedMin": 520, "speedMax": 940, "spreadDeg": 70 },
  "server": { "latencyMs": 280, "failureRate": 0 }
}
```

## 10. Testing hooks

`createSlotGame(config, { seed, latencyMs: 0, failureRate?, server?, winView?, particleViewFactory? })`
returns `{ game, fsm, reels, fountain, winSequence, server, evaluator, symbols, update(dt) }` with
no DOM. Drive it by calling `update(1/60)` in a loop and awaiting microtasks. `vite.config.ts`
sets Vitest to `jsdom`, with tests in `tests/**/*.test.ts`.
