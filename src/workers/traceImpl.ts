/**
 * The one place the app gets its line tracer from. The real engine (`traceLine` in
 * src/auto/trace/index.ts) is built separately; until it is merged this re-exports the stub.
 * Swapping is this one line:  export { traceLine } from '../auto/trace/index.ts';
 */

export { traceLineStub as traceLine } from '../auto/trace/stub.ts';
