/** Keyboard nudging of the selected point or ref, in image pixels. */

import { clampDelta, clampToImage } from './view.ts';

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Image pixels per press: 1, Shift 10, Alt 0.1 (Alt wins when both are held). */
export function nudgeStep(mods: { shiftKey: boolean; altKey: boolean }): number {
  return mods.altKey ? 0.1 : mods.shiftKey ? 10 : 1;
}

/** Direction of an arrow key (image y grows downward), or null for any other key. */
export function nudgeDirection(key: string): readonly [number, number] | null {
  return ARROWS[key] ?? null;
}

/**
 * `pos` moved by `step` in direction `dir`, kept on the image. The result is rounded to 1e-6 px
 * so that ten 0.1 px nudges land exactly 1 px away instead of accumulating float noise.
 */
export function nudged(
  pos: { px: number; py: number },
  dir: readonly [number, number],
  step: number,
  width: number,
  height: number,
): { px: number; py: number } {
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  return clampToImage(round(pos.px + dir[0] * step), round(pos.py + dir[1] * step), width, height);
}

/**
 * Every one of `positions` moved by the same step, as a group: the step is shortened so that all
 * of them stay on the image (a selection keeps its shape at the edge), then rounded as `nudged`.
 */
export function nudgedAll(
  positions: readonly { px: number; py: number }[],
  dir: readonly [number, number],
  step: number,
  width: number,
  height: number,
): { px: number; py: number }[] {
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  const { dx, dy } = clampDelta(positions, dir[0] * step, dir[1] * step, width, height);
  return positions.map((p) => clampToImage(round(p.px + dx), round(p.py + dy), width, height));
}
