/* Cadence mobile — theme tokens, matching the Mac app's dark palette. */
export const C = {
  bg: "#0B1220",
  surface: "#111A2C",
  surface2: "#16213A",
  surface3: "#1C2A47",
  border: "#1F2C47",
  text: "#E6EDF7",
  textSecondary: "#9FB0C9",
  textFaint: "#7A8DA9", // lightened from #5E7190 — WCAG contrast on bg/surface (audit U8)
  brand: "#7FB4E8",
  brandFg: "#0A1626",
  success: "#4CC38A",
  warning: "#F5C242",
  danger: "#E5747A",
  telegram: "#54A9E8",
};

/* Per-kind identity: color + a translucent tint for chips/accents. */
export const KIND_META = {
  reply:   { label: "Reply owed", color: "#E5747A", tint: "rgba(229,116,122,0.14)", icon: "↩" },
  recap:   { label: "Recap due",  color: "#B78AE8", tint: "rgba(183,138,232,0.14)", icon: "✎" },
  promise: { label: "Promise",    color: "#F5C242", tint: "rgba(245,194,66,0.14)",  icon: "◆" },
  todo:    { label: "Todo",       color: "#7FB4E8", tint: "rgba(127,180,232,0.14)", icon: "☑" },
  cold:    { label: "Going cold", color: "#7FD1E8", tint: "rgba(127,209,232,0.14)", icon: "❄" },
};

export const KIND_ORDER = ["reply", "recap", "promise", "todo", "cold"];

/* Deterministic avatar colors — same hash trick as the Mac's CompanyLogo,
   so a client keeps its color forever. */
const AVATAR_COLORS = [
  "#7FB4E8", "#4CC38A", "#F5C242", "#E5747A", "#B78AE8",
  "#7FD1E8", "#E8A87F", "#8AE8B7", "#E87FB4", "#A8C47F",
];

export function avatarColor(name) {
  let h = 0;
  const s = String(name || "?");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initials(name) {
  const words = String(name || "?").trim().split(/[\s\-–—]+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function timeAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
