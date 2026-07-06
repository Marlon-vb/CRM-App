/* ─── CompanyLogo ────────────────────────────────────────────────────
   Cadence variant: initials on a hash-colored background, always.

   PipeWise resolved remote logo art first (explicit logoUrl → CoinGecko
   image → Clearbit domain fallback) before falling through to initials.
   Cadence's CSP is `img-src 'self' data:` with NO external origins, so
   the remote tiers are removed outright rather than left to error on
   every render. The hash palette + initials helpers are inlined here —
   this app has no TOKEN_META and no lib/logos. */

/* Company avatar palette (hash-indexed) — same 10 hues as PipeWise. */
const LOGO_COLORS = [
  "#7B6CF6", "#F87171", "#60A5FA", "#34D399", "#F59E0B",
  "#A78BFA", "#EC4899", "#14B8A6", "#F97316", "#6366F1",
];

/* Hashed palette pick for the avatar background. */
const getLogoColor = (name) =>
  LOGO_COLORS[
    Math.abs([...name].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)) %
      LOGO_COLORS.length
  ];

/* Up-to-2-letter initials from a name. */
const getInitials = (name) =>
  name
    .split(/[\s.]+/)
    .filter((w) => w.length > 0)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

export const CompanyLogo = ({ company, small = false }) => {
  const name = (company || "").trim() || "?";
  const dim = small ? 22 : 36;
  const rad = small ? 6 : 8;
  const fontSize = small ? 9 : 12;

  return (
    <div
      className="flex-shrink-0 flex items-center justify-center text-white"
      style={{
        width: dim,
        height: dim,
        borderRadius: rad,
        background: getLogoColor(name),
        fontWeight: 600,
        fontSize,
      }}
    >
      {getInitials(name)}
    </div>
  );
};
