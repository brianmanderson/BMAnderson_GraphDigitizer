"""
Charts l200-l247 of the line-tracing corpus ("new kinds"): graphs whose data are not one y per x,
and bar charts. Called by generate.py's main (after its own charts, which stay byte-identical) and
runnable alone, which rewrites only these files:

    python bench/lines/generate_kinds.py

Track A, l200-l215 - curves that are not functions of x, as `kind: "line"` series tagged
`series:path` whose `path` is the drawn polyline *in drawing order* (a closed loop ends on its
first point): `loop` (hysteresis M-H loops whose branches merge before the tips, nested loops,
lens-shaped and elliptic P-E loops, stress-strain cycles drawn in one stroke, cyclic voltammograms,
a minor loop of the major loop's own colour over axis lines of that colour), `vertical` (ROC
staircases, depth profiles with y as the independent variable, isotherms with a vertical drop),
`overhang` (bistable S-curves, nose curves on a log axis, an impedance arc that curls back),
`spiral` (phase portraits) and `parametric` (Lissajous figures, limit cycles, a wandering
trajectory); `closed`, `self-crossing` and `cusps` say what else is in the path. `corners` are the
vertices a user needs as points: step corners, the tips of a loop, the ends of a vertical drop.

Track B, l216-l229 and l240-l247 - bars, as `kind: "bars"` series tagged `series:bars` whose `markers` are the
value end of every bar of the series, at the middle of the bar's width: the top edge of a bar above
its baseline, the bottom edge of one below it, the right or left end of a horizontal bar, the top
edge of a stacked segment. Bars of height zero are not drawn and have no truth. `bars:plain`,
`bars:grouped`, `bars:stacked`, `histogram`, `bars:horizontal`, `bars:outlined` (no fill),
`bars:hatched`, `bars:negative` (some values below the baseline), `bars:errorbars` (the point is
the bar's end, not the cap) and `bars:labels` (value labels beyond the ends).

Styles vary per chart: matplotlib's style sheets (ggplot, seaborn, dark_background,
fivethirtyeight, bmh, grayscale, classic), fonts, line widths, DPI 72-200, PNG or JPEG, legends.
As everywhere in the corpus, pixel snapping is off so the drawn geometry is exactly the truth.

Seeds: on visible ink of the series, as a user would click it - for a path, on a stretch well
clear of the series' own other branches and of every other series; for a filled bar, inside one of
the middle bars of the series, on its fill; for an unfilled bar, on its outline; for a bar told
apart only by its hatching, on a hatch line.
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
from PIL import Image  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate import FONTS, OUT, coverage_at, px_of, resample_poly, seg_dist  # noqa: E402

KINDS_FROM = 200
# Chart numbers, in SPECS order: l200-l229 (round one), then l240-l247 (bar styles, round two;
# l230-l239 are left unused, other ranges belong to other corpus additions).
NUMBERS = list(range(200, 230)) + list(range(240, 248))
KINDS_COUNT = len(NUMBERS)

# (builder, style sheet or None, dpi, JPEG quality or 0, legend)
SPECS = [
    ("mh-merged", None, 100, 0, False),
    ("mh-nested", None, 120, 0, True),
    ("pe-loops", "seaborn-v0_8-whitegrid", 96, 80, True),
    ("stress-cycles", "classic", 150, 0, False),
    ("voltammogram", "ggplot", 100, 0, True),
    ("minor-loop", None, 72, 60, False),
    ("roc", None, 100, 0, True),
    ("depth-profile", None, 120, 75, True),
    ("s-curve", "dark_background", 100, 0, False),
    ("nose", "bmh", 150, 0, True),
    ("isotherm", None, 100, 85, False),
    ("spiral", None, 100, 0, False),
    ("two-spirals", "fivethirtyeight", 96, 0, False),
    ("lissajous", None, 120, 70, False),
    ("limit-cycle", "seaborn-v0_8-darkgrid", 100, 0, False),
    ("nyquist", None, 200, 0, True),
    ("bars-plain", None, 100, 0, False),
    ("bars-errorbars", "classic", 120, 80, False),
    ("bars-grouped", "ggplot", 100, 0, True),
    ("bars-grouped-negative", "seaborn-v0_8-whitegrid", 96, 0, True),
    ("bars-grouped-thin", None, 72, 70, True),
    ("bars-stacked", None, 100, 0, True),
    ("bars-stacked-538", "fivethirtyeight", 100, 85, True),
    ("hist-plain", None, 100, 0, False),
    ("hist-white-edges", "seaborn-v0_8-darkgrid", 120, 80, False),
    ("hist-black-edges", "grayscale", 150, 0, False),
    ("barh-plain", None, 100, 0, False),
    ("barh-grouped", "dark_background", 100, 0, True),
    ("bars-outlined-hatched", None, 150, 0, True),
    ("bars-hatched-colour", None, 100, 90, True),
    # l240-l247 (appended in round two): black-and-white hatched and outlined bars, bars told apart
    # only by their hatching, negative bars under a spine drawn at zero, hatched horizontal and
    # stacked bars, an outlined histogram, four coloured series with error caps.
    ("bars-bw-hatched", None, 120, 0, True),
    ("bars-bw-errorbars", "grayscale", 100, 85, True),
    ("bars-negative-spine", None, 100, 0, True),
    ("barh-hatched-negative", None, 150, 0, True),
    ("bars-same-face-hatch", "ggplot", 100, 0, True),
    ("bars-stacked-hatched", None, 120, 80, True),
    ("histogram-outlined", None, 100, 0, False),
    ("bars-grouped-errcaps", "seaborn-v0_8-whitegrid", 96, 0, True),
]


def simplify(p: np.ndarray, eps: float) -> np.ndarray:
    """Indices of a Douglas-Peucker simplification of polyline `p` at tolerance `eps` px."""
    keep = np.zeros(len(p), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(p) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        seg = p[b] - p[a]
        L = math.hypot(*seg)
        q = p[a + 1:b] - p[a]
        d = np.abs(q[:, 0] * seg[1] - q[:, 1] * seg[0]) / L if L > 1e-9 else np.hypot(q[:, 0], q[:, 1])
        k = int(np.argmax(d))
        if d[k] > eps:
            m = a + 1 + k
            keep[m] = True
            stack += [(a, m), (m, b)]
    return np.where(keep)[0]


def clean(rgb: np.ndarray, x: int, y: int, col: np.ndarray, bg: np.ndarray, radius: int) -> bool:
    """No ink of another colour within `radius` px (generate.py's `uncluttered`, any radius)."""
    d = col - bg
    for yy in range(y - radius, y + radius + 1):
        for xx in range(x - radius, x + radius + 1):
            v = rgb[yy, xx].astype(float) - bg
            if np.linalg.norm(v) < 30:
                continue
            a = float(v @ d / max(1e-9, d @ d))
            if np.linalg.norm(v - a * d) > max(12.0, 0.08 * float(np.linalg.norm(v))):
                return False
    return True


# ---------------------------------------------------------------- Track A: the curves

def path_series(xy, color, lw, tags, corners=None, closed=False, seed_at=0.5):
    xy = np.asarray(xy, float)
    if closed and not np.allclose(xy[0], xy[-1]):
        xy = np.vstack([xy, xy[:1]])
    return dict(kind="path", xy=xy, color=color, lw=lw, tags=list(tags) + (["closed"] if closed else []),
                corners=None if corners is None else np.asarray(corners, float), closed=closed, seed_at=seed_at)


def hysteresis(hmax, ms, hc, a, chi, n=1500, h0=0.0, m0=0.0):
    """A closed M-H loop: the ascending branch left to right, then the descending one back. The
    branches' difference is shifted to vanish at the tips, so they merge there (early for small a)."""
    h = np.linspace(-hmax, hmax, n)
    asc = ms * np.tanh((h - hc) / a) + chi * h
    gap = ms * (np.tanh((h + hc) / a) - np.tanh((h - hc) / a))
    desc = asc + (gap - gap[-1])
    x = np.concatenate([h, h[::-1][1:]]) + h0
    y = np.concatenate([asc, desc[::-1][1:]]) + m0
    tips = np.array([[hmax + h0, asc[-1] + m0], [-hmax + h0, asc[0] + m0]])
    return np.column_stack([x, y]), tips


def draw_paths(ax, rng, series):
    for z, s in enumerate(series):
        s["handle"], = ax.plot(s["xy"][:, 0], s["xy"][:, 1], color=s["color"], lw=s["lw"], zorder=3 + 0.1 * z,
                               solid_joinstyle=s.get("join", "round"), solid_capstyle="butt")


def cycle_colors(rng, n):
    cols = plt.rcParams["axes.prop_cycle"].by_key()["color"]
    order = rng.permutation(len(cols))
    return [cols[int(k)] for k in order[:n]]


def build_a(name, ax, rng):
    """Draws one Track A chart; returns (series, labels, extra chart tags)."""
    series, tags = [], []
    xlabel, ylabel = "x", "y"
    if name == "mh-merged":
        xy, tips = hysteresis(8.0, 1.0, 0.9, 0.9, 0.004)
        series.append(path_series(xy, "C0", 1.5, ["loop", "cusps", "merged-tips"], tips, True, 0.3))
        ax.axhline(0, color="#999999", lw=0.6, zorder=1)
        ax.axvline(0, color="#999999", lw=0.6, zorder=1)
        xlabel, ylabel = "H (kOe)", "M / Ms"
    elif name == "mh-nested":
        cols = cycle_colors(rng, 3)
        for k, (ms, hc, a) in enumerate([(1.0, 1.6, 1.3), (0.8, 1.0, 1.1), (0.55, 0.45, 0.9)]):
            xy, tips = hysteresis(6.0, ms, hc, a, 0.01)
            series.append(path_series(xy, cols[k], 1.2, ["loop", "cusps", "merged-tips", "crossing-loops"], tips, True, float(rng.uniform(0.15, 0.4))))
        ax.grid(True, color="#d0d0d0", lw=0.6)
        xlabel, ylabel = "Field (T)", "Magnetization (emu/g)"
    elif name == "pe-loops":
        cols = cycle_colors(rng, 2)
        t = np.linspace(0, 2 * math.pi, 1200)
        series.append(path_series(np.column_stack([60 * np.cos(t), 14 * np.sin(t + 0.9) + 0.12 * 60 * np.cos(t)]), cols[0], 1.6, ["loop", "smooth"], None, True, 0.2))
        xy, tips = hysteresis(60.0, 22.0, 18.0, 24.0, 0.05)
        series.append(path_series(xy, cols[1], 1.6, ["loop", "cusps"], tips, True, 0.3))
        xlabel, ylabel = "E (kV/cm)", "P (uC/cm2)"
    elif name == "stress-cycles":
        # Loading-unloading cycles to growing strains, one stroke: every reload leaves the previous
        # unloading curve at the zero-stress point and meets the envelope again at a new peak.
        env = lambda e: 420 * (1 - np.exp(-e / 0.9))  # noqa: E731
        peaks = [0.8, 1.6, 2.6, 3.8]
        resid = [0.0] + [0.28 * p for p in peaks]
        pts, corners = [], []
        for k, p in enumerate(peaks):
            u = np.linspace(0, 1, 300)
            e = resid[k] + (p - resid[k]) * u
            pts.append(np.column_stack([e, env(p) * u ** 0.62]))
            corners.append([p, env(p)])
            e2 = p + (resid[k + 1] - p) * u
            pts.append(np.column_stack([e2, env(p) * (1 - u) ** 1.9])[1:])
            corners.append([resid[k + 1], 0.0])
        xy = np.vstack(pts)
        series.append(path_series(xy, "k", 1.8, ["loop", "cusps", "multi-loop", "self-crossing"], corners[:-1], False, 0.12))
        series[-1]["join"] = "miter"
        xlabel, ylabel = "Strain (%)", "Stress (MPa)"
    elif name == "voltammogram":
        cols = cycle_colors(rng, 2)

        def wave(u):
            s = np.where(u < 0, 1.0, 2.6)
            return 0.7 * np.exp(-0.5 * (u / s) ** 2) + 0.3 / (1 + np.exp(-3 * u))

        e = np.linspace(-0.2, 0.6, 900)
        for k, (amp, closed) in enumerate([(1.0, True), (0.55, False)]):
            fwd = 3.0 * (e - 0.2) + 1.0 + 12 * amp * wave((e - 0.27) / 0.045)
            rev = 3.0 * (e - 0.2) - 1.0 - 10 * amp * wave(-(e - 0.19) / 0.045)
            rev = rev + (fwd[-1] - rev[-1]) * np.exp(-(e[-1] - e) / 0.035)
            if closed:
                fwd = fwd + (rev[0] - fwd[0]) * np.exp(-(e - e[0]) / 0.035)
            x = np.concatenate([e, e[::-1][1:]])
            y = np.concatenate([fwd, rev[::-1][1:]])
            corners = [[e[-1], fwd[-1]]] + ([[e[0], fwd[0]]] if closed else [])
            series.append(path_series(np.column_stack([x, y]), cols[k], 1.4, ["loop", "cusps"] + ([] if closed else ["open"]), corners, closed, 0.25))
        xlabel, ylabel = "E (V vs Ag/AgCl)", "i (uA)"
    elif name == "minor-loop":
        xy, tips = hysteresis(10.0, 1.0, 2.2, 1.6, 0.006)
        series.append(path_series(xy, "k", 1.6, ["loop", "cusps", "merged-tips", "same-colour", "own-colour-lines"], tips, True, 0.3))
        xy2, tips2 = hysteresis(2.6, 0.42, 0.9, 1.3, 0.006, h0=0.3, m0=0.04)
        series.append(path_series(xy2, "k", 1.6, ["loop", "cusps", "same-colour", "own-colour-lines"], tips2, True, 0.3))
        ax.axhline(0, color="k", lw=0.8, zorder=1)
        ax.axvline(0, color="k", lw=0.8, zorder=1)
        xlabel, ylabel = "H (kA/m)", "B (T)"
    elif name == "roc":
        cols = cycle_colors(rng, 2)
        for k, sep in enumerate([1.6, 0.8]):
            n = int(rng.integers(30, 55))
            score = np.concatenate([rng.normal(sep, 1, n), rng.normal(0, 1, n)])
            label = np.concatenate([np.ones(n), np.zeros(n)])
            order = np.argsort(-score)
            v = [(0.0, 0.0)]
            for lab in label[order]:
                x, y = v[-1]
                step = (x, y + 1 / n) if lab else (x + 1 / n, y)
                # Runs of one direction are one segment.
                if len(v) >= 2 and ((v[-2][0] == x and step[0] == x) or (v[-2][1] == y and step[1] == y)):
                    v[-1] = step
                else:
                    v.append(step)
            v = np.array(v)
            series.append(path_series(v, cols[k], 1.5, ["vertical", "roc", "steps"], v[1:-1], False, float(rng.uniform(0.35, 0.65))))
            series[-1]["join"] = "miter"
        ax.plot([0, 1], [0, 1], color="#808080", lw=0.9, ls="--", zorder=1)
        ax.set_xlim(-0.02, 1.02)
        ax.set_ylim(-0.02, 1.02)
        xlabel, ylabel = "False positive rate", "True positive rate"
    elif name == "depth-profile":
        cols = cycle_colors(rng, 2)
        d = np.linspace(0, 500, 1400)
        for k in range(2):
            ph = float(rng.uniform(0, 6))
            temp = 6 + 12 * np.exp(-d / (90 + 60 * k)) + (2.2 - 0.6 * k) * np.sin(2 * math.pi * d / (120 + 50 * k) + ph) * np.exp(-d / 420) + 1.5 * k
            series.append(path_series(np.column_stack([temp, d]), cols[k], 1.3, ["vertical", "profile"], None, False, float(rng.uniform(0.4, 0.7))))
        ax.invert_yaxis()
        ax.grid(True, color="#cccccc", lw=0.6, ls=":")
        xlabel, ylabel = "Temperature (C)", "Depth (m)"
    elif name == "s-curve":
        cols = cycle_colors(rng, 2)
        y = np.linspace(-2.1, 2.1, 1200)
        for k, a in enumerate([1.0, 0.45]):
            x = 0.9 * (y ** 3 - 3 * a * y) + 0.8 * k
            series.append(path_series(np.column_stack([x, y + 0.25 * k]), cols[k], 1.6, ["overhang", "s-curve"], None, False, 0.5))
        xlabel, ylabel = "Control parameter", "Response"
    elif name == "nose":
        cols = cycle_colors(rng, 2)
        temp = np.linspace(260, 700, 1200)
        for k in range(2):
            t = (4.0 * 10 ** k) * np.exp(900 / (temp - 180)) * np.exp(1500 / (760 - temp)) / 1e6
            series.append(path_series(np.column_stack([t, temp]), cols[k], 1.5, ["overhang", "nose", "log-x"], None, False, float(rng.uniform(0.3, 0.7))))
        ax.set_xscale("log")
        xlabel, ylabel = "Time (s)", "Temperature (C)"
    elif name == "isotherm":
        cols = cycle_colors(rng, 3)
        for k in range(3):
            x1 = 2.0 + 0.9 * k
            xa = np.linspace(0.8, x1, 300)
            xb = np.linspace(x1, 9.0, 500)
            ya = 9.0 / xa ** 0.7 + 1.2 * k
            drop = 1.6 + 0.5 * k
            yb = (ya[-1] - drop) * (x1 / xb) ** 0.55
            xy = np.vstack([np.column_stack([xa, ya]), np.column_stack([xb, yb])])
            series.append(path_series(xy, cols[k], 1.4, ["vertical", "drop"], [[x1, ya[-1]], [x1, yb[0]]], False, float(rng.uniform(0.5, 0.8))))
            series[-1]["join"] = "miter"
        xlabel, ylabel = "Volume (L)", "Pressure (bar)"
    elif name == "spiral":
        t = np.linspace(0, 2 * math.pi * 4.5, 3000)
        r = 2.0 * np.exp(-0.09 * t)
        series.append(path_series(np.column_stack([r * np.cos(t), -1.4 * r * np.sin(t)]), "C0", 1.3, ["spiral"], None, False, 0.2))
        ax.plot([0], [0], marker="o", ms=4, color="k", zorder=2)
        ax.axhline(0, color="#bbbbbb", lw=0.6, zorder=1)
        ax.axvline(0, color="#bbbbbb", lw=0.6, zorder=1)
        xlabel, ylabel = "x", "dx/dt"
    elif name == "two-spirals":
        cols = cycle_colors(rng, 2)
        t = np.linspace(0, 2 * math.pi * 3.2, 2400)
        for k in range(2):
            r = (0.25 + 0.28 * t) if k == 0 else 6.2 * np.exp(-0.16 * t)
            sgn = 1 if k == 0 else -1
            series.append(path_series(np.column_stack([r * np.cos(t + k), sgn * r * np.sin(t + k)]), cols[k], 2.2, ["spiral", "crossing-loops"], None, False, float(rng.uniform(0.5, 0.8))))
        xlabel, ylabel = "u", "v"
    elif name == "lissajous":
        cols = cycle_colors(rng, 2)
        t = np.linspace(0, 2 * math.pi, 2400)
        series.append(path_series(np.column_stack([np.sin(3 * t + math.pi / 2), np.sin(2 * t)]), cols[0], 1.3, ["parametric", "self-crossing"], None, True, 0.07))
        series.append(path_series(np.column_stack([0.45 * np.cos(t) + 0.1, 0.6 * np.sin(t) - 0.05]), cols[1], 1.3, ["parametric", "smooth", "crossing-loops"], None, True, 0.4))
        xlabel, ylabel = "Channel X (V)", "Channel Y (V)"
    elif name == "limit-cycle":
        cols = cycle_colors(rng, 3)
        th = np.linspace(0, 2 * math.pi, 1500)

        def cyc(th, r):
            return np.column_stack([r * (2.0 * np.cos(th) + 0.25 * np.cos(3 * th)), r * (2.6 * np.sin(th) - 0.5 * np.sin(3 * th))])

        series.append(path_series(cyc(th, 1.0), cols[0], 1.8, ["parametric", "smooth"], None, True, 0.3))
        # Two trajectories winding towards the cycle, from inside and from outside; they stop while
        # still clear of it (drawn further, they would hide it under their own ink).
        t = np.linspace(0, 2 * math.pi * 2.0, 2600)
        series.append(path_series(cyc(t + 0.6, 1 - 0.93 * np.exp(-0.22 * t)), cols[1], 1.1, ["spiral", "approaching"], None, False, 0.25))
        series.append(path_series(cyc(-t + 2.0, 1 + 0.75 * np.exp(-0.2 * t)), cols[2], 1.1, ["spiral", "approaching"], None, False, 0.12))
        xlabel, ylabel = "x", "y"
    elif name == "nyquist":
        cols = cycle_colors(rng, 2)
        w = np.logspace(5, -2.5, 2000)
        z = 5 + 40 / (1 + 1j * w * 2e-3) + (1j * w * 9.0 * 22) / (22 + 1j * w * 9.0) - 22
        series.append(path_series(np.column_stack([z.real, -z.imag]), cols[0], 0.8, ["overhang", "curl"], None, False, 0.3))
        t = np.linspace(0, 5.2, 2400)
        x = 30 + 14 * np.sin(1.3 * t + 0.4) + 7 * np.sin(2.9 * t + 1.0)
        y = 9 + 7 * np.cos(1.7 * t + 0.2) + 3.5 * np.cos(3.3 * t + 2.0)
        series.append(path_series(np.column_stack([x, y]), cols[1], 0.8, ["parametric", "self-crossing"], None, False, 0.1))
        ax.axhline(0, color="#999999", lw=0.5, zorder=1)
        xlabel, ylabel = "Re Z (ohm)", "-Im Z (ohm)"
    else:
        raise ValueError(name)
    draw_paths(ax, rng, series)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    return series, tags


# ---------------------------------------------------------------- Track B: the bars

def bar_series(pos, val, width, base, color, tags, horizontal=False, edge=None, elw=0.0, hatch=None, seed_on="fill", face=None):
    pos, val = np.asarray(pos, float), np.asarray(val, float)
    base = np.zeros(len(pos)) + np.asarray(base, float)
    return dict(kind="bars", pos=pos, val=val, base=base, width=float(width), color=color, tags=list(tags), horizontal=horizontal,
                edge=edge, elw=elw, hatch=hatch, seed_on=seed_on, face=color if face is None else face)


def draw_bars(ax, s, z=3.0, yerr=None, label=None):
    kw = dict(color=s["face"], edgecolor=s["edge"] if s["edge"] else "none", linewidth=s["elw"] if s["edge"] else 0.0, hatch=s["hatch"], zorder=z, label=label)
    ek = dict(ecolor="k", lw=1.0, capsize=3, capthick=1.0)
    if s["horizontal"]:
        return ax.barh(s["pos"], s["val"] - s["base"], height=s["width"], left=s["base"], xerr=yerr, error_kw=ek, **kw)
    return ax.bar(s["pos"], s["val"] - s["base"], width=s["width"], bottom=s["base"], yerr=yerr, error_kw=ek, **kw)


def build_b(name, ax, rng):
    series, tags, handles = [], [], []
    xlabel, ylabel = "", "Value"
    cats = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"]
    if name == "bars-plain":
        n = 8
        v = rng.uniform(8, 60, n)
        s = bar_series(np.arange(n), v, 0.7, 0, "C0", ["bars:plain", "bars:labels"])
        cont = draw_bars(ax, s)
        ax.bar_label(cont, fmt="%.1f", padding=2, fontsize=8)
        ax.set_xticks(np.arange(n), cats[:n])
        series.append(s)
        ylabel = "Yield (%)"
    elif name == "bars-errorbars":
        n = 6
        v = rng.uniform(1.5, 9, n)
        s = bar_series(np.arange(n), v, 0.6, 0, "#a6a6a6", ["bars:plain", "bars:errorbars", "bars:edged"], edge="k", elw=1.0)
        draw_bars(ax, s, yerr=rng.uniform(0.3, 1.2, n))
        ax.set_xticks(np.arange(n), ["ctrl", "0.1", "0.3", "1", "3", "10"])
        series.append(s)
        xlabel, ylabel = "Dose (mg/kg)", "Response (a.u.)"
    elif name in ("bars-grouped", "bars-grouped-negative", "bars-grouped-thin"):
        k_n, n = {"bars-grouped": (3, 5), "bars-grouped-negative": (2, 6), "bars-grouped-thin": (4, 12)}[name]
        cols = cycle_colors(rng, k_n)
        wd = 0.8 / k_n
        for k in range(k_n):
            if name == "bars-grouped-negative":
                v = rng.uniform(-14, 22, n)
                v[np.abs(v) < 2.5] += 5.0
            else:
                v = rng.uniform(5, 40, n)
            stags = ["bars:grouped"] + (["bars:negative", "bars:errorbars"] if name == "bars-grouped-negative" else []) + (["bars:thin"] if name == "bars-grouped-thin" else [])
            s = bar_series(np.arange(n) + (k - (k_n - 1) / 2) * wd, v, wd, 0, cols[k], stags)
            handles.append(draw_bars(ax, s, yerr=rng.uniform(1.0, 3.0, n) if name == "bars-grouped-negative" else None, label=f"group {k + 1}"))
            series.append(s)
        if name == "bars-grouped-negative":
            ax.axhline(0, color="k", lw=0.8, zorder=2)
        ax.set_xticks(np.arange(n), cats[:n])
        ylabel = "Change (%)" if name == "bars-grouped-negative" else "Count"
    elif name in ("bars-stacked", "bars-stacked-538"):
        k_n, n = (3, 6) if name == "bars-stacked" else (4, 7)
        cols = cycle_colors(rng, k_n)
        raw = rng.uniform(4, 30, (k_n, n))
        if name == "bars-stacked-538":
            raw = 100 * raw / raw.sum(0)
        base = np.zeros(n)
        for k in range(k_n):
            s = bar_series(np.arange(n), base + raw[k], 0.72, base.copy(), cols[k], ["bars:stacked"] + (["bars:edged"] if name == "bars-stacked" else []),
                           edge="white" if name == "bars-stacked" else None, elw=0.6)
            handles.append(draw_bars(ax, s, label=f"part {k + 1}"))
            series.append(s)
            base = base + raw[k]
        ax.set_xticks(np.arange(n), [str(2015 + j) for j in range(n)])
        ylabel = "Share (%)" if name == "bars-stacked-538" else "Energy (TWh)"
    elif name.startswith("hist-"):
        bins = {"hist-plain": 25, "hist-white-edges": 15, "hist-black-edges": 30}[name]
        data = np.concatenate([rng.normal(52, 9, 260), rng.normal(78, 6, 120)]) if name != "hist-black-edges" else rng.gamma(2.2, 9.0, 300)
        counts, edges = np.histogram(data, bins=bins)
        wd = float(edges[1] - edges[0])
        keep = counts > 0
        col, edge, elw = {"hist-plain": ("C0", None, 0.0), "hist-white-edges": ("C0", "white", 1.0), "hist-black-edges": ("#b3b3b3", "k", 0.8)}[name]
        col = cycle_colors(rng, 1)[0] if col == "C0" else col
        s = bar_series((edges[:-1] + wd / 2)[keep], counts[keep].astype(float), wd, 0, col, ["histogram"] + (["bars:edged"] if edge else ["bars:touching"]), edge=edge, elw=elw)
        if edge:
            draw_bars(ax, s)
        else:
            # Touching bars without edges are one filled outline (as snapped bars or a "stepfilled"
            # histogram look): separate rectangles would leave anti-aliasing seams between them.
            ax.stairs(counts, edges, fill=True, color=col, zorder=3.0)
        series.append(s)
        if name == "hist-plain":
            # A fitted density over the bars, in another colour: it crosses their tops.
            xs = np.linspace(edges[0], edges[-1], 400)
            dens = (260 * np.exp(-0.5 * ((xs - 52) / 9) ** 2) / 9 + 120 * np.exp(-0.5 * ((xs - 78) / 6) ** 2) / 6) / math.sqrt(2 * math.pi) * wd
            ax.plot(xs, dens, color="C3", lw=1.6, zorder=4)
        if name == "hist-white-edges":
            ax.axvline(float(np.mean(data)), color="k", lw=1.0, ls="--", zorder=4)
        xlabel, ylabel = "Measurement", "Frequency"
    elif name == "barh-plain":
        n = 7
        v = rng.uniform(12, 95, n)
        s = bar_series(np.arange(n), v, 0.65, 0, "C2", ["bars:horizontal", "bars:plain", "bars:labels"], horizontal=True)
        cont = draw_bars(ax, s)
        ax.bar_label(cont, fmt="%.0f", padding=3, fontsize=8)
        ax.set_yticks(np.arange(n), ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"])
        series.append(s)
        xlabel, ylabel = "Score", ""
    elif name == "barh-grouped":
        k_n, n = 2, 6
        cols = cycle_colors(rng, k_n)
        wd = 0.8 / k_n
        for k in range(k_n):
            s = bar_series(np.arange(n) + (k - (k_n - 1) / 2) * wd, rng.uniform(10, 80, n), wd, 0, cols[k], ["bars:horizontal", "bars:grouped"], horizontal=True)
            handles.append(draw_bars(ax, s, label=f"run {k + 1}"))
            series.append(s)
        ax.set_yticks(np.arange(n), [f"task {j + 1}" for j in range(n)])
        xlabel, ylabel = "Time (ms)", ""
    elif name == "bars-outlined-hatched":
        n = 5
        wd = 0.8 / 3
        looks = [("white", None, "outline", ["bars:outlined"]), ("white", "////", "hatch", ["bars:hatched", "fill:hatch-only"]), ("#8c8c8c", None, "fill", ["bars:edged"])]
        for k, (face, hatch, seed_on, extra) in enumerate(looks):
            s = bar_series(np.arange(n) + (k - 1) * wd, rng.uniform(6, 30, n), wd, 0, "k" if face == "white" else face, ["bars:grouped", "same-colour"] + extra,
                           edge="k", elw=0.9, hatch=hatch, seed_on=seed_on, face=face)
            handles.append(draw_bars(ax, s, label=["control", "treated", "recovered"][k]))
            series.append(s)
        ax.set_xticks(np.arange(n), [f"day {3 * j}" for j in range(n)])
        ylabel = "Cell count (x1000)"
    elif name == "bars-hatched-colour":
        n = 6
        cols = cycle_colors(rng, 2)
        wd = 0.4
        for k in range(2):
            v = rng.uniform(-9, 20, n)
            v[np.abs(v) < 2.0] += 4.0
            s = bar_series(np.arange(n) + (k - 0.5) * wd, v, wd, 0, cols[k], ["bars:grouped", "bars:hatched", "bars:negative", "bars:errorbars", "bars:edged"],
                           edge="k", elw=0.7, hatch=["xx", ".."][k])
            handles.append(draw_bars(ax, s, yerr=rng.uniform(0.8, 2.0, n), label=["before", "after"][k]))
            series.append(s)
        ax.axhline(0, color="k", lw=0.8, zorder=2)
        ax.set_xticks(np.arange(n), cats[:n])
        ylabel = "Difference"
    elif name == "bars-bw-hatched":
        # Publication black and white: four series told apart only by their hatching.
        n, k_n = 5, 4
        wd = 0.8 / k_n
        for k, hatch in enumerate(["//", "\\\\", "xx", ".."]):
            s = bar_series(np.arange(n) + (k - (k_n - 1) / 2) * wd, rng.uniform(5, 40, n), wd, 0, "k", ["bars:grouped", "bars:hatched", "fill:hatch-only", "same-colour"],
                           edge="k", elw=0.8, hatch=hatch, seed_on="hatch", face="white")
            handles.append(draw_bars(ax, s, label=f"strain {k + 1}"))
            series.append(s)
        ax.set_xticks(np.arange(n), ["WT", "KO1", "KO2", "KO3", "KO4"])
        ylabel = "Expression (a.u.)"
    elif name == "bars-bw-errorbars":
        # Outlined, hatched and solid black bars of one colour, with error caps and negative values.
        n = 5
        wd = 0.8 / 3
        looks = [("white", None, "outline", ["bars:outlined"]), ("white", "///", "hatch", ["bars:hatched", "fill:hatch-only"]), ("k", None, "fill", [])]
        for k, (face, hatch, seed_on, extra) in enumerate(looks):
            v = rng.uniform(-8, 25, n)
            v[np.abs(v) < 2.5] += 5.0
            s = bar_series(np.arange(n) + (k - 1) * wd, v, wd, 0, "k", ["bars:grouped", "same-colour", "bars:negative", "bars:errorbars"] + extra,
                           edge="k", elw=0.9, hatch=hatch, seed_on=seed_on, face=face)
            handles.append(draw_bars(ax, s, yerr=rng.uniform(0.8, 2.5, n), label=["sham", "low", "high"][k]))
            series.append(s)
        ax.axhline(0, color="k", lw=0.8, zorder=2)
        ax.set_xticks(np.arange(n), [f"wk {j + 1}" for j in range(n)])
        ylabel = "Change from baseline (%)"
    elif name == "bars-negative-spine":
        # The bottom spine drawn at zero: bars hang below the axis line, category labels at the bottom.
        n, k_n = 7, 2
        cols = cycle_colors(rng, k_n)
        wd = 0.38
        for k in range(k_n):
            v = rng.uniform(-20, 30, n)
            v[np.abs(v) < 3.0] -= 6.0
            s = bar_series(np.arange(n) + (k - 0.5) * wd, v, wd, 0, cols[k], ["bars:grouped", "bars:negative", "bars:zero-spine"])
            handles.append(draw_bars(ax, s, label=["2023", "2024"][k]))
            series.append(s)
        ax.spines["bottom"].set_position(("data", 0))
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
        ax.tick_params(axis="x", which="both", length=0, labelbottom=False)
        ax.set_xticks(np.arange(n))
        for j in range(n):
            ax.annotate(cats[j], (j, 0), xycoords=("data", "axes fraction"), xytext=(0, -12), textcoords="offset points", ha="center", fontsize=9)
        ylabel = "Net flow (%)"
    elif name == "barh-hatched-negative":
        n = 6
        wd = 0.38
        looks = [("white", "\\\\", "hatch", ["bars:hatched", "fill:hatch-only"]), ("white", None, "outline", ["bars:outlined"])]
        for k, (face, hatch, seed_on, extra) in enumerate(looks):
            v = rng.uniform(-15, 30, n)
            v[np.abs(v) < 2.5] += 5.0
            s = bar_series(np.arange(n) + (k - 0.5) * wd, v, wd, 0, "k", ["bars:horizontal", "bars:grouped", "bars:negative", "same-colour"] + extra,
                           horizontal=True, edge="k", elw=0.8, hatch=hatch, seed_on=seed_on, face=face)
            handles.append(draw_bars(ax, s, label=["men", "women"][k]))
            series.append(s)
        ax.axvline(0, color="k", lw=0.8, zorder=2)
        ax.set_yticks(np.arange(n), ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"])
        xlabel, ylabel = "Change (pp)", ""
    elif name == "bars-same-face-hatch":
        # One fill colour for every series: plain, diagonal and cross hatching tell them apart.
        n, k_n = 5, 3
        face = cycle_colors(rng, 1)[0]
        wd = 0.8 / k_n
        for k, hatch in enumerate([None, "//", "xx"]):
            s = bar_series(np.arange(n) + (k - 1) * wd, rng.uniform(5, 40, n), wd, 0, face, ["bars:grouped", "bars:same-face"] + (["bars:hatched"] if hatch else []),
                           edge="k", elw=0.6, hatch=hatch)
            handles.append(draw_bars(ax, s, label=["A", "B", "C"][k]))
            series.append(s)
        ax.set_xticks(np.arange(n), [f"site {j + 1}" for j in range(n)])
        ylabel = "Cover (%)"
    elif name == "bars-stacked-hatched":
        # A black-and-white stack: an outlined layer, a hatched one and a cross-ruled one.
        n, k_n = 6, 3
        raw = rng.uniform(4, 20, (k_n, n))
        base = np.zeros(n)
        looks = [(None, "outline", ["bars:outlined"]), ("//", "hatch", ["bars:hatched", "fill:hatch-only"]), ("++", "hatch", ["bars:hatched", "fill:hatch-only", "hatch:ruled"])]
        for k, (hatch, seed_on, extra) in enumerate(looks):
            s = bar_series(np.arange(n), base + raw[k], 0.6, base.copy(), "k", ["bars:stacked", "same-colour"] + extra, edge="k", elw=0.8, hatch=hatch, seed_on=seed_on, face="white")
            handles.append(draw_bars(ax, s, label=["fixed", "variable", "other"][k]))
            series.append(s)
            base = base + raw[k]
        ax.set_xticks(np.arange(n), [str(2018 + j) for j in range(n)])
        ylabel = "Cost (k$)"
    elif name == "histogram-outlined":
        data = rng.normal(40, 10, 400)
        counts, edges = np.histogram(data, bins=18)
        wd = float(edges[1] - edges[0])
        keep = counts > 0
        s = bar_series((edges[:-1] + wd / 2)[keep], counts[keep].astype(float), wd, 0, "k", ["histogram", "bars:outlined"], edge="k", elw=0.8, seed_on="outline", face="white")
        draw_bars(ax, s)
        series.append(s)
        xlabel, ylabel = "Age (years)", "Patients"
    elif name == "bars-grouped-errcaps":
        n, k_n = 5, 4
        cols = cycle_colors(rng, k_n)
        wd = 0.8 / k_n
        for k in range(k_n):
            v = rng.uniform(-10, 30, n)
            v[np.abs(v) < 3.0] += 6.0
            s = bar_series(np.arange(n) + (k - (k_n - 1) / 2) * wd, v, wd, 0, cols[k], ["bars:grouped", "bars:negative", "bars:errorbars", "bars:four"])
            handles.append(draw_bars(ax, s, yerr=rng.uniform(1.0, 4.0, n), label=f"dose {k + 1}"))
            series.append(s)
        ax.axhline(0, color="k", lw=0.8, zorder=2)
        ax.set_xticks(np.arange(n), cats[:n])
        ylabel = "Response (%)"
    else:
        raise ValueError(name)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    return series, tags


# ---------------------------------------------------------------- seeds

def seed_path(s, others, rgb, bg, legend_box, W, H):
    col = np.array(to_rgb(s["color"])) * 255
    dense = resample_poly(s["path"], 1.0)
    arc = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(dense, axis=0).T))])
    total = arc[-1]
    cand = np.arange(0, len(dense), 2)
    pts = dense[cand]
    clear = np.full(len(pts), 1e9)
    for o in others:
        if o["kind"] == "path":
            clear = np.minimum(clear, seg_dist(pts, o["path"]) - o["lw_px"] / 2)
    # The series' own other branches: everything more than `sep` px away along the path.
    sep = 6 * s["lw_px"] + 10
    own = np.full(len(pts), 1e9)
    for a in range(0, len(pts), 400):
        chunk = pts[a:a + 400]
        d = np.hypot(chunk[:, None, 0] - dense[None, :, 0], chunk[:, None, 1] - dense[None, :, 1])
        along = np.abs(arc[cand[a:a + 400]][:, None] - arc[None, :])
        if s["closed"]:
            along = np.minimum(along, total - along)
        d[along <= sep] = 1e9
        own[a:a + 400] = d.min(1)
    clear = np.minimum(clear, own - s["lw_px"])
    if legend_box:
        x0, y0, x1, y1 = legend_box
        inside = (pts[:, 0] >= x0 - 6) & (pts[:, 0] <= x1 + 6) & (pts[:, 1] >= y0 - 6) & (pts[:, 1] <= y1 + 6)
        clear[inside] = -1e9
    frac = arc[cand] / max(1e-9, total)
    score = np.minimum(clear, 12.0) - 8.0 * np.abs(frac - s["seed_at"])
    for idx in np.argsort(-score):
        x, y = int(round(pts[idx, 0])), int(round(pts[idx, 1]))
        if not (3 <= x < W - 3 and 3 <= y < H - 3):
            continue
        if coverage_at(rgb, x, y, col, bg) >= 0.6 and clean(rgb, x, y, col, bg, 3):
            return [x, y]
    raise RuntimeError("no visible seed for a path series")


def seed_bars(s, rgb, bg, rng, W, H):
    """A click on one of the series' middle bars: on its fill, its outline, or a hatch line."""
    col = np.array(to_rgb(s["color"])) * 255
    order = np.argsort(np.abs(np.arange(len(s["rects"])) - (len(s["rects"]) - 1) / 2 + rng.uniform(-0.6, 0.6)))
    edge = s["elw_px"] if s["edge"] else 0.0
    for radius in (3, 1, 0):
        for k in order:
            x0, y0, x1, y1 = s["rects"][k]
            if s["seed_on"] == "outline":
                ys = np.arange(math.ceil(y0 + 4), math.floor(y1 - 4) + 1)
                cands = [(x0, y) for y in ys] + [(x1, y) for y in ys]
                need = 0.6
            else:
                inset = max(2.0, edge + 1.5) if s["seed_on"] == "fill" else edge + 3.0
                xs = np.arange(math.ceil(x0 + inset), math.floor(x1 - inset) + 1)
                ys = np.arange(math.ceil(y0 + inset), math.floor(y1 - inset) + 1)
                cands = [(x, y) for x in xs for y in ys]
                need = 0.9 if s["seed_on"] == "fill" else 0.6
            if not cands:
                continue
            for j in rng.permutation(len(cands)):
                x, y = int(round(cands[j][0])), int(round(cands[j][1]))
                if not (3 <= x < W - 3 and 3 <= y < H - 3):
                    continue
                if coverage_at(rgb, x, y, col, bg) >= need and clean(rgb, x, y, col, bg, radius):
                    return [x, y]
    raise RuntimeError("no visible seed for a bar series")


# ---------------------------------------------------------------- one chart

def build_kind(i: int):
    name, style, dpi, jpeg_q, legend = SPECS[NUMBERS.index(i)]
    rng = np.random.default_rng(5000 + i)
    w_in = float(rng.uniform(5.0, 7.0))
    h_in = float(w_in * rng.uniform(0.62, 0.8))
    if w_in * dpi > 1100:
        w_in, h_in = 1100 / dpi, 1100 / dpi * h_in / w_in
    font = str(FONTS[int(rng.integers(0, len(FONTS)))])
    track_b = name.startswith(("bars", "hist", "barh"))
    with plt.style.context(style if style else "default"):
        with plt.rc_context({"path.snap": False, "font.family": font, "font.size": float(rng.uniform(8.5, 11))}):
            fig, ax = plt.subplots(figsize=(w_in, h_in), dpi=dpi)
            series, tags = (build_b if track_b else build_a)(name, ax, rng)
            leg = None
            if legend:
                if name == "bars-stacked-538":
                    leg = ax.legend(loc="center left", bbox_to_anchor=(1.0, 0.5))  # beside a 100 % chart
                elif track_b:
                    # Headroom beyond the longest bar for a one-row legend, as such charts are laid out.
                    lim = ax.get_xlim() if series[0]["horizontal"] else ax.get_ylim()
                    (ax.set_xlim if series[0]["horizontal"] else ax.set_ylim)(lim[0], lim[1] + 0.22 * (lim[1] - lim[0]))
                    leg = ax.legend(loc="upper right" if series[0]["horizontal"] else "upper center", ncol=1 if series[0]["horizontal"] else len(series), fontsize="small")
                else:
                    leg = ax.legend([s["handle"] for s in series], [f"series {k + 1}" for k in range(len(series))], loc="best")
            fig.tight_layout()
            fig.canvas.draw()
            W, H = fig.canvas.get_width_height()
            rgba = np.asarray(fig.canvas.buffer_rgba()).copy()
            box = px_of(ax.transAxes.transform([(0, 1), (1, 1), (1, 0), (0, 0)]), H)
            bg = np.array(to_rgb(ax.get_facecolor())) * 255
            grid = any(g.get_visible() for g in ax.get_xgridlines() + ax.get_ygridlines())
            legend_box = None
            if leg is not None:
                bb = leg.get_window_extent()
                p = px_of(np.array([[bb.x0, bb.y1], [bb.x1, bb.y0]]), H)
                legend_box = [float(p[0, 0]), float(p[0, 1]), float(p[1, 0]), float(p[1, 1])]
            for s in series:
                s["color"] = to_rgb(s["color"])
                if s["kind"] == "path":
                    full = px_of(ax.transData.transform(s["xy"]), H)
                    keep = simplify(full, 0.03)
                    s["path"] = full[keep]
                    s["data"] = s["xy"][keep]
                    s["lw_px"] = s["lw"] * dpi / 72
                    s["corners_px"] = px_of(ax.transData.transform(s["corners"]), H) if s["corners"] is not None and len(s["corners"]) else None
                else:
                    hz = s["horizontal"]
                    ends = np.column_stack([s["val"], s["pos"]]) if hz else np.column_stack([s["pos"], s["val"]])
                    s["ends_px"] = px_of(ax.transData.transform(ends), H)
                    lo, hi = s["pos"] - s["width"] / 2, s["pos"] + s["width"] / 2
                    a = np.column_stack([s["base"], lo]) if hz else np.column_stack([lo, s["base"]])
                    b = np.column_stack([s["val"], hi]) if hz else np.column_stack([hi, s["val"]])
                    pa, pb = px_of(ax.transData.transform(a), H), px_of(ax.transData.transform(b), H)
                    s["rects"] = [(min(p[0], q[0]), min(p[1], q[1]), max(p[0], q[0]), max(p[1], q[1])) for p, q in zip(pa, pb)]
                    s["width_px"] = float(np.mean([(r[3] - r[1]) if hz else (r[2] - r[0]) for r in s["rects"]]))
                    s["elw_px"] = s["elw"] * dpi / 72
            plt.close(fig)

    rgb = rgba[:, :, :3]
    out_series = []
    for k, s in enumerate(series):
        c255 = [round(255 * c) for c in s["color"]]
        spread = max(c255) - min(c255)
        ctag = "color:colour" if spread >= 60 else "color:black" if max(c255) < 80 else "color:light" if min(c255) > 200 else "color:grey"
        if s["kind"] == "path":
            seed = seed_path(s, [o for j, o in enumerate(series) if j != k], rgb, bg, legend_box, W, H)
            entry = {
                "id": f"s{k}",
                "kind": "line",
                "tags": ["series:path"] + s["tags"] + ["style:solid", "lw:thin" if s["lw_px"] < 1.5 else "lw:thick", ctag],
                "color": c255,
                "style": "solid",
                "marker": None,
                "lineWidthPx": round(s["lw_px"], 3),
                "markerSizePx": 0.0,
                "seed": seed,
                "data": [[round(float(x), 6), round(float(y), 6)] for x, y in s["data"]],
                "pixels": [[round(float(x), 3), round(float(y), 3)] for x, y in s["path"]],
            }
            entry["path"] = entry["pixels"]
            if s["corners_px"] is not None:
                entry["corners"] = [[round(float(x), 3), round(float(y), 3)] for x, y in s["corners_px"]]
        else:
            seed = seed_bars(s, rgb, bg, rng, W, H)
            entry = {
                "id": f"s{k}",
                "kind": "bars",
                "tags": ["series:bars"] + s["tags"] + [ctag],
                "color": c255,
                "style": "none",
                "marker": None,
                "lineWidthPx": round(s["elw_px"], 3),
                "markerSizePx": 0.0,
                "barWidthPx": round(s["width_px"], 3),
                "orientation": "horizontal" if s["horizontal"] else "vertical",
                "seed": seed,
                "data": [[round(float(x), 6), round(float(y), 6)] for x, y in zip(s["pos"], s["val"])],
                "pixels": [[round(float(x), 3), round(float(y), 3)] for x, y in s["ends_px"]],
            }
            entry["markers"] = entry["pixels"]
        out_series.append(entry)

    tags = ["scenario:bars" if track_b else "scenario:paths", f"chart:{name}", f"theme:{style or 'default'}", "grid" if grid else "no-grid",
            "jpeg" if jpeg_q else "png", "dpi:low" if dpi <= 96 else "dpi:mid" if dpi <= 150 else "dpi:high"] + tags
    if legend:
        tags.append("legend")
    doc = {
        "image": f"l{i}.{'jpg' if jpeg_q else 'png'}",
        "width": W,
        "height": H,
        "description": (f"Synthetic {'bar' if track_b else 'path'} chart ({name}), {len(series)} series, style {style or 'default'}, dpi {dpi}, font {font}"
                        + (f", JPEG q{jpeg_q}" if jpeg_q else "") + ". Generated by bench/lines/generate_kinds.py."),
        "tags": tags,
        "plotBox": [[round(float(c), 3) for c in p] for p in box],
        "legendBox": [round(v, 3) for v in legend_box] if legend_box else None,
        "series": out_series,
    }
    return Image.fromarray(rgb), doc, jpeg_q


def write_all() -> int:
    """Writes l200-l247 (only these files are touched)."""
    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    traces = 0
    for i in NUMBERS:
        for old in OUT.glob(f"l{i}.*"):
            old.unlink()
        img, doc, q = build_kind(i)
        if q:
            img.save(OUT / doc["image"], quality=q)
        else:
            img.save(OUT / doc["image"], optimize=True)
        (OUT / f"l{i}.json").write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
        total += (OUT / doc["image"]).stat().st_size
        traces += len(doc["series"])
        print(f"{doc['image']:9s} {img.width:5d}x{img.height:<5d} {' '.join(doc['tags'])} | {len(doc['series'])} series")
    print(f"{KINDS_COUNT} charts (new kinds), {traces} series, {total / 1e6:.2f} MB of images")
    return 0


if __name__ == "__main__":
    sys.exit(write_all())
