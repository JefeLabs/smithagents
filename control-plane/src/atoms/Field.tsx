import type { CSSProperties, ReactNode } from "react";

interface FieldProps {
  label: ReactNode;
  htmlFor?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function Field({ label, htmlFor, style, children }: FieldProps) {
  return (
    <div className="field" style={style}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}
