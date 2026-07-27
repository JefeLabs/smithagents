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

  const choose = useCallback((next: ThemeId) => setTheme(next), []);
  return { theme, setTheme: choose };
}
