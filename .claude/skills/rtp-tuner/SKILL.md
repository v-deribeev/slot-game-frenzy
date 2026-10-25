---
name: rtp-tuner
description: Audits and tunes slot game DSL configurations (game-dsl.json), reel strips, and payout tables to hit a target Return to Player (RTP) percentage (default 96.0% ± 1.5%) verified via Monte Carlo simulation.
---

# Slot RTP (Return to Player) Tuner Skill

When asked to tune or audit game payouts / RTP:

1. **Target Metric:** Standard European online slot RTP is **95.5% to 96.5%**.
2. **Rules for Tuning `src/core/game-dsl.json`:**
   - Never hardcode fake wins in the RNG; RTP must emerge naturally from **Reel Strip symbol weights** (how many times each low/high/wild/multiplier symbol appears on each reel strip) and **Paytable multipliers**.
   - High-paying symbols and Wilds/Multipliers should be scarcer on the reel strips than low-paying symbols.
3. **Verification Loop (Monte Carlo Test):**
   - Run a minimum **10,000-spin headless simulation** using seeded deterministic runs in Vitest.
   - Calculate `RTP = (totalWon / totalStaked) * 100`.
   - Iterate on `game-dsl.json` symbol frequencies and payouts until the measured RTP across 10,000+ spins lands within **94.5% – 97.5%**.
