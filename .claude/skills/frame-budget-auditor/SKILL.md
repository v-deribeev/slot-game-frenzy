---
name: frame-budget-auditor
description: Audits and fixes 60 FPS game loop code, reel physics/deceleration, DOM/GC string allocations per frame, and HMR event listener leaks.
---

# 60 FPS Frame-Budget & Physics Auditor Skill

When auditing or fixing rendering, animation, or reel physics code:

1. **Smooth Reel Deceleration:**
   - A landing reel must NEVER exceed its base spin velocity (`maxSpeed`).
   - If the target landing stop is too close when the server responds, add extra full revolutions (`+ stripLength`) or extend the landing duration so the reel smoothly decelerates from `spinSpeed` down to `0` using an easing curve.
2. **Zero Per-Frame GC Allocations:**
   - Inside `requestAnimationFrame` (`update(dt)` / `render()`), avoid creating new template strings, arrays, or objects on frames where values have not changed (cache the last rendered string/value and only touch `element.textContent` or `style.transform` when dirty).
3. **Lifecycle & HMR Cleanup:**
   - Always expose a `destroy()` / `dispose()` method and hook into `import.meta.hot?.dispose()` so `window` keyboard listeners (`Space`) and `requestAnimationFrame` loops never duplicate during Vite hot reloads.
