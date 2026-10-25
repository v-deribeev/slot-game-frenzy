---
description: Fixes open QA issues using skills, opens a GitHub PR, and enters an autonomous review/debate loop (max 4 rounds) with the Gemini PR Reviewer.
---

Execute this autonomous workflow end-to-end without stopping for human input until the PR is approved or 4 review rounds are completed:

1. **Create Feature Branch:**
   - Run `git checkout -b fix/rtp-and-reel-physics`.
2. **Create & Optimize Skills (if not yet created) & Apply Fixes:**
   - Ensure `.claude/skills/rtp-tuner/SKILL.md` and `.claude/skills/frame-budget-auditor/SKILL.md` exist and are concise/token-optimized.
   - Retune `src/core/game-dsl.json` to achieve ~96% RTP (verified by a Monte Carlo test in Vitest).
   - Fix the reel landing velocity spike in `Reel.ts`, remove `test.fails` so all 181+ tests pass, and fix the 4 minor items in `QA_REPORT.md` (post-response error bet refund, 30 FPS vs 60 FPS drift, per-frame string allocations, and HMR Space listener cleanup).
   - Verify `npm run build` and `npm run test` pass 100%.
3. **Commit & Open Pull Request:**
   - Commit the changes and push `fix/rtp-and-reel-physics` to `origin`.
   - Open a Pull Request using `gh pr create --fill` (make sure `gh auth status` is logged in).
4. **Autonomous Cross-Model PR Review Loop (Max 4 Iterations):**
   - For `iteration = 1` to `3`:
     - Wait for the GitHub Action `Slot CI & Gemini AI PR Review` to finish (`gh run watch` or sleep 25s and check `gh pr view --comments`).
     - Read the latest `## 🤖 Gemini Cross-Model PR Review` comment.
     - If it contains `VERDICT: APPROVED`, stop the loop and announce the PR is ready for human merge!
     - If it contains `VERDICT: CHANGES_REQUESTED`:
       - Analyze each point raised by Gemini:
         - **Valid Issue:** Fix the code surgically with `Edit`, add/update a Vitest test proving the fix, and commit/push.
         - **Invalid / Lower-Quality Suggestion:** Do NOT blindly degrade the code. Instead, write a Vitest test or benchmark proving why our current implementation is superior/correct, and post a reply on the PR using `gh pr comment --body "[CLAUDE-RESPONSE] ..."` citing exact line numbers and test results so Gemini re-evaluates!
