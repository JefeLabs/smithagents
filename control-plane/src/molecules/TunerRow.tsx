import type { GridParamMeta } from "../hooks/useDotGrid";

interface TunerRowProps {
  meta: GridParamMeta;
  value: number;
  onChange: (value: number) => void;
}

export function TunerRow({ meta, value, onChange }: TunerRowProps) {
  return (
    <div className="r">
      <div className="t">
        <span>{meta.label}</span>
        <output>{meta.step < 1 ? value.toFixed(2) : String(value)}</output>
      </div>
      <input
        type="range"
        min={meta.min}
        max={meta.max}
        step={meta.step}
        value={value}
        aria-label={meta.label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
