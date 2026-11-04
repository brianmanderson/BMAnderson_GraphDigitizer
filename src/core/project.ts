/**
 * The Project data model (docs/SPEC.md → Data model).
 *
 * Points and refs are stored in image pixel coordinates (sub-pixel floats, origin at the image's
 * top-left, y down). Data values are always derived through the calibration, never stored.
 */

import { DEFAULT_DATE_FORMAT } from './dates.ts';
import type { ScaleType } from './scales.ts';

export const PROJECT_VERSION = 1;

export const REF_NAMES = ['X1', 'X2', 'Y1', 'Y2'] as const;

export type RefName = (typeof REF_NAMES)[number];

/** A calibration reference: where it was clicked, and the axis value typed for it. */
export interface RefPoint {
  px: number;
  py: number;
  /** A number, or text: a date/time string on date axes, or a numeric string. */
  value: number | string;
}

export type CalibrationRefs = Record<RefName, RefPoint>;

export interface CalibrationSpec {
  xScale: ScaleType;
  yScale: ScaleType;
  refs: CalibrationRefs;
}

export interface ProjectImage {
  dataUrl: string;
  width: number;
  height: number;
  name: string;
}

export interface DataPoint {
  id: string;
  px: number;
  py: number;
}

export interface Dataset {
  id: string;
  name: string;
  /** CSS colour string. */
  color: string;
  points: DataPoint[];
}

export interface ProjectSettings {
  significantFigures: number;
  /** Token format for date axes, see formatDateTime(). */
  dateFormat: string;
}

export interface Project {
  /** Schema version, for loading saved projects across releases. */
  version: typeof PROJECT_VERSION;
  image: ProjectImage;
  calibration: CalibrationSpec | null;
  datasets: Dataset[];
  settings: ProjectSettings;
}

export const DEFAULT_SETTINGS: Readonly<ProjectSettings> = {
  significantFigures: 4,
  dateFormat: DEFAULT_DATE_FORMAT,
};
