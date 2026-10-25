# QA Report: Amaze Frenzy Slot Engine

Date: 2026-10-25. Scope: `src/core`, `src/entities`, `src/ui`, `src/main.ts` checked against `CLAUDE.md` and `SPEC.md`.
Tooling: Vitest 5.0.5 (jsdom), TypeScript strict (`tsc` also type-checks `tests/`).

## 1. Summary

| Result | Value |
| --- | --- |
| `npm run test` | **5 files, 181 tests: 180 passed + 1 expected-fail (`it.fails`, open finding F-02), 0 failed**, about 1.7 s |
| `npm run build` | **pass** (`tsc` clean, `vite build` OK) |
| Findings | 9 total: 2 fixed (F-01, F-05), 7 open (1 High game-math, 1 Medium, 5 Low/Info) |
| Mutation check | 8 of 8 hand-injected src mutants caught (see section 5) |

## 2. Findings

| ID | Severity | Location | Description | Status |
| --- | --- | --- | --- | --- |
| F-01 | **Medium** (soft-lock) | `src/core/SlotGame.ts:242-247` | If the FSM rejected the `SHOWING_WIN` payload (for example a server response with non-string `winningSymbols`, or `totalWin` NaN/Infinity), `runSpin` returned `slammed` but left the FSM in **SPINNING**, with `controller = null`. After that `primaryAction` stayed `NONE` and every `spin()` returned `rejected`: a permanent soft-lock. | **Fixed**: the branch now calls `this.toIdle()`. Regression tests: `never soft-locks on a malformed win payload (*)`. |
| F-05 | Low (race) | `src/core/SlotGame.ts:268-272` (`fail`) | `fail()` notified ERROR while `inFlight` was still set. `toIdle()` releases the busy flag before notifying, but `fail()` did not. A subscriber that acknowledged the error and re-spun synchronously (autoplay) saw `IDLE` + `isBusy=true` + `primaryAction=NONE`, and its `spin()` was rejected. The effect was transient (cleared on the next microtask). | **Fixed**: `fail()` now clears `inFlight` and `controller` before notifying. Regression test: `lets an ERROR subscriber acknowledge and immediately re-spin`. |
| F-02 | Medium (spec violation, visual) | `src/entities/Reel.ts:148-161` (`beginLanding`) | SPEC section 4 says the landing begins at spin speed, with no velocity jump. In fact the tween distance is `minDistance + [0, stripLength)`, so the landing starts at 41-202 symbols/s against a spin speed of 18 (up to about 11x). The reel never reverses and always lands exactly on target. Fixing this means delaying each landing until the reel phase lines up (up to `len/spinSpeed` = about 1.1 s per reel, which can reorder the stagger), so it needs a design decision. | Open. Documented with `it.fails('landing begins at spin speed ... [F-02, open]')` in `tests/game-loop.test.ts`. That test flags itself for removal once the defect is fixed. |
| F-03 | **High** (game math, DSL) | `src/core/game-dsl.json` (paytable / reel strips / WILD x2) | An exhaustive scan of all 8,000 stop combinations gives a **theoretical RTP of 284.49%** (hit rate 38.45%, max win 60x bet). The 1,000-spin stress run agrees: it bet 35,595 and won 81,019. The machine pays out about 2.8x what it takes. This is a content/tuning issue, not an engine bug. | Open (needs game-design tuning). `symbols-payout.test.ts` asserts `rtp > 1` so a retune visibly updates the test. |
| F-04 | Low (balance semantics) | `src/core/SlotGame.ts:252-257` (`runSpin` inner `catch`) | On `INTERNAL_ERROR` after the server responded (for example a wrong stop count, which makes `ReelSet.stopAt` reject), the bet is **not refunded**. A server-side rejection, by contrast, refunds the bet. If the exception happens after the win was credited, the win is kept. So the balance is still conserved against the server's view of the round, but the policy differs from the server-error path. | Open (product decision). Recovery is tested: ERROR, then acknowledge, then IDLE. |
| F-06 | Low (timing) | `src/core/WinSequence.ts:149-155`; `src/entities/Reel.ts` / `ReelSet.ts` | Leftover dt past a step's end is dropped rather than carried into the next step, so each step can run up to 1 frame long. Measured difference between 30 and 60 FPS: within 4 frames @30 FPS (133 ms or less) over the 4.7 s win sequence, and 3 frames or less for reel landing. CLAUDE.md section 2 asks for exactly the same duration. | Open. Tests assert the bound. |
| F-07 | Info | `src/entities/CoinFountain.ts:181-183` | Semi-implicit Euler (`v += g*dt; y += v*dt`, as SPEC section 5 specifies) makes coin trajectories slightly frame-rate dependent (about 7 px of difference at t = 0.5 s between 30 and 60 FPS). Emission counts are frame-rate independent (tested). Cosmetic only. | Open / accepted. |
| F-08 | Info (GC) | `src/ui/SlotView.ts:82, 114-115` | No `new` in the rAF path (verified by audit, and the stress test confirms particle views are created only at pre-allocation). However `DomCoinView.render` builds 2 to 5 strings per live coin per frame (`toFixed` and the template), and `ReelView.render` builds a `translate3d` string per spinning reel per frame. That is about 300+ short-lived strings per frame at the 105-coin peak. | Open (minor optimisation). |
| F-09 | Low (dev-only leak) | `src/main.ts:54, 68, 74, 86-90` | The HMR `dispose` stops the loop and aborts the game, but does not remove the `resize`, `keydown` and `keyup` window listeners. It also leaves the injected `<style>` and coin nodes behind. After a hot reload, the old game's Space handler still fires next to the new one. | Open (dev builds only). |

### Audit checks that passed (no finding)
- **FSM**: a Proxy `set` trap validates both the transition map and the payload. States are frozen. Self-transitions (double spin) are blocked. Re-entrant notifications are queued in order. A throwing listener is isolated.
- **AbortController**: a new controller is created per spin and never reused. `ReelSet` and `WinSequence` both remove their `abort` listener on settle (verified with a listener tracker during the 1,000-spin run: 0 live listeners after every spin).
- **No double crediting**: the win is credited exactly once per response, including slam during SPINNING, slam during each SHOWING_WIN step, and slam spam.
- **Pool**: free-index stack and LIFO reuse. Double or foreign releases are rejected. `releaseAll` runs on every sequence exit. `activeCount` is 0 after every spin.
- **Game loop**: `requestAnimationFrame`, `dt = (now - last)/1000` clamped to [0, 0.1]. The next frame is scheduled before dispatch, so a throwing system cannot kill the loop. The callback list is copy-on-write. Only one frame handle is pending at a time, and `stop()` cancels it.
- **Re-entrant `spin()`** while busy resolves `rejected` with no debit. Bet changes are locked outside IDLE.
- **Determinism**: the same seed gives the same stops, wins and final balance at 30 FPS, at 60 FPS, and with slam-stops.

## 3. Source changes made

Both changes are in `src/core/SlotGame.ts`, are minimal, and each one has a regression test that failed before the fix:

1. `runSpin`, in the branch where the FSM rejects `SHOWING_WIN`: added `this.toIdle();` before `return` (F-01).
2. `fail()`: added `this.inFlight = null; this.controller = null;` before `onError` and the ERROR transition (F-05).

`npm run build` was re-run after both changes and passes.

## 4. Test inventory

| File | Tests | Covers |
| --- | --- | --- |
| `tests/slot-engine.test.ts` | 71 | FSM: full 4x4 transition matrix against the SPEC table, double-spin block, payload validation (bet, win, symbols, error code), unknown states, Proxy write/delete/define guards, frozen states and defensive copies, `reset()`, pub/sub (args, unsubscribe, throwing listener, re-entrant ordering, unsubscribe during dispatch), 1,000 rapid FSM cycles. ObjectPool: pre-allocation, **same 100 references reused** (`toBe`), LIFO, 10k churn without growth, double/foreign release, reset/onAcquire hooks, lazy growth up to max, release inside `forEachActive`, option validation. WinSequence abort after 50 ms. SlotGame: debit/credit and reel landing, re-entrant spin, insufficient funds, server error with refund, unknown error code, malformed stop count, **F-01 and F-05 regressions**, primary action per state, determinism across FPS and slams. Slam-stop: during SPINNING, during HIGHLIGHT, COUNT_UP and COIN_FOUNTAIN, slam spam (50 presses), random Space spam over 6,000 frames, slam while the server is pending (then resolve, or reject), no-op states, `dispose()`. Stress: **1,000 spins**, plus 300-spin re-entrant autoplay. |
| `tests/game-loop.test.ts` | 28 (incl. 1 `it.fails`) | `computeDeltaTime` (units, 0.1 cap, negative/NaN), default rAF wiring, dt and time passed to callbacks, tab-switch cap, single pending frame, `stop()` cancel, throwing system, dedupe, copy-on-write, `advance()`, total time equal at 30 and 60 FPS. Reel: speed*dt, equal distance at 30 and 60 FPS, exact landing and `onStopped` once, snap/halt, easing endpoints, no reversal, F-02. ReelSet: minSpin + stagger timing, 30 vs 60 FPS, stagger order, abort snap and listener removal, pre-aborted signal, bad stop count, stale-stop settle, wrapped column-major grid, 5 s gap capped. Frame-rate independence of WinSequence, coin emission and a full winning spin. |
| `tests/symbols-payout.test.ts` | 22 | Composition (no subclassing, behaviours, frozen), wild excludes, `withBehaviors` immutability, multiplier rules and validation, custom behaviour via the interface, registry duplicates. Line evaluation (x1, x2, x4, all-wild, non-pays, unknown id). Payouts (line bet, multi-line sums, unique winning symbols, cent rounding, shape validation, `winningPositions`). Exhaustive 8,000-combination scan for invariants and RTP. |
| `tests/dsl-rng.test.ts` | 45 | Shipped DSL parses and is deep-frozen; defaults; 31 invalid configs, each checked for the exact `DslValidationError.path` (including CSS-injection colours); non-finite numbers. mulberry32 determinism, range, chi-square uniformity, `nextInt` validation; `toSeed`; `buildGrid`. Spin server: grid-consistent responses, determinism independent of latency, injected schedule, `INVALID_BET` (async, no spin consumed), `NETWORK_TIMEOUT`, evaluator exceptions surface as rejections. |
| `tests/win-sequence.test.ts` | 15 | Full sequence: step order, monotonic count-up, particles emitted then released, duration. Zero timings, negative amount, non-positive dt. Abort during each step (resolves on microtasks alone, counter snapped, pool empty, listener removed, no resurrection afterwards). Pre-aborted signal, `skip()`, abort after completion, abort between steps, pre-emption by a new `play()`, 100 abort cycles. CoinFountain: fixed pool and views, backlog drop, physics and expiry, show/hide/render. |
| `tests/helpers.ts` | n/a | Headless engine factory, frame driver with soft-lock detection (`runUntil` throws if a promise stays pending past `maxFrames`), manual and scripted servers, stop finder, test PRNG, AbortSignal listener tracker. |

## 5. Final test output and mutation check

```
 Test Files  5 passed (5)
      Tests  180 passed | 1 expected fail (181)
   Duration  ~1.7s
```

Hand-injected mutants. Each was applied, the suite was run, and src was restored byte-identical afterwards:

| Mutant | Tests failed |
| --- | --- |
| WinSequence omits `emitter.releaseAll()` | 6 |
| ReelSet does not remove its abort listener | 2 |
| WinSequence does not remove its abort listener | 4 |
| No dt cap in `computeDeltaTime` | 3 |
| No refund on server error | 3 |
| Double credit on slam | 6 |
| FSM allows SPINNING -> SPINNING | 4 |
| Pool free-stack corruption | 12 |

## 6. Stress-test metrics (1,000-spin run, seed 20261025, 3% server failure rate)

| Metric | Value |
| --- | --- |
| Spins | 1,000 (535 completed, 433 slammed, 32 server errors, all recovered) |
| Slam-stops | 298 during SPINNING, 135 during SHOWING_WIN |
| Wins / full win presentations | 363 / 257 |
| Total bet / total won | 35,595 / 81,019 (start 1,000,000, end 1,045,424) |
| Balance conservation `start - bets + wins == end` | Holds **after every spin** (errors are refunded and excluded from bets) |
| Simulated time / frames | 1,940.9 s / 116,456 frames @60 FPS (longest spin 377 frames, about 6.3 s) |
| Wall-clock | about 0.54 s |
| Peak live particles | 105 of 160 (pool size constant at 160, views created exactly 160 times) |
| After every spin | FSM `IDLE`, `isBusy=false`, `primaryAction=SPIN`, reels at rest on server stops, no pending `stopAt`, WinSequence idle, `activeCount=0`, emitter stopped, FSM listener count unchanged, **0 live AbortSignal listeners** (peak 1) |
| Autoplay (re-entrant spin from IDLE subscriber) | 300 chained spins, all completed, balance conserved |
