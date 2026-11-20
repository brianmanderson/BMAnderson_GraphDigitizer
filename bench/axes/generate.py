"""
Generates the synthetic axis-detection corpus in bench/axes/synthetic/: ~60 matplotlib charts
with exact ground truth (axis lines, plot box, every tick's pixel position, value and label).
Run offline and commit the output; the benchmark itself never needs Python:

    npm run bench:axes:corpus     (= python bench/axes/generate.py; Python 3.12, matplotlib 3.10,
                                   numpy, Pillow)

Everything is seeded per chart, so a rerun reproduces the same files (given the same
matplotlib/font versions). Charts c60-c69 were appended later (axes moved to the top/right), so
the first 60 are unchanged: c60-c67 have the X axis at the top (a "Γ" frame without a bottom
line, or a box frame with ticks and labels only on top), c68-c69 the Y axis at the right.
Charts c70-c75 (`build_handlettered`, appended after tester feedback on a 1928 dose-response
figure) look like old scanned figures: hand-lettered or italic tick labels (Windows script and
italic fonts, offline), no tick marks, a heavy black grid on every second label, a frame one
label step beyond the labelled range, gridlines poking past the frame, and a scan's blur, paper
tone, noise and specks. Charts c76-c83 (`build_range`) are range frames: both spines moved outward
from the data and trimmed to the first and last major tick, so the axis lines never meet (linear
and log-log, with and without tick labels); their plot box truth is the rectangle from the corner
where the extended axis lines would meet to each line's far end. Charts c120-c155
(`build_labels`) are ordinary axes with unusual tick LABELS: rotated 45/90 degrees, thousands
separators and decimal commas, SI suffixes, percent, currency, scientific notation, offset and
multiplier notes, both minus signs, log axes with plain numbers, reversed axes, serif / bold /
italic / condensed / monospace fonts, tiny, grey and coloured labels, years, months, quarters,
times of day, category names (truth scale `categorical`: the right answer is to decline), no tick
marks, and light text on a dark background. Each variant has a `label:<variant>` tag. Do not edit the output by hand and do not change a chart because the
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
import matplotlib.ticker as mticker  # noqa: E402
import matplotlib.transforms as mtransforms  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

OUT = Path(__file__).resolve().parent / "synthetic"
COUNT = 70

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
# Appended charts with the axes moved: X at the top (c60-c67), Y at the right (c68-c69). Their
# scales are fixed here (linear and log Y both covered), not taken from SCALES.
TOP_X = {60: ("linear", "linear"), 61: ("linear", "log10"), 62: ("linear", "log10"), 63: ("linear", "linear"),
         64: ("log10", "linear"), 65: ("linear", "log10"), 66: ("date", "linear"), 67: ("linear", "log10")}
RIGHT_Y = {68: ("linear", "linear"), 69: ("linear", "log10")}
# Appended old-scan look-alikes (build_handlettered): label font (family, style), label step on
# X and Y, first labelled X value, whether Y's lowest label sits on the bottom frame line.
HANDLETTERED = {
    70: (("Segoe Script", "normal"), 10, 10, 150, True),
    71: (("Ink Free", "normal"), 5, 20, 25, True),
    72: (("Lucida Handwriting", "italic"), 0.5, 10, 1.5, False),
    73: (("Times New Roman", "italic"), 20, 5, 60, True),
    74: (("Bradley Hand ITC", "normal"), 10, 25, 50, False),
    75: (("Comic Sans MS", "italic"), 2, 10, 6, True),
}
# Appended range frames (build_range): (scale of both axes, tick labels drawn). The spines are
# moved outward from the data and trimmed to the first and last major tick, so they never meet.
RANGE_FRAME = {
    76: ("linear", True), 77: ("log10", True), 78: ("linear", False), 79: ("log10", False),
    80: ("linear", True), 81: ("log10", True), 82: ("linear", False), 83: ("log10", False),
}

# Appended label-variety charts (build_labels): what the X and Y tick labels look like, plus
# chart-level options (xrot / yrot = label rotation in degrees, xrev / yrev = descending axis,
# font = (family, weight, style), em = label size in px, dpi, colours, style sheet, tick marks,
# jpeg quality). See `label_plan` for the kinds.
LABEL_VARIETY = {
    120: dict(x="plain-big", y="plain", xrot=45),
    121: dict(x="month-year", y="percent", xrot=45),
    122: dict(x="plain-big", y="plain", xrot=90),
    123: dict(x="yyyy-mm", y="thousands-comma", xrot=90),
    124: dict(x="plain", y="plain", yrot=90, font=("Arial", "normal", "normal")),
    125: dict(x="thousands-comma", y="thousands-comma"),
    126: dict(x="decimal-comma", y="thousands-space"),
    127: dict(x="decimal-comma", y="decimal-comma"),
    128: dict(x="si-k", y="si-mixed"),
    129: dict(x="plain", y="plain", ticks=False, style="seaborn-v0_8-whitegrid"),
    130: dict(x="month-2line", y="percent"),
    131: dict(x="year", y="currency"),
    132: dict(x="quarter", y="currency-thousands"),
    133: dict(x="sci-e-log", y="sci-e"),
    134: dict(x="sci-times", y="sci-times"),
    135: dict(x="note-mult-small", y="note-mult"),
    136: dict(x="note-offset", y="note-offset-small"),
    137: dict(x="negative", y="negative-small", minus="unicode"),
    138: dict(x="negative", y="negative-small", minus="hyphen"),
    139: dict(x="log-plain", y="log-plain"),
    140: dict(x="log-pow", y="log-pow", font=("Times New Roman", "normal", "normal")),
    141: dict(x="plain", y="plain", xrev=True, yrev=True),
    142: dict(x="log-plain", y="plain", xrev=True),
    143: dict(x="plain", y="plain", font=("Georgia", "normal", "normal")),
    144: dict(x="plain", y="plain", font=("Arial", "bold", "normal")),
    145: dict(x="plain", y="plain", font=("Times New Roman", "normal", "italic")),
    146: dict(x="plain", y="plain", font=("Franklin Gothic Medium Cond", "normal", "normal")),
    147: dict(x="plain", y="plain", font=("Consolas", "normal", "normal")),
    148: dict(x="plain", y="plain", em=9.0, dpi=72),
    149: dict(x="plain", y="plain", em=10.5, dpi=72, jpeg=85),
    150: dict(x="plain", y="plain", color="#8c8c8c"),
    151: dict(x="plain", y="plain", xcolor="#c0392b", ycolor="#1f77b4"),
    152: dict(x="time-concise", y="plain"),
    153: dict(x="time-only", y="plain"),
    154: dict(x="categorical", y="plain-zero"),
    155: dict(x="plain", y="plain", style="dark_background"),
}


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
    top_x = i in TOP_X
    right_y = i in RIGHT_Y
    xscale, yscale = ("linear", "linear") if offset else SCALES[i % len(SCALES)]
    if top_x or right_y:
        xscale, yscale = TOP_X.get(i) or RIGHT_Y[i]
    kind = ["line", "scatter", "bar"][int(rng.integers(0, 3))]
    if kind == "bar" and (yscale != "linear" or xscale == "log10"):
        kind = "line"
    frame = "offset" if offset else "ggplot" if ggplot else ("box" if rng.random() < 0.55 else "L")
    if top_x:  # "top" = Γ (no bottom/right lines); "box-top" = closed frame, ticks only on top
        frame = "box-top" if frame == "box" else "top"
    if right_y:  # mirrored: no left/top lines; or a closed frame with ticks only at the right
        frame = "box-right" if frame == "box" else "right"
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
        if top_x:
            ax.xaxis.tick_top()
            ax.xaxis.set_label_position("top")
            if frame == "top":
                ax.spines["bottom"].set_visible(False)
                ax.spines["right"].set_visible(False)
        if right_y:
            ax.yaxis.tick_right()
            ax.yaxis.set_label_position("right")
            if frame == "right":
                ax.spines["left"].set_visible(False)
                ax.spines["top"].set_visible(False)
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
                              no_x_ticks=i in NO_X_TICKMARKS, top_x=top_x, right_y=right_y)
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
    if top_x:
        tags.append("x-axis:top")
    if right_y:
        tags.append("y-axis:right")
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


def build_handlettered(i: int) -> tuple[Image.Image, dict, int]:
    """An old scanned figure: hand-lettered labels without tick marks, a heavy grid on every second
    label, a frame one label step beyond the labelled range. Truth = the labelled values."""
    rng = np.random.default_rng(1000 + i)
    (font, style), sx, sy, x_first, y_on_frame = HANDLETTERED[i]
    nx = int(rng.integers(7, 10))  # labels on X
    ny = int(rng.integers(6, 11))  # labels on Y
    x_labels = [x_first + k * sx for k in range(nx)]
    y_labels = [k * sy for k in range(ny)]
    # Frame: one label step beyond the labels on X; one or two steps above the top label on Y;
    # at the lowest label or one step below it.
    xlim = (x_first - sx, x_labels[-1] + sx)
    ylim = (0.0 if y_on_frame else -sy, y_labels[-1] + sy * int(rng.integers(1, 3)))
    dpi = int(rng.choice([100, 120, 150, 200]))
    w_in = float(rng.uniform(5.0, 7.0))
    h_in = float(w_in * rng.uniform(1.0, 1.3))
    if h_in * dpi > 1400:
        w_in, h_in = 1400 / dpi * w_in / h_in, 1400 / dpi
    fontsize = float(rng.uniform(11, 15))
    spine_lw = float(rng.uniform(2.0, 3.5))
    grid_lw = float(rng.uniform(1.2, 2.4))
    rotation = float(rng.choice([-1, 1]) * rng.uniform(0.3, 1.0)) if i % 2 else 0.0
    jpeg_q = int(rng.integers(55, 86)) if i % 3 != 2 else 0
    rc = {
        "path.snap": False, "font.family": font, "font.size": fontsize, "axes.linewidth": spine_lw,
        "axes.edgecolor": "#000000", "xtick.major.size": 0, "ytick.major.size": 0,
        "xtick.major.pad": float(rng.uniform(1, 5)), "ytick.major.pad": float(rng.uniform(0, 2)),
    }
    with plt.rc_context(rc):
        fig, ax = plt.subplots(figsize=(w_in, h_in), dpi=dpi)
        ax.set_xlim(*xlim)
        ax.set_ylim(*ylim)
        # A heavy hand-ruled grid on every second label (through the frame's values), the
        # horizontal lines running a little past the left frame on some charts.
        poke = float(rng.uniform(0, 0.25)) * sx if rng.random() < 0.6 else 0.0
        for v in np.arange(xlim[0] + 2 * sx, xlim[1] - 0.5 * sx, 2 * sx):
            ax.plot([v, v], [ylim[0], ylim[1]], color="k", lw=grid_lw, solid_capstyle="butt")
        for v in np.arange(ylim[0] + 2 * sy, ylim[1] - 0.5 * sy, 2 * sy):
            ax.plot([xlim[0] - poke, xlim[1]], [v, v], color="k", lw=grid_lw, clip_on=False, solid_capstyle="butt")
        # Data: a fitted curve, two dashed bands and scattered markers, all black.
        xs = np.linspace(x_labels[0], x_labels[-1] - sx, 60)
        t = (xs - xs[0]) / (xs[-1] - xs[0])
        top = y_labels[-1]
        curve = top * (0.2 + 0.75 * (1 - np.exp(-2.2 * t)) / (1 - np.exp(-2.2)))
        ax.plot(xs, curve, color="k", lw=float(rng.uniform(1.2, 2.2)))
        for d in (-0.12, 0.12):
            ax.plot(xs, curve + d * top, color="k", lw=1.2, linestyle=(0, (4, 3)))
        pts = rng.choice(len(xs), 7, replace=False)
        ax.scatter(xs[pts], curve[pts] + rng.normal(0, 0.06 * top, 7), s=60, facecolors="none",
                   edgecolors="k", marker="o", linewidths=1.3)
        ax.scatter(xs[pts[:4]] + 0.2 * sx, curve[pts[:4]] + rng.normal(0, 0.1 * top, 4), s=50, color="k", marker="x")
        ax.xaxis.set_major_locator(mticker.FixedLocator(x_labels))
        ax.xaxis.set_major_formatter(mticker.FixedFormatter([f"{v:g}" for v in x_labels]))
        ax.yaxis.set_major_locator(mticker.FixedLocator(y_labels))
        ax.yaxis.set_major_formatter(mticker.FixedFormatter([f"{v:g}" for v in y_labels]))
        ax.minorticks_off()
        for lab in ax.get_xticklabels() + ax.get_yticklabels():
            lab.set_fontstyle(style)
        ax.set_xlabel(str(rng.choice(["Milliampere-minutes", "Dose", "Exposure (r)", "Time in days"])),
                      family="Times New Roman", fontsize=fontsize)
        ax.set_ylabel(str(rng.choice(["Percentage Positive Reactions", "Per cent surviving", "Response"])),
                      family="Times New Roman", fontsize=fontsize)
        fig.tight_layout()
        fig.canvas.draw()
        # Hand-lettered labels are not exactly centred: shift each a little (the truth is the
        # value's position on the axis, not the label's).
        for lab in ax.get_xticklabels() + ax.get_yticklabels():
            dx, dy = rng.normal(0, 0.02), rng.normal(0, 0.015)
            lab.set_transform(lab.get_transform() + mtransforms.ScaledTranslation(dx, dy, fig.dpi_scale_trans))
        fig.canvas.draw()
        W, H = fig.canvas.get_width_height()
        rgba = np.asarray(fig.canvas.buffer_rgba()).copy()
        truth = extract_truth(fig, ax, W, H, "linear", "linear", "box", "out", no_x_ticks=True, no_y_ticks=True)
        plt.close(fig)

    # Scan: grey, slightly blurred, paper tone, sensor noise and dust specks.
    g = np.asarray(Image.fromarray(rgba[:, :, :3]).convert("L")).astype(np.float32)
    k = np.array([0.25, 0.5, 0.25], np.float32)
    g = np.pad(g, 1, mode="edge")
    g = np.apply_along_axis(lambda r: np.convolve(r, k, mode="same"), 1, g)
    g = np.apply_along_axis(lambda c: np.convolve(c, k, mode="same"), 0, g)[1:-1, 1:-1]
    paper = float(rng.uniform(228, 248))
    g = g * (paper / 255.0) + rng.normal(0, float(rng.uniform(3, 9)), g.shape)
    for _ in range(int(g.size / 4000)):
        y, x = int(rng.integers(0, g.shape[0])), int(rng.integers(0, g.shape[1]))
        g[y:y + int(rng.integers(1, 3)), x:x + int(rng.integers(1, 3))] *= float(rng.uniform(0.3, 0.8))
    img = Image.fromarray(np.clip(g + 0.5, 0, 255).astype(np.uint8)).convert("RGB")
    if rotation:
        img, truth = rotate(img, truth, rotation)
    tags = ["x:linear", "y:linear", "kind:line", "grid", "frame:box", "rotated" if rotation else "upright",
            "jpeg" if jpeg_q else "png", "antialiased", "dpi:mid" if dpi <= 150 else "dpi:high",
            "x-no-tickmarks", "no-tickmarks", "handlettered", "heavy-grid", "frame-beyond-labels", "scanned"]
    name = f"c{i:02d}"
    ext = "jpg" if jpeg_q else "png"
    doc = {
        "image": f"{name}.{ext}",
        "width": img.width,
        "height": img.height,
        "description": (f"Synthetic old-scan look-alike: hand-lettered labels ({font} {style} {fontsize:.1f}pt), "
                        f"no tick marks, heavy grid every {2 * sx:g} x {2 * sy:g}, frame beyond the labels, "
                        f"dpi {dpi}, rotation {rotation:.2f} deg" + (f", JPEG q{jpeg_q}" if jpeg_q else "")
                        + ". Generated by bench/axes/generate.py."),
        "tags": tags,
        **truth,
    }
    return img, doc, jpeg_q


def build_range(i: int) -> tuple[Image.Image, dict, int]:
    """A range frame: both spines moved outward from the data and trimmed to the labelled range, so
    the axis lines stand apart and never meet. Plot box truth = the rectangle the two axis lines
    span if extended to meet: from that virtual corner to the far end of each line."""
    rng = np.random.default_rng(1000 + i)
    scale, labelled = RANGE_FRAME[i]
    log = scale == "log10"
    kind = str(rng.choice(["scatter", "line"]))
    dpi = int(rng.choice([72, 96, 100, 120, 150, 200]))
    w_in = float(rng.uniform(4.5, 7.5))
    h_in = float(w_in * rng.uniform(0.6, 0.85))
    if w_in * dpi > 1200:
        w_in, h_in = 1200 / dpi, 1200 / dpi * h_in / w_in
    font = str(FONTS[int(rng.integers(0, len(FONTS)))])
    fontsize = float(rng.uniform(8, 12))
    spine_lw = float(rng.choice([0.6, 0.8, 1.0, 1.25, 1.5]))
    tick_len = float(rng.uniform(3, 7))
    tick_w = float(min(spine_lw, rng.choice([0.6, 0.8, 1.0])))
    rotation = float(rng.choice([-1, 1]) * rng.uniform(0.5, 2.0)) if i % 4 == 3 else 0.0
    jpeg_q = int(rng.integers(50, 91)) if i % 3 == 1 else 0
    crisp = rng.random() < 0.5
    if crisp:
        spine_lw = 72 / dpi
        tick_w = spine_lw
    # The outward offset in whole pixels, so a crisp chart's spines stay on pixel centres.
    offset_px = int(rng.integers(max(3, round(4 * dpi / 72)), round(16 * dpi / 72) + 1))
    minor = log or rng.random() < 0.4
    if log:
        xlo = int(rng.integers(-3, 1))
        xhi = xlo + int(rng.integers(2, 5))
        ylo = int(rng.integers(-2, 2))
        yhi = ylo + int(rng.integers(2, 4))
        x_major = [10.0**k for k in range(xlo, xhi + 1)]
        y_major = [10.0**k for k in range(ylo, yhi + 1)]
        x_minor = [m * 10.0**k for k in range(xlo, xhi) for m in range(2, 10)]
        y_minor = [m * 10.0**k for k in range(ylo, yhi) for m in range(2, 10)]
    else:
        sx = float(rng.choice([1, 2, 5, 10, 20, 25]))
        sy = float(rng.choice([0.5, 1, 2, 5, 10, 50]))
        x0 = float(rng.choice([0, 0, -2, 10])) * sx
        y0 = float(rng.choice([0, 0, -1, 4])) * sy
        x_major = [x0 + k * sx for k in range(int(rng.integers(4, 8)))]
        y_major = [y0 + k * sy for k in range(int(rng.integers(4, 8)))]
        x_minor = [v + sx / 2 for v in x_major[:-1]] if minor else []
        y_minor = [v + sy / 2 for v in y_major[:-1]] if minor else []
    xb, yb = (x_major[0], x_major[-1]), (y_major[0], y_major[-1])

    def lin(v: float) -> float:
        return math.log10(v) if log else v

    def unlin(u):
        return 10.0**u if log else u

    pad_x = float(rng.uniform(0.02, 0.08))
    pad_y = float(rng.uniform(0.02, 0.08))
    xlim = (unlin(lin(xb[0]) - pad_x * (lin(xb[1]) - lin(xb[0]))), unlin(lin(xb[1]) + pad_x * (lin(xb[1]) - lin(xb[0]))))
    ylim = (unlin(lin(yb[0]) - pad_y * (lin(yb[1]) - lin(yb[0]))), unlin(lin(yb[1]) + pad_y * (lin(yb[1]) - lin(yb[0]))))
    axis_color = "#000000" if rng.random() < 0.75 else "#444444"
    rc = {
        "path.snap": False,
        "font.family": font, "font.size": fontsize, "axes.linewidth": spine_lw,
        "axes.edgecolor": axis_color, "xtick.color": axis_color, "ytick.color": axis_color,
        "xtick.direction": "out", "ytick.direction": "out",
        "xtick.major.size": tick_len, "ytick.major.size": tick_len,
        "xtick.major.width": tick_w, "ytick.major.width": tick_w,
        "xtick.minor.size": tick_len * 0.55, "ytick.minor.size": tick_len * 0.55,
        "xtick.minor.width": tick_w * 0.8, "ytick.minor.width": tick_w * 0.8,
    }
    with plt.rc_context(rc):
        fig, ax = plt.subplots(figsize=(w_in, h_in), dpi=dpi)
        n = int(rng.integers(15, 60))
        u = np.sort(rng.uniform(0.0, 1.0, n))
        vv = np.clip(0.15 + 0.7 * u ** float(rng.uniform(0.4, 2.0)) + rng.normal(0, 0.06, n), 0.0, 1.0)
        xs = unlin(lin(xb[0]) + u * (lin(xb[1]) - lin(xb[0])))
        ys = unlin(lin(yb[0]) + vv * (lin(yb[1]) - lin(yb[0])))
        color = ["C0", "C1", "C2", "C3", "k"][int(rng.integers(0, 5))]
        if kind == "line":
            ax.plot(xs, ys, color=color, lw=float(rng.uniform(0.8, 2.0)), marker=str(rng.choice(["", "o"])), ms=4)
        else:
            ax.scatter(xs, ys, s=float(rng.uniform(8, 36)), color=color, marker=str(rng.choice(["o", "s", "^", "x"])))
        if log:
            ax.set_xscale("log")
            ax.set_yscale("log")
        ax.set_xlim(*xlim)
        ax.set_ylim(*ylim)
        ax.xaxis.set_major_locator(mticker.FixedLocator(x_major))
        ax.yaxis.set_major_locator(mticker.FixedLocator(y_major))
        ax.xaxis.set_minor_locator(mticker.FixedLocator(x_minor))
        ax.yaxis.set_minor_locator(mticker.FixedLocator(y_minor))
        ax.xaxis.set_minor_formatter(mticker.NullFormatter())
        ax.yaxis.set_minor_formatter(mticker.NullFormatter())
        if not log:
            ax.xaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: f"{v:g}"))
            ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: f"{v:g}"))
        elif rng.random() < 0.5:  # plain numbers instead of 10^n
            ax.xaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: f"{v:g}"))
            ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: f"{v:g}"))
        if not labelled:
            ax.tick_params(labelbottom=False, labelleft=False, which="both")
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        offset_pt = offset_px * 72 / dpi
        ax.spines["left"].set_position(("outward", offset_pt))
        ax.spines["bottom"].set_position(("outward", offset_pt))
        ax.spines["left"].set_bounds(*yb)
        ax.spines["bottom"].set_bounds(*xb)
        if rng.random() < 0.5:
            ax.set_title(str(rng.choice(["Dose response", "Figure 3", "Measured vs. predicted"])))
        ax.set_xlabel(str(rng.choice(["Volume (cm3)", "Concentration", "Time [h]", "x"])))
        ax.set_ylabel(str(rng.choice(["Dose (Gy)", "Response", "Count", "y"])))
        fig.tight_layout()
        if crisp:
            fig.canvas.draw()
            (x0_, y0_), (x1_, y1_) = ax.get_position().get_points() * [fig.bbox.width, fig.bbox.height]
            snap = lambda v: math.floor(v) + 0.5  # noqa: E731
            fw, fh = fig.bbox.width, fig.bbox.height
            ax.set_position([snap(x0_) / fw, snap(y0_) / fh, (snap(x1_) - snap(x0_)) / fw, (snap(y1_) - snap(y0_)) / fh])
        fig.canvas.draw()
        W, H = fig.canvas.get_width_height()
        rgba = np.asarray(fig.canvas.buffer_rgba()).copy()
        truth = extract_truth(fig, ax, W, H, scale, scale, "range", "out", no_x_ticks=False)
        plt.close(fig)
    (xl, xr), (yb_, yt) = truth["xAxis"]["line"], truth["yAxis"]["line"]
    left, right, bottom, top = yb_[0], xr[0], xl[1], yt[1]
    truth["plotBox"] = [[round(float(x), 3), round(float(y), 3)] for x, y in
                        ((left, top), (right, top), (right, bottom), (left, bottom))]
    img = Image.fromarray(rgba[:, :, :3])
    if rotation:
        img, truth = rotate(img, truth, rotation)
    tags = [f"x:{scale}", f"y:{scale}", f"kind:{kind}", "no-grid", "frame:range", "ticks:out",
            "rotated" if rotation else "upright", "jpeg" if jpeg_q else "png", "crisp" if crisp else "antialiased",
            "dpi:low" if dpi <= 96 else "dpi:mid" if dpi <= 150 else "dpi:high", "range-frame",
            "ticklabels" if labelled else "no-ticklabels"]
    if minor:
        tags.append("minor-ticks")
    if axis_color != "#000000":
        tags.append("grey-axes")
    name = f"c{i:02d}"
    ext = "jpg" if jpeg_q else "png"
    doc = {
        "image": f"{name}.{ext}",
        "width": img.width,
        "height": img.height,
        "description": (f"Synthetic range frame ({kind}, {scale} x {scale}, axes {offset_px} px out from the data, "
                        f"trimmed to the labelled range, tick labels {'drawn' if labelled else 'hidden'}), dpi {dpi}, "
                        f"font {font} {fontsize:.1f}pt, rotation {rotation:.2f} deg" + (f", JPEG q{jpeg_q}" if jpeg_q else "")
                        + ". Generated by bench/axes/generate.py."),
        "tags": tags,
        **truth,
    }
    return img, doc, jpeg_q


def label_plan(kind: str, rng: np.random.Generator, minus: str) -> dict:
    """One axis of a label-variety chart: scale, major tick values, their label strings (or a
    locator / formatter of matplotlib's own), whether minor ticks are drawn, and the variant tags.
    Values are what the labels MEAN (`2k` = 2000, `20%` = 20, `$1,000` = 1000)."""

    def lin(start: float, step: float, n: int) -> list[float]:
        return [round(start + k * step, 10) for k in range(n)]

    def fixed(vals: list[float], decimals: int) -> list[str]:
        out = [f"{v:.{decimals}f}" for v in vals]
        return [t.replace("-", "−") for t in out] if minus == "unicode" else out

    def months(year: int, month: int, step: int, n: int) -> list[dt.datetime]:
        out = []
        for k in range(n):
            m = month - 1 + k * step
            out.append(dt.datetime(year + m // 12, m % 12 + 1, 1))
        return out

    def pick(options):
        return options[int(rng.integers(0, len(options)))]

    n = int(rng.integers(5, 8))
    plan = dict(scale="linear", vals=None, labels=None, locator=None, formatter=None, minor=False, tags=[])
    if kind in ("plain", "plain-zero"):
        start, step, dec = pick([(0, 2, 0), (0, 20, 0), (0.0, 0.2, 1), (10, 5, 0), (0, 50, 0), (1.0, 0.5, 1)])
        if kind == "plain-zero":
            start, step, dec = pick([(0, 2, 0), (0, 20, 0), (0, 50, 0)])
        vals = lin(start, step, n)
        plan.update(vals=vals, labels=fixed(vals, dec), minor=bool(rng.random() < 0.3))
    elif kind == "plain-big":
        vals = lin(*pick([(10000, 10000), (0, 25000), (200000, 100000)]), n)
        plan.update(vals=vals, labels=fixed(vals, 0))
    elif kind in ("thousands-comma", "thousands-space"):
        vals = lin(*pick([(0, 5000), (1000, 1000), (0, 250000), (10000, 10000)]), n)
        sep = "," if kind == "thousands-comma" else " "
        plan.update(vals=vals, labels=[f"{v:,.0f}".replace(",", sep) for v in vals], tags=[f"label:{kind}"])
    elif kind == "decimal-comma":
        start, step, dec = pick([(0.0, 0.5, 1), (1.5, 0.5, 1), (0.0, 0.25, 2), (0.0, 0.2, 1)])
        vals = lin(start, step, n)
        plan.update(vals=vals, labels=[f"{v:.{dec}f}".replace(".", ",") for v in vals], tags=["label:decimal-comma"])
    elif kind == "si-k":
        vals = lin(0, float(pick([2000, 5000, 20000])), n)
        plan.update(vals=vals, labels=["0" if v == 0 else f"{v / 1000:g}k" for v in vals], tags=["label:si"])
    elif kind == "si-mixed":
        vals = lin(0, 250000.0, 7)
        plan.update(vals=vals, tags=["label:si"],
                    labels=["0" if v == 0 else f"{v / 1e6:g}M" if v >= 1e6 else f"{v / 1000:g}k" for v in vals])
    elif kind == "percent":
        vals = lin(0, float(pick([20, 10, 25])), int(pick([5, 6])))
        plan.update(vals=vals, labels=[f"{v:g}%" for v in vals], tags=["label:percent"])
    elif kind == "currency":
        vals = lin(0, float(pick([20, 50, 5])), n)
        plan.update(vals=vals, labels=[f"${v:g}" for v in vals], tags=["label:currency"])
    elif kind == "currency-thousands":
        vals = lin(0, float(pick([1000, 2500, 500])), n)
        plan.update(vals=vals, labels=[f"${v:,.0f}" for v in vals], tags=["label:currency", "label:thousands-comma"])
    elif kind == "sci-e":
        step, dec = pick([(0.002, 0), (2000.0, 0), (0.0005, 1)])
        vals = lin(0, step, n)
        plan.update(vals=vals, labels=[f"{v:.{dec}e}" for v in vals], tags=["label:sci-e"])
    elif kind == "sci-e-log":
        lo = int(rng.integers(-4, 0))
        vals = [10.0**k for k in range(lo, lo + int(rng.integers(4, 7)))]
        plan.update(scale="log10", vals=vals, labels=[f"{v:.0e}" for v in vals], minor=True, tags=["label:sci-e"])
    elif kind == "sci-times":
        e = int(pick([3, 5, -2, 4]))
        vals = [float(f"{m}e{e}") for m in range(0, n)]
        plan.update(vals=vals, tags=["label:sci-times"],
                    labels=["0" if m == 0 else rf"${m}\times10^{{{e}}}$" for m in range(0, n)])
    elif kind in ("note-mult", "note-mult-small"):
        vals = lin(0, 10000.0 if kind == "note-mult" else 0.001, n)
        fmt = mticker.ScalarFormatter(useMathText=True)
        fmt.set_powerlimits((0, 0))
        plan.update(vals=vals, formatter=fmt, tags=["label:note-mult"])
    elif kind in ("note-offset", "note-offset-small"):
        vals = lin(10000.0, 0.2, 6) if kind == "note-offset" else lin(2500.0, 0.01, 6)  # "+1e4", "+2.5e3"
        plan.update(vals=vals, formatter=mticker.ScalarFormatter(useOffset=True, useMathText=False), tags=["label:note-offset"])
    elif kind in ("negative", "negative-small"):
        if kind == "negative":
            start, step, dec = pick([(-40, 20, 0), (-300, 100, 0), (-8, 2, 0)])
        else:
            start, step, dec = pick([(-1.5, 0.5, 1), (-0.6, 0.2, 1)])
        vals = lin(start, step, n)
        plan.update(vals=vals, labels=fixed(vals, dec), tags=[f"label:minus-{minus}"])
    elif kind in ("log-plain", "log-pow"):
        lo = int(rng.integers(-3, 1))
        vals = [10.0**k for k in range(lo, lo + int(rng.integers(4, 6)))]
        plan.update(scale="log10", vals=vals, minor=True, tags=[f"label:{kind}"])
        if kind == "log-plain":
            plan.update(labels=[f"{v:g}" for v in vals])
    elif kind == "year":
        y0 = int(rng.integers(1990, 2016))
        ds = [dt.datetime(y0 + k, 1, 1) for k in range(int(rng.integers(6, 10)))]
        plan.update(scale="date", vals=list(mdates.date2num(ds)), labels=[d.strftime("%Y") for d in ds], tags=["label:year"])
    elif kind in ("month-year", "yyyy-mm", "quarter", "month-2line"):
        y0 = int(rng.integers(1998, 2023))
        if kind == "month-2line":
            ds = months(y0, int(rng.integers(3, 12)), 1, int(rng.integers(8, 12)))
            labels = [d.strftime("%b") + (f"\n{d.year}" if k == 0 or d.month == 1 else "") for k, d in enumerate(ds)]
        elif kind == "quarter":
            ds = months(y0, int(pick([1, 4, 7, 10])), 3, int(rng.integers(6, 9)))
            labels = [f"Q{(d.month - 1) // 3 + 1} {d.year}" for d in ds]
        else:
            ds = months(y0, int(rng.integers(1, 13)), int(pick([2, 3])), int(rng.integers(6, 9)))
            labels = [d.strftime("%b %Y" if kind == "month-year" else "%Y-%m") for d in ds]
        plan.update(scale="date", vals=list(mdates.date2num(ds)), labels=labels, tags=[f"label:{kind}"])
    elif kind in ("time-concise", "time-only"):
        day = dt.datetime(int(rng.integers(2005, 2024)), int(rng.integers(1, 13)), int(rng.integers(2, 28)))
        if kind == "time-only":  # no date anywhere on the axis: it cannot be calibrated as dates
            ds = [day + dt.timedelta(hours=6 + 2 * k) for k in range(7)]
            plan.update(scale="time-of-day", vals=list(mdates.date2num(ds)), labels=[d.strftime("%H:%M") for d in ds],
                        tags=["label:time-only"])
        else:  # matplotlib's concise formatter: times on the ticks, the date in the offset text
            loc = mdates.HourLocator(byhour=range(0, 24, 3))
            plan.update(scale="date", locator=loc, formatter=mdates.ConciseDateFormatter(loc),
                        lim=tuple(mdates.date2num([day + dt.timedelta(hours=2), day + dt.timedelta(hours=22)])),
                        tags=["label:time-concise"])
    elif kind == "categorical":
        names = pick([["Control", "Low", "Medium", "High", "Recovery"], ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
                      ["Liver", "Lung", "Kidney", "Brain", "Heart"], ["A", "B", "C", "D", "E", "F"]])
        plan.update(scale="categorical", vals=[float(k) for k in range(len(names))], labels=names, tags=["label:categorical"])
    else:
        raise ValueError(kind)
    return plan


def build_labels(i: int) -> tuple[Image.Image, dict, int]:
    """Ordinary axes with unusual tick labels (see LABEL_VARIETY and `label_plan`)."""
    rng = np.random.default_rng(1000 + i)
    spec = LABEL_VARIETY[i]
    minus = spec.get("minus", "unicode")
    px_ = label_plan(spec["x"], rng, minus)
    py_ = label_plan(spec["y"], rng, minus)
    categorical = px_["scale"] == "categorical"
    kind = "bar" if categorical else str(rng.choice(["line", "scatter"]))
    dpi = int(spec.get("dpi", rng.choice([100, 120, 150])))
    w_in = float(rng.uniform(5.0, 7.0))
    h_in = float(w_in * rng.uniform(0.6, 0.8))
    if w_in * dpi > 1100:
        w_in, h_in = 1100 / dpi, 1100 / dpi * h_in / w_in
    plain_font = str(rng.choice(["Arial", "DejaVu Sans", "Segoe UI", "Calibri", "Verdana", "Tahoma"]))
    family, weight, fstyle = spec.get("font") or (plain_font, "normal", "normal")
    fontsize = spec["em"] * 72 / dpi if "em" in spec else float(rng.uniform(8.5, 11.5))
    style = spec.get("style", "default")
    plain_style = style == "default"
    ticks_drawn = spec.get("ticks", True)
    color = spec.get("color", "#000000")
    frame = "box" if not plain_style or rng.random() < 0.55 else "L"
    grid = not plain_style or bool(rng.random() < 0.3)
    spine_lw = float(rng.choice([0.8, 1.0, 1.25]))
    tick_len = float(rng.uniform(3, 6)) if ticks_drawn else 0.0
    crisp = plain_style and bool(rng.random() < 0.5)
    if crisp:
        spine_lw = 72 / dpi
    jpeg_q = int(spec.get("jpeg", 0))
    rc = {"path.snap": False, "font.family": family, "font.size": fontsize, "axes.unicode_minus": minus == "unicode",
          "xtick.major.size": tick_len, "ytick.major.size": tick_len, "xtick.minor.size": tick_len * 0.55,
          "ytick.minor.size": tick_len * 0.55}
    if plain_style:
        rc.update({"axes.linewidth": spine_lw, "axes.edgecolor": color, "xtick.color": color, "ytick.color": color,
                   "xtick.labelcolor": spec.get("xcolor", color), "ytick.labelcolor": spec.get("ycolor", color),
                   "xtick.direction": "out", "ytick.direction": "out",
                   "xtick.major.width": min(spine_lw, 0.8), "ytick.major.width": min(spine_lw, 0.8),
                   "xtick.minor.width": min(spine_lw, 0.6), "ytick.minor.width": min(spine_lw, 0.6)})

    def linear(scale: str, v):
        return np.log10(v) if scale == "log10" else np.asarray(v, dtype=float)

    def limits(plan: dict) -> tuple[float, float]:
        if "lim" in plan:
            return plan["lim"]
        if plan["scale"] == "categorical":
            return (-0.6, len(plan["vals"]) - 0.4)
        lo, hi = float(linear(plan["scale"], plan["vals"][0])), float(linear(plan["scale"], plan["vals"][-1]))
        pad = [float(rng.uniform(0.0, 0.06)) if rng.random() < 0.7 else 0.0 for _ in range(2)]
        lo, hi = lo - pad[0] * (hi - lo), hi + pad[1] * (hi - lo)
        return (10.0**lo, 10.0**hi) if plan["scale"] == "log10" else (lo, hi)

    with plt.style.context(style), plt.rc_context(rc):
        fig, ax = plt.subplots(figsize=(w_in, h_in), dpi=dpi)
        xlim, ylim = limits(px_), limits(py_)
        n = int(rng.integers(12, 40))
        u = np.sort(rng.uniform(0.04, 0.96, n))
        v = np.clip(0.12 + 0.72 * u ** float(rng.uniform(0.5, 2.0)) + rng.normal(0, 0.05, n), 0.03, 0.97)

        def place(plan: dict, lim: tuple[float, float], t):
            lo, hi = float(linear(plan["scale"], lim[0])), float(linear(plan["scale"], lim[1]))
            w = lo + t * (hi - lo)
            return 10.0**w if plan["scale"] == "log10" else w

        series = ["C0", "C1", "C2", "C3"][int(rng.integers(0, 4))]
        if categorical:
            heights = place(py_, ylim, rng.uniform(0.25, 0.9, len(px_["vals"])))
            ax.bar(px_["vals"], heights, width=0.6, color=series)
        elif kind == "line":
            ax.plot(place(px_, xlim, u), place(py_, ylim, v), color=series, lw=float(rng.uniform(1.0, 2.0)),
                    marker=str(rng.choice(["", "o"])), ms=4)
        else:
            ax.scatter(place(px_, xlim, u), place(py_, ylim, v), s=float(rng.uniform(8, 30)), color=series)
        for axis, plan, lim, name in ((ax.xaxis, px_, xlim, "x"), (ax.yaxis, py_, ylim, "y")):
            if plan["scale"] == "log10":
                (ax.set_xscale if name == "x" else ax.set_yscale)("log")
            (ax.set_xlim if name == "x" else ax.set_ylim)(*lim)
            axis.set_major_locator(plan["locator"] if plan["locator"] is not None else mticker.FixedLocator(plan["vals"]))
            if plan["formatter"] is not None:
                axis.set_major_formatter(plan["formatter"])
            elif plan["labels"] is not None:
                axis.set_major_formatter(mticker.FixedFormatter(plan["labels"]))
            if plan["minor"] and ticks_drawn and plan["scale"] == "log10":
                axis.set_minor_locator(mticker.LogLocator(base=10, subs=np.arange(2, 10), numticks=100))
                axis.set_minor_formatter(mticker.NullFormatter())
            elif plan["minor"] and ticks_drawn and plan["vals"] is not None:
                step = plan["vals"][1] - plan["vals"][0]
                axis.set_minor_locator(mticker.FixedLocator([t + step / 2 for t in plan["vals"][:-1]]))
            else:
                axis.set_minor_locator(mticker.NullLocator())
        if spec.get("xrev"):
            ax.invert_xaxis()
        if spec.get("yrev"):
            ax.invert_yaxis()
        if grid and plain_style:
            ax.grid(True, which="major", color="#d0d0d0", linewidth=0.6)
        if frame == "L":
            ax.spines["top"].set_visible(False)
            ax.spines["right"].set_visible(False)
        for lab in ax.get_xticklabels() + ax.get_yticklabels():
            lab.set_fontweight(weight)
            lab.set_fontstyle(fstyle)
        if spec.get("xrot") == 45:
            plt.setp(ax.get_xticklabels(), rotation=45, ha="right", rotation_mode="anchor")
        elif spec.get("xrot"):
            plt.setp(ax.get_xticklabels(), rotation=spec["xrot"])
        if spec.get("yrot"):
            plt.setp(ax.get_yticklabels(), rotation=spec["yrot"], va="center")
        if rng.random() < 0.4:
            ax.set_title(str(rng.choice(["Measured response", "Figure 4", "Summary of results", "Trend"])))
        ax.set_xlabel(str(rng.choice(["Group", "Category"]) if categorical
                          else rng.choice(["Time", "Concentration (mg/L)", "Distance [km]", "x"])))
        ax.set_ylabel(str(rng.choice(["Response", "Intensity (a.u.)", "Count", "y"])))
        fig.tight_layout()
        if crisp:
            fig.canvas.draw()
            (x0, y0), (x1, y1) = ax.get_position().get_points() * [fig.bbox.width, fig.bbox.height]
            fw, fh = fig.bbox.width, fig.bbox.height

            def snap(q: float) -> float:
                return math.floor(q) + 0.5

            ax.set_position([snap(x0) / fw, snap(y0) / fh, (snap(x1) - snap(x0)) / fw, (snap(y1) - snap(y0)) / fh])
        fig.canvas.draw()
        W, H = fig.canvas.get_width_height()
        rgba = np.asarray(fig.canvas.buffer_rgba()).copy()
        truth = extract_truth(fig, ax, W, H, px_["scale"], py_["scale"], frame, "out", no_x_ticks=not ticks_drawn,
                              no_y_ticks=not ticks_drawn)
        notes = {k: a.get_offset_text().get_text() for k, a in (("x", ax.xaxis), ("y", ax.yaxis))
                 if a.get_offset_text().get_text()}
        plt.close(fig)
    for key, plan in (("xAxis", px_), ("yAxis", py_)):
        if plan["scale"] in ("categorical", "time-of-day"):  # positions only: these labels carry no values
            for k, t in enumerate(truth[key]["ticks"]):
                t["value"] = float(k)

    img = Image.fromarray(rgba[:, :, :3])
    tags = [f"x:{px_['scale']}", f"y:{py_['scale']}", f"kind:{kind}", "grid" if grid else "no-grid", f"frame:{frame}",
            "ticks:out", "upright", "jpeg" if jpeg_q else "png", "crisp" if crisp else "antialiased",
            "dpi:low" if dpi <= 96 else "dpi:mid" if dpi <= 150 else "dpi:high", "label-variety"]
    variants = list(px_["tags"]) + [t for t in py_["tags"] if t not in px_["tags"]]
    if spec.get("xrot"):
        variants.append(f"label:rot{spec['xrot']}")
    if spec.get("yrot"):
        variants.append("label:y-rot90")
    if spec.get("xrev") or spec.get("yrev"):
        variants.append("label:reversed")
    if "font" in spec and i != 124:
        variants.append("label:" + ("bold" if weight == "bold" else "italic" if fstyle == "italic" else
                                    {"Franklin Gothic Medium Cond": "condensed", "Consolas": "mono"}.get(family, "serif")))
    if "em" in spec:
        variants.append("label:tiny")
    if "color" in spec:
        variants += ["label:grey", "grey-axes"]
    if "xcolor" in spec:
        variants.append("label:coloured")
    if not ticks_drawn:
        variants += ["label:no-tickmarks", "x-no-tickmarks", "no-tickmarks"]
    if style == "dark_background":
        variants.append("label:dark-bg")
    if any(plan["minor"] and ticks_drawn for plan in (px_, py_)):
        variants.append("minor-ticks")
    tags += [t for t in variants if t not in tags]
    name = f"c{i:02d}"
    ext = "jpg" if jpeg_q else "png"
    doc = {
        "image": f"{name}.{ext}",
        "width": img.width,
        "height": img.height,
        "description": (f"Synthetic label-variety chart ({kind}; X labels: {spec['x']}, Y labels: {spec['y']}"
                        + "".join(f", {k} {spec[k]}" for k in ("xrot", "yrot", "xrev", "yrev", "minus", "style") if k in spec)
                        + (f"; axis notes {notes}" if notes else "")
                        + f"), dpi {dpi}, font {family} {weight} {fstyle} {fontsize:.1f}pt" + (f", JPEG q{jpeg_q}" if jpeg_q else "")
                        + ". Generated by bench/axes/generate.py."),
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
        # tick1/label1 = bottom/left; an axis moved to the top/right draws tick2/label2 only.
        if not (t.tick1line.get_visible() or t.tick2line.get_visible()):
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
        label = (t.label1.get_text() if t.label1.get_visible()
                 else t.label2.get_text() if t.label2.get_visible() else "")
        if label:
            e["label"] = label
        if which == "minor":
            e["minor"] = True
        out.append(e)
    return out


def extract_truth(fig, ax, W, H, xscale, yscale, frame, tickdir, no_x_ticks, top_x=False, right_y=False,
                  no_y_ticks=False):
    box = px_of(ax.transAxes.transform([(0, 1), (1, 1), (1, 0), (0, 0)]), H)  # TL TR BR BL

    def spine_line(name: str, fallback: np.ndarray) -> tuple[np.ndarray, bool]:
        sp = ax.spines[name]
        if frame == "ggplot" or not sp.get_visible():
            return fallback, False
        verts = sp.get_transform().transform(sp.get_path().vertices)
        return px_of(verts[[0, -1]], H), True

    xline, xdrawn = spine_line("top", box[[0, 1]]) if top_x else spine_line("bottom", box[[3, 2]])
    yline, ydrawn = spine_line("right", box[[2, 1]]) if right_y else spine_line("left", box[[3, 0]])
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
        "yAxis": axis_doc(yscale, yline, ydrawn, y_ticks, not no_y_ticks),
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
    for i in list(range(COUNT)) + sorted(HANDLETTERED) + sorted(RANGE_FRAME) + sorted(LABEL_VARIETY):
        img, doc, q = (build_handlettered(i) if i in HANDLETTERED else build_range(i) if i in RANGE_FRAME
                       else build_labels(i) if i in LABEL_VARIETY else build(i))
        name = doc["image"]
        if q:
            img.save(OUT / name, quality=q)
            img = Image.open(OUT / name)
        else:
            img.save(OUT / name, optimize=True)
        (OUT / f"c{i:02d}.json").write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
        # Light lines on a dark background: the check measures darkness, so look at the negative.
        err = self_check(Image.eval(img, lambda p: 255 - p) if "label:dark-bg" in doc["tags"] else img, doc)
        total += (OUT / name).stat().st_size
        flag = "" if err <= 0.35 else "  <-- truth check FAILED"
        bad += err > 0.35
        print(f"{name:8s} {img.width:5d}x{img.height:<5d} truth-check {err:4.2f}px  {' '.join(doc['tags'])}{flag}")
    print(f"{COUNT + len(HANDLETTERED) + len(RANGE_FRAME) + len(LABEL_VARIETY)} charts, {total / 1e6:.2f} MB of images")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
