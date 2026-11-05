/**
 * The one place the app gets its line tracer from: the engine in src/auto/trace/index.ts.
 * Keeping it behind this seam lets the worker swap tracers without touching its message code.
 */

export { traceLine } from '../auto/trace/index.ts';
