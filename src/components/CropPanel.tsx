import { useState, type FormEvent } from 'react';
import { MIN_CROP, cropHeight, cropWidth, fullCrop, type CropField, type CropRect } from '../ui/crop.ts';

interface Props {
  /** The rectangle chosen so far; null until one is dragged on the canvas or typed here. */
  rect: CropRect | null;
  imageWidth: number;
  imageHeight: number;
  onField: (field: CropField, value: number) => void;
  onApply: () => void;
  onCancel: () => void;
}

/**
 * The Image step's crop mode: Left/Top/Width/Height of the rectangle (image px; typing here
 * moves the rectangle on the canvas and a drag there updates these), the resulting size,
 * "Apply crop" (Enter, also from the inputs) and "Cancel" (Esc). The fields start from the whole
 * image until a rectangle exists; Apply waits for one.
 */
export function CropPanel({ rect, imageWidth, imageHeight, onField, onApply, onCancel }: Props) {
  const shown = rect ?? fullCrop(imageWidth, imageHeight);
  const width = cropWidth(shown);
  const height = cropHeight(shown);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (rect) onApply();
  };
  return (
    // noValidate: the fields clamp their own values, so a half-typed number never blocks Enter.
    <form className="crop-panel" aria-label="Crop" data-testid="crop-panel" onSubmit={submit} noValidate>
      <p className="prompt">Drag a rectangle on the image, or type its edges (image pixels).</p>
      <div className="crop-fields">
        <NumberField label="Left" testId="crop-left" value={shown.x0} min={0} max={imageWidth - MIN_CROP} onChange={(v) => onField('left', v)} />
        <NumberField label="Top" testId="crop-top" value={shown.y0} min={0} max={imageHeight - MIN_CROP} onChange={(v) => onField('top', v)} />
        <NumberField label="Width" testId="crop-width" value={width} min={MIN_CROP} max={imageWidth - shown.x0} onChange={(v) => onField('width', v)} />
        <NumberField label="Height" testId="crop-height" value={height} min={MIN_CROP} max={imageHeight - shown.y0} onChange={(v) => onField('height', v)} />
      </div>
      <p className="hint muted" data-testid="crop-size">
        {rect ? (
          <>
            Result: {width} × {height} px (of {imageWidth} × {imageHeight}).
          </>
        ) : (
          'No rectangle yet.'
        )}
      </p>
      <div className="row">
        <button type="submit" className="primary" disabled={!rect} data-testid="crop-apply" title="Apply the crop (Enter)">
          Apply crop
        </button>
        <button type="button" onClick={onCancel} data-testid="crop-cancel" title="Leave crop mode (Esc)">
          Cancel
        </button>
      </div>
    </form>
  );
}

interface FieldProps {
  label: string;
  testId: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

/**
 * A whole-pixel number input. While it has focus it shows what was typed (so a value in progress
 * is not rewritten under the cursor) and commits each finite value as typed; the clamped value
 * takes over on blur.
 */
function NumberField({ label, testId, value, min, max, onChange }: FieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="field">
      {label}
      <input
        type="number"
        inputMode="numeric"
        step={1}
        min={min}
        max={max}
        value={draft ?? String(value)}
        data-testid={testId}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => setDraft(null)}
      />
    </label>
  );
}
