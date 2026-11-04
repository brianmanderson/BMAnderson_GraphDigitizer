/**
 * Skew estimation: a Hough transform restricted to near-horizontal and near-vertical lines.
 *
 * For each trial angle θ every ink pixel votes for its frame offsets w (horizontal family) and
 * u (vertical family) in 1-px bins. Long straight lines — axes, frames, gridlines — pile their
 * votes into few bins only at the right angle, while text and curves spread out. The evidence for
 * an angle is the sum of squared bin counts (the classic projection-profile sharpness), which
 * rewards concentration even for lines several pixels thick. Both families vote together because
 * a rotation turns them by the same angle. A coarse sweep is refined around the best angle, and
 * the result snaps back to exactly 0 when that explains the image (nearly) as well — the usual
 * case, which keeps the projection profiles on whole pixels. detect.ts then refines the angle
 * further from the slopes of the longest fitted lines.
 */

import { INK_THRESHOLD, type DarknessMap } from './darkness.ts';

export const MAX_SKEW_DEGREES = 5;
const COARSE_STEP = 0.1;
const FINE_STEP = 0.01;
const MAX_VOTERS = 200_000;

export interface SkewEstimate {
  /** Radians, positive = clockwise on screen. */
  theta: number;
  /** Line evidence at θ relative to θ = 0 (≥ 1; large when the image is clearly rotated). */
  gain: number;
}

function inkPixels(map: DarknessMap): { xs: Float32Array; ys: Float32Array } {
  const { width: w, height: h, dark } = map;
  let count = 0;
  for (let i = 0; i < dark.length; i++) if ((dark[i] ?? 0) >= INK_THRESHOLD) count++;
  const stride = Math.max(1, Math.ceil(count / MAX_VOTERS));
  const n = Math.ceil(count / stride);
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  let k = 0;
  let seen = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((dark[y * w + x] ?? 0) < INK_THRESHOLD) continue;
      if (seen++ % stride === 0 && k < n) {
        xs[k] = x;
        ys[k] = y;
        k++;
      }
    }
  }
  return { xs: xs.subarray(0, k), ys: ys.subarray(0, k) };
}

/** Projection-profile sharpness (sum of squared bins) of both families at angle θ. */
function lineEvidence(
  xs: Float32Array,
  ys: Float32Array,
  theta: number,
  width: number,
  height: number,
  hAcc: Int32Array,
  vAcc: Int32Array,
): number {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const pad = width + height; // offsets range over (−pad, pad)
  hAcc.fill(0);
  vAcc.fill(0);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] ?? 0;
    const y = ys[i] ?? 0;
    const hBin = Math.round(-x * s + y * c) + pad;
    const vBin = Math.round(x * c + y * s) + pad;
    hAcc[hBin] = (hAcc[hBin] ?? 0) + 1;
    vAcc[vBin] = (vAcc[vBin] ?? 0) + 1;
  }
  return sharpness(hAcc) + sharpness(vAcc);
}

function sharpness(acc: Int32Array): number {
  let s = 0;
  for (let i = 0; i < acc.length; i++) s += (acc[i] ?? 0) ** 2;
  return s;
}

export function estimateSkew(map: DarknessMap): SkewEstimate {
  const { xs, ys } = inkPixels(map);
  if (xs.length === 0) return { theta: 0, gain: 1 };
  const size = 2 * (map.width + map.height) + 2;
  const hAcc = new Int32Array(size);
  const vAcc = new Int32Array(size);
  const evidence = (deg: number) =>
    lineEvidence(xs, ys, (deg * Math.PI) / 180, map.width, map.height, hAcc, vAcc);

  const atZero = evidence(0);
  let bestDeg = 0;
  let best = atZero;
  const steps = Math.round(MAX_SKEW_DEGREES / COARSE_STEP);
  for (let k = -steps; k <= steps; k++) {
    const deg = k * COARSE_STEP;
    const e = evidence(deg);
    if (e > best) {
      best = e;
      bestDeg = deg;
    }
  }
  if (bestDeg !== 0) {
    const centre = bestDeg;
    const fine = Math.round(COARSE_STEP / FINE_STEP);
    for (let k = -fine; k <= fine; k++) {
      const deg = centre + k * FINE_STEP;
      const e = evidence(deg);
      if (e > best) {
        best = e;
        bestDeg = deg;
      }
    }
  }
  // Prefer exactly 0 unless the rotation is clearly better (a crisp, unrotated chart's lines all
  // land in single bins at 0; a tiny spurious angle would smear them across pixel rows).
  if (atZero >= 0.97 * best) return { theta: 0, gain: 1 };
  return { theta: (bestDeg * Math.PI) / 180, gain: best / Math.max(1, atZero) };
}
