import type { LucideIcon } from "lucide-react";

interface ToolButtonProps {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick?: () => void;
}

export function ToolButton({ icon: Icon, label, active = false, onClick }: ToolButtonProps) {
  return (
    <button
      type="button"
      className="tool"
      aria-current={active ? "true" : undefined}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <Icon strokeWidth={1.7} />
    </button>
  );
}
