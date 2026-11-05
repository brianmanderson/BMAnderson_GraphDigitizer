export type TraceMode = 'auto' | 'curve' | 'markers';
export interface TraceRequest {
  rgba: Uint8ClampedArray; width: number; height: number;
  plotBox: [number, number][] | null;
  seed: { px: number; py: number };
  mode: TraceMode;
  maxPoints: number;
}
export interface TracedPoint { px: number; py: number; confidence: number }
export interface TraceResult {
  ok: boolean;
  kind: 'curve' | 'markers' | 'none';
  color: [number, number, number];
  path: TracedPoint[];
  points: TracedPoint[];
  message?: string;
  timings: { totalMs: number };
}
