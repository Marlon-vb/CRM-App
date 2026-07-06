import { Sun, Moon } from "lucide-react";
import { useTheme } from "../../hooks/useTheme";

/* ── Theme toggle button ── */
export const ThemeToggle = () => {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      onClick={toggle}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors hover:bg-gray-100"
      style={{ background: "var(--surface-3)", color: "var(--text-secondary)" }}
    >
      {isDark ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
};
