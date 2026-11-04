---
name: calibration-engine
description: >
  Invariants and test map for the pure-TS calibration engine in src/core/ (scales, date parsing,
  the affine pixel↔value fit, the Project model). Load it BEFORE editing anything in src/core/,
  before writing UI/worker code that converts pixels to values or parses axis values, before
  adding a scale type or a CalibrationError kind, and when a calibration test fails. Skipping it
  risks NaN/Infinity leaking into the table, host-time-zone bugs in date axes, or reimplementing
  math in components that must call src/core instead.
---

# Calibration engine (`src/core/`)

## Invariants — do not break these

1. **Pixels are stored, values are derived.** Points and refs live in image pixel coordinates
   (sub-pixel floats, origin top-left, y down). Values come from `Calibration.pixelToValue`
   every time; never store them. Changing a scale or ref must not move points.
2. **No NaN/Infinity escapes.** `calibrate()` returns `{ ok: false, error }` with a typed
   `CalibrationError` for every degenerate input. `pixelToValue` returns `null` per component
   where a scale cannot represent the value (reciprocal at u = 0, log overflow, dates past
   ±8.64e15 ms); `valueToPixel` returns `null` for out-of-domain values. Callers render
   `null` as blank/"—", never coerce it.
3. **UTC dates.** `parseDateTime` treats text as UTC unless it carries Z/UTC/GMT/±HH[:mm].
   Never use `new Date(string)`, `Date.parse`, or local getters in core. Ambiguous numeric
   dates (`03/04/2024`) are rejected, and `2024.5` is not May — both deliberate.
4. **DOM-free.** `tsconfig.core.json` has no DOM lib and ESLint bans browser globals there.
   Workers (Phases 4–5) import this module.
5. **Saved projects are versioned.** `parseProject` (`projectFile.ts`) is the only way JSON
   becomes a `Project`: it migrates (`MIGRATIONS[v]` upgrades v → v+1), validates and never
   throws on bad input. A schema change bumps `PROJECT_VERSION`, adds a migration and a
   `projectFile.test.ts` case, and updates SPEC → Data model.
6. **UI never reimplements math.** Components call `calibrate`, `pixelToValue`,
   `valueToPixel`, `parseDateTime`, `formatDateTime`.

## Error kinds (`CalibrationError['kind']`)

Checked in this order: `invalid-pixel` → `invalid-value` (unparseable / non-finite) →
`out-of-domain` → `reciprocal-straddles-zero` → `equal-values` → `coincident-points`
(< `COINCIDENT_TOLERANCE_PX`) → `singular-system` (sin angle between X-ref and Y-ref
directions < `SINGULAR_SINE_TOLERANCE`) → `numeric-overflow`. Each carries a user-facing
`message` naming the refs involved. Adding a kind: extend the union, add a row to the
`error cases` table in `calibrate.test.ts`, and document it in docs/SPEC.md.

## Adding a scale type

Add it to `SCALE_TYPES`, `SCALE_LABELS`, `DOMAIN_RULES`, `isInDomain`, `forward`, `inverse`
(the `switch` statements are exhaustive, so `tsc` lists every spot), add a `RANGES` entry in
`calibrate.test.ts` (the all-pairs round-trip test then covers it), and update the SPEC table.

## Test map

- `scales.test.ts` — transforms, domains, inverse(forward(v)) = v.
- `dates.test.ts` — accepted/rejected forms (table-driven), leap years, formatting, host-zone
  independence.
- `calibrate.test.ts` — synthetic charts with known geometry (axis-aligned, ±5° rotation,
  shear, non-square, flipped x/y, transposed); all 25 scale pairs round-trip; log10 ≡ ln;
  every error kind; date axes across DST changes and leap days.
- `projectFile.test.ts` — current/v1 files, newer-version refusal, every damaged-field message.
- `fixture-km.test.ts` — the real Kaplan–Meier figure in `fixtures/real/`: other ticks within
  1% of axis range, plateau row 295 ≈ 0.162.

Tolerances are tight on purpose (1e-9 relative values, 1e-6 px). If one fails, the engine is
wrong — find the bug; do not loosen the tolerance.
