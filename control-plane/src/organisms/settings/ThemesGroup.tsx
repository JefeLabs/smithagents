import { THEMES, type ThemeId } from "../../hooks/useTheme";

interface ThemesGroupProps {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}

export function ThemesGroup({ theme, onThemeChange }: ThemesGroupProps) {
  return (
    <>
      <h1>themes</h1>
      <div className="theme-row">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`theme-chip${theme === t.id ? " is-picked" : ""}`}
            onClick={() => onThemeChange(t.id)}
            title={t.label}
            aria-pressed={theme === t.id}
          >
            <span className="theme-chip__swatch" style={{ background: t.swatch }} />
            {t.label}
          </button>
        ))}
      </div>
    </>
  );
}
