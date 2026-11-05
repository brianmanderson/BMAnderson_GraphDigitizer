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
third chart, q35-90) vary on top.

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
from PIL import Image  # noqa: E402

OUT = Path(__file__).resolve().parent / "synthetic"
COUNT = 60

FONTS = ["DejaVu Sans", "DejaVu Serif", "Arial", "Times New Roman", "Calibri", "Verdana", "Segoe UI"]
DPIS = [72, 96, 100, 120, 150, 200]
SCENARIOS = ["curves", "line-markers", "dashed", "step", "scatter", "black", "mixed", "dense"]
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
    scenario = SCENARIOS[i % len(SCENARIOS)]
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
        series = []
        for k, (kind, style, marker, color) in enumerate(specs):
            lw = float(rng.uniform(0.8, 2.5))
            ms = float(rng.uniform(4, 8))
            ls = "-" if style == "solid" else STYLES.get(style, "-")
            cens = []
            if kind == "line" and marker is None:
                xs = np.linspace(xlo, xhi, 300)
                ys = smooth_curve(rng, xs, ylo, yhi)
                ax.plot(xs, ys, color=color, lw=lw, ls=ls, zorder=2 + k)
                verts = np.column_stack([xs, ys])
            elif kind == "line":
                n = int(rng.integers(8, 20))
                xs = np.sort(rng.uniform(xlo, xhi, n))
                xs[0], xs[-1] = xlo + 0.03 * (xhi - xlo), xhi - 0.03 * (xhi - xlo)
                ys = smooth_curve(rng, xs, ylo, yhi) + rng.normal(0, 0.05 * (yhi - ylo), n)
                ax.plot(xs, ys, color=color, lw=lw, ls=ls, marker=marker, ms=ms, zorder=2 + k)
                verts = np.column_stack([xs, ys])
            elif kind == "step":
                xs, ys, cens = km_curve(rng, xhi)
                ax.plot(xs, ys, color=color, lw=lw, drawstyle="steps-post", zorder=2 + k)
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
                               xs=np.asarray(xs), ys=np.asarray(ys), cens=cens, seed_at=float(rng.uniform(0.25, 0.75))))
        allv = np.vstack([s["verts"] for s in series])
        pad_y = 0.06 * (allv[:, 1].max() - allv[:, 1].min() + 1e-9)
        ax.set_xlim(xlo - 0.02 * (xhi - xlo), xhi + 0.02 * (xhi - xlo))
        ax.set_ylim(allv[:, 1].min() - pad_y, allv[:, 1].max() + pad_y)
        if grid:
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
        plt.close(fig)

    rgb = rgba[:, :, :3]
    bg = np.array([255.0, 255.0, 255.0])
    for k, s in enumerate(series):
        others = [o for j, o in enumerate(series) if j != k]
        s["crossing"] = s["kind"] != "scatter" and any(o["kind"] != "scatter" and crosses(s["path"], o["path"]) for o in others)
        s["seed"] = pick_seed(s, others, rgb, bg, legend_box, W, H)

    tags = [f"scenario:{scenario}", "grid" if grid else "no-grid", f"frame:{frame}", "jpeg" if jpeg_q else "png",
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
            if s["kind"] == "step":
                entry["corners"] = entry["path"][1:-1]
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


def pick_seed(s, others, rgb, bg, legend_box, W, H):
    col = np.array(to_rgb(s["color"])) * 255
    if s["kind"] == "scatter":
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
    if s["kind"] == "scatter" and len(cands) > 1:  # isolated from its own markers too
        d_own = np.hypot(cands[:, None, 0] - cands[None, :, 0], cands[:, None, 1] - cands[None, :, 1])
        np.fill_diagonal(d_own, 1e9)
        clear = np.minimum(clear, d_own.min(1) - s["ms_px"])
    if legend_box:
        x0, y0, x1, y1 = legend_box
        inside = (cands[:, 0] >= x0 - 6) & (cands[:, 0] <= x1 + 6) & (cands[:, 1] >= y0 - 6) & (cands[:, 1] <= y1 + 6)
        clear[inside] = -1e9
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
        img, doc, q = build(i)
        name = doc["image"]
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
