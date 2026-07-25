import { GRID_META, type GridParams } from "../hooks/useDotGrid";
import { TunerRow } from "../molecules/TunerRow";

interface DotGridTunerProps {
  open: boolean;
  params: GridParams;
  onChange: (key: keyof GridParams, value: number) => void;
  onReset: () => void;
}

const PARAM_KEYS = Object.keys(GRID_META) as (keyof GridParams)[];

export function DotGridTuner({ open, params, onChange, onReset }: DotGridTunerProps) {
  return (
    <aside className="tuner" data-open={open ? "true" : "false"} aria-label="Background tuning">
      <h4>fisheye grid</h4>
      <div>
        {PARAM_KEYS.map((key) => (
          <TunerRow key={key} meta={GRID_META[key]} value={params[key]} onChange={(value) => onChange(key, value)} />
        ))}
      </div>
      <button type="button" onClick={onReset}>
        reset
      </button>
    </aside>
  );
}
