"""
Generates the synthetic line-tracing corpus in bench/lines/synthetic/: matplotlib charts with
one to four series each and exact per-series ground truth (data points, their pixel positions,
the drawn polyline, step corners, marker centres) plus a seed pixel on every series.
Run offline and commit the output; the benchmark itself never needs Python:

    npm run bench:lines:corpus    (= python bench/lines/generate.py; Python 3.12, matplotlib 3.10,
                                   numpy, Pillow)

Everything is seeded per chart, so a rerun reproduces the same files (given the same
matplotlib/font versions). Do not edit the output by hand and do not change a chart because the
tracer gets it wrong: the corpus measures the tracer, not the other way round.

Coordinates are image pixels in the app's convention: integer = pixel centre, origin top-left,
y down (docs/SPEC.md -> Pixel convention); a matplotlib display point (xd, yd) is pixel
(xd - 0.5, H - yd - 0.5). Pixel snapping is off (`path.snap: False`) so drawn lines sit exactly on
their recorded positions.

Scenarios (chart i uses SCENARIOS[i % 8]): smooth crossing curves, lines with markers, dashed /
dotted / dash-dot lines, Kaplan-Meier step curves (starting together at 1.0, with '+' censoring
marks of the same colour), scatter, black series on black axes, a mix of kinds, and many series
on dark gridlines. Gridlines, legends, box/L frames, line widths, DPI (72-200) and JPEG (every
third chart, q35-90) vary on top. Appended later (earlier charts stay byte-identical): l60-l71
zigzag polylines ("kinks"), l72-l83 pairs of series of one colour told apart only by line style
("same-colour": solid + dashed or dotted KM steps starting together, crossing smooth curves, close
plateaus), l84-l95 pairs of scatter series of one colour told apart only by marker fill or shape
("find-points": filled vs open circles / squares / triangles, filled circles vs filled squares,
with vertical and horizontal error bars and caps, overlapping pairs, markers against the x axis, a
dashed reference line of the same colour, legends), l96-l107 a thick solid sigmoid with dashed
confidence curves among straight lines of its own colour ("grid-crossing", like a dose-response
figure: gridlines at every y tick and outlined histogram bars whose tops it crosses at shallow
angles, drawn in the series' colour, black in two charts of three), l108-l115 survival-style
pairs of one colour under an X axis drawn along the top ("top-axis": a Γ frame with the X tick
labels above the plot, log or linear Y; a solid line with filled squares and a dashed one with open
squares and tall error bars around fitted curves, both starting at the top-left corner, where they
meet the top axis), l116-l127 old black-and-white scans ("scan-grid": a heavy black major grid and
frame, a solid fitted curve and two dashed confidence curves of the same black whose dashes vary in
length like hand-drawn ones, "x" and open "o" markers on and near the curves; rendered, then blurred,
thresholded against a smooth random field (uneven stroke width), noised and, in two charts of three,
rotated by up to half a degree before the threshold, like a scan; the truth is rotated with it),
l128-l139 busy scatterplots ("busy-scatter": 300-1000 small black "+", "x" or dot markers in
dense, overlapping clusters with rows of equal y, 25-80 filled diamonds among them, one to three
grey or coloured iso-probability curves through the cloud - the first a steep straight stretch
meeting the curve at a 25-40 degree corner - "1%"/"3%"/"5%" labels at their starts, an offset
range frame, log-log or linear; build_busy), l140-l169 marker styles ("marker-styles": two to
four marker classes per chart with exact per-class centres - stars, triangles in four directions,
pentagons, hexagons, thin diamonds, filled plus / x, thin x and +, circles, squares, diamonds; filled,
open (white inside), hollow (the line shows through), black- or white-edged, semi-transparent and
overlapping; 4.5-16 px; classes of one colour or of similar hues; x / y error bars with and without
caps, in the marker's colour or black; pure scatter or on a connecting line; legends with sample
markers inside the plot; light gridlines, the dark_background, ggplot and seaborn-darkgrid style
sheets; JPEG and 72-96 dpi; every class is a scatter series seeded on one of its markers;
build_marks).

Seeds: a pixel on the series, as a user would click it: on visible ink of that series (checked in
the rendered image: coverage >= 0.6 by the series colour, and no ink of another colour - gridline,
axis, other series, text - within 3 px), as far as possible from every other series and from the
legend, preferring a random position in the middle half of the series; on a horizontal stretch for
steps, on the line between markers for lines with markers, on an isolated marker for scatter.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.colors import to_rgb  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402
from PIL import Image  # noqa: E402

OUT = Path(__file__).resolve().parent / "synthetic"
COUNT = 170

FONTS = ["DejaVu Sans", "DejaVu Serif", "Arial", "Times New Roman", "Calibri", "Verdana", "Segoe UI"]
DPIS = [72, 96, 100, 120, 150, 200]
SCENARIOS = ["curves", "line-markers", "dashed", "step", "scatter", "black", "mixed", "dense"]
# Charts from KINKS_FROM on (appended later, so the first 60 stay byte-identical): zigzag polylines
# with a marker on every vertex - sharp V/Lambda reversals hidden under markers of the line's own
# colour or of another colour drawn on top, in varying sizes.
KINKS_FROM = 60
# Charts from SAME_FROM on: two series of the same colour, one solid and one dashed or dotted.
SAME_FROM = 72
SAME_VARIANTS = ["km-together", "crossing", "close-plateaus", "dotted"]
# Charts from POINTS_FROM on: two scatter series of the same colour, told apart by fill or shape.
POINTS_FROM = 84
POINTS_VARIANTS = ["circle", "square", "triangle", "shapes"]
# Charts from CROSS_FROM on: a thick curve crossing gridlines and bar outlines of its own colour.
CROSS_FROM = 96
# Charts from TOP_FROM on: the X axis along the top of the plot (no bottom axis), two series of one
# colour starting together at the top-left corner, with square markers and error bars.
TOP_FROM = 108
TOP_VARIANTS = ["log", "linear"]
# Charts from SCAN_FROM on: an old printed figure scanned in black and white ("scan-grid"): a heavy
# black major grid and frame, a solid fitted curve and two hand-dashed confidence curves of the same
# black, "x" and "o" data markers on and near them, then a scanner's blur, noise, uneven stroke
# width and (two charts in three) a slight rotation. Built by build_scan.
SCAN_FROM = 116
# Charts from BUSY_FROM on: a busy scatterplot ("busy-scatter"): 300-1000 small black markers of two
# or three shapes ("+", "x" or dots, filled diamonds) in dense, overlapping clusters with rows of
# equal y, one to three grey or coloured curves running through them (the first with a corner),
# percent labels at the curves' starts and an offset range frame; log-log or linear. Built by
# build_busy.
BUSY_FROM = 128
BUSY_VARIANTS = ["log-log", "linear"]
# Charts from MARKS_FROM on (l140-l169): marker styles for "Find points" - one entry of MARK_CHARTS
# per chart. Built by build_marks.
MARKS_FROM = 140
PALETTE = ["C0", "C1", "C2", "C3", "C4", "C5", "C6", "C8", "C9"]
MARKERS = ["o", "s", "^", "D", "v", "x", "+"]
STYLES = {"dashed": "--", "dotted": ":", "dashdot": "-."}


def px_of(display: np.ndarray, height: int) -> np.ndarray:
    d = np.atleast_2d(display).astype(float)
    return np.column_stack([d[:, 0] - 0.5, height - d[:, 1] - 0.5])


def smooth_curve(rng: np.random.Generator, x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """A smooth function of x spanning roughly [lo, hi]."""
    t = (x - x.min()) / (x.max() - x.min())
    kind = int(rng.integers(0, 4))
    if kind == 0:
        y = np.sin(2 * math.pi * (rng.uniform(0.4, 1.8) * t + rng.uniform(0, 1)))
    elif kind == 1:
        y = np.exp(-rng.uniform(1, 5) * t) * 2 - 1
    elif kind == 2:
        y = np.tanh(rng.uniform(4, 12) * (t - rng.uniform(0.2, 0.8)))
    else:
        c = rng.uniform(-1, 1, 3)
        y = c[0] + c[1] * (2 * t - 1) + c[2] * (2 * t - 1) ** 2
        y = (y - y.min()) / max(1e-9, y.max() - y.min()) * 2 - 1
    a = rng.uniform(0.3, 0.5) * (hi - lo)
    return (lo + hi) / 2 + a * y + rng.uniform(-0.15, 0.15) * (hi - lo)


def km_curve(rng: np.random.Generator, t_end: float):
    """Kaplan-Meier estimate of a random cohort: step x/y (steps-post) and censoring times."""
    n = int(rng.integers(15, 60))
    events = rng.exponential(rng.uniform(0.3, 1.5) * t_end, n)
    censor = rng.uniform(0.1, 1.2, n) * t_end
    time = np.minimum(events, censor)
    observed = events <= censor
    order = np.argsort(time)
    time, observed = time[order], observed[order]
    s = 1.0
    xs, ys, cens = [0.0], [1.0], []
    at_risk = n
    for ti, ob in zip(time, observed):
        if ti >= t_end:
            break
        if ob:
            s *= (at_risk - 1) / at_risk
            xs.append(float(ti))
            ys.append(s)
        else:
            cens.append((float(ti), s))
        at_risk -= 1
        if at_risk == 0:
            break
    end = min(t_end, float(time.max()))
    if end <= xs[-1]:
        end = min(t_end, xs[-1] + 0.05 * t_end)
    xs.append(end)
    ys.append(ys[-1])
    return np.array(xs), np.array(ys), cens


def step_vertices(xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """steps-post polyline: (x0,y0) (x1,y0) (x1,y1) (x2,y1) ... (xn,yn)."""
    v = [(xs[0], ys[0])]
    for i in range(1, len(xs)):
        v.append((xs[i], ys[i - 1]))
        v.append((xs[i], ys[i]))
    out = [v[0]]
    for p in v[1:]:  # drop zero-length pieces (the last point repeats the last level)
        if p != out[-1]:
            out.append(p)
    return np.array(out)


def seg_dist(points: np.ndarray, poly: np.ndarray) -> np.ndarray:
    """Distance from each point to a polyline (or to a single point)."""
    if len(poly) == 1:
        return np.hypot(points[:, 0] - poly[0, 0], points[:, 1] - poly[0, 1])
    a, b = poly[:-1], poly[1:]
    ab = b - a
    L2 = np.maximum((ab ** 2).sum(1), 1e-12)
    ap = points[:, None, :] - a[None, :, :]
    t = np.clip((ap * ab[None]).sum(2) / L2[None], 0, 1)
    proj = a[None] + t[..., None] * ab[None]
    return np.sqrt(((points[:, None, :] - proj) ** 2).sum(2)).min(1)


def resample_poly(poly: np.ndarray, step: float) -> np.ndarray:
    out = [poly[0]]
    for a, b in zip(poly[:-1], poly[1:]):
        L = math.hypot(*(b - a))
        k = max(1, int(L / step))
        for j in range(1, k + 1):
            out.append(a + (b - a) * j / k)
    return np.array(out)


def crosses(p: np.ndarray, q: np.ndarray) -> bool:
    """Whether two polylines (functions of x) cross: the sign of p - q changes on the overlap."""
    lo, hi = max(p[:, 0].min(), q[:, 0].min()), min(p[:, 0].max(), q[:, 0].max())
    if hi - lo < 5:
        return False
    xs = np.linspace(lo, hi, 400)
    d = np.interp(xs, p[:, 0], p[:, 1]) - np.interp(xs, q[:, 0], q[:, 1])
    return bool(np.any(d[:-1] * d[1:] < 0))


def coverage_at(rgb: np.ndarray, x: int, y: int, col: np.ndarray, bg: np.ndarray) -> float:
    """Coverage of pixel (x, y) by colour `col` over background `bg` (−1 if another colour)."""
    c = rgb[y, x].astype(float)
    d = col - bg
    v = c - bg
    a = float(v @ d / max(1e-9, d @ d))
    r = float(np.linalg.norm(v - a * d))
    return a if r <= max(22.0, 0.28 * float(np.linalg.norm(v))) else -1.0


def build(i: int):
    rng = np.random.default_rng(5000 + i)
    scenario = ("top-axis" if i >= TOP_FROM else "grid-crossing" if i >= CROSS_FROM else "find-points" if i >= POINTS_FROM else "same-colour" if i >= SAME_FROM else "kinks" if i >= KINKS_FROM
                else SCENARIOS[i % len(SCENARIOS)])
    dpi = int(DPIS[i % len(DPIS)] if rng.random() < 0.7 else rng.choice(DPIS))
    w_in = float(rng.uniform(4.5, 7.5))
    h_in = float(w_in * rng.uniform(0.55, 0.8))
    if w_in * dpi > 1200:
        w_in, h_in = 1200 / dpi, 1200 / dpi * h_in / w_in
    font = str(FONTS[int(rng.integers(0, len(FONTS)))])
    grid = scenario == "dense" or rng.random() < 0.4
    grid_color = "#555555" if scenario == "dense" else str(rng.choice(["#b0b0b0", "#d0d0d0", "#888888"]))
    frame = "box" if rng.random() < 0.6 else "L"
    tickdir = str(rng.choice(["out", "out", "out", "in"]))
    jpeg_q = int(rng.integers(35, 91)) if i % 3 == 1 else 0
    legend = rng.random() < 0.4

    colors = [str(c) for c in rng.permutation(PALETTE)]
    specs = []  # (kind, style, marker, color)
    if scenario == "curves":
        for k in range(int(rng.integers(2, 4))):
            specs.append(("line", "solid", None, colors[k]))
    elif scenario == "line-markers":
        for k in range(int(rng.integers(1, 4))):
            specs.append(("line", "solid", str(rng.choice(MARKERS[:5])), colors[k]))
    elif scenario == "dashed":
        n = int(rng.integers(2, 4))
        styles = list(rng.permutation(list(STYLES)))
        for k in range(n):
            specs.append(("line", styles[k] if k < len(styles) else "solid", None, colors[k]))
    elif scenario == "step":
        for k in range(int(rng.integers(1, 4))):
            specs.append(("step", "solid", "+" if rng.random() < 0.6 else None, colors[k]))
    elif scenario == "scatter":
        ms = list(rng.permutation(MARKERS))
        for k in range(int(rng.integers(1, 4))):
            specs.append(("scatter", "none", str(ms[k]), colors[k]))
    elif scenario == "black":
        specs.append((str(rng.choice(["line", "step"])), "solid", None, "k"))
        if rng.random() < 0.5:
            specs.append(("line", str(rng.choice(["solid", "dashed"])), None, "k" if rng.random() < 0.5 else colors[0]))
    elif scenario == "mixed":
        specs.append(("line", "solid", None, colors[0]))
        specs.append(("scatter", "none", str(rng.choice(MARKERS)), colors[1]))
        if rng.random() < 0.5:
            specs.append(("step", "solid", None, colors[2]))
    elif scenario == "kinks":
        for k in range(int(rng.integers(1, 3))):
            specs.append(("kink", "solid", str(rng.choice(["o", "s", "D", "^"])), colors[k]))
    elif scenario == "same-colour":
        variant = SAME_VARIANTS[(i - SAME_FROM) % len(SAME_VARIANTS)]
        color = "k" if rng.random() < 0.5 else colors[0]
        kind = "step" if variant in ("km-together", "close-plateaus") or (variant == "dotted" and rng.random() < 0.5) else "line"
        other = "dotted" if variant == "dotted" else str(rng.choice(["dashed", "dashed", "dashdot"]))
        specs.append((kind, "solid", None, color))
        specs.append((kind, other, None, color))
    elif scenario == "find-points":
        variant = POINTS_VARIANTS[(i - POINTS_FROM) % len(POINTS_VARIANTS)]
        color = "k" if rng.random() < 0.5 else colors[0]
        if variant == "shapes":
            specs.append(("scatter", "none", "o", color))
            specs.append(("scatter", "none", "s", color))
        else:
            m = {"circle": "o", "square": "s", "triangle": "^"}[variant]
            specs.append(("scatter", "none", m, color))
            specs.append(("scatter", "none", m, color))
        legend = legend or variant == "triangle"
    elif scenario == "grid-crossing":
        color = "k" if i % 3 != 2 else colors[0]
        specs.append(("line", "solid", None, color))
        specs.append(("line", "dashed", None, color))
        specs.append(("line", "dashed", None, color))
    elif scenario == "top-axis":
        variant = TOP_VARIANTS[(i - TOP_FROM) % len(TOP_VARIANTS)]
        color = "k" if rng.random() < 0.5 else colors[0]
        frame = "top-L"
        specs.append(("line", "solid", "s", color))
        specs.append(("line", "dashed", "s", color))
    else:  # dense
        for k in range(4):
            specs.append(("line", "solid" if k < 3 else "dashed", None, colors[k]))

    any_step = any(s[0] == "step" for s in specs)
    rc = {
        "path.snap": False, "font.family": font, "font.size": float(rng.uniform(8, 12)),
        "xtick.direction": tickdir, "ytick.direction": tickdir,
        "axes.linewidth": float(rng.choice([0.8, 1.0, 1.25, 1.5])),
    }
    with plt.rc_context(rc):
        fig, ax = plt.subplots(figsize=(w_in, h_in), dpi=dpi)
        if any_step:
            xlo, xhi = 0.0, float(rng.choice([24, 60, 100, 120]))
            ylo, yhi = 0.0, 1.0
        else:
            xlo = float(rng.choice([0, -5, 10, 100]))
            xhi = xlo + float(rng.choice([10, 50, 100, 400]))
            ylo = float(rng.choice([0, -1, 20]))
            yhi = ylo + float(rng.choice([1, 10, 80, 500]))
        if scenario == "top-axis":
            xlo, xhi = 0.0, float(rng.choice([4, 6, 8, 10]))
            ylo, yhi = 0.0, 100.0
            n_pts = int(rng.integers(6, 10))
            top_xs = np.linspace(xlo, xhi, n_pts)
            top_xs[1] = top_xs[1] / 2  # a first point close to the start, where the lines converge
        series = []
        # Same-colour pairs: the second series' data are made from the first's (crossing, close).
        pair = None
        if scenario == "same-colour":
            if specs[0][0] == "step":
                xs1, ys1, _ = km_curve(rng, xhi)
                if variant == "close-plateaus":
                    xs2 = np.clip(xs1 * rng.uniform(1.03, 1.12), 0, xhi)
                    ys2 = np.clip(ys1 - rng.uniform(0.03, 0.06), 0, 1)
                    ys2[0] = 1.0
                else:
                    xs2, ys2, _ = km_curve(rng, xhi)
            else:
                xs1 = np.linspace(xlo, xhi, 300)
                ys1 = smooth_curve(rng, xs1, ylo, yhi)
                xs2 = xs1
                tilt = rng.uniform(-0.2, 0.2) * (yhi - ylo) * (xs1 - xs1.mean()) / (xhi - xlo)
                ys2 = 2 * ys1.mean() - ys1 + tilt
            pair = [(xs1, ys1), (xs2, ys2)]
        for k, (kind, style, marker, color) in enumerate(specs):
            lw = float(rng.uniform(0.8, 2.5))
            ms = float(rng.uniform(4, 8))
            ls = "-" if style == "solid" else STYLES.get(style, "-")
            cens = []
            marker_color = None
            marker_fill = None
            if kind == "kink":
                # Vertices alternate above and below a trend: every interior vertex reverses the
                # slope. Markers of the line's colour, or of another colour drawn over the line.
                n = int(rng.integers(5, 10))
                xs = np.linspace(xlo + 0.04 * (xhi - xlo), xhi - 0.04 * (xhi - xlo), n)
                xs[1:-1] += rng.uniform(-0.3, 0.3, n - 2) * (xs[1] - xs[0])
                mid = ylo + (yhi - ylo) * float(rng.uniform(0.35, 0.65))
                amp = rng.uniform(0.08, 0.45, n) * (yhi - ylo)
                ys = mid + amp * np.where(np.arange(n) % 2 == 0, -1.0, 1.0) * float(rng.choice([-1, 1]))
                ms = float(rng.uniform(4, 11))
                marker_color = color if rng.random() < 0.5 else colors[k + 4]
                ax.plot(xs, ys, color=color, lw=lw, zorder=2 + k)
                ax.plot(xs, ys, ls="none", marker=marker, color=marker_color, ms=ms, zorder=2.5 + k)
                verts = np.column_stack([xs, ys])
                kind = "line"
            elif scenario == "top-axis":
                # Survival-style fits from (0, yhi), as in a clonogenic-survival figure: the solid
                # one falls slowly, the dashed one by several decades. The line is the fitted model
                # (the truth path); the measured points scatter around it as filled / open squares
                # with error bars that grow tall on the dashed series.
                xs = top_xs.copy()
                fit_x = np.linspace(xlo, xhi, 300)
                if k == 0:
                    a, b = rng.uniform(0.02, 0.08), rng.uniform(0.005, 0.03)
                    model = lambda x: yhi * np.exp(-a * x - b * x ** 2)  # noqa: E731
                    f = 1 + rng.uniform(0.05, 0.35, len(xs))
                    noise = rng.normal(0, 0.06, len(xs))
                else:
                    c = rng.uniform(3.0, 5.0) * math.log(10) / xhi
                    model = lambda x: yhi * np.exp(-c * x)  # noqa: E731
                    f = 1.2 + rng.uniform(0.2, 1.0, len(xs)) * (1 + 6 * xs / xhi)
                    noise = rng.normal(0, 0.3, len(xs))
                if variant == "linear":
                    f = 1 + 0.25 * (f - 1)
                    noise = 0.25 * noise
                noise[0] = 0  # the start point is exact
                ys = model(xs) * np.exp(noise)
                yerr = np.vstack([ys - ys / f, ys * f - ys])
                yerr[:, 0] = 0
                lw = float(rng.uniform(1.2, 3.0))
                ms = float(rng.uniform(5, 8))
                # Office-style dashes: a dash about 3.3 line widths long, a gap about 4.
                dash = ls if k == 0 else (0, (3.3, 4.2))
                ax.plot(fit_x, model(fit_x), color=color, lw=lw, ls=dash, zorder=2 + k)
                ax.errorbar(xs, ys, yerr=yerr, fmt=marker, ls="none", color=color, ecolor=color, mec=color,
                            mfc=color if k == 0 else "white", ms=ms, mew=float(rng.uniform(1.0, 1.6)),
                            elinewidth=float(rng.uniform(0.8, 1.4)), capsize=float(rng.uniform(2, 4)), zorder=2 + k)
                verts = np.column_stack([fit_x, model(fit_x)])
            elif kind == "line" and marker is None:
                if scenario == "grid-crossing":
                    # A shallow sigmoid (the fitted curve), then the dashed lower/upper bounds: the
                    # same sigmoid shifted along x. Thick solid curve, thinner dashes.
                    if k == 0:
                        steep = float(rng.uniform(3, 6))
                        centre = float(rng.uniform(0.45, 0.75))
                        band = float(rng.uniform(0.1, 0.22))
                    xs = np.linspace(xlo, xhi, 300)
                    tt = (xs - xlo) / (xhi - xlo) - centre + (0 if k == 0 else band if k == 1 else -band)
                    ys = ylo + (yhi - ylo) * (0.1 + 0.8 / (1 + np.exp(-steep * 2 * tt)))
                    lw = float(rng.uniform(3.5, 7.0) if k == 0 else rng.uniform(1.2, 2.5)) * 72 / dpi
                    ax.plot(xs, ys, color=color, lw=lw, ls=ls, zorder=2 + k)
                    verts = np.column_stack([xs, ys])
                elif pair:
                    xs, ys = pair[k]
                else:
                    xs = np.linspace(xlo, xhi, 300)
                    ys = smooth_curve(rng, xs, ylo, yhi)
                if scenario != "grid-crossing":
                    ax.plot(xs, ys, color=color, lw=lw, ls=ls, zorder=2 + k)
                    verts = np.column_stack([xs, ys])
            elif kind == "line":
                n = int(rng.integers(8, 20))
                xs = np.sort(rng.uniform(xlo, xhi, n))
                xs[0], xs[-1] = xlo + 0.03 * (xhi - xlo), xhi - 0.03 * (xhi - xlo)
                ys = smooth_curve(rng, xs, ylo, yhi) + rng.normal(0, 0.05 * (yhi - ylo), n)
                ax.plot(xs, ys, color=color, lw=lw, ls=ls, marker=marker, ms=ms, zorder=2 + k)
                verts = np.column_stack([xs, ys])
            elif scenario == "find-points":
                # Filled, then open (white inside) or a second shape; error bars with caps drawn
                # under the markers; a few points of the second series right next to the first's.
                filled = variant == "shapes" or k == 0
                ms = float(rng.uniform(5, 9))
                n = int(rng.integers(8, 16))
                xs = np.sort(rng.uniform(xlo + 0.06 * (xhi - xlo), xhi - 0.06 * (xhi - xlo), n))
                trend = smooth_curve(rng, xs, ylo, yhi)
                ys = np.clip(trend + rng.normal(0, 0.1 * (yhi - ylo), n), ylo + 0.03 * (yhi - ylo), yhi - 0.03 * (yhi - ylo))
                if k == 1:
                    first = series[0]
                    for j in rng.choice(n, size=min(n, 2), replace=False):
                        f = int(rng.integers(0, len(first["xs"])))
                        xs[j] = first["xs"][f] + float(rng.uniform(0.25, 0.6)) * float(rng.choice([-1, 1])) * 0.012 * (xhi - xlo) * ms
                        ys[j] = first["ys"][f] + float(rng.uniform(-0.3, 0.3)) * 0.012 * (yhi - ylo) * ms
                if variant != "triangle":
                    ys[int(np.argmin(ys))] = ylo  # one marker against the x axis
                yerr = rng.uniform(0.03, 0.12, n) * (yhi - ylo) if variant != "triangle" else None
                xerr = rng.uniform(0.01, 0.04, n) * (xhi - xlo) if variant in ("circle", "triangle", "shapes") else None
                ax.errorbar(xs, ys, yerr=yerr, xerr=xerr, fmt=marker, color=color, ecolor=color, mec=color,
                            mfc=color if filled else "white", ms=ms, mew=float(rng.uniform(1.2, 1.8)),
                            elinewidth=float(rng.uniform(0.8, 1.6)), capsize=float(rng.uniform(2, 4)), zorder=2 + k)
                if k == 1 and rng.random() < 0.6:
                    ax.axhline(float(np.median(ys)), ls="--", color=color, lw=float(rng.uniform(0.8, 1.5)), zorder=1.5)
                verts = np.column_stack([xs, ys])
                marker_fill = filled
            elif kind == "step":
                if pair:
                    xs, ys = pair[k]
                else:
                    xs, ys, cens = km_curve(rng, xhi)
                ax.plot(xs, ys, color=color, lw=lw, ls=ls, drawstyle="steps-post", zorder=2 + k)
                if marker and cens:
                    c = np.array(cens)
                    ax.plot(c[:, 0], c[:, 1], ls="none", marker="+", color=color, ms=ms, mew=max(0.8, lw * 0.7), zorder=2 + k)
                verts = step_vertices(xs, ys)
            else:
                n = int(rng.integers(10, 40))
                xs = rng.uniform(xlo + 0.03 * (xhi - xlo), xhi - 0.03 * (xhi - xlo), n)
                trend = smooth_curve(rng, np.sort(xs), ylo, yhi)
                ys = np.interp(xs, np.sort(xs), trend) + rng.normal(0, 0.12 * (yhi - ylo), n)
                ys = np.clip(ys, ylo + 0.03 * (yhi - ylo), yhi - 0.03 * (yhi - ylo))
                ax.plot(xs, ys, ls="none", marker=marker, color=color, ms=ms, mew=max(1.0, lw * 0.6), zorder=2 + k)
                verts = np.column_stack([xs, ys])
            series.append(dict(kind=kind, style=style, marker=marker, color=color, lw=lw, ms=ms, verts=verts,
                               xs=np.asarray(xs), ys=np.asarray(ys), cens=cens, seed_at=float(rng.uniform(0.25, 0.75)),
                               marker_color=marker_color, fill=marker_fill))
        allv = np.vstack([s["verts"] for s in series])
        pad_y = 0.06 * (allv[:, 1].max() - allv[:, 1].min() + 1e-9)
        if scenario == "top-axis":
            # The start point sits in the corner of the axes; the X axis and its labels are on top.
            ax.set_xlim(xlo, xhi * 1.02)
            if variant == "log":
                ax.set_yscale("log")
                ax.set_ylim(10 ** math.floor(math.log10(allv[:, 1].min() / 2)), yhi)
                ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:g}"))
            else:
                ax.set_ylim(0, yhi)
            ax.xaxis.tick_top()
            ax.xaxis.set_label_position("top")
            ax.spines["bottom"].set_visible(False)
            ax.spines["right"].set_visible(False)
        else:
            ax.set_xlim(xlo - 0.02 * (xhi - xlo), xhi + 0.02 * (xhi - xlo))
            ax.set_ylim(allv[:, 1].min() - (0 if scenario == "find-points" else pad_y), allv[:, 1].max() + pad_y)
        decor = []  # straight lines of the series' colour that are not series: (polyline in data, width px)
        if scenario == "grid-crossing":
            # Outlined bars from the bottom whose tops the solid curve crosses inside the bar, then a
            # thin gridline at every y tick over them (and under the curves), all in its colour.
            main = series[0]
            ybot = ax.get_ylim()[0]
            edges = np.sort(rng.uniform(xlo + 0.08 * (xhi - xlo), xhi - 0.08 * (xhi - xlo), int(rng.integers(4, 7))))
            elw = float(rng.uniform(1.0, 3.0))
            for a, b in zip(edges[:-1], edges[1:]):
                if b - a < 0.05 * (xhi - xlo):
                    continue
                top = float(np.interp(a + float(rng.uniform(0.2, 0.8)) * (b - a), main["xs"], main["ys"]))
                ax.bar(a, top - ybot, width=b - a, bottom=ybot, align="edge", color=str(rng.choice(["#d9d9d9", "#e8e8e8", "white"])),
                       edgecolor=main["color"], lw=elw * 72 / dpi, zorder=1.2)
                decor.append((np.array([[a, ybot], [a, top], [b, top], [b, ybot]]), elw))
            glw = float(rng.uniform(0.8, 2.0))
            for yt in ax.get_yticks():
                if ax.get_ylim()[0] < yt < ax.get_ylim()[1]:
                    ax.axhline(yt, color=main["color"], lw=glw * 72 / dpi, zorder=1.5)
                    decor.append((np.array([[ax.get_xlim()[0], yt], [ax.get_xlim()[1], yt]]), glw))
        if grid and scenario != "grid-crossing":
            ax.grid(True, color=grid_color, ls=str(rng.choice(["-", "--", ":"])), lw=float(rng.uniform(0.5, 1.0)))
        if frame == "L":
            ax.spines["top"].set_visible(False)
            ax.spines["right"].set_visible(False)
        ax.set_xlabel(str(rng.choice(["Time (months)", "x", "Dose (mg)", "Distance"])))
        ax.set_ylabel(str(rng.choice(["Survival", "Response", "y", "Signal (a.u.)"])))
        leg = None
        if legend:
            leg = ax.legend([f"series {k + 1}" for k in range(len(series))], loc="best")
        fig.tight_layout()
        fig.canvas.draw()
        W, H = fig.canvas.get_width_height()
        rgba = np.asarray(fig.canvas.buffer_rgba()).copy()
        box = px_of(ax.transAxes.transform([(0, 1), (1, 1), (1, 0), (0, 0)]), H)
        legend_box = None
        if leg is not None:
            bb = leg.get_window_extent()
            p = px_of(np.array([[bb.x0, bb.y1], [bb.x1, bb.y0]]), H)
            legend_box = [float(p[0, 0]), float(p[0, 1]), float(p[1, 0]), float(p[1, 1])]
        for s in series:
            s["path"] = px_of(ax.transData.transform(s["verts"]), H)
            s["points"] = px_of(ax.transData.transform(np.column_stack([s["xs"], s["ys"]])), H)
            s["censor"] = px_of(ax.transData.transform(np.array(s["cens"])), H) if s["cens"] else np.zeros((0, 2))
            s["lw_px"] = s["lw"] * dpi / 72
            s["ms_px"] = s["ms"] * dpi / 72
        decor_px = [dict(kind="line", path=px_of(ax.transData.transform(p), H), lw_px=w, marker=None) for p, w in decor]
        plt.close(fig)

    rgb = rgba[:, :, :3]
    bg = np.array([255.0, 255.0, 255.0])
    for k, s in enumerate(series):
        others = [o for j, o in enumerate(series) if j != k]
        s["crossing"] = s["kind"] != "scatter" and any(o["kind"] != "scatter" and crosses(s["path"], o["path"]) for o in others)
        s["seed"] = pick_seed(s, others + decor_px, rgb, bg, legend_box, W, H, strict=scenario in ("same-colour", "grid-crossing", "top-axis"))

    tags = [f"scenario:{scenario}", "grid" if grid or scenario == "grid-crossing" else "no-grid", f"frame:{frame}", "jpeg" if jpeg_q else "png",
            "dpi:low" if dpi <= 96 else "dpi:mid" if dpi <= 150 else "dpi:high"]
    if legend:
        tags.append("legend")
    if tickdir == "in":
        tags.append("ticks:in")
    out_series = []
    for k, s in enumerate(series):
        stags = [f"series:{s['kind']}" + ("+markers" if s["kind"] == "line" and s["marker"] else "")]
        if s["kind"] != "scatter":
            stags.append(f"style:{s['style']}")
            stags.append("lw:thin" if s["lw_px"] < 1.5 else "lw:thick")
        stags.append("color:black" if s["color"] == "k" else "color:colour")
        if s["crossing"]:
            stags.append("crossing")
        if s["kind"] == "step" and s["marker"]:
            stags.append("censor-marks")
        if scenario in ("same-colour", "top-axis"):
            stags.append("same-colour")
        if decor_px:
            stags.append("own-colour-lines")
        if scenario == "top-axis":
            stags.append("errorbars")
        if s["fill"] is not None:
            stags.append("fill:filled" if s["fill"] else "fill:open")
            stags.append(f"marker:{ {'o': 'circle', 's': 'square', '^': 'triangle'}[s['marker']] }")
        if s["marker_color"] is not None:
            stags.append("kinks")
            stags.append("markers:same-colour" if s["marker_color"] == s["color"] else "markers:other-colour")
        entry = {
            "id": f"s{k}",
            "kind": s["kind"],
            "tags": stags,
            "color": [round(255 * c) for c in to_rgb(s["color"])],
            "style": s["style"],
            "marker": s["marker"],
            "lineWidthPx": round(s["lw_px"], 3),
            "markerSizePx": round(s["ms_px"], 3),
            "seed": s["seed"],
            "data": [[round(float(x), 6), round(float(y), 6)] for x, y in zip(s["xs"], s["ys"])],
            "pixels": [[round(float(x), 3), round(float(y), 3)] for x, y in s["points"]],
        }
        if s["kind"] == "scatter":
            entry["markers"] = entry["pixels"]
        else:
            entry["path"] = [[round(float(x), 3), round(float(y), 3)] for x, y in s["path"]]
            if s["kind"] == "line" and s["marker"]:
                entry["markers"] = entry["pixels"]
            if s["kind"] == "step" or s["marker_color"] is not None:
                entry["corners"] = entry["path"][1:-1] if s["kind"] == "step" else entry["path"]
        out_series.append(entry)
    name = f"l{i:02d}"
    doc = {
        "image": f"{name}.{'jpg' if jpeg_q else 'png'}",
        "width": W,
        "height": H,
        "description": (f"Synthetic {scenario} chart, {len(series)} series, dpi {dpi}, font {font}"
                        + (f", JPEG q{jpeg_q}" if jpeg_q else "") + ". Generated by bench/lines/generate.py."),
        "tags": tags,
        "plotBox": [[round(float(c), 3) for c in p] for p in box],
        "legendBox": [round(v, 3) for v in legend_box] if legend_box else None,
        "series": out_series,
    }
    return Image.fromarray(rgb), doc, jpeg_q


def blur(a: np.ndarray, sigma: float) -> np.ndarray:
    """Separable Gaussian blur (edges padded)."""
    if sigma <= 0:
        return a
    r = int(math.ceil(3 * sigma))
    x = np.arange(-r, r + 1)
    k = np.exp(-x ** 2 / (2 * sigma ** 2))
    k /= k.sum()
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (r, r)
        p = np.pad(a, pad, mode="edge")
        n = a.shape[axis]
        a = sum(k[j] * (p[j:j + n] if axis == 0 else p[:, j:j + n]) for j in range(2 * r + 1))
    return a


def build_scan(i: int):
    """A scanned black-and-white dose-response figure (see SCAN_FROM)."""
    rng = np.random.default_rng(5000 + i)
    dpi = int(rng.choice([120, 150, 200]))
    w_in = float(rng.uniform(4.5, 6.5))
    h_in = float(w_in * rng.uniform(0.8, 1.2))
    if w_in * dpi > 1200:
        w_in, h_in = 1200 / dpi, 1200 / dpi * h_in / w_in
    if h_in * dpi > 1300:
        w_in, h_in = w_in * 1300 / (h_in * dpi), 1300 / dpi
    font = str(FONTS[int(rng.integers(0, len(FONTS)))])
    jpeg_q = int(rng.integers(50, 91)) if i % 3 == 1 else 0
    angle = float(rng.uniform(0.15, 0.5) * rng.choice([-1, 1])) if i % 3 != 0 else 0.0
    lw = float(rng.uniform(2.2, 3.5))  # the solid curve, pt
    dlw = lw * float(rng.uniform(0.8, 1.0))  # the dashed curves
    glw = lw * float(rng.uniform(0.6, 1.1))  # grid and frame
    ms = float(rng.uniform(8, 12))
    xlo = float(rng.choice([0, 100, 140]))
    span = 100.0
    xhi = xlo + span
    ytop = float(rng.choice([100, 110, 120]))
    # The fitted curve: rising from a quarter or so to (nearly) 100 % across most of the plot.
    xs = np.linspace(xlo + rng.uniform(0.08, 0.15) * span, xlo + rng.uniform(0.82, 0.9) * span, 300)
    tt = (xs - xs[0]) / (xs[-1] - xs[0])
    k = float(rng.uniform(1.5, 3.0))
    y0, y1 = float(rng.uniform(15, 35)), float(rng.uniform(92, 100))
    fit = y0 + (y1 - y0) * (1 - np.exp(-k * tt)) / (1 - math.exp(-k))
    off = float(rng.uniform(8, 14))
    # Confidence curves: the fit shifted up and down, over their own stretches of x, ending where
    # they leave the plot (the upper one may poke just past the top gridline, as on a scan).
    cis = []
    for sign in (1, -1):
        cx = np.linspace(xs[0] + rng.uniform(-0.02, 0.03) * span, xs[-1] + rng.uniform(-0.03, 0.04) * span, 300)
        ct = (cx - xs[0]) / (xs[-1] - xs[0])
        cy = y0 + (y1 - y0) * (1 - np.exp(-k * ct)) / (1 - math.exp(-k)) + sign * off * (1 - 0.3 * ct)
        keep = (cy >= 3) & (cy <= min(ytop - 1, 101.5))
        cis.append((cx[keep], cy[keep]))
    rc = {"path.snap": False, "font.family": font, "font.size": float(rng.uniform(10, 13)), "axes.linewidth": glw}
    with plt.rc_context(rc):
        fig, ax = plt.subplots(figsize=(w_in, h_in), dpi=dpi)
        ax.set_xlim(xlo, xhi)
        ax.set_ylim(0, ytop)
        ax.set_xticks(np.arange(xlo, xhi + 1, 20))
        ax.set_yticks(np.arange(0, ytop + 1, 20))
        ax.tick_params(length=0, pad=6)
        ax.grid(True, color="k", lw=glw, ls="-")
        ax.set_axisbelow(True)
        ax.set_xlabel(str(rng.choice(["Milliampere-minutes", "Dose", "Exposure (units)"])))
        ax.set_ylabel(str(rng.choice(["Percentage positive reactions", "Response (%)", "Per cent"])))
        fig.tight_layout()
        fig.canvas.draw()
        W, H = fig.canvas.get_width_height()
        ax.plot(xs, fit, color="k", lw=lw, solid_capstyle="round", zorder=3)
        # Hand-drawn dashes: lengths and gaps vary by a quarter around the pen's own.
        dash_px = dlw * dpi / 72 * float(rng.uniform(3.0, 4.5))
        gap_px = dlw * dpi / 72 * float(rng.uniform(1.0, 1.8))
        inv = ax.transData.inverted()
        for cx, cy in cis:
            d = ax.transData.transform(np.column_stack([cx, cy]))
            seg = np.hypot(*np.diff(d, axis=0).T)
            arc = np.concatenate([[0], np.cumsum(seg)])
            pos = float(rng.uniform(0, 0.5)) * dash_px
            while pos < arc[-1]:
                a, b = pos, min(arc[-1], pos + dash_px * float(rng.uniform(0.75, 1.25)))
                ts = np.linspace(a, b, max(2, int(b - a) + 1))
                piece = np.column_stack([np.interp(ts, arc, d[:, 0]), np.interp(ts, arc, d[:, 1])])
                pd = inv.transform(piece)
                ax.plot(pd[:, 0], pd[:, 1], color="k", lw=dlw, solid_capstyle="butt", zorder=3)
                pos = b + gap_px * float(rng.uniform(0.7, 1.3))
        # Data points: open circles about the fit, crosses about the confidence curves, at
        # gridline x values and between them (some on a gridline crossing).
        mx = np.sort(rng.choice(np.arange(xs[0] + 2, xs[-1], 10.0), size=int(rng.integers(5, 8)), replace=False))
        o_y = np.interp(mx, xs, fit) + rng.normal(0, 2.5, len(mx))
        x_pts = []
        for cx, cy in cis:
            inside = mx[(mx >= cx[0]) & (mx <= cx[-1])]
            for xv in inside[: max(1, len(inside) - 1)]:
                yv = float(np.interp(xv, cx, cy)) + float(rng.normal(0, 2.5))
                if rng.random() < 0.3:
                    yv = 20 * round(yv / 20)  # on a gridline
                x_pts.append((float(xv), float(np.clip(yv, 2, ytop - 2))))
        o_pts = np.column_stack([mx, np.clip(o_y, 2, ytop - 2)])
        x_pts = np.array(x_pts)
        mew = lw * float(rng.uniform(0.5, 0.7))
        ax.plot(o_pts[:, 0], o_pts[:, 1], ls="none", marker="o", ms=ms, mfc="none", mec="k", mew=mew, zorder=4)
        ax.plot(x_pts[:, 0], x_pts[:, 1], ls="none", marker="x", ms=ms * 0.8, mec="k", mew=mew, zorder=4)
        fig.canvas.draw()
        rgba = np.asarray(fig.canvas.buffer_rgba()).copy()
        box = px_of(ax.transAxes.transform([(0, 1), (1, 1), (1, 0), (0, 0)]), H)

        def tf(v):
            return px_of(ax.transData.transform(v), H)

        grid_lines = [np.array([[xv, 0], [xv, ytop]]) for xv in np.arange(xlo, xhi + 1, 20)]
        grid_lines += [np.array([[xlo, yv], [xhi, yv]]) for yv in np.arange(0, ytop + 1, 20)]
        grid_lines += [np.array([[xlo, ytop], [xhi, ytop]]), np.array([[xhi, 0], [xhi, ytop]])]
        fit_px = tf(np.column_stack([xs, fit]))
        ci_px = [tf(np.column_stack(c)) for c in cis]
        o_px = tf(o_pts)
        x_px = tf(x_pts)
        grid_px = [tf(g) for g in grid_lines]
        plt.close(fig)

    # The scan: darkness rotated (bilinear), blurred, thresholded against a smooth random field
    # (stroke widths vary along a line), noised and blurred again (the scanner's optics).
    scale = dpi / 150
    dark = 1 - rgba[:, :, :3].mean(2) / 255
    if angle:
        dark = np.asarray(Image.fromarray(dark.astype(np.float32), mode="F").rotate(angle, resample=Image.BILINEAR, fillcolor=0.0))
    dark = blur(dark, 0.6 * scale)
    field = blur(rng.uniform(-1, 1, dark.shape), 8 * scale)
    field /= max(1e-9, field.std())
    thr = np.clip(0.45 + 0.07 * field, 0.25, 0.65)
    dark = 1 / (1 + np.exp(-(dark - thr) / 0.05))
    dark = np.clip(dark + rng.normal(0, 0.06, dark.shape), 0, 1)
    dark = np.clip(blur(dark, 0.5 * scale), 0, 1)
    dark[dark < 0.06] = 0  # the scanner's white point: clean paper (and a PNG that compresses)
    gray = np.round(253 - (253 - 18) * dark).astype(np.uint8)
    rgb = np.repeat(gray[:, :, None], 3, axis=2)

    # Truth rotated with the image (about its centre, pixel-centre convention).
    cxp, cyp = W / 2 - 0.5, H / 2 - 0.5
    th = math.radians(angle)

    def rot(p: np.ndarray) -> np.ndarray:
        p = np.atleast_2d(p)
        x, y = p[:, 0] - cxp, p[:, 1] - cyp
        return np.column_stack([cxp + x * math.cos(th) + y * math.sin(th), cyp - x * math.sin(th) + y * math.cos(th)])

    glw_px = glw * dpi / 72
    decor_px = [dict(kind="line", path=rot(g), lw_px=glw_px, marker=None) for g in grid_px]
    lw_px, dlw_px, ms_px = lw * dpi / 72, dlw * dpi / 72, ms * dpi / 72
    none = np.zeros((0, 2))
    series = [dict(kind="line", style="solid", marker=None, color="k", lw_px=lw_px, ms_px=ms_px, path=rot(fit_px), points=rot(fit_px),
                   censor=none, seed_at=float(rng.uniform(0.3, 0.7)), xs=xs, ys=fit)]
    for (cx, cy), g in zip(cis, ci_px):
        series.append(dict(kind="line", style="dashed", marker=None, color="k", lw_px=dlw_px, ms_px=ms_px, path=rot(g), points=rot(g),
                           censor=none, seed_at=float(rng.uniform(0.3, 0.7)), xs=cx, ys=cy))
    series.append(dict(kind="scatter", style="none", marker="o", color="k", lw_px=lw_px, ms_px=ms_px, points=rot(o_px),
                       censor=none, seed_at=0.5, fill=False, xs=o_pts[:, 0], ys=o_pts[:, 1]))
    series.append(dict(kind="scatter", style="none", marker="x", color="k", lw_px=lw_px, ms_px=0.8 * ms_px, points=rot(x_px),
                       censor=none, seed_at=0.5, xs=x_pts[:, 0], ys=x_pts[:, 1]))
    bg = np.array([255.0, 255.0, 255.0])
    for k_, s in enumerate(series):
        others = [o for j, o in enumerate(series) if j != k_]
        s["crossing"] = s["kind"] != "scatter" and any(o["kind"] != "scatter" and crosses(s["path"], o["path"]) for o in others)
        s["seed"] = pick_seed(s, others + decor_px, rgb, bg, None, W, H, strict=True)

    tags = ["scenario:scan-grid", "grid", "frame:box", "jpeg" if jpeg_q else "png", "dpi:mid" if dpi <= 150 else "dpi:high", "scan"]
    if angle:
        tags.append("rotated")
    out_series = []
    for k_, s in enumerate(series):
        stags = [f"series:{s['kind']}", "color:black", "same-colour", "own-colour-lines", "scan"]
        if s["kind"] == "scatter":
            stags += ["marker:circle", "fill:open"] if s["marker"] == "o" else ["marker:x"]
        else:
            stags += [f"style:{s['style']}", "lw:thin" if s["lw_px"] < 1.5 else "lw:thick"]
            if s["crossing"]:
                stags.append("crossing")
        entry = {
            "id": f"s{k_}",
            "kind": s["kind"],
            "tags": stags,
            "color": [0, 0, 0],
            "style": s["style"],
            "marker": s["marker"],
            "lineWidthPx": round(s["lw_px"], 3),
            "markerSizePx": round(s["ms_px"], 3),
            "seed": s["seed"],
            "data": [[round(float(x), 6), round(float(y), 6)] for x, y in zip(s["xs"], s["ys"])],
            "pixels": [[round(float(x), 3), round(float(y), 3)] for x, y in s["points"]],
        }
        if s["kind"] == "scatter":
            entry["markers"] = entry["pixels"]
        else:
            entry["path"] = [[round(float(x), 3), round(float(y), 3)] for x, y in s["path"]]
        out_series.append(entry)
    name = f"l{i:02d}"
    doc = {
        "image": f"{name}.{'jpg' if jpeg_q else 'png'}",
        "width": W,
        "height": H,
        "description": (f"Synthetic scan-grid chart, {len(series)} series, dpi {dpi}, font {font}, rotated {angle:.2f} deg"
                        + (f", JPEG q{jpeg_q}" if jpeg_q else "") + ". Generated by bench/lines/generate.py."),
        "tags": tags,
        "plotBox": [[round(float(c), 3) for c in p] for p in rot(box)],
        "legendBox": None,
        "series": out_series,
    }
    return Image.fromarray(rgb), doc, jpeg_q


def build_busy(i: int):
    """A busy scatterplot: hundreds of small overlapping markers and curves through them (see BUSY_FROM)."""
    rng = np.random.default_rng(5000 + i)
    variant = BUSY_VARIANTS[(i - BUSY_FROM) % len(BUSY_VARIANTS)]
    log = variant == "log-log"
    dpi = int(rng.choice([100, 120, 150]))
    w_in = float(rng.uniform(6.0, 8.0))
    h_in = float(w_in * rng.uniform(0.62, 0.78))
    if w_in * dpi > 1200:
        w_in, h_in = 1200 / dpi, 1200 / dpi * h_in / w_in
    font = str(FONTS[int(rng.integers(0, len(FONTS)))])
    jpeg_q = int(rng.integers(60, 91)) if i % 3 == 1 else 0
    offset = float(rng.uniform(6, 14))  # the range frame's distance from the data, pt
    # Data in "u" units (0-1 across the labelled range): log10 for log-log (X 0.1-1000, Y 3-50), the
    # value itself for linear (X 0-100, Y 0-60).
    if log:
        xlo, xhi, ylo, yhi = -1.0, 3.0, math.log10(3), math.log10(50)
    else:
        xlo, xhi, ylo, yhi = 0.0, 100.0, 0.0, 60.0
    sx, sy = xhi - xlo, yhi - ylo
    n_main = int(rng.integers(300, 900))
    # Two dense clusters (tight along y, wide along x), part of their y values on a few fixed levels
    # (a dose given in round numbers: rows of overlapping markers), and a sparse halo.
    cl = [(rng.uniform(0.4, 0.55), rng.uniform(0.55, 0.7), rng.uniform(0.1, 0.15), rng.uniform(0.035, 0.06)),
          (rng.uniform(0.62, 0.78), rng.uniform(0.3, 0.45), rng.uniform(0.06, 0.1), rng.uniform(0.04, 0.07))]
    pts = []
    for _ in range(n_main):
        r = rng.random()
        if r < 0.1:
            u, v = rng.uniform(0.05, 0.97), rng.uniform(0.05, 0.95)
        else:
            cx, cy, ux, uy = cl[0] if r < 0.55 else cl[1]
            u, v = rng.normal(cx, ux), rng.normal(cy, uy)
        pts.append((u, v))
    pts = np.array(pts)
    levels = np.linspace(0.25, 0.75, int(rng.integers(4, 7)))
    snap = rng.random(len(pts)) < 0.3
    for j in np.where(snap)[0]:
        pts[j, 1] = levels[int(np.argmin(np.abs(levels - pts[j, 1])))]
    pts = pts[(pts[:, 0] > 0.02) & (pts[:, 0] < 0.98) & (pts[:, 1] > 0.03) & (pts[:, 1] < 0.97)]
    n_second = int(rng.integers(25, 80))
    second = np.column_stack([rng.uniform(0.2, 0.9, n_second), rng.uniform(0.3, 0.85, n_second)])
    third = None
    if rng.random() < 0.5:
        n3 = int(rng.integers(30, 90))
        third = np.column_stack([rng.normal(cl[1][0] + 0.08, 0.08, n3), rng.normal(cl[1][1] - 0.12, 0.06, n3)])
        third = third[(third[:, 0] > 0.03) & (third[:, 0] < 0.97) & (third[:, 1] > 0.03) & (third[:, 1] < 0.97)]
    main_marker = str(rng.choice(["+", "+", "x", "o"]))
    classes = [(main_marker, pts), ("D", second)]
    if third is not None:
        classes.append(("o" if main_marker != "o" else "x", third))
    # Curves: iso-probability lines falling from the upper left towards a plateau, through the cloud;
    # the first one starts with a straight steep stretch that meets the curve at a corner.
    n_curves = int(rng.integers(1, 4))
    grey = rng.random() < 0.7
    pal = rng.choice(["#808080", "#8c8c8c", "#999999", "#a6a6a6"], n_curves) if grey else rng.permutation(["C0", "C3", "C2"])[:n_curves]
    curves = []
    for c in range(n_curves):
        u0 = 0.05 + 0.08 * c + rng.uniform(0, 0.04)
        u1 = rng.uniform(0.8, 0.88)
        plateau = cl[1][1] - 0.1 + 0.12 * c + rng.uniform(-0.03, 0.03)
        top = rng.uniform(0.82, 0.95)
        k = rng.uniform(4, 7)
        uu = np.linspace(u0, u1, 300)
        vv = plateau + (top - plateau) * np.exp(-k * (uu - u0) / (u1 - u0) * 2)
        corner = None
        if c == 0:
            # A straight steep stretch first, then the curve: the slope jumps at the corner, by
            # 25-40 degrees on the page (a model fitted piecewise). The corner is where the curve
            # falls at about 45 degrees (u spans ~w_in, v ~h_in on the page).
            page = h_in / w_in
            fall = (top - plateau) * 2 * k / (u1 - u0) * np.exp(-2 * k * (uu - u0) / (u1 - u0)) * page
            angle = float(rng.uniform(35, 55))
            ic = int(np.argmin(np.abs(np.degrees(np.arctan(fall)) - angle)))
            uc, vc = float(uu[ic]), float(vv[ic])
            steep = math.radians(min(84.0, float(np.degrees(np.arctan(fall[ic]))) + rng.uniform(25, 40)))
            keep = uu >= uc
            dv = min(0.97 - vc, rng.uniform(0.25, 0.4))
            ua, va = uc - dv * page / math.tan(steep), vc + dv
            uu = np.concatenate([[ua, uc], uu[keep]])
            vv = np.concatenate([[va, vc], vv[keep]])
            corner = (uc, vc)
        curves.append(dict(u=uu, v=vv, corner=corner, color=str(pal[c]), label=f"{[1, 3, 5][c]}%"))
    lw = float(rng.uniform(1.0, 2.0))

    def to_data(u, v):
        return (10 ** (xlo + u * sx), 10 ** (ylo + v * sy)) if log else (xlo + u * sx, ylo + v * sy)

    rc = {"path.snap": False, "font.family": font, "font.size": float(rng.uniform(9, 12)),
          "xtick.direction": "out", "ytick.direction": "out", "axes.linewidth": float(rng.choice([0.8, 1.0]))}
    with plt.rc_context(rc):
        fig, ax = plt.subplots(figsize=(w_in, h_in), dpi=dpi)
        series = []
        sizes = {"+": rng.uniform(3.0, 4.5), "x": rng.uniform(3.0, 4.0), "o": rng.uniform(2.2, 3.2), "D": rng.uniform(5.0, 7.0)}
        curves_on_top = rng.random() < 0.4
        for c in curves:
            xd, yd = to_data(c["u"], c["v"])
            ax.plot(xd, yd, color=c["color"], lw=lw, zorder=4 if curves_on_top else 2, solid_joinstyle="miter")
            series.append(dict(kind="line", style="solid", marker=None, color=c["color"], lw=lw, ms=0.0, verts=np.column_stack([xd, yd]),
                               xs=xd, ys=yd, seed_at=float(rng.uniform(0.3, 0.7)), fill=None,
                               corner=None if c["corner"] is None else np.array([to_data(*c["corner"])])))
        for z, (m, p) in enumerate(classes):
            ms = float(sizes[m])
            mew = float(rng.uniform(0.6, 0.9)) if m in "+x" else 0.0
            xd, yd = to_data(p[:, 0], p[:, 1])
            ax.plot(xd, yd, ls="none", marker=m, ms=ms, mew=mew, color="k", mfc="k", mec="k", zorder=3 + 0.1 * z)
            series.append(dict(kind="scatter", style="none", marker=m, color="k", lw=mew, ms=ms, verts=np.column_stack([xd, yd]),
                               xs=xd, ys=yd, seed_at=0.5, fill=True if m in "Do" else None, corner=None))
        for c in curves:
            xd, yd = to_data(c["u"][:1], c["v"][:1])
            ax.annotate(c["label"], (float(xd[0]), float(yd[0])), xytext=(float(rng.uniform(-14, -4)), float(rng.uniform(5, 9))),
                        textcoords="offset points", fontsize=float(rng.uniform(9, 12)), color="k")
        if log:
            ax.set_xscale("log")
            ax.set_yscale("log")
            ax.set_xticks([0.1, 1, 10, 100, 1000])
            ax.set_xticklabels(["0.1", "1.0", "10.0", "100.0", "1000.0"])
            ax.set_yticks([3, 4, 5, 6, 7, 8, 10, 20, 30, 40, 50])
            ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:g}"))
            ax.yaxis.set_minor_formatter(FuncFormatter(lambda v, _: ""))
            ax.xaxis.set_minor_formatter(FuncFormatter(lambda v, _: ""))
            ax.set_xlim(10 ** (xlo - 0.04 * sx), 10 ** (xhi + 0.04 * sx))
            ax.set_ylim(10 ** (ylo - 0.04 * sy), 10 ** (yhi + 0.04 * sy))
            xb, yb = (0.1, 1000), (3, 50)
        else:
            ax.set_xticks(np.arange(0, 101, 20))
            ax.set_yticks(np.arange(0, 61, 10))
            ax.set_xlim(xlo - 0.04 * sx, xhi + 0.04 * sx)
            ax.set_ylim(ylo - 0.04 * sy, yhi + 0.04 * sy)
            xb, yb = (0, 100), (0, 60)
        # Range frame: the axes stand off from the data and span only the labelled range.
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        ax.spines["left"].set_position(("outward", offset))
        ax.spines["bottom"].set_position(("outward", offset))
        ax.spines["left"].set_bounds(*yb)
        ax.spines["bottom"].set_bounds(*xb)
        ax.set_xlabel(str(rng.choice(["Treatment volume (cm3)", "Volume", "Size (mm)"])))
        ax.set_ylabel(str(rng.choice(["Dose (Gy)", "Dose", "Response"])))
        fig.tight_layout()
        fig.canvas.draw()
        W, H = fig.canvas.get_width_height()
        rgba = np.asarray(fig.canvas.buffer_rgba()).copy()
        box = px_of(ax.transAxes.transform([(0, 1), (1, 1), (1, 0), (0, 0)]), H)
        for s in series:
            s["path"] = px_of(ax.transData.transform(s["verts"]), H)
            s["points"] = s["path"]
            s["censor"] = np.zeros((0, 2))
            s["lw_px"] = s["lw"] * dpi / 72
            s["ms_px"] = s["ms"] * dpi / 72
            s["corner_px"] = px_of(ax.transData.transform(s["corner"]), H) if s["corner"] is not None else None
        plt.close(fig)

    rgb = rgba[:, :, :3]
    bg = np.array([255.0, 255.0, 255.0])
    for k_, s in enumerate(series):
        others = [o for j, o in enumerate(series) if j != k_]
        s["crossing"] = s["kind"] != "scatter" and any(o["kind"] != "scatter" and crosses(s["path"], o["path"]) for o in others)
        s["seed"] = pick_seed(s, others, rgb, bg, None, W, H, strict=True)
    tags = ["scenario:busy-scatter", "log-log" if log else "linear", "frame:range", "no-grid", "jpeg" if jpeg_q else "png",
            "dpi:mid" if dpi <= 150 else "dpi:high"]
    names = {"+": "plus", "x": "x", "o": "dot", "D": "diamond"}
    out_series = []
    for k_, s in enumerate(series):
        stags = [f"series:{s['kind']}", "busy"]
        if s["kind"] == "scatter":
            stags += ["color:black", f"marker:{names[s['marker']]}", "small-markers" if s["ms_px"] < 7 else "markers:mid"]
            if s["fill"]:
                stags.append("fill:filled")
        else:
            stags += ["style:solid", "lw:thin" if s["lw_px"] < 1.5 else "lw:thick",
                      "color:grey" if s["color"].startswith("#") else "color:colour", "through-markers"]
            if s["corner_px"] is not None:
                stags.append("corner")
        entry = {
            "id": f"s{k_}",
            "kind": s["kind"],
            "tags": stags,
            "color": [round(255 * c) for c in to_rgb(s["color"])],
            "style": s["style"],
            "marker": s["marker"],
            "lineWidthPx": round(s["lw_px"], 3),
            "markerSizePx": round(s["ms_px"], 3),
            "seed": s["seed"],
            "data": [[round(float(x), 6), round(float(y), 6)] for x, y in zip(s["xs"], s["ys"])],
            "pixels": [[round(float(x), 3), round(float(y), 3)] for x, y in s["points"]],
        }
        if s["kind"] == "scatter":
            entry["markers"] = entry["pixels"]
        else:
            entry["path"] = entry["pixels"]
            if s["corner_px"] is not None:
                entry["corners"] = [[round(float(x), 3), round(float(y), 3)] for x, y in s["corner_px"]]
        out_series.append(entry)
    name = f"l{i:02d}"
    n_markers = sum(len(s["points"]) for s in series if s["kind"] == "scatter")
    doc = {
        "image": f"{name}.{'jpg' if jpeg_q else 'png'}",
        "width": W,
        "height": H,
        "description": (f"Synthetic busy-scatter chart ({variant}), {n_markers} markers in {len(classes)} shapes, {n_curves} curve(s), dpi {dpi}, "
                        f"font {font}" + (f", JPEG q{jpeg_q}" if jpeg_q else "") + ". Generated by bench/lines/generate.py."),
        "tags": tags,
        "plotBox": [[round(float(c), 3) for c in p] for p in box],
        "legendBox": None,
        "series": out_series,
    }
    return Image.fromarray(rgb), doc, jpeg_q


MARK_NAMES = {"o": "circle", "s": "square", "^": "triangle", "v": "triangle-down", "<": "triangle-left", ">": "triangle-right",
              "D": "diamond", "d": "thin-diamond", "*": "star", "p": "pentagon", "h": "hexagon", "P": "plus-filled", "X": "x-filled",
              "x": "x", "+": "plus"}
# One chart each. series: (matplotlib marker, mode, colour, size in px). Modes: filled; open (inside
# of the background colour: hides the line or bar behind it); hollow (no fill: they show through);
# edge (filled, black edge - white on a dark page); wedge (filled, white edge, slightly
# transparent: seaborn's scatter); alpha (semi-transparent, no edge); thin (stroke markers).
MARK_CHARTS = [
    dict(dpi=100, series=[("*", "filled", "C0", 11), ("p", "filled", "C1", 9), ("h", "filled", "C2", 9)]),
    dict(dpi=120, jpeg=True, grid=True, series=[("v", "filled", "C3", 9), ("<", "filled", "C0", 9), (">", "filled", "C2", 9), ("d", "filled", "C4", 10)]),
    dict(dpi=150, series=[("*", "open", "k", 14), ("p", "open", "k", 12), ("v", "filled", "k", 11)]),
    dict(dpi=100, series=[("P", "filled", "C3", 10), ("X", "filled", "C0", 10), ("x", "thin", "k", 7)]),
    dict(dpi=150, jpeg=True, err="y", caps=True, series=[("P", "open", "k", 13), ("X", "open", "k", 13)]),
    dict(dpi=72, series=[("o", "filled", "C0", 4.5), ("s", "filled", "C1", 4.5), ("^", "filled", "C2", 5)]),
    dict(dpi=150, series=[("o", "open", "C0", 16), ("*", "filled", "C3", 16), ("D", "filled", "C2", 14)]),
    dict(dpi=120, jpeg=True, err="y", caps=True, ecolor="k", series=[("o", "edge", "C0", 10), ("s", "edge", "C3", 9), ("^", "edge", "C2", 10)]),
    dict(dpi=100, layout="line", legend="frame", series=[("o", "edge", "C1", 8), ("s", "edge", "C0", 7.5), ("v", "edge", "C2", 8.5)]),
    dict(dpi=120, layout="line", legend="plain", series=[("o", "open", "C0", 9), ("s", "open", "C1", 8), ("D", "open", "C2", 8)]),
    dict(dpi=100, jpeg=True, layout="line", err="y", caps=True, series=[("o", "filled", "k", 8), ("o", "open", "k", 8)]),
    dict(dpi=100, cloud=True, alpha=0.5, series=[("o", "alpha", "C0", 9), ("o", "alpha", "C1", 9)]),
    dict(dpi=100, style="seaborn-v0_8-darkgrid", cloud=True, alpha=0.8, series=[("o", "wedge", "C0", 8), ("o", "wedge", "C1", 8), ("o", "wedge", "C2", 8)]),
    dict(dpi=96, jpeg=True, cloud=True, alpha=0.6, grid=True, series=[("s", "alpha", "C3", 8), ("^", "alpha", "C0", 9)]),
    dict(dpi=120, grid=True, similar=True, series=[("o", "filled", "#1f77b4", 8), ("o", "filled", "#6baed6", 8)]),
    dict(dpi=100, layout="line", legend="frame", similar=True, series=[("s", "filled", "#d62728", 8), ("s", "filled", "#ff7f0e", 8)]),
    dict(dpi=100, jpeg=True, similar=True, series=[("^", "filled", "#2ca02c", 9), ("^", "filled", "#98df8a", 9)]),
    dict(dpi=150, similar=True, series=[("o", "filled", "k", 11), ("o", "filled", "#7f7f7f", 11)]),
    dict(dpi=120, err="xy", caps=False, series=[("*", "filled", "C4", 13), ("h", "open", "C4", 11)]),
    dict(dpi=150, jpeg=True, layout="line", err="y", caps=False, series=[("v", "filled", "k", 12), ("^", "hollow", "k", 12)]),
    dict(dpi=100, err="xy", caps=True, ecolor="k", series=[("d", "filled", "C0", 10), ("p", "filled", "C3", 10)]),
    dict(dpi=96, grid=True, legend="frame", series=[("o", "filled", "C0", 7), ("s", "filled", "C1", 7), ("^", "filled", "C2", 8), ("D", "filled", "C3", 7)]),
    dict(dpi=120, jpeg=True, legend="plain", series=[("o", "open", "k", 9), ("s", "open", "k", 8.5), ("^", "open", "k", 10)]),
    dict(dpi=100, style="dark_background", series=[("o", "filled", "C0", 8), ("*", "filled", "C1", 11), ("s", "filled", "C3", 8)]),
    dict(dpi=120, style="dark_background", layout="line", legend="plain", series=[("o", "open", "C0", 9), ("D", "filled", "C3", 8), ("^", "open", "C5", 10)]),
    dict(dpi=100, jpeg=True, style="dark_background", err="y", caps=True, series=[("s", "filled", "C4", 8), ("o", "open", "C4", 9)]),
    dict(dpi=100, style="ggplot", series=[("o", "filled", "C0", 7), ("^", "filled", "C1", 8), ("s", "filled", "C5", 7)]),
    dict(dpi=96, style="ggplot", layout="line", legend="frame", series=[("o", "filled", "C0", 7), ("o", "filled", "C1", 7)]),
    dict(dpi=72, jpeg=True, grid=True, series=[("*", "filled", "C0", 9), ("p", "filled", "C1", 7), ("X", "filled", "C2", 8)]),
    dict(dpi=120, layout="line", series=[("x", "thin", "k", 8), ("+", "thin", "k", 9), ("^", "open", "k", 10)]),
]


def build_marks(i: int):
    """Marker styles for "Find points" (see MARKS_FROM): every marker class is a scatter series."""
    rng = np.random.default_rng(5000 + i)
    spec = MARK_CHARTS[i - MARKS_FROM]
    dpi = int(spec["dpi"])
    style = spec.get("style")
    layout = spec.get("layout", "scatter")
    err = spec.get("err")
    caps = bool(spec.get("caps"))
    cloud = bool(spec.get("cloud"))
    a_fill = float(spec.get("alpha", 1.0))
    w_in = float(rng.uniform(4.5, 6.5))
    h_in = float(w_in * rng.uniform(0.62, 0.8))
    font = str(FONTS[int(rng.integers(0, len(FONTS)))])
    jpeg_q = int(rng.integers(50, 91)) if spec.get("jpeg") else 0
    grid = bool(spec.get("grid"))
    frame = "box" if rng.random() < 0.5 else "L"
    xlo = float(rng.choice([0, 1, 10]))
    sx = float(rng.choice([10, 50, 100]))
    ylo = float(rng.choice([0, 0, 20]))
    sy = float(rng.choice([1, 10, 100]))
    xhi, yhi = xlo + sx, ylo + sy
    px_pt = 72 / dpi
    rc = {"path.snap": False, "font.family": font, "font.size": float(rng.uniform(8, 11))}
    with plt.style.context(style or "default"), plt.rc_context(rc):
        fig, ax = plt.subplots(figsize=(w_in, h_in), dpi=dpi)
        face = np.array(to_rgb(ax.get_facecolor()))
        dark = bool(face.mean() < 0.5)
        series = []
        for k, (m, mode, cname, ms_px) in enumerate(spec["series"]):
            color = np.array(to_rgb(cname))
            if dark and cname == "k":
                color = np.array([1.0, 1.0, 1.0])
            if cloud:
                n = int(rng.integers(25, 46))
                cu, cv = rng.uniform(0.3, 0.7), rng.uniform(0.3, 0.7)
                xs = xlo + sx * np.clip(rng.normal(cu, 0.16, n), 0.04, 0.96)
                ys = ylo + sy * np.clip(rng.normal(cv, 0.16, n), 0.05, 0.95)
            elif layout == "line" or err:
                n = int(rng.integers(6, 13))
                xs = np.linspace(xlo + 0.06 * sx, xhi - 0.06 * sx, n)
                xs[1:-1] += rng.uniform(-0.25, 0.25, n - 2) * (xs[1] - xs[0])
                ys = smooth_curve(rng, xs, ylo + 0.2 * sy, yhi - 0.2 * sy) + rng.normal(0, 0.04 * sy, n)
                ys = np.clip(ys, ylo + 0.1 * sy, yhi - 0.1 * sy)
            else:
                n = int(rng.integers(10, 25))
                xs = rng.uniform(xlo + 0.05 * sx, xhi - 0.05 * sx, n)
                trend = smooth_curve(rng, np.sort(xs), ylo + 0.2 * sy, yhi - 0.2 * sy)
                ys = np.interp(xs, np.sort(xs), trend) + rng.normal(0, 0.1 * sy, n)
                ys = np.clip(ys, ylo + 0.05 * sy, yhi - 0.05 * sy)
            thick = float(np.clip(ms_px / 9, 0.8, 1.6))
            eff = color
            kw = dict(mfc=color, mec=color, mew=0.5 * px_pt)
            if mode in ("open", "hollow"):
                kw = dict(mfc=face if mode == "open" else "none", mec=color, mew=float(rng.uniform(1.0, 1.6)) * thick * px_pt)
            elif mode == "edge":
                kw = dict(mfc=color, mec="w" if dark else "k", mew=float(rng.uniform(0.7, 1.1)) * thick * px_pt)
            elif mode == "wedge":
                kw = dict(mfc=(*color, a_fill), mec="w", mew=float(rng.uniform(0.5, 0.8)) * px_pt)
                eff = face + a_fill * (color - face)
            elif mode == "alpha":
                kw = dict(mfc=(*color, a_fill), mec="none", mew=0.0)
                eff = face + a_fill * (color - face)
            elif mode == "thin":
                kw = dict(mfc=color, mec=color, mew=float(rng.uniform(1.0, 1.5)) * thick * px_pt)
            line = layout == "line"
            lw_px = float(rng.uniform(1.0, 2.0))
            ls = "none" if not line else "--" if k == 1 and rng.random() < 0.35 else "-"
            elw_px = float(rng.uniform(0.8, 1.4)) * max(1.0, dpi / 100)
            yerr = rng.uniform(0.03, 0.1, n) * sy if err else None
            xerr = rng.uniform(0.012, 0.035, n) * sx if err == "xy" else None
            ecolor = ("w" if dark else "k") if spec.get("ecolor") == "k" else color
            if err:
                ax.errorbar(xs, ys, yerr=yerr, xerr=xerr, marker=m, ls=ls, color=color, lw=lw_px * px_pt, ms=ms_px * px_pt,
                            ecolor=ecolor, elinewidth=elw_px * px_pt, capsize=float(rng.uniform(2.5, 4.5)) * thick * px_pt if caps else 0,
                            capthick=elw_px * px_pt, zorder=2 + k, **kw)
            else:
                ax.plot(xs, ys, marker=m, ls=ls, color=color, lw=lw_px * px_pt, ms=ms_px * px_pt, zorder=2 + k, **kw)
            series.append(dict(marker=m, mode=mode, cname=cname, color=color, eff=eff * 255, ms_px=float(ms_px), xs=xs, ys=ys,
                               line=line, seed_at=float(rng.uniform(0.25, 0.75))))
        ax.set_xlim(xlo - 0.03 * sx, xhi + 0.03 * sx)
        ax.set_ylim(ylo - (0.1 if err else 0.03) * sy, yhi + (0.1 if err else 0.03) * sy)
        if grid:
            ax.grid(True, color=str(rng.choice(["#d9d9d9", "#e0e0e0", "#cccccc"])), lw=float(rng.uniform(0.6, 1.0)) * px_pt)
            ax.set_axisbelow(True)
        if not style and frame == "L":
            ax.spines["top"].set_visible(False)
            ax.spines["right"].set_visible(False)
        ax.set_xlabel(str(rng.choice(["Time (h)", "Dose (Gy)", "Concentration (mM)", "Distance (mm)"])))
        ax.set_ylabel(str(rng.choice(["Response (%)", "Signal (a.u.)", "Survival", "Uptake"])))
        leg = None
        if spec.get("legend"):
            names = [str(v) for v in rng.permutation(["Control", "Treated", "Group A", "Group B", "Placebo", "High dose"])]
            leg = ax.legend(names[:len(series)], loc="best", frameon=spec["legend"] == "frame")
        fig.tight_layout()
        fig.canvas.draw()
        W, H = fig.canvas.get_width_height()
        rgba = np.asarray(fig.canvas.buffer_rgba()).copy()
        box = px_of(ax.transAxes.transform([(0, 1), (1, 1), (1, 0), (0, 0)]), H)
        legend_box = None
        if leg is not None:
            bb = leg.get_window_extent()
            p = px_of(np.array([[bb.x0, bb.y1], [bb.x1, bb.y0]]), H)
            legend_box = [float(p[0, 0]), float(p[0, 1]), float(p[1, 0]), float(p[1, 1])]
        for s in series:
            s["points"] = px_of(ax.transData.transform(np.column_stack([s["xs"], s["ys"]])), H)
        plt.close(fig)

    rgb = rgba[:, :, :3]
    bg = face * 255
    for s in series:
        s["seed"] = pick_mark_seed(s, series, rgb, bg, legend_box, W, H)
    panel = style in ("ggplot", "seaborn-v0_8-darkgrid")
    tags = ["scenario:marker-styles", "grid" if grid or panel else "no-grid", "frame:panel" if panel else "frame:box" if style or frame == "box" else "frame:L",
            "jpeg" if jpeg_q else "png", "dpi:low" if dpi <= 96 else "dpi:mid" if dpi <= 150 else "dpi:high"]
    if grid:
        tags.append("grid:light")
    if dark:
        tags.append("theme:dark")
    if panel:
        tags.append("theme:grey-panel")
    if leg is not None:
        tags += ["legend", "legend:samples"]
    out_series = []
    for k, s in enumerate(series):
        mode = s["mode"]
        stags = ["series:scatter", "color:black" if s["cname"] == "k" else "color:colour", f"marker:{MARK_NAMES[s['marker']]}",
                 "layout:on-line" if s["line"] else "layout:scatter",
                 "size:small" if s["ms_px"] < 6.5 else "size:large" if s["ms_px"] >= 12 else "size:mid"]
        if mode != "thin":
            stags.append("fill:open" if mode in ("open", "hollow") else "fill:filled")
        if mode == "hollow":
            stags.append("fill:hollow")
        if mode == "edge":
            stags.append("edge:white" if dark else "edge:black")
        if mode == "wedge":
            stags.append("edge:white")
        if mode in ("alpha", "wedge"):
            stags.append("alpha")
        if err:
            stags += ["errorbars", f"errorbars:{err}", "caps" if caps else "no-caps"]
            if spec.get("ecolor"):
                stags.append("errorbars:black")
        if spec.get("similar"):
            stags.append("similar-hues")
        if sum(o["cname"] == s["cname"] for o in series) > 1:
            stags.append("one-colour-classes")
        pixels = [[round(float(x), 3), round(float(y), 3)] for x, y in s["points"]]
        out_series.append({
            "id": f"s{k}",
            "kind": "scatter",
            "tags": stags,
            "color": [round(255 * float(c)) for c in s["color"]],
            "style": "none",
            "marker": s["marker"],
            "markerFill": mode,
            "lineWidthPx": 0,
            "markerSizePx": round(s["ms_px"], 3),
            "seed": s["seed"],
            "data": [[round(float(x), 6), round(float(y), 6)] for x, y in zip(s["xs"], s["ys"])],
            "pixels": pixels,
            "markers": pixels,
        })
    name = f"l{i:02d}"
    doc = {
        "image": f"{name}.{'jpg' if jpeg_q else 'png'}",
        "width": W,
        "height": H,
        "description": (f"Synthetic marker-styles chart, {len(series)} marker classes ({', '.join(s['mode'] + ' ' + MARK_NAMES[s['marker']] for s in series)}), "
                        f"{'on lines' if layout == 'line' else 'scatter'}, dpi {dpi}, font {font}" + (f", style sheet {style}" if style else "")
                        + (f", JPEG q{jpeg_q}" if jpeg_q else "") + ". Generated by bench/lines/generate.py."),
        "tags": tags,
        "plotBox": [[round(float(c), 3) for c in p] for p in box],
        "legendBox": [round(v, 3) for v in legend_box] if legend_box else None,
        "series": out_series,
    }
    return Image.fromarray(rgb), doc, jpeg_q


def pick_mark_seed(s, series, rgb, bg, legend_box, W, H):
    """A click on one marker of the class: its centre (a filled, edged, transparent or stroke marker:
    the fill colour, one layer of it) or its outline (open, hollow), on the marker standing most
    clear of every other marker, preferring the middle of the plot; never a legend sample."""
    pts = s["points"]
    ms = s["ms_px"]
    clear = np.full(len(pts), 1e9)
    for o in series:
        d = np.hypot(pts[:, None, 0] - o["points"][None, :, 0], pts[:, None, 1] - o["points"][None, :, 1])
        if o is s:
            np.fill_diagonal(d, 1e9)
        clear = np.minimum(clear, d.min(1) - (ms + o["ms_px"]) / 2)
    if legend_box:
        x0, y0, x1, y1 = legend_box
        inside = (pts[:, 0] >= x0 - ms) & (pts[:, 0] <= x1 + ms) & (pts[:, 1] >= y0 - ms) & (pts[:, 1] <= y1 + ms)
        clear[inside] = -1e9
    xr = (pts[:, 0] - pts[:, 0].min()) / max(1e-9, np.ptp(pts[:, 0]))
    score = np.minimum(clear, 12.0) - 4.0 * np.abs(xr - s["seed_at"])
    if s["mode"] in ("open", "hollow"):
        ang = np.radians([a for a in range(0, 360, 10) if 20 <= a % 90 <= 70])
        rad = np.arange(0.25, 0.76, 0.05) * ms
        offs = np.array([[r * np.cos(t), r * np.sin(t)] for r in rad for t in ang])
    else:
        offs = np.zeros((1, 2))
    for idx in np.argsort(-score):
        if clear[idx] < -1e8:
            continue
        for off in offs:
            x, y = int(round(pts[idx, 0] + off[0])), int(round(pts[idx, 1] + off[1]))
            if not (3 <= x < W - 3 and 3 <= y < H - 3):
                continue
            if 0.6 <= coverage_at(rgb, x, y, s["eff"], bg) <= 1.15:
                return [x, y]
    raise RuntimeError(f"no visible seed for a {s['mode']} {s['marker']} class")


def pick_seed(s, others, rgb, bg, legend_box, W, H, strict=False):
    col = np.array(to_rgb(s["color"])) * 255
    if s["kind"] == "scatter" and s.get("fill") is False:
        # An open marker is clicked on its outline (its inside is white), away from its error bars:
        # points around it, of which the coverage test below keeps those on ink.
        ang = np.radians([a for a in range(0, 360, 10) if 20 <= a % 90 <= 70])
        rad = np.arange(0.3, 0.76, 0.05) * s["ms_px"]
        offs = np.array([[r * np.cos(t), r * np.sin(t)] for r in rad for t in ang])
        cands = (s["points"][:, None, :] + offs[None, :, :]).reshape(-1, 2)
    elif s["kind"] == "scatter":
        cands = s["points"]
    else:
        cands = resample_poly(s["path"], 1.0)
        if s["kind"] == "step":  # horizontal stretches only, away from the corners
            corners = s["path"]
            d_corner = np.min(np.hypot(cands[:, None, 0] - corners[None, :, 0], cands[:, None, 1] - corners[None, :, 1]), 1)
            far = d_corner >= max(4.0, 2 * s["lw_px"])
            cands = cands[far]
        if s["marker"] is not None and len(s["points"]):
            d_m = np.min(np.hypot(cands[:, None, 0] - s["points"][None, :, 0], cands[:, None, 1] - s["points"][None, :, 1]), 1)
            cands = cands[d_m >= s["ms_px"]]
        if len(s["censor"]):
            d_c = np.min(np.hypot(cands[:, None, 0] - s["censor"][None, :, 0], cands[:, None, 1] - s["censor"][None, :, 1]), 1)
            cands = cands[d_c >= s["ms_px"]]
    clear = np.full(len(cands), 1e9)
    for o in others:
        geom = o["points"] if o["kind"] == "scatter" else o["path"]
        reach = o["ms_px"] / 2 if o["kind"] == "scatter" else o["lw_px"] / 2
        clear = np.minimum(clear, seg_dist(cands, geom) - reach)
        if o["marker"] is not None and o["kind"] != "scatter":
            clear = np.minimum(clear, seg_dist(cands, o["points"]) - o["ms_px"] / 2)
    if s["kind"] == "scatter" and s.get("fill") is False and len(cands) > 1:  # clear of its other markers
        own = s["points"]
        d_own = np.hypot(cands[:, None, 0] - own[None, :, 0], cands[:, None, 1] - own[None, :, 1])
        d_own[d_own < s["ms_px"]] = 1e9  # the marker the candidate is on
        clear = np.minimum(clear, d_own.min(1) - s["ms_px"])
    elif s["kind"] == "scatter" and len(cands) > 1:  # isolated from its own markers too
        d_own = np.hypot(cands[:, None, 0] - cands[None, :, 0], cands[:, None, 1] - cands[None, :, 1])
        np.fill_diagonal(d_own, 1e9)
        clear = np.minimum(clear, d_own.min(1) - s["ms_px"])
    if legend_box:
        x0, y0, x1, y1 = legend_box
        inside = (cands[:, 0] >= x0 - 6) & (cands[:, 0] <= x1 + 6) & (cands[:, 1] >= y0 - 6) & (cands[:, 1] <= y1 + 6)
        clear[inside] = -1e9
    if strict and np.any(clear >= 3):
        # Another series of the same colour: its ink is not told apart by the render test below,
        # so keep at least 3 px from it here (a click on the series itself, not on the other).
        cands, clear = cands[clear >= 3], clear[clear >= 3]
    xr = (cands[:, 0] - cands[:, 0].min()) / max(1e-9, np.ptp(cands[:, 0]))
    score = np.minimum(clear, 12.0) - 4.0 * np.abs(xr - s["seed_at"])
    for idx in np.argsort(-score):
        x, y = int(round(cands[idx, 0])), int(round(cands[idx, 1]))
        if not (3 <= x < W - 3 and 3 <= y < H - 3):
            continue
        if coverage_at(rgb, x, y, col, bg) >= 0.6 and uncluttered(rgb, x, y, col, bg):
            return [x, y]
    raise RuntimeError(f"no visible seed for a {s['kind']} series")


def uncluttered(rgb: np.ndarray, x: int, y: int, col: np.ndarray, bg: np.ndarray) -> bool:
    """No ink of another colour (gridline, axis, another series, text) within 3 px: a click on
    the series itself, not on a crossing."""
    d = col - bg
    for yy in range(y - 3, y + 4):
        for xx in range(x - 3, x + 4):
            v = rgb[yy, xx].astype(float) - bg
            if np.linalg.norm(v) < 30:
                continue
            a = float(v @ d / max(1e-9, d @ d))
            # The render blends exactly: series pixels are bg + a * (col - bg) up to rounding.
            if np.linalg.norm(v - a * d) > max(12.0, 0.08 * float(np.linalg.norm(v))):
                return False
    return True


# Charts l170-l199 (appended; ids below STYLE_FROM belong to other builders and stay byte-identical):
# line-chart looks the corpus lacked ("styles"), one variant per chart - (variant, JPEG quality or 0,
# dpi). A shaded band of the series' own lighter colour around each curve (with dashed limits in the
# JPEG one); filled areas under an edge line; stacked areas with and without edge lines (the truth
# is each layer's top edge); six to eight series from one palette (tab10, a colour-blind palette,
# shades of one hue, shades of grey, the last also with line styles); noisy time series crossing
# many times; curves that run together for a stretch before parting (the upper one hides the
# other); 1-px lines at low DPI, antialiased and crisp; dark and grey-panel themes with their
# gridlines; dashed / dotted gridlines in the series' colour; text labels, an arrow and a legend box
# lying over the curves; Kaplan-Meier pairs of one colour with "|" censor ticks, solid + dashed and
# solid + dotted; steep sigmoids; log-x dose-response curves with bands; log-log power laws.
STYLE_FROM = 170
STYLE_VARIANTS = [
    ("band", 0, 100), ("band-limits", 78, 120),
    ("area", 0, 100), ("area", 82, 96),
    ("stacked", 0, 100), ("stacked-fill", 0, 120),
    ("palette:tab10", 0, 120), ("palette:colorblind", 0, 100), ("palette:hue", 0, 150), ("palette:grey", 0, 100), ("palette:grey-styles", 70, 120),
    ("noisy", 0, 100), ("noisy", 80, 72),
    ("touching", 0, 100), ("touching-hue", 0, 120),
    ("hairline:aa", 0, 72), ("hairline:crisp", 0, 96),
    ("theme:dark", 0, 100), ("theme:dark-band", 85, 100),
    ("theme:ggplot", 0, 100), ("theme:darkgrid", 75, 120),
    ("own-grid:dashed", 0, 120), ("own-grid:dotted", 0, 100),
    ("annotations", 0, 100), ("annotations", 80, 120),
    ("km:dashed", 0, 120), ("km:dotted", 0, 150),
    ("steep", 0, 100), ("log-x", 0, 100), ("log-log", 0, 120),
]
STYLE_THEMES = {"theme:dark": "dark_background", "theme:dark-band": "dark_background", "theme:ggplot": "ggplot",
                "theme:darkgrid": "seaborn-v0_8-darkgrid"}
OKABE_ITO = ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9", "#F0E442"]


def curve_family(rng: np.random.Generator, xs: np.ndarray, n: int, ylo: float, yhi: float) -> list:
    """n curves as one figure shows them: one model at n parameter values, with a slow wobble each so
    that neighbours cross here and there."""
    t = (xs - xs.min()) / np.ptp(xs)
    kind = int(rng.integers(0, 3))
    out = []
    for k in range(n):
        f = (k + 0.5) / n
        if kind == 0:  # saturating growth to different plateaus
            y = (0.25 + 0.75 * f) * (1 - np.exp(-rng.uniform(2, 7) * t))
        elif kind == 1:  # decay from one start
            y = np.exp(-(0.4 + 4 * f) * t ** rng.uniform(0.8, 1.6))
        else:  # absorption and elimination: a peak, then a tail
            ka, ke = rng.uniform(6, 14), 0.8 + 3 * f
            y = np.exp(-ke * t) - np.exp(-ka * t)
            y = y / y.max() * (0.35 + 0.65 * (1 - f))
        y = y + rng.uniform(0.0, 0.04) * np.sin(2 * math.pi * (rng.uniform(0.5, 2) * t + rng.uniform(0, 1)))
        out.append(ylo + (yhi - ylo) * (0.05 + 0.9 * y))
    return out


def pick_seed_styles(s, others, rgb, bg, keepout, W, H):
    """A seed for the "styles" charts: on the series (or, for an area without an edge line, in its
    fill just below the top edge), at least 3 px clear of every other series, outside the legend
    and the text boxes. First a pixel that passes pick_seed's test (coverage >= 0.6 by the series'
    colour over the panel, no ink of another colour within 3 px); where a fill, a band or a theme's
    gridlines leave none, a pixel at least 60 % of the way from the panel's colour to the series'."""
    col = np.array(to_rgb(s["color"])) * 255
    cands = resample_poly(s["path"], 1.0)
    if s["kind"] == "step":
        d_corner = np.min(np.hypot(cands[:, None, 0] - s["path"][None, :, 0], cands[:, None, 1] - s["path"][None, :, 1]), 1)
        cands = cands[d_corner >= max(4.0, 2 * s["lw_px"])]
    if len(s["censor"]):
        d_c = np.min(np.hypot(cands[:, None, 0] - s["censor"][None, :, 0], cands[:, None, 1] - s["censor"][None, :, 1]), 1)
        cands = cands[d_c >= s["ms_px"]]
    cands = cands + np.array([0.0, s["seed_dy"]])
    clear = np.full(len(cands), 1e9)
    for o in others:
        clear = np.minimum(clear, seg_dist(cands, o["path"]) - o["lw_px"] / 2 - s["lw_px"] / 2)
        if len(o["censor"]):
            clear = np.minimum(clear, seg_dist(cands, o["censor"]) - o["ms_px"] / 2)
    for x0, y0, x1, y1 in keepout:
        inside = (cands[:, 0] >= x0 - 6) & (cands[:, 0] <= x1 + 6) & (cands[:, 1] >= y0 - 6) & (cands[:, 1] <= y1 + 6)
        clear[inside] = -1e9
    if np.any(clear >= 3):
        cands, clear = cands[clear >= 3], clear[clear >= 3]
    xr = (cands[:, 0] - cands[:, 0].min()) / max(1e-9, np.ptp(cands[:, 0]))
    # Not on the very tip of a series (where the others leave no other place, a click is still inside it).
    order = np.argsort(-(np.minimum(clear, 12.0) - 4.0 * np.abs(xr - s["seed_at"]) - 20.0 * ((xr < 0.04) | (xr > 0.96))))
    tol = max(30.0, 0.4 * float(np.linalg.norm(col - bg)))
    for strict in (True, False):
        for idx in order:
            x, y = int(round(cands[idx, 0])), int(round(cands[idx, 1]))
            if not (3 <= x < W - 3 and 3 <= y < H - 3) or clear[idx] < -1e8:
                continue
            if strict and coverage_at(rgb, x, y, col, bg) >= 0.6 and uncluttered(rgb, x, y, col, bg):
                return [x, y]
            if not strict and float(np.linalg.norm(rgb[y, x].astype(float) - col)) <= tol:
                return [x, y]
    raise RuntimeError(f"no visible seed for a {s['kind']} series")


def build_styles(i: int):
    """One chart of the "styles" set (see STYLE_FROM)."""
    rng = np.random.default_rng(5000 + i)
    variant, jpeg_q, dpi = STYLE_VARIANTS[i - STYLE_FROM]
    w_in = float(rng.uniform(5.5, 7.5))
    h_in = float(w_in * rng.uniform(0.58, 0.75))
    if w_in * dpi > 900:
        w_in, h_in = 900 / dpi, 900 / dpi * h_in / w_in
    font = str(FONTS[int(rng.integers(0, len(FONTS)))])
    theme = STYLE_THEMES.get(variant)
    rc = {"path.snap": False, "font.family": font, "font.size": float(rng.uniform(8, 11))}
    tags = []
    grid = False
    frame = "box"
    with plt.style.context(theme or "default"), plt.rc_context(rc):
        fig, ax = plt.subplots(figsize=(w_in, h_in), dpi=dpi)
        hexc = matplotlib.colors.to_hex
        xlo, xhi = 0.0, float(rng.choice([10, 24, 60, 100]))
        ylo, yhi = 0.0, float(rng.choice([1, 10, 100]))
        xs = np.linspace(xlo, xhi, 400)
        t = (xs - xlo) / (xhi - xlo)
        span = yhi - ylo
        series = []
        texts = []  # artists whose boxes seeds keep out of
        leg = None
        floor = False  # the y axis starts at ylo exactly (areas)
        pal = [hexc(c) for c in rng.permutation(PALETTE)]

        def add(kind, style, color, lw, xd, yd, verts=None, cens=(), ms=0.0, seed_dy=0.0, edge=True):
            series.append(dict(kind=kind, style=style, marker=None, color=color, lw=lw, ms=ms, xs=np.asarray(xd), ys=np.asarray(yd),
                               verts=np.column_stack([xd, yd]) if verts is None else verts, cens=list(cens),
                               seed_at=float(rng.uniform(0.25, 0.75)), seed_dy=seed_dy, edge=edge))

        def band(xd, yd, color, k, lo=0.04, hi=0.09):
            half = span * rng.uniform(lo, hi) * (1 + rng.uniform(0, 1.2) * np.linspace(0, 1, len(xd)))
            ax.fill_between(xd, yd - half, yd + half, color=color, alpha=float(rng.uniform(0.15, 0.3)), lw=0, zorder=1 + 0.1 * k)
            return half

        if variant in ("band", "band-limits"):
            tags += ["band"] + (["band-limits"] if variant == "band-limits" else [])
            for k in range(2 if variant == "band" else 3):
                ys = smooth_curve(rng, xs, ylo, yhi)
                half = band(xs, ys, pal[k], k)
                if variant == "band-limits":
                    for sign in (-1, 1):
                        ax.plot(xs, ys + sign * half, color=pal[k], lw=0.7, ls="--", alpha=0.7, zorder=1.5)
                lw = float(rng.uniform(1.2, 2.2))
                ax.plot(xs, ys, color=pal[k], lw=lw, zorder=3 + k)
                add("line", "solid", pal[k], lw, xs, ys)
        elif variant == "area":
            tags += ["area"]
            floor = True
            for k in range(2):
                ys = smooth_curve(rng, xs, ylo + 0.25 * span, yhi)
                lw = float(rng.uniform(1.0, 2.0))
                if k == 0 or jpeg_q:
                    ax.fill_between(xs, ylo, ys, color=pal[k], alpha=float(rng.uniform(0.3, 0.45)), lw=0, zorder=1 + 0.1 * k)
                ax.plot(xs, ys, color=pal[k], lw=lw, zorder=3 + k)
                add("line", "solid", pal[k], lw, xs, ys)
        elif variant in ("stacked", "stacked-fill"):
            tags += ["area", "stacked"] + (["area:no-edge"] if variant == "stacked-fill" else [])
            floor = True
            n = 3 if variant == "stacked" else 4
            base = np.full(len(xs), ylo)
            for k in range(n):
                hgt = span / n * rng.uniform(0.45, 0.85) * (1 + rng.uniform(0.2, 0.5) * np.sin(2 * math.pi * (rng.uniform(0.4, 1.5) * t + rng.uniform(0, 1))))
                top = base + hgt
                if variant == "stacked":
                    lw = float(rng.uniform(1.0, 1.8))
                    ax.fill_between(xs, base, top, color=pal[k], alpha=float(rng.uniform(0.4, 0.55)), lw=0, zorder=1)
                    ax.plot(xs, top, color=pal[k], lw=lw, zorder=3 + k)
                    add("line", "solid", pal[k], lw, xs, top)
                else:
                    ax.fill_between(xs, base, top, color=pal[k], lw=0, zorder=1)
                    add("line", "none", pal[k], 0.0, xs, top, seed_dy=2.5, edge=False)
                base = top
        elif variant.startswith("palette:"):
            name = variant.split(":")[1]
            tags += ["many-series", "palette:grey" if name.startswith("grey") else f"palette:{name}"]
            grid = name in ("tab10", "hue")
            if name == "tab10":
                cols = [hexc(plt.cm.tab10(k)) for k in range(8)]
            elif name == "colorblind":
                cols = list(OKABE_ITO)
            elif name == "hue":
                cmap = plt.cm.Blues if rng.random() < 0.5 else plt.cm.Reds
                cols = [hexc(cmap(v)) for v in np.linspace(0.35, 1.0, 6)]
            elif name == "grey":
                cols = [hexc(str(v)) for v in (0.0, 0.25, 0.45, 0.6, 0.72, 0.8)]
            else:
                cols = [hexc(str(v)) for v in (0.0, 0.3, 0.5, 0.65, 0.78)]
            styles = ["solid", "dashed", "solid", "dotted", "dashdot"] if name == "grey-styles" else ["solid"] * len(cols)
            order = rng.permutation(len(cols))
            for k, ys in enumerate(curve_family(rng, xs, len(cols), ylo, yhi)):
                c, st = cols[int(order[k])], styles[k % len(styles)]
                lw = float(rng.uniform(1.2, 1.9))
                ax.plot(xs, ys, color=c, lw=lw, ls="-" if st == "solid" else STYLES[st], zorder=3 + k, label=f"group {k + 1}")
                add("line", st, c, lw, xs, ys)
            if name in ("tab10", "colorblind"):
                leg = ax.legend(loc="best", ncol=2, fontsize=float(rng.uniform(6.5, 8)))
        elif variant == "noisy":
            tags += ["noisy"]
            grid = jpeg_q > 0
            n_pts = int(rng.integers(350, 600))
            xs = np.linspace(xlo, xhi, n_pts)
            kernel = np.hanning(31) / np.hanning(31).sum()
            for k in range(3 if not jpeg_q else 4):
                walk = np.convolve(np.cumsum(rng.normal(0, 1, n_pts + 30)), kernel, mode="valid")
                ys = (walk - walk.mean()) / max(1e-9, np.ptp(walk)) * 0.5 + rng.normal(0, rng.uniform(0.03, 0.07), n_pts) + 0.5 + 0.1 * (k - 1)
                ys = ylo + span * ys
                lw = float(rng.uniform(0.8, 1.2))
                ax.plot(xs, ys, color=pal[k], lw=lw, zorder=3 + k)
                add("line", "solid", pal[k], lw, xs, ys)
        elif variant in ("touching", "touching-hue"):
            tags += ["touching"] + (["palette:hue"] if variant == "touching-hue" else [])
            cols = ["#1f4e79", "#6baed6", "#3182bd"] if variant == "touching-hue" else pal

            def smoothstep(u):
                u = np.clip(u, 0, 1)
                return u * u * (3 - 2 * u)

            ya = smooth_curve(rng, xs, ylo + 0.2 * span, yhi - 0.2 * span)
            t1 = float(rng.uniform(0.3, 0.45))
            t2 = t1 + float(rng.uniform(0.15, 0.25))
            # The second curve is the first one over t1…t2 exactly, and leaves it smoothly either side.
            yb = ya + span * (rng.uniform(0.12, 0.25) * float(rng.choice([-1, 1])) * smoothstep((t1 - t) / 0.25)
                              + rng.uniform(0.12, 0.25) * float(rng.choice([-1, 1])) * smoothstep((t - t2) / 0.25))
            curves = [ya, yb]
            if variant == "touching-hue":  # a third one that only touches the first, at one point
                t0 = float(rng.uniform(0.6, 0.85))
                curves.append(ya + span * float(rng.uniform(0.8, 1.6)) * float(rng.choice([-1, 1])) * (t - t0) ** 2)
            for k, ys in enumerate(curves):
                lw = float(rng.uniform(1.3, 2.2))
                ax.plot(xs, ys, color=cols[k], lw=lw, zorder=3 + k)
                add("line", "solid", cols[k], lw, xs, ys)
        elif variant.startswith("hairline"):
            crisp = variant.endswith("crisp")
            tags += ["hairline", "hairline:crisp" if crisp else "hairline:aa"]
            lw = 72.0 / dpi  # one pixel
            cols = pal[:3] + ["#000000"]
            for k in range(4):
                ys = smooth_curve(rng, xs, ylo, yhi)
                st = "dashed" if crisp and k == 2 else "solid"
                ax.plot(xs, ys, color=cols[k], lw=lw, ls="-" if st == "solid" else "--", antialiased=not crisp, zorder=3 + k)
                add("line", st, cols[k], lw, xs, ys)
        elif theme:
            tags += ["theme:dark" if "dark_background" in theme else "theme:grey-panel"] + (["band"] if variant == "theme:dark-band" else [])
            grid = True
            cyc = [hexc(c) for c in plt.rcParams["axes.prop_cycle"].by_key()["color"]]
            n = {"theme:dark": 4, "theme:dark-band": 3, "theme:ggplot": 4, "theme:darkgrid": 5}[variant]
            for k in range(n):
                ys = smooth_curve(rng, xs, ylo, yhi)
                if variant == "theme:dark-band":
                    band(xs, ys, cyc[k], k)
                lw = float(rng.uniform(1.2, 2.0))
                ax.plot(xs, ys, color=cyc[k], lw=lw, zorder=3 + k)
                add("line", "solid", cyc[k], lw, xs, ys)
            if "dark_background" in theme:
                ax.grid(True, color="#4d4d4d", lw=0.6)
            else:
                ax.grid(True)
        elif variant.startswith("own-grid"):
            tags += ["grid:series-colour"]
            grid = True
            dotted = variant.endswith("dotted")
            c = pal[0] if dotted else "#000000"
            specs = [("solid", c), ("dashed", c)] + ([] if dotted else [("solid", pal[1])])
            for k, (st, col) in enumerate(specs):
                ys = smooth_curve(rng, xs, ylo, yhi)
                lw = float(rng.uniform(1.2, 2.0))
                ax.plot(xs, ys, color=col, lw=lw, ls="-" if st == "solid" else "--", zorder=3 + k)
                add("line", st, col, lw, xs, ys)
            ax.grid(True, color=c, ls=":" if dotted else "--", lw=float(rng.uniform(0.5, 0.8)))
        elif variant == "annotations":
            tags += ["annotations", "legend-over"]
            for k in range(3):
                ys = smooth_curve(rng, xs, ylo, yhi)
                lw = float(rng.uniform(1.2, 2.0))
                ax.plot(xs, ys, color=pal[k], lw=lw, zorder=3 + k, label=["Control", "Treated", "Reference"][k])
                add("line", "solid", pal[k], lw, xs, ys)
                # A label per curve: above it in its colour, on it in a white box, on it in black.
                j = int(rng.integers(40, 360))
                fs = float(rng.uniform(8, 10))
                if k == 0:
                    texts.append(ax.annotate(["Control", "Treated", "Reference"][k], (xs[j], ys[j]), xytext=(0, 3), textcoords="offset points",
                                             color=pal[k], fontsize=fs, ha="center", va="bottom", zorder=6))
                elif k == 1:
                    texts.append(ax.text(xs[j], ys[j], ["Control", "Treated", "Reference"][k], color=pal[k], fontsize=fs, ha="center", va="center",
                                         zorder=6, bbox=dict(facecolor="white", edgecolor="none", pad=1.5)))
                else:
                    texts.append(ax.text(xs[j], ys[j], "n = %d" % int(rng.integers(12, 90)), color="k", fontsize=fs, ha="center", va="center", zorder=6))
            # An arrow to the first curve's highest point, from a note beside it.
            j = int(np.clip(np.argmax(series[0]["ys"]), 30, 370))
            texts.append(ax.annotate("peak", (xs[j], series[0]["ys"][j]), xytext=(float(rng.choice([-45, 45])), float(rng.uniform(-40, -25))),
                                     textcoords="offset points", fontsize=float(rng.uniform(8, 10)), ha="center", zorder=6,
                                     arrowprops=dict(arrowstyle="->", color="k", lw=0.9)))
            loc = str(rng.choice(["center", "center right", "lower center", "upper center"]))
            leg = ax.legend(loc=loc, framealpha=0.8, fancybox=True) if jpeg_q else ax.legend(loc=loc, framealpha=1.0, fancybox=False, edgecolor="k")
            leg.set_zorder(7)
        elif variant.startswith("km:"):
            other = variant.split(":")[1]
            tags += ["km-styles"]
            xhi = float(rng.choice([24, 60, 120]))
            ylo, yhi = 0.0, 1.0
            c = "#000000" if other == "dashed" else pal[0]
            for k, st in enumerate(["solid", other]):
                kx, ky, cens = km_curve(rng, xhi)
                lw = float(rng.uniform(1.0, 2.0))
                ms = float(rng.uniform(5, 8))
                ax.plot(kx, ky, color=c, lw=lw, ls="-" if st == "solid" else STYLES[st], drawstyle="steps-post", zorder=3 + k)
                if cens:
                    cc = np.array(cens)
                    ax.plot(cc[:, 0], cc[:, 1], ls="none", marker="|", color=c, ms=ms, mew=max(0.8, lw * 0.8), zorder=3 + k)
                add("step", st, c, lw, kx, ky, verts=step_vertices(kx, ky), cens=cens, ms=ms)
        elif variant == "steep":
            tags += ["steep"]
            xs = np.linspace(xlo, xhi, 4000)
            t = (xs - xlo) / (xhi - xlo)
            centres = rng.permutation([0.3, 0.5, 0.7]) + rng.uniform(-0.06, 0.06, 3)
            for k in range(3):
                rate = float(rng.choice([60, 120, 250]))
                up = float(rng.choice([-1, 1]))
                lo, hi = ylo + span * rng.uniform(0.03, 0.2), yhi - span * rng.uniform(0.03, 0.2)
                ys = lo + (hi - lo) / (1 + np.exp(-up * rate * (t - centres[k])))
                st = "dashed" if k == 2 else "solid"
                lw = float(rng.uniform(1.2, 2.0))
                ax.plot(xs, ys, color=pal[k], lw=lw, ls="-" if st == "solid" else "--", zorder=3 + k)
                add("line", st, pal[k], lw, xs, ys)
        elif variant == "log-x":
            tags += ["log-x", "band"]
            grid = True
            xs = np.logspace(-2, 2, 500)
            ylo, yhi, span = 0.0, 100.0, 100.0
            for k in range(3):
                ec50 = 10 ** float(rng.uniform(-1.2, 1.2))
                bottom, top = float(rng.uniform(0, 15)), float(rng.uniform(70, 100))
                ys = bottom + (top - bottom) / (1 + (ec50 / xs) ** float(rng.uniform(0.8, 2.5)))
                band(xs, ys, pal[k], k, 0.03, 0.06)
                lw = float(rng.uniform(1.2, 2.0))
                ax.plot(xs, ys, color=pal[k], lw=lw, zorder=3 + k)
                add("line", "solid", pal[k], lw, xs, ys)
            ax.set_xscale("log")
            ax.grid(True, which="major", color="#c8c8c8", lw=0.7)
            ax.grid(True, which="minor", color="#e6e6e6", lw=0.5)
        else:  # log-log
            tags += ["log-log"]
            grid = True
            xs = np.logspace(0, 4, 500)
            for k in range(4):
                a, b = 10 ** float(rng.uniform(-1, 2)), float(rng.uniform(-1.4, 1.2))
                ys = a * xs ** b
                if k == 1:  # a power law with a cut-off: straight, then bending down
                    ys = ys * np.exp(-xs / 10 ** float(rng.uniform(2.8, 3.6)))
                st = "dashed" if k == 3 else "solid"
                lw = float(rng.uniform(1.2, 2.0))
                ax.plot(xs, ys, color=pal[k], lw=lw, ls="-" if st == "solid" else "--", zorder=3 + k)
                add("line", st, pal[k], lw, xs, ys)
            ax.set_xscale("log")
            ax.set_yscale("log")
            ax.grid(True, which="major", color="#c8c8c8", lw=0.7)
            ax.grid(True, which="minor", color="#e6e6e6", lw=0.5)

        logx, logy = variant in ("log-x", "log-log"), variant == "log-log"
        allv = np.vstack([s["verts"] for s in series])
        if not logx:
            ax.set_xlim(xlo - 0.02 * (xhi - xlo), xhi + 0.02 * (xhi - xlo))
        if not logy:
            pad_y = 0.06 * (allv[:, 1].max() - allv[:, 1].min() + 1e-9)
            ax.set_ylim(ylo if floor else allv[:, 1].min() - pad_y, allv[:, 1].max() + pad_y)
        if grid and not theme and not variant.startswith(("own-grid", "log")):
            ax.grid(True, color=str(rng.choice(["#b0b0b0", "#d0d0d0"])), ls=str(rng.choice(["-", "--", ":"])), lw=float(rng.uniform(0.5, 1.0)))
        if not theme and rng.random() < 0.4:
            frame = "L"
            ax.spines["top"].set_visible(False)
            ax.spines["right"].set_visible(False)
        if theme and "dark_background" not in theme:
            frame = "none"
        ax.set_xlabel(str(rng.choice(["Time (months)", "Time (h)", "Dose (mg)", "Concentration", "Frequency (Hz)"])))
        ax.set_ylabel(str(rng.choice(["Survival", "Response (%)", "Signal (a.u.)", "Count", "Fraction"])))
        fig.tight_layout()
        fig.canvas.draw()
        W, H = fig.canvas.get_width_height()
        rgba = np.asarray(fig.canvas.buffer_rgba()).copy()
        box = px_of(ax.transAxes.transform([(0, 1), (1, 1), (1, 0), (0, 0)]), H)
        bg = np.array(to_rgb(ax.get_facecolor())) * 255
        keepout = []
        legend_box = None
        for artist in texts + ([leg] if leg is not None else []):
            bb = artist.get_window_extent()
            p = px_of(np.array([[bb.x0, bb.y1], [bb.x1, bb.y0]]), H)
            keepout.append([float(p[0, 0]), float(p[0, 1]), float(p[1, 0]), float(p[1, 1])])
        if leg is not None:
            legend_box = keepout[-1]
        for s in series:
            s["path"] = px_of(ax.transData.transform(s["verts"]), H)
            s["points"] = px_of(ax.transData.transform(np.column_stack([s["xs"], s["ys"]])), H)
            s["censor"] = px_of(ax.transData.transform(np.array(s["cens"])), H) if s["cens"] else np.zeros((0, 2))
            s["lw_px"] = s["lw"] * dpi / 72
            s["ms_px"] = s["ms"] * dpi / 72
        plt.close(fig)

    rgb = rgba[:, :, :3]
    for k, s in enumerate(series):
        others = [o for j, o in enumerate(series) if j != k]
        s["crossing"] = any(crosses(s["path"], o["path"]) for o in others)
        s["seed"] = pick_seed_styles(s, others, rgb, bg, keepout, W, H)
    tags = ["scenario:styles"] + tags + ["grid" if grid else "no-grid", f"frame:{frame}", "jpeg" if jpeg_q else "png",
                                         "dpi:low" if dpi <= 96 else "dpi:mid" if dpi <= 150 else "dpi:high"]
    if leg is not None:
        tags.append("legend")
    same = variant.startswith(("km:", "own-grid"))
    out_series = []
    for k, s in enumerate(series):
        r, g, b = (round(255 * c) for c in to_rgb(s["color"]))
        stags = [f"series:{s['kind']}"]
        if s["edge"]:
            stags += [f"style:{s['style']}", "lw:thin" if s["lw_px"] < 1.5 else "lw:thick"]
        stags.append("color:black" if max(r, g, b) < 30 else "color:grey" if max(r, g, b) - min(r, g, b) < 12 else "color:colour")
        if s["crossing"]:
            stags.append("crossing")
        if len(s["censor"]):
            stags.append("censor-ticks")
        if same and sum(o["color"] == s["color"] for o in series) > 1:
            stags.append("same-colour")
        path = [[round(float(x), 3), round(float(y), 3)] for x, y in s["path"]]
        entry = {
            "id": f"s{k}",
            "kind": s["kind"],
            "tags": stags,
            "color": [r, g, b],
            "style": s["style"],
            "marker": None,
            "lineWidthPx": round(s["lw_px"], 3),
            "markerSizePx": round(s["ms_px"], 3),
            "seed": s["seed"],
            "data": [[round(float(x), 6), round(float(y), 6)] for x, y in zip(s["xs"], s["ys"])],
            "pixels": [[round(float(x), 3), round(float(y), 3)] for x, y in s["points"]],
            "path": path,
        }
        if s["kind"] == "step":
            entry["corners"] = path[1:-1]
        out_series.append(entry)
    doc = {
        "image": f"l{i:02d}.{'jpg' if jpeg_q else 'png'}",
        "width": W,
        "height": H,
        "description": (f"Synthetic styles chart ({variant}), {len(series)} series, dpi {dpi}, font {font}"
                        + (f", JPEG q{jpeg_q}" if jpeg_q else "") + ". Generated by bench/lines/generate.py."),
        "tags": tags,
        "plotBox": [[round(float(c), 3) for c in p] for p in box],
        "legendBox": [round(v, 3) for v in legend_box] if legend_box else None,
        "series": out_series,
    }
    return Image.fromarray(rgb), doc, jpeg_q


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("l*.*"):
        old.unlink()
    total = 0
    traces = 0
    # COUNT covers l00-l169 (MARKS_FROM's marker-styles end at 169); then l170-l199 (STYLE_FROM).
    ids = [*range(COUNT), *range(STYLE_FROM, STYLE_FROM + len(STYLE_VARIANTS))]
    for i in ids:
        img, doc, q = (build_styles(i) if i >= STYLE_FROM else build_marks(i) if i >= MARKS_FROM else build_busy(i) if i >= BUSY_FROM
                       else build_scan(i) if i >= SCAN_FROM else build(i))
        name = doc["image"]
        if SCAN_FROM <= i < BUSY_FROM:
            img = img.convert("L")  # a black-and-white scan: one grey channel
        if q:
            img.save(OUT / name, quality=q)
        else:
            img.save(OUT / name, optimize=True)
        (OUT / f"l{i:02d}.json").write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
        total += (OUT / name).stat().st_size
        traces += len(doc["series"])
        kinds = " ".join(s["kind"] + ("+m" if s.get("marker") and s["kind"] == "line" else "") for s in doc["series"])
        print(f"{name:8s} {img.width:5d}x{img.height:<5d} {' '.join(doc['tags'])} | {kinds}")
    print(f"{len(ids)} charts, {traces} series, {total / 1e6:.2f} MB of images")
    # l200-l229, "new kinds" (curves that are not functions of x, bar charts): generate_kinds.py.
    import generate_kinds
    generate_kinds.write_all()
    return 0


if __name__ == "__main__":
    sys.exit(main())
