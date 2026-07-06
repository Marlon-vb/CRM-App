/* ── Sidebar navigation ── */
import { Zap, ListTodo, Users, Settings } from "lucide-react";

// Flat list — Cadence has four tabs, no section headers. `dynamicBadge`
// items get a live count in the sidebar: Queue = actionable queue items
// (fuSummary.queueSize), Todos = open todos due today / overdue / My Day.
export const NAV = [
  { key: "queue", label: "Queue", icon: Zap, dynamicBadge: true },
  { key: "todos", label: "Todos", icon: ListTodo, dynamicBadge: true },
  { key: "clients", label: "Clients", icon: Users },
  { key: "settings", label: "Settings", icon: Settings },
];

/* ── Company avatar palette (hash-indexed) ── */
export const LOGO_COLORS = [
  "#7B6CF6", "#F87171", "#60A5FA", "#34D399", "#F59E0B",
  "#A78BFA", "#EC4899", "#14B8A6", "#F97316", "#6366F1",
];
