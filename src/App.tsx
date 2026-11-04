import { SCALE_TYPES } from './core/index.ts';

/** Placeholder page until the digitizing UI lands in Phase 2. */
export function App() {
  return (
    <main className="placeholder">
      <h1>Graph Digitizer</h1>
      <p>
        Extract numeric data from chart images, entirely in your browser. The digitizing workspace
        is under construction.
      </p>
      <p className="muted">Calibration engine ready — scales: {SCALE_TYPES.join(', ')}.</p>
    </main>
  );
}
