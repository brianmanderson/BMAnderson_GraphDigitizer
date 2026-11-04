"""
Generates the synthetic axis-detection corpus in bench/axes/synthetic/: ~60 matplotlib charts
with exact ground truth (axis lines, plot box, every tick's pixel position, value and label).
Run offline and commit the output; the benchmark itself never needs Python:

    npm run bench:axes:corpus     (= python bench/axes/generate.py; Python 3.12, matplotlib 3.10,
                                   numpy, Pillow)

Everything is seeded per chart, so a rerun reproduces the same files (given the same
matplotlib/font versions). Do not edit the output by hand and do not change a chart because the
detector gets it wrong: the corpus measures the detector, not the other way round.

Coordinates are image pixels in the app's convention: integer = pixel centre, origin top-left,
y down (docs/SPEC.md -> Pixel convention). Matplotlib display coordinates have their origin at
the bottom-left *corner* of the figure, so a display point (xd, yd) is pixel
(xd - 0.5, H - yd - 0.5).

Pixel snapping is turned off (`path.snap: False`): Agg would otherwise move straight lines and
ticks by up to 1 px onto the pixel grid, and the recorded transform positions would be wrong by
that much. Instead, about half the charts ("crisp") have their axes box moved so the spines sit
exactly on pixel centres with an odd whole-pixel width, giving the hard 1-px lines of a typical
screenshot; the rest have fractional positions and antialiased lines. A self-check at the end
measures every drawn axis line in the rendered image and fails the run if the median offset from
its ground truth exceeds 0.35 px.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

OUT = Path(__file__).resolve().parent / "synthetic"
COUNT = 60

FONTS = [
    "DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono", "Arial", "Times New Roman",
    "Courier New", "Calibri", "Verdana", "Georgia", "Tahoma", "Segoe UI", "Cambria",
]
DPIS = [72, 96, 100, 120, 150, 200]
# (x scale, y scale), cycled so every combination is well represented.
SCALES = [
    ("linear", "linear"), ("linear", "log10"), ("date", "linear"), ("linear", "linear"),
    ("log10", "log10"), ("date", "log10"), ("log10", "linear"), ("linear", "linear"),
]
OFFSET_AXES = {5, 17, 29, 41, 53}      # spines through data zero, not at the plot edge
GGPLOT = {11, 35, 59}                  # grey panel, white grid, no axis lines at all
NO_X_TICKMARKS = {6, 19, 32, 45, 58}   # x tick labels without tick marks (like the KM figure)


@dataclass
class Chart:
    name: str
    tags: list[str] = field(default_factory=list)


def px_of(display: np.ndarray, height: int) -> np.ndarray:
    """Matplotlib display coords (origin bottom-left corner) -> image pixel centres."""
    d = np.atleast_2d(display).astype(float)
    return np.column_stack([d[:, 0] - 0.5, height - d[:, 1] - 0.5])


def iso(num: float) -> str:
    d = mdates.num2date(num).astimezone(dt.timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def make_data(rng: np.random.Generator, scale: str, n: int):
    if scale == "log10":
        lo = rng.uniform(-3, 1)
        hi = lo + rng.uniform(1.5, 4.5)
        return np.sort(10 ** rng.uniform(lo, hi, n)), (10**lo, 10**hi)
    if scale == "date":
        start = dt.datetime(int(rng.integers(1995, 2024)), int(rng.integers(1, 13)), 1)
        span_days = float(rng.choice([20, 75, 200, 400, 900, 2500]))
        offs = np.sort(rng.uniform(0, span_days, n))
        vals = [start + dt.timedelta(days=float(o)) for o in offs]
        return np.array(mdates.date2num(vals)), (mdates.date2num(start),
                                                 mdates.date2num(start + dt.timedelta(days=span_days)))
    lo = float(rng.choice([0, 0, -5, 10, 100, -50])) * float(rng.choice([1, 0.01, 1000]))
    hi = lo + float(rng.choice([1, 8, 10, 45, 100, 250])) * float(rng.choice([1, 0.01, 1000]))
    return np.sort(rng.uniform(lo, hi, n)), (lo, hi)


def build(i: int) -> tuple[Image.Image, dict, int]:
    rng = np.random.default_rng(1000 + i)
    chart = Chart(name=f"c{i:02d}")
    offset = i in OFFSET_AXES
    ggplot = i in GGPLOT
    xscale, yscale = ("linear", "linear") if offset else SCALES[i % len(SCALES)]
    kind = ["line", "scatter", "bar"][int(rng.integers(0, 3))]
    if kind == "bar" and (yscale != "linear" or xscale == "log10"):
        kind = "line"
    frame = "offset" if offset else "ggplot" if ggplot else ("box" if rng.random() < 0.55 else "L")
    grid = ggplot or rng.random() < 0.4
    tickdir = "out" if ggplot else str(rng.choice(["out"] * 7 + ["in"] * 2 + ["inout"] * 2))
    mirror = frame == "box" and rng.random() < 0.15
    minor = xscale == "linear" and yscale == "linear" and rng.random() < 0.3
    dpi = int(DPIS[i % len(DPIS)] if rng.random() < 0.7 else rng.choice(DPIS))
    w_in = float(rng.uniform(4.0, 7.5))
    h_in = float(w_in * rng.uniform(0.55, 0.85))
    if w_in * dpi > 1200:
        w_in, h_in = 1200 / dpi, 1200 / dpi * h_in / w_in
    font = str(FONTS[int(rng.integers(0, len(FONTS)))])
    fontsize = float(rng.uniform(7, 13))
    spine_lw = float(rng.choice([0.5, 0.8, 0.8, 1.0, 1.25, 1.5, 2.0]))
    tick_len = float(rng.uniform(2.5, 7))
    tick_w = float(min(spine_lw, rng.choice([0.5, 0.8, 1.0, 1.5])))
    axis_color = "#000000" if rng.random() < 0.8 else str(rng.choice(["#333333", "#555555", "#262626"]))
    rotation = float(rng.choice([-1, 1]) * rng.uniform(0.5, 3.0)) if i % 5 == 2 else 0.0
    jpeg_q = int(rng.integers(30, 91)) if i % 3 == 1 else 0
    crisp = not ggplot and rng.random() < 0.5
    if crisp:  # an odd whole number of device pixels, centred on a pixel centre below
        spine_lw = float(rng.choice([1, 1, 1, 3])) * 72 / dpi
        tick_w = min(tick_w, spine_lw)

    rc = {
        "path.snap": False,
        "font.family": font, "font.size": fontsize, "axes.linewidth": spine_lw,
        "axes.edgecolor": axis_color, "xtick.color": axis_color, "ytick.color": axis_color,
        "xtick.direction": tickdir, "ytick.direction": tickdir,
        "xtick.major.size": tick_len, "ytick.major.size": tick_len,
        "xtick.major.width": tick_w, "ytick.major.width": tick_w,
        "xtick.minor.size": tick_len * 0.55, "ytick.minor.size": tick_len * 0.55,
        "xtick.minor.width": tick_w * 0.8, "ytick.minor.width": tick_w * 0.8,
    }
    style = "ggplot" if ggplot else "default"
    if ggplot:  # keep the style's own axes and ticks; vary only the font
        rc = {"path.snap": False, "font.family": font, "font.size": fontsize}
    with plt.style.context(style), plt.rc_context(rc):
        fig, ax = plt.subplots(figsize=(w_in, h_in), dpi=dpi)
        n = int(rng.integers(8, 40))
        xs, xlim = make_data(rng, xscale, n)
        if offset:
            xs = np.sort(rng.uniform(-6, 10, n))
            xlim = (-6.0, 10.0)
        ys, ylim = make_data(rng, yscale, n)
        if offset:
            ys = np.sin(xs / 2) * 3 + rng.normal(0, 0.3, n)
            ylim = (-4.0, 4.0)
        color = ["C0", "C1", "C2", "C3", "k"][int(rng.integers(0, 5))]
        if kind == "line":
            ax.plot(xs, ys, color=color, lw=float(rng.uniform(0.8, 2.5)),
                    marker=str(rng.choice(["", "", "o", "s"])), ms=4)
        elif kind == "scatter":
            ax.scatter(xs, ys, s=float(rng.uniform(6, 40)), color=color,
                       marker=str(rng.choice(["o", "s", "^", "x", "+"])))
        else:
            widths = (xlim[1] - xlim[0]) / max(n, 1) * 0.7
            heights = np.abs(ys - min(ylim[0], 0)) if yscale == "linear" else ys
            ax.bar(xs, heights, width=widths, color=color, edgecolor=str(rng.choice(["none", "k"])))
            ylim = (min(0.0, ylim[0]), max(ylim[1], float(heights.max()) * 1.05))
        if xscale == "log10":
            ax.set_xscale("log")
        if yscale == "log10":
            ax.set_yscale("log")
        if xscale == "date":
            loc = mdates.AutoDateLocator()
            ax.xaxis.set_major_locator(loc)
            ax.xaxis.set_major_formatter(mdates.ConciseDateFormatter(loc))
        pad_x = 0.0 if xscale != "linear" else (xlim[1] - xlim[0]) * float(rng.uniform(0, 0.08))
        ax.set_xlim(xlim[0] - pad_x, xlim[1] + pad_x)
        if yscale == "linear":
            pad_y = (ylim[1] - ylim[0]) * float(rng.uniform(0, 0.1))
            ax.set_ylim(ylim[0] - (0 if kind == "bar" else pad_y), ylim[1] + pad_y)
        else:
            ax.set_ylim(ylim[0], ylim[1])
        if minor:
            ax.minorticks_on()
        if grid and not ggplot:
            ax.grid(True, which="major", color=str(rng.choice(["#b0b0b0", "#d0d0d0", "#888888"])),
                    linestyle=str(rng.choice(["-", "--", ":"])), linewidth=float(rng.uniform(0.5, 1.0)))
        if frame == "L":
            ax.spines["top"].set_visible(False)
            ax.spines["right"].set_visible(False)
        if offset:
            ax.spines["left"].set_position(("data", 0))
            ax.spines["bottom"].set_position(("data", 0))
            ax.spines["top"].set_visible(False)
            ax.spines["right"].set_visible(False)
        if mirror:
            ax.tick_params(top=True, right=True, which="both")
        if i in NO_X_TICKMARKS:
            ax.tick_params(axis="x", which="both", length=0)
        if rng.random() < 0.5:
            ax.set_title(str(rng.choice(["Measured response", "Figure 2", "Signal vs. time",
                                         "Dose-response", "Results (n = 48)"])))
        ax.set_xlabel(str(rng.choice(["Time", "Concentration (mg/L)", "Distance [km]", "x", "Date"])))
        ax.set_ylabel(str(rng.choice(["Response", "Intensity (a.u.)", "Count",
                                      "Cumulative incidence of the measured outcome", "y"])))
        if rng.random() < 0.35 and kind != "bar":
            ax.legend(["series A"], loc=str(rng.choice(["upper left", "upper right", "lower right"])))
        fig.tight_layout()
        if crisp:
            fig.canvas.draw()
            (x0, y0), (x1, y1) = ax.get_position().get_points() * [fig.bbox.width, fig.bbox.height]
            snap = lambda v: math.floor(v) + 0.5  # noqa: E731  display coords of a pixel centre
            fw, fh = fig.bbox.width, fig.bbox.height
            ax.set_position([snap(x0) / fw, snap(y0) / fh, (snap(x1) - snap(x0)) / fw,
                             (snap(y1) - snap(y0)) / fh])
        fig.canvas.draw()
        W, H = fig.canvas.get_width_height()
        rgba = np.asarray(fig.canvas.buffer_rgba()).copy()
        truth = extract_truth(fig, ax, W, H, xscale, yscale, frame, tickdir,
                              no_x_ticks=i in NO_X_TICKMARKS)
        plt.close(fig)

    img = Image.fromarray(rgba[:, :, :3])
    if rotation:
        img, truth = rotate(img, truth, rotation)

    tags = [f"x:{xscale}", f"y:{yscale}", f"kind:{kind}", "grid" if grid else "no-grid",
            f"frame:{frame}", f"ticks:{tickdir}", "rotated" if rotation else "upright",
            "jpeg" if jpeg_q else "png", "crisp" if crisp else "antialiased", "dpi:low" if dpi <= 96 else "dpi:mid" if dpi <= 150 else "dpi:high"]
    if minor:
        tags.append("minor-ticks")
    if mirror:
        tags.append("mirrored-ticks")
    if i in NO_X_TICKMARKS:
        tags.append("x-no-tickmarks")
    if axis_color != "#000000":
        tags.append("grey-axes")
    chart.tags = tags
    ext = "jpg" if jpeg_q else "png"
    doc = {
        "image": f"{chart.name}.{ext}",
        "width": img.width,
        "height": img.height,
        "description": (f"Synthetic {kind} chart, {xscale} x {yscale}, frame {frame}, dpi {dpi}, "
                        f"font {font} {fontsize:.1f}pt, rotation {rotation:.2f} deg"
                        + (f", JPEG q{jpeg_q}" if jpeg_q else "") + ". Generated by bench/axes/generate.py."),
        "tags": tags,
        **truth,
    }
    return img, doc, jpeg_q


def tick_entries(ax, axis: str, scale: str, line: np.ndarray, H: int, which: str):
    """Ticks inside the view limits, placed on the axis line (pixel centres)."""
    a = ax.xaxis if axis == "x" else ax.yaxis
    ticks = a.get_major_ticks() if which == "major" else a.get_minor_ticks()
    locs = a.get_majorticklocs() if which == "major" else a.get_minorticklocs()
    out = []
    p0, p1 = line
    for t, v in zip(ticks, locs):
        if not t.tick1line.get_visible():
            continue
        disp = ax.transData.transform((v, 1.0) if axis == "x" else (1.0, v))
        pix = px_of(disp, H)[0]
        if axis == "x":
            lo, hi = sorted([p0[0], p1[0]])
            if not lo - 0.6 <= pix[0] <= hi + 0.6:
                continue
            # Point on the axis line at this column.
            f = (pix[0] - p0[0]) / (p1[0] - p0[0])
            pt = (float(pix[0]), float(p0[1] + f * (p1[1] - p0[1])))
        else:
            lo, hi = sorted([p0[1], p1[1]])
            if not lo - 0.6 <= pix[1] <= hi + 0.6:
                continue
            f = (pix[1] - p0[1]) / (p1[1] - p0[1])
            pt = (float(p0[0] + f * (p1[0] - p0[0])), float(pix[1]))
        value = iso(v) if scale == "date" else float(v)
        e = {"value": value, "px": round(pt[0], 3), "py": round(pt[1], 3)}
        label = t.label1.get_text() if t.label1.get_visible() else ""
        if label:
            e["label"] = label
        if which == "minor":
            e["minor"] = True
        out.append(e)
    return out


def extract_truth(fig, ax, W, H, xscale, yscale, frame, tickdir, no_x_ticks):
    box = px_of(ax.transAxes.transform([(0, 1), (1, 1), (1, 0), (0, 0)]), H)  # TL TR BR BL

    def spine_line(name: str, fallback: np.ndarray) -> tuple[np.ndarray, bool]:
        sp = ax.spines[name]
        if frame == "ggplot" or not sp.get_visible():
            return fallback, False
        verts = sp.get_transform().transform(sp.get_path().vertices)
        return px_of(verts[[0, -1]], H), True

    xline, xdrawn = spine_line("bottom", box[[3, 2]])
    yline, ydrawn = spine_line("left", box[[3, 0]])
    # Orient: x axis left -> right, y axis bottom -> top.
    if xline[0][0] > xline[1][0]:
        xline = xline[::-1]
    if yline[0][1] < yline[1][1]:
        yline = yline[::-1]
    ticklen_px = plt.rcParams["xtick.major.size"] * fig.dpi / 72
    x_ticks = tick_entries(ax, "x", xscale, xline, H, "major") + tick_entries(ax, "x", xscale, xline, H, "minor")
    y_ticks = tick_entries(ax, "y", yscale, yline, H, "major") + tick_entries(ax, "y", yscale, yline, H, "minor")

    def axis_doc(scale, line, drawn, ticks, marks):
        d = {"scale": scale, "line": [[round(float(c), 3) for c in p] for p in line]}
        if not drawn:
            d["lineDrawn"] = False
        d["tickMarks"] = marks
        if marks:
            d["tickDirection"] = tickdir
            d["tickLengthPx"] = round(float(ticklen_px), 2)
        d["ticks"] = ticks
        return d

    return {
        "plotBox": [[round(float(c), 3) for c in p] for p in box],
        "xAxis": axis_doc(xscale, xline, xdrawn, x_ticks, not no_x_ticks),
        "yAxis": axis_doc(yscale, yline, ydrawn, y_ticks, True),
    }


def rotate(img: Image.Image, truth: dict, deg: float):
    """Rotate counter-clockwise by `deg` about the image centre (bilinear, white fill, canvas
    expanded) and map every truth coordinate through the same transform."""
    src = np.asarray(img).astype(np.float32)
    h, w = src.shape[:2]
    th = math.radians(deg)
    c, s = math.cos(th), math.sin(th)
    # Forward map (pixel centres, y down): counter-clockwise on screen.
    cx, cy = (w - 1) / 2, (h - 1) / 2
    W2 = int(math.ceil(abs(w * c) + abs(h * s)))
    H2 = int(math.ceil(abs(w * s) + abs(h * c)))
    cx2, cy2 = (W2 - 1) / 2, (H2 - 1) / 2

    def fwd(x, y):
        dx, dy = x - cx, y - cy
        return cx2 + c * dx + s * dy, cy2 - s * dx + c * dy

    yy, xx = np.mgrid[0:H2, 0:W2].astype(np.float32)
    dx, dy = xx - cx2, yy - cy2
    sx = cx + c * dx - s * dy
    sy = cy + s * dx + c * dy
    x0 = np.floor(sx).astype(int)
    y0 = np.floor(sy).astype(int)
    fx, fy = (sx - x0)[..., None], (sy - y0)[..., None]
    pad = np.pad(src, ((1, 2), (1, 2), (0, 0)), constant_values=255)

    def at(yi, xi):
        return pad[np.clip(yi + 1, 0, h + 2), np.clip(xi + 1, 0, w + 2)]

    out = (at(y0, x0) * (1 - fx) * (1 - fy) + at(y0, x0 + 1) * fx * (1 - fy)
           + at(y0 + 1, x0) * (1 - fx) * fy + at(y0 + 1, x0 + 1) * fx * fy)
    rot = Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8))

    def mp(p):
        x, y = fwd(p[0], p[1])
        return [round(x, 3), round(y, 3)]

    truth["plotBox"] = [mp(p) for p in truth["plotBox"]]
    for key in ("xAxis", "yAxis"):
        ax = truth[key]
        ax["line"] = [mp(p) for p in ax["line"]]
        for t in ax["ticks"]:
            t["px"], t["py"] = mp((t["px"], t["py"]))
    return rot, truth


def self_check(img: Image.Image, doc: dict) -> float:
    """Largest (over the drawn axis lines) median distance between the ground-truth line and the
    darkness centroid across it, sampled at 37 points along the line (the median ignores ticks,
    data and labels crossing it). Guards the truth extraction, not the detector."""
    g = np.asarray(img.convert("L")).astype(float)
    worst = 0.0
    for key in ("xAxis", "yAxis"):
        found = []
        ax = doc[key]
        if ax.get("lineDrawn") is False:
            continue
        (x1, y1), (x2, y2) = ax["line"]
        L = math.hypot(x2 - x1, y2 - y1)
        ux, uy = (x2 - x1) / L, (y2 - y1) / L
        nx, ny = -uy, ux
        for f in np.linspace(0.05, 0.95, 37):
            bx, by = x1 + f * (x2 - x1), y1 + f * (y2 - y1)
            offs = np.arange(-3, 3.01, 0.25)
            vals = []
            for o in offs:
                X, Y = bx + o * nx, by + o * ny
                xi, yi = int(math.floor(X)), int(math.floor(Y))
                ax_, ay_ = X - xi, Y - yi
                v = (g[yi, xi] * (1 - ax_) * (1 - ay_) + g[yi, xi + 1] * ax_ * (1 - ay_)
                     + g[yi + 1, xi] * (1 - ax_) * ay_ + g[yi + 1, xi + 1] * ax_ * ay_)
                vals.append(v)
            vals = np.array(vals)
            dark = 255 - vals
            # Skip samples where something else crosses the line (a white legend box, a bar
            # standing on the axis, a tick or label): the profile must be light at both ends.
            if dark.max() < 40 or max(dark[0], dark[-1]) > 0.3 * dark.max():
                continue
            wsum = np.where(dark > dark.max() * 0.5, dark, 0)
            found.append(float((wsum * offs).sum() / wsum.sum()))
        if found:
            worst = max(worst, abs(float(np.median(found))))
    return worst


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("c*.*"):
        old.unlink()
    bad = 0
    total = 0
    for i in range(COUNT):
        img, doc, q = build(i)
        name = doc["image"]
        if q:
            img.save(OUT / name, quality=q)
            img = Image.open(OUT / name)
        else:
            img.save(OUT / name, optimize=True)
        (OUT / f"c{i:02d}.json").write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
        err = self_check(img, doc)
        total += (OUT / name).stat().st_size
        flag = "" if err <= 0.35 else "  <-- truth check FAILED"
        bad += err > 0.35
        print(f"{name:8s} {img.width:5d}x{img.height:<5d} truth-check {err:4.2f}px  {' '.join(doc['tags'])}{flag}")
    print(f"{COUNT} charts, {total / 1e6:.2f} MB of images")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
