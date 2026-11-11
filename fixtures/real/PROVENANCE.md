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

## Negative-value figures (added 2026-11-10)

Six figures whose data span negative X and/or Y values, chosen from a research shortlist and
approved by the owner. Each licence was re-read on the publisher's article page on 2026-11-10.
The full-size images were downloaded on 2026-11-10 from the URLs given; SHA-256 of each
downloaded file is recorded so the crop can be reproduced. All crops are whole-pixel boxes of the
source, no resampling. The Springer Nature licence sentence (A, C, D, F) reads: "Open Access This
article is licensed under a Creative Commons Attribution 4.0 International License, which permits
use, sharing, adaptation, distribution and reproduction in any medium or format, as long as you
give appropriate credit to the original author(s) and the source, provide a link to the Creative
Commons licence, and indicate if changes were made." Labelled by pixel analysis (Pillow, NumPy,
SciPy) in the negative-axis Claude Code session, 2026-11-10.

### angle-response-chea.png (980 × 642, PNG)

- **Source**: Chea M, Croisé M, Huet C, Bassinet C, Benadjaoud M-A, Jenny C. MR compatible
  detectors assessment for a 0.35 T MR-linac commissioning. *Radiation Oncology* 2024;19:40.
- **DOI**: 10.1186/s13014-024-02431-8 — **PMC**: PMC10956263
- **Figure / panel / crop**: Fig. 10, panel **a** (angular response of three detectors relative
  to the PTW31010 chamber at the MRIdian, an Excel chart); crop `0–980, 0–642` of the publisher's
  full-size figure `MediaObjects/13014_2024_2431_Fig10_HTML.png` (1960 × 642, SHA-256
  `b8bce527…`) from `media.springernature.com/full/springer-static/image/…`.
- **Licence**: CC BY 4.0 — Springer Nature sentence above — http://creativecommons.org/licenses/by/4.0/
- **Attribution**: Chea M et al. (2024), Radiat Oncol 19:40, doi:10.1186/s13014-024-02431-8,
  Fig. 10a. © The Author(s) 2024. Licensed under CC BY 4.0. Cropped to panel a.
- **Obtained**: 2026-11-10 from the publisher (Springer Nature media server).
- **Labelled by**: truth in `angle-response-chea.json` (axis lines, 7 + 9 value positions, no
  tick marks; 36 visible marker centres of three series; 4 known values). The text gives the
  deviations at 60° as −0.5, −6.6 and −11.9 % (PTW 60019, PTW 60023, SN Edge) and +4 % at −60°
  (PTW 60019); the marker centres read −0.51, −6.62, −11.90 and +3.95 % through the labelled
  gridlines (the last within the text's whole-percent rounding, 1.9 px).

### hysteresis-loops-zhou.png (1835 × 1458, PNG)

- **Source**: Zhou TH, Zhang B, Zheng X, Song Y, Si P, Choi C-J, Cho Y-R, Park J. Anisotropic
  SmFe10V2 Bulk Magnets with Enhanced Coercivity via Ball Milling Process. *Nanomaterials*
  2024;14(16):1329.
- **DOI**: 10.3390/nano14161329 — **PMC**: PMC11357663
- **Figure / panel / crop**: Fig. 6, panel **a** (demagnetization-corrected hysteresis loops of
  seven anisotropic bulks, AP-04 … AP-40); crop `0–1835, 0–1458` of the publisher's figure
  `nanomaterials-14-01329-g006.png` (3832 × 1458, SHA-256 `1cb00e4c…`) from
  `mdpi-res.com/nanomaterials/nanomaterials-14-01329/article_deploy/html/images/`.
- **Licence**: CC BY 4.0 — "This article is an open access article distributed under the terms
  and conditions of the Creative Commons Attribution (CC BY) license
  (https://creativecommons.org/licenses/by/4.0/)."
- **Attribution**: Zhou TH et al. (2024), Nanomaterials 14(16):1329, doi:10.3390/nano14161329,
  Fig. 6a. © 2024 by the authors. Licensee MDPI. Licensed under CC BY 4.0. Cropped to panel a.
- **Obtained**: 2026-11-10 from the publisher (MDPI resource server).
- **Labelled by**: truth in `hysteresis-loops-zhou.json` (frame lines, 9 + 9 major and 10 + 10
  minor ticks, zero lines). The text gives Hc = 9.86 kOe for AP-35 (3.5 GPa, red) and 0.13 kOe
  for AP-04 (0.4 GPa, cyan), and Ms at 23 kOe of 73–79 emu/g; the red loop's zero crossings read
  −9.96 / +9.75 kOe from the pixels, Hc 9.86 kOe; the cyan loop's two branches lie inside one
  ~15 px stroke at M = 0 (≈ 0.5 kOe), so 0.13 kOe cannot be read. No `knownValues` (the values
  are on the X axis or ranges).

### moke-loops-nayyef.png (942 × 865, PNG)

- **Source**: Nayyef H, Świerkosz E, Janus W, Klimeczek A, Szpytma M, Zając M, Dróżdż P,
  Kozioł-Rachwał A, Ślęzak T, Ślęzak M. Tunable interplay between exchange coupling and uniaxial
  magnetic anisotropy in epitaxial CoO/Au/Fe trilayers. *Scientific Reports* 2023;13:10902.
- **DOI**: 10.1038/s41598-023-38098-6 — **PMC**: PMC10322835
- **Figure / panel / crop**: Fig. 4, panel **a** (three MOKE hysteresis loops: 300 K, 80 K ZFC,
  80 K FC); crop `0–942, 0–865` of the publisher's full-size figure
  `MediaObjects/41598_2023_38098_Fig4_HTML.png` (2007 × 1725, SHA-256 `f7602bf3…`).
- **Licence**: CC BY 4.0 — Springer Nature sentence above — http://creativecommons.org/licenses/by/4.0/
- **Attribution**: Nayyef H et al. (2023), Sci Rep 13:10902, doi:10.1038/s41598-023-38098-6,
  Fig. 4a. © The Author(s) 2023. Licensed under CC BY 4.0. Cropped to panel a.
- **Obtained**: 2026-11-10 from the publisher (Springer Nature media server).
- **Labelled by**: truth in `moke-loops-nayyef.json` (frame lines, 7 + 5 major and 6 + 4 minor
  ticks, zero lines). The text gives HEB ≈ 180 Oe and MR = 1 after field cooling at 80 K (Fig.
  4c/d). **Disagreement**: the red FC loop in panel a crosses M = 0 at about −31 and +467 Oe in
  the pixels (marker clouds ±10 Oe), a loop shift of ≈ 218 Oe, not 180; recorded, not forced.
  MR = 1 agrees: at H = 0 the red ascending branch sits on its −1.0 plateau.

### bland-altman-rabe.png (975 × 482, PNG)

- **Source**: Rabe M, Dietrich O, Forbrig R, Niyazi M, Belka C, Corradini S, Landry G, Kurz C.
  Repeatability quantification of brain diffusion-weighted imaging for future clinical
  implementation at a low-field MR-linac. *Radiation Oncology* 2024;19:31.
- **DOI**: 10.1186/s13014-024-02424-7 — **PMC**: PMC10916154
- **Figure / panel / crop**: Fig. 3, panel **c** (Bland–Altman plot, highSNR variant,
  cylindrical ROIs; matplotlib); crop `0–975, 482–964` of the publisher's full-size figure
  `MediaObjects/13014_2024_2424_Fig3_HTML.png` (1961 × 964, SHA-256 `60875fc6…`). The shared
  marker legend above panel a is not in the crop.
- **Licence**: CC BY 4.0 — Springer Nature sentence above — http://creativecommons.org/licenses/by/4.0/
- **Attribution**: Rabe M et al. (2024), Radiat Oncol 19:31, doi:10.1186/s13014-024-02424-7,
  Fig. 3c. © The Author(s) 2024. Licensed under CC BY 4.0. Cropped to panel c.
- **Obtained**: 2026-11-10 from the publisher (Springer Nature media server).
- **Labelled by**: truth in `bland-altman-rabe.json` (frame lines, 6 + 9 major and 20 + 28 minor
  ticks; bias and limits-of-agreement lines). The text gives bias +2 with LoA [−42, +46]
  × 10⁻⁶ mm²/s for the highSNR ROIs; the drawn lines read +1.74, −42.12 and +46.11 through the
  ticks (within ±1 px of the text's integers).

### beam-profile-pittet.jpg (1264 × 936, JPEG)

- **Source**: Pittet P, Esteves J, Galvan J-M, Lu G-N, Blanc F, Haefeli G, Hopchev P, Rit S,
  Desbat L, Ribouton J, Jalade P. SciFi detector and associated method for real-time
  determination of profile and output factor for small fields in stereotactic radiotherapy.
  *Medical Physics* 2020;47(4):1930–1939.
- **DOI**: 10.1002/mp.14019 — **PMC**: PMC7216919
- **Figure / panel / crop**: Fig. 8, panel **b** (15-mm circular field: SciFi profile as blue
  dots vs EBT3 film as an orange line; Excel chart), without the reconstructed-image and film
  thumbnails at the right and without the "(b)" caption; crop `0–1264, 1008–1944` of the
  publisher's figure `mp14019-fig-0008-m.jpg` (2128 × 3053, progressive JPEG, 4:4:4, SHA-256
  `ef6abf86…`) from `aapm.onlinelibrary.wiley.com/cms/asset/8878b6e7-bb64-40a2-a3d3-bb862b49b451/`.
  **Re-encoded**: no lossless JPEG cropper was available, so the crop (top-left on the 8-px block
  grid) was decoded and re-saved as a baseline JPEG with the source's own quantization tables and
  4:4:4 sampling (Pillow); against the decoded source crop 2.8 % of samples differ, by at most 7
  grey levels (mean 0.04).
- **Licence**: CC BY 4.0 — "This is an open access article under the terms of the Creative
  Commons Attribution License, which permits use, distribution and reproduction in any medium,
  provided the original work is properly cited." — http://creativecommons.org/licenses/by/4.0/
- **Attribution**: Pittet P et al. (2020), Med Phys 47(4):1930–1939, doi:10.1002/mp.14019,
  Fig. 8b. © 2020 The Authors. Medical Physics published by Wiley Periodicals, Inc. on behalf of
  AAPM. Licensed under CC BY 4.0. Cropped to panel b.
- **Obtained**: 2026-11-10 from the publisher (Wiley Online Library).
- **Labelled by**: truth in `beam-profile-pittet.json` (L-shaped axes, 9 + 3 major and 20 + 9
  minor ticks; SciFi flat top and tails as known values). Table 2 (15 mm) gives FWHM 14.77 mm
  (SciFi) / 15.07 mm (EBT3) and 20–80 % penumbra 2.24 / 2.03 mm. From the pixels: SciFi FWHM
  14.76 mm (agrees); **disagreements** recorded, not forced: SciFi penumbra 2.05 mm (both sides)
  vs 2.24, EBT3 FWHM 14.79 mm vs 15.07 (half of the plotted 1.0 level).

### hysteresis-ferrite-tahir.png (968 × 809, PNG)

- **Source**: Tahir W, Zeeshan T, Waseem S, Ali MD, Kayani Z, Aftab Z-H, Mehtab SMT, Ezzine S.
  Impact of silver substitution on the structural, magnetic, optical, and antibacterial
  properties of cobalt ferrite. *Scientific Reports* 2023;13:15730.
- **DOI**: 10.1038/s41598-023-41729-7 — **PMC**: PMC10514321
- **Figure / panel / crop**: Fig. 13 (hysteresis loops of AgxCo1−xFe2O4, x = 0, 0.05, 0.1,
  0.15), the whole figure as served (`MediaObjects/41598_2023_41729_Fig13_HTML.png`, 968 × 809,
  SHA-256 `1859a9d7…`); the file is the publisher's, byte for byte.
- **Licence**: CC BY 4.0 — Springer Nature sentence above — http://creativecommons.org/licenses/by/4.0/
- **Attribution**: Tahir W et al. (2023), Sci Rep 13:15730, doi:10.1038/s41598-023-41729-7,
  Fig. 13. © The Author(s) 2023. Licensed under CC BY 4.0.
- **Obtained**: 2026-11-10 from the publisher (Springer Nature media server).
- **Labelled by**: truth in `hysteresis-ferrite-tahir.json` (frame lines, 9 + 11 major and 8 +
  10 minor ticks, zero lines, 8 known values). Table 9 gives Ms 48.34, 29.06, 40.69, 45.85 emu/g
  (x = 0, 0.05, 0.1, 0.15); the curve ends at ±2 kOe read +48.48 / −48.34, +29.16 / −28.95,
  +40.65 / −40.61, +46.04 / −45.91 (within 1.2 px). Table 9's coercivity column is in the wrong
  unit ("Oe", values 0.02–0.05) and is not used.

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
