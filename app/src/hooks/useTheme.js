import { useState, useEffect } from "react";

/* ── Theme hook — mirrors document.documentElement[data-theme] to localStorage ── */
export function useTheme() {
  const [theme, setTheme] = useState(() => {
    if (typeof document === "undefined") return "dark";
    // Persisted preference wins; otherwise default to dark (Mock 1 Linear-style).
    try {
      const stored = localStorage.getItem("cadence-theme");
      if (stored === "dark" || stored === "light") return stored;
    } catch (e) { /* ignore */ }
    return document.documentElement.getAttribute("data-theme") || "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("cadence-theme", theme); } catch (e) { /* ignore */ }
  }, [theme]);

  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return { theme, toggle };
}
