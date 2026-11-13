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
rotated by up to half a degree before the threshold, like a scan; the truth is rotated with it).

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
COUNT = 128

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


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("l*.*"):
        old.unlink()
    total = 0
    traces = 0
    for i in range(COUNT):
        img, doc, q = build_scan(i) if i >= SCAN_FROM else build(i)
        name = doc["image"]
        if i >= SCAN_FROM:
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
    print(f"{COUNT} charts, {traces} series, {total / 1e6:.2f} MB of images")
    return 0


if __name__ == "__main__":
    sys.exit(main())
