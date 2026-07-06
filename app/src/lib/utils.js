import { LOGO_COLORS } from "../constants";

/* ── Hashed palette pick for company avatar ── */
export const getLogoColor = (name) =>
  LOGO_COLORS[
    Math.abs([...name].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)) %
      LOGO_COLORS.length
  ];

/* ── Up-to-2-letter initials from a name ── */
export const getInitials = (name) =>
  name
    .split(/[\s.]+/)
    .filter((w) => w.length > 0)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

/* ── Relative time formatter ("3m ago", "2h ago", "5d ago", ...) ── */
export const timeAgo = (isoDate) => {
  if (!isoDate) return "";
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
};

/* ── Compact duration ("3d", "2w", "5mo", "1y") for silence badges ── */
export const shortDuration = (isoDate) => {
  if (!isoDate) return "";
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 0) return "";              // future date — ignore
  if (ms < 86400000) return "";       // < 1 day — treat as active, no badge
  const days = Math.floor(ms / 86400000);
  if (days < 7)   return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5)  return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
};
