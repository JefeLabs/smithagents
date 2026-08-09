import { useCallback, useEffect, useState } from "react";

const STORE_KEY = "smith.theme";

export type ThemeId = "system" | "dark" | "light" | "midnight" | "sand";

export const THEMES: Array<{ id: ThemeId; label: string; swatch: string }> = [
  { id: "system", label: "System", swatch: "linear-gradient(135deg,#0d1119 50%,#f3f5f9 50%)" },
  { id: "dark", label: "Dark", swatch: "#0d1119" },
  { id: "light", label: "Light", swatch: "#f3f5f9" },
  { id: "midnight", label: "Midnight", swatch: "#050a14" },
  { id: "sand", label: "Sand", swatch: "#f6f1e7" },
];

/** Which of our themes are dark. `system` is decided at runtime from the OS. */
const DARK_THEMES: ReadonlySet<ThemeId> = new Set<ThemeId>(["dark", "midnight"]);

/**
 * Theme switcher. Palettes live in tokens.css keyed on `data-theme`; this
 * only decides which key is on <html> and remembers the choice. "system"
 * removes the attribute so the CSS media query takes over — that way the app
 * keeps following the OS after a restart, instead of freezing today's guess.
 */
export function useTheme() {
  const [theme, setTheme] = useState<ThemeId>(() => (localStorage.getItem(STORE_KEY) as ThemeId) || "system");

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    localStorage.setItem(STORE_KEY, theme);
  }, [theme]);

  /**
   * HeroUI's default theme keys its dark palette on `.dark` (and its own
   * [data-theme="dark"], which only lines up for one of our five themes). Mirroring
   * our light/dark intent onto that class is what lets us inherit HeroUI's status
   * colours, field chrome and radii instead of re-deriving them per theme.
   *
   * Separate effect from the one above because `system` has to keep tracking the OS
   * after mount — a one-shot read would strand HeroUI in the wrong palette the moment
   * the user flips their OS appearance.
   */
  useEffect(() => {
    const root = document.documentElement;
    const prefersLight = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const dark = theme === "system" ? !prefersLight.matches : DARK_THEMES.has(theme);
      root.classList.toggle("dark", dark);
    };
    apply();
    prefersLight.addEventListener("change", apply);
    return () => prefersLight.removeEventListener("change", apply);
  }, [theme]);

  const choose = useCallback((next: ThemeId) => setTheme(next), []);
  return { theme, setTheme: choose };
}
