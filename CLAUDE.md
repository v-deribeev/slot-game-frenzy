# Amaze Slot Machine Demo - Project Constitution

## Tech Stack

- **Language:** Strict TypeScript (`strict: true`) compiling to modern ESNext JS, plus a pure Vanilla JS utility module (`src/core/legacy-rng.js` with JSDoc types) to demonstrate seamless TS + JS interop.
- **Bundler:** Vite
- **Styling:** SCSS (`src/styles/main.scss`) using BEM naming, CSS variables, and hardware-accelerated transforms (`translate3d`).
- **Testing:** Vitest (`npm run test`)

## Mandatory Game Architecture & Design Patterns

Every agent working in this repository MUST enforce the following patterns:

1. **Finite State Machine (FSM) + Discriminated Unions (`src/core/StateMachine.ts`):**
   - Game states MUST be modeled as a TypeScript Discriminated Union:
     - `IDLE`
     - `SPINNING` (holds `betAmount: number`)
     - `SHOWING_WIN` (holds `winAmount: number`, `winningSymbols: string[]`)
     - `ERROR` (holds `errorCode: string`)
   - Use a JavaScript `Proxy` or strict state transition map inside `StateMachine` to block invalid transitions (e.g., cannot transition from `SPINNING` to `SPINNING`) and notify subscribers via Pub/Sub.

2. **60 FPS Game Loop with Delta Time (`src/core/GameLoop.ts`):**
   - Must use `requestAnimationFrame`.
   - Must calculate `deltaTime = (currentTime - lastTime) / 1000` (in seconds) and cap `deltaTime` at `0.1s` (to prevent huge jumps if the user switches browser tabs).
   - All reel movements and win animations must multiply speed by `deltaTime` so 30 FPS and 60 FPS finish in the exact same real-world duration.

3. **Object Pooling for Memory/GC Optimization (`src/core/ObjectPool.ts`):**
   - Never instantiate `new` objects inside the `requestAnimationFrame` update loop.
   - Pre-allocate a generic `ObjectPool<T>` (used for Win Celebration Coins/Particles or Reel Symbols) with `acquire()` and `release(item)` methods to prevent V8 Garbage Collection pauses.

4. **Composition Over Inheritance (`src/entities/SlotSymbol.ts`):**
   - Do NOT use deep class inheritance for symbols.
   - Use the Strategy/Component pattern: `SlotSymbol` holds an array of `SymbolBehavior` interfaces (e.g., `WildBehavior`, `MultiplierBehavior`).

5. **Async Choreography & Slam-Stop Cancellation (`src/core/WinSequence.ts`):**
   - The win presentation sequence (Highlight Symbols -> Count Up Win -> Coin Fountain) must be asynchronous and accept a native `AbortSignal` (`AbortController`).
   - Pressing the `Spacebar` during `SPINNING` or `SHOWING_WIN` triggers `abortController.abort()`, immediately cancelling animations, snapping the win counter to its final value, releasing pooled particles, and returning the FSM to `IDLE`.

6. **Declarative DSL Config (`src/core/game-dsl.json`):**
   - Define symbol payouts, reel strips, and win sequence timings in a declarative JSON DSL file parsed at runtime.
