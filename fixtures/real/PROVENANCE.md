# Provenance of the real figures

Every real-world figure in this repository (`fixtures/real/`, listed for the benchmarks in
`bench/axes/real/manifest.json` and `bench/lines/real/manifest.json`; the synthetic charts are
generated and need no provenance) is a published figure released under the Creative Commons
Attribution licence (CC BY 4.0), which permits redistribution and adaptation (here: cropping to
one panel) with attribution. **Only CC BY figures may be added**; record every new one here with
the same fields. Licences were re-checked against the publisher's page on 2026-11-07.

Pixel positions in the labels follow the app's convention (integer = pixel centre, origin
top-left); crop boxes are given in the source image's pixels as `x0–x1, y0–y1` (end exclusive).

## km-pericardial-pao.png (710 × 691, greyscale PNG)

- **Source**: Pao T-H, Chang W-L, Chiang N-J, Lin C-Y, Lai W-W, Tseng Y-L, Lin F-C. Pericardial
  effusion after definitive concurrent chemotherapy and intensity modulated radiotherapy for
  esophageal cancer. *Radiation Oncology* 2020;15:48.
- **DOI**: 10.1186/s13014-020-01498-3 — **PMC**: PMC7045635
- **Figure / panel / crop**: Fig. 1, panel **c** (mean pericardium dose > 20.33 Gy vs
  ≤ 20.33 Gy); crop `0–710, 740–1431` of the publisher's full-size figure
  `MediaObjects/13014_2020_1498_Fig1_HTML.png` (1418 × 1431), whole pixels, no resampling.
- **Licence**: CC BY 4.0 — "This article is distributed under the terms of the Creative Commons
  Attribution 4.0 International License" — http://creativecommons.org/licenses/by/4.0/
- **Attribution**: Pao T-H et al. (2020), Radiat Oncol 15:48, doi:10.1186/s13014-020-01498-3,
  Fig. 1c. © The Author(s) 2020. Licensed under CC BY 4.0. Cropped to panel c.
- **Obtained**: 2026-11-07 from the publisher (Springer Nature media server).
- **Labelled by**: pixel analysis (Pillow) in the release-hygiene Claude Code session,
  2026-11-07; truth in `km-pericardial-pao.json` (axis lines, 4 + 5 ticks, 7 plateaus). The
  article reports no cumulative-incidence percentages for this panel; the labelled plateau
  values are read from the pixels through the labelled ticks (±1 px ≈ ±0.0024). Number at risk
  (from the figure): > 20.33 Gy 86, 12, 6, 0 and ≤ 20.33 Gy 40, 15, 8, 5 at 0, 24, 48, 72 months.

## km-sas-frame-ikawa.png (967 × 725, PNG)

- **Source**: Ikawa T, Ishihara R, Matsueda K, Konishi K, Yamamoto S, Morimoto M, Kanayama N,
  Teshima T. Influence of radiation dose and predicted tumor invasion depth on local recurrence
  after definitive chemoradiotherapy for stage 0–I esophageal squamous cell carcinoma: a
  propensity score-weighted, retrospective, observational study. *BMC Cancer* 2022;22:301.
- **DOI**: 10.1186/s12885-022-09418-2 — **PMC**: PMC8939113
- **Figure / panel / crop**: Fig. 1, panel **a** (local recurrence); crop `3–970, 2–727` of the
  publisher's full-size figure `MediaObjects/12885_2022_9418_Fig1_HTML.png` (1944 × 731): the
  left panel inside its light-grey border and the divider between the panels; whole pixels.
- **Licence**: CC BY 4.0 — "Open Access This article is licensed under a Creative Commons
  Attribution 4.0 International License, which permits use, sharing, adaptation, distribution and
  reproduction in any medium or format, as long as you give appropriate credit to the original
  author(s) and the source, provide a link to the Creative Commons licence, and indicate if
  changes were made." — http://creativecommons.org/licenses/by/4.0/
- **Attribution**: Ikawa T et al. (2022), BMC Cancer 22:301, doi:10.1186/s12885-022-09418-2,
  Fig. 1a. © The Author(s) 2022. Licensed under CC BY 4.0. Cropped to panel a.
- **Obtained**: 2026-11-07 from the publisher (Springer Nature media server).
- **Labelled by**: pixel analysis (Pillow) in the release-hygiene Claude Code session,
  2026-11-07; truth in `km-sas-frame-ikawa.json` (frame lines, 8 + 11 ticks, 9 plateaus of four
  series, line styles). Number at risk (figure, unweighted population): High dose 68, 60, 55,
  51, 47, 41, 37, 33; Standard dose 66, 52, 40, 33, 26, 20, 10, 6 at 0, 12, …, 84 months. The
  abstract reports adjusted 3-year local recurrence of 33.8 % (standard dose) and 9.6 % (high
  dose), consistent with the labelled weighted plateaus 0.337 and 0.096.

## km-same-colour-styles.jpg (763 × 624, JPEG)

- **Source**: Takata N, et al. *Journal of Radiation Research* 2018;59(3):291–297.
- **DOI**: 10.1093/jrr/rry029 — **PMC**: PMC5967453
- **Figure / panel / crop**: Fig. 1 (cumulative incidence, TFT solid vs FFT dashed), whole figure
  as served by the publisher (no crop).
- **Licence**: CC BY 4.0 — http://creativecommons.org/licenses/by/4.0/
- **Attribution**: Takata N et al. (2018), J Radiat Res 59(3):291–297, doi:10.1093/jrr/rry029,
  Fig. 1. © The Author(s) 2018. Licensed under CC BY 4.0.
- **Obtained**: 2026-11-06 (Phase 6, same-colour line tracing).
- **Labelled by**: pixel analysis in the Phase 6 Claude Code session, 2026-11-06; truth in
  `km-same-colour-styles.json` (axis lines, 5 + 5 ticks, 5 plateaus of two series, line styles).

## scatter-errorbars-glowa.png (960 × 674, PNG)

- **Source**: Glowa C, et al. Relative biological effectiveness of oxygen ion beams in the rat
  spinal cord: Dependence on linear energy transfer and dose and comparison with model
  predictions. *Physics and Imaging in Radiation Oncology* 2024;30:100581.
- **DOI**: 10.1016/j.phro.2024.100581 — **PMC**: PMC11070926
- **Figure / panel / crop**: Fig. 3, panel **a** (RBE vs LET: red filled circles = 1 Fx oxygen,
  blue filled squares = 2 Fx oxygen, grey circles/squares = carbon literature data, with
  horizontal and vertical error bars and 2nd-order fits); crop `0–1440, 0–1011` of the
  publisher's large JPEG `1-s2.0-S2405631624000514-gr3_lrg.jpg` (3066 × 2182, four panels),
  then **downscaled by exactly 2/3 (Lanczos) to 960 × 674** so the markers are 12–14 px, a
  journal-page size, and saved as PNG. Not a whole-pixel copy of the source: this is a derived
  (resampled) image of the panel.
- **Licence**: CC BY 4.0 — "This is an open access article under the CC BY license
  (http://creativecommons.org/licenses/by/4.0/)." — http://creativecommons.org/licenses/by/4.0/
- **Attribution**: Glowa C, et al. (2024). Relative biological effectiveness of oxygen ion beams
  in the rat spinal cord: Dependence on linear energy transfer and dose and comparison with
  model predictions. Physics and Imaging in Radiation Oncology 30:100581.
  https://doi.org/10.1016/j.phro.2024.100581. CC BY 4.0. Cropped to panel a and downscaled.
- **Obtained**: 2026-11-07 from the publisher (Elsevier, ars.els-cdn.com) by the supervisor's
  provenance trace (`evidence/corpus/scatter-date/raw/scat03/FILES.md` records the download
  and the file's SHA-256).
- **Labelled by**: pixel analysis (Pillow) in the release-hygiene Claude Code session,
  2026-11-07; truth in `scatter-errorbars-glowa.json` (frame lines, 10 + 9 major and 36 + 32
  minor ticks, 4 + 4 marker centres ±0.5 px, legend samples). Independent data truth: the
  article's Table 2 gives RBE ± SE at LET 26, 66, 98 and 141 keV/µm — 1 Fx 1.43, 1.71, 1.82,
  1.56; 2 Fx 1.58, 2.01, 2.21, 1.99 — which the labelled centres reproduce through the ticks
  within 0.01 RBE / 0.5 keV/µm. The horizontal bars' half-widths are not tabulated.

## Removed (release hygiene, 2026-11-07)

Three figures used during development were not CC BY and were removed from the tree before the
public release. They were replaced by the figures above, with the tests and benchmarks ported
to the replacements. **Git history was deliberately not rewritten**: the files remain in earlier
commits of this repository's history, which is a development record, not a redistribution.

| Removed file | Source | Licence | Replaced by |
| --- | --- | --- | --- |
| `km-pericardial-effusion.jpg` + `.json` | Takeuchi et al. 2020, Fig. 1 (cumulative incidence of pericardial effusion) | CC BY-NC (non-commercial clause: not CC BY) | `km-pericardial-pao.png` |
| `km-cns-lymphoma.png` + `.json` | Curry et al. 2023 (SAS Kaplan–Meier plot) | Subscription article, no reuse licence | `km-sas-frame-ikawa.png` |
| `scatter-filled-open-errorbars.png` + `.json` (`Graph.png`) | Moiseenko et al. 2012 (filled vs open circles with error bars) | Subscription article, no reuse licence | `scatter-errorbars-glowa.png` |

A fourth CC BY candidate for the scatter case, Kim et al. 2020 (PLoS ONE, doi
10.1371/journal.pone.0234829, Fig 2a), was tried first and withdrawn the same day — not for
licensing, but because its pixel-doubled 8-px markers coincide at four of five points, which
turned the find-points check into a documented failure; it is not in the tree.

The benchmark baselines (`bench/axes/baseline.json`, `bench/lines/baseline.json`) were
re-recorded for the new corpus in the same change; the previous per-figure numbers are kept in
`docs/SPEC.md` (Phase 4/5/6 baselines) as history.
