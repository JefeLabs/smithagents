interface ChipProps {
  label: string;
  pressed: boolean;
  onToggle: () => void;
}

export function Chip({ label, pressed, onToggle }: ChipProps) {
  return (
    <button type="button" className="chip" aria-pressed={pressed} onClick={onToggle}>
      {label}
    </button>
  );
}
