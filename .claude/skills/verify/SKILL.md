---
name: verify
description: >
  How to run and interpret this repo's verification gate (npm run typecheck && npm run lint &&
  npm test) and the dev server. Load it BEFORE declaring any change done, when the gate fails,
  when a date test behaves differently on another machine, or when starting the app to check a
  change by eye. Skipping it means declaring work done without the gate, or "fixing" a failure
  by easing a test, which the owner forbids.
---

# Verify a change

## The gate

```
npm run typecheck && npm run lint && npm test
```

All three must pass before a change is done. Never ease a test, tolerance, fixture or lint rule
to get there; fix the code. From Phase 4 on, also `npm run bench:axes` (must not regress against
`bench/axes/baseline.json`).

- `typecheck` is `tsc -b` over three projects: `tsconfig.core.json` (src/core, no DOM lib),
  `tsconfig.app.json` (UI), `tsconfig.node.json` (vite/eslint configs and `*.test.ts`). A
  "Cannot find name 'document'" error in src/core means DOM code crept into the engine — move it
  out, don't add the DOM lib.
- `lint` runs with `--max-warnings 0`; warnings fail the gate too.
- `test` is `vitest run`. Focus with `npx vitest run src/core/dates.test.ts` or `-t "<name>"`.

## Test-environment quirks

- `vite.config.ts` sets `TZ=America/New_York` for the test workers, so date tests run on a
  DST-observing host. A test asserts this took effect; if it fails, Node ignored `TZ`, and the
  DST tests would be proving nothing.
- Synthetic-chart tests use a seeded PRNG, so failures reproduce exactly.
- Fixture JSON is imported directly (`resolveJsonModule` in `tsconfig.node.json`).

## Seeing it run

`npm run dev` → http://localhost:5173, or `preview_start` with the `dev` entry in
`.claude/launch.json`. Check the console for errors. Stop the server before deleting
`node_modules`/`dist` on Windows (file locks).

## Proving a new test can fail

When adding a test for a fix, break the code briefly (or check out the parent commit) and
confirm the test fails, then restore. A test that passes on first run against new code has not
yet shown it can catch anything.
