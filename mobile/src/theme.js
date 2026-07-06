/* Cadence mobile — theme tokens, matching the Mac app's dark palette. */
export const C = {
  bg: "#0B1220",
  surface: "#111A2C",
  surface2: "#16213A",
  border: "#1F2C47",
  text: "#E6EDF7",
  textSecondary: "#9FB0C9",
  textFaint: "#5E7190",
  brand: "#7FB4E8",
  brandFg: "#0A1626",
  success: "#4CC38A",
  warning: "#F5C242",
  danger: "#E5747A",
  telegram: "#54A9E8",
};

export const KIND_META = {
  reply:   { label: "Reply owed",  color: "#E5747A", icon: "↩" },
  recap:   { label: "Recap due",   color: "#B78AE8", icon: "✎" },
  promise: { label: "Promise",     color: "#F5C242", icon: "◆" },
  todo:    { label: "Todo",        color: "#7FB4E8", icon: "☑" },
  cold:    { label: "Going cold",  color: "#7FD1E8", icon: "❄" },
};

export const KIND_ORDER = ["reply", "recap", "promise", "todo", "cold"];
