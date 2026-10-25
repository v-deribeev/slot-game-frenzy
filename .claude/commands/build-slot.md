Execute the multi-agent slot development workflow:

1. Invoke the `@slot-architect` subagent to design `SPEC.md` and implement the full TypeScript + JS + SCSS slot machine according to `CLAUDE.md`. Wait for it to finish and verify `npm run build` passes.
2. Once the implementation is complete, hand off to the `@qa-tester` subagent to audit the code for race conditions, write the Vitest suite (including the 1,000-spin stress test and AbortController slam-stop test), run `npm run test`, and generate `QA_REPORT.md`.
3. Summarize the final architecture and test results.
