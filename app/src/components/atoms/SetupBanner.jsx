import { useEffect, useState } from "react";
import { AlertCircle, Settings as SettingsIcon } from "lucide-react";
import { api } from "../../lib/api";

/* ── SetupBanner ──
   Polls /api/setup/status and renders a one-line warning when a required key
   is missing. AI-powered features (todo extraction, reply drafting, recap
   drafts) silently 503 when anthropicKey isn't set — that failure mode is
   invisible to a new user on a fresh Mac install (Electron safeStorage
   encrypts settings to the local Keychain, so re-installing on another
   machine starts blank). This banner is the loud version.

   Props:
     require      — which capability must be configured ("anthropic" | "telegram")
     onOpenSettings — callback to switch the active tab to "settings"
     compact      — bool, shrinks padding for inline use
*/
export function SetupBanner({ require: requirement, onOpenSettings, compact = false }) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.getSetupStatus().then(s => { if (!cancelled) setStatus(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!status) return null;

  const labels = {
    anthropic: {
      title: "AI features need an Anthropic API key",
      desc: "Todo extraction, reply drafting, and recap drafts can't run until you add a key in Settings → Anthropic API key.",
    },
    telegram: {
      title: "Telegram isn't connected",
      desc: "Cadence builds your follow-up queue from your Telegram conversations. Connect your account in Settings → Telegram to see live conversations and suggestions.",
    },
  };

  if (status[requirement]) return null; // configured — nothing to show
  const meta = labels[requirement];
  if (!meta) return null;

  return (
    <div
      className="flex items-start"
      style={{
        gap: "var(--space-2-5)",
        padding: compact ? "8px 12px" : "12px 14px",
        borderRadius: "var(--radius-lg)",
        background: "var(--tone-amber-bg, rgba(245,158,11,0.08))",
        border: "1px solid rgba(245,158,11,0.30)",
        marginBottom: "var(--space-4)",
      }}
      role="alert"
    >
      <AlertCircle size={15} style={{ color: "var(--warning, #f59e0b)", flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--font-base)", fontWeight: 600, color: "var(--text)", marginBottom: "var(--space-0-5)" }}>
          {meta.title}
        </div>
        <div style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)", lineHeight: 1.45 }}>
          {meta.desc}
        </div>
      </div>
      {onOpenSettings && (
        <button
          onClick={onOpenSettings}
          className="inline-flex items-center"
          style={{
            gap: "var(--space-1-5)",
            padding: "var(--space-1-5) var(--space-2-5)",
            borderRadius: "var(--radius-md)",
            background: "var(--surface)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            fontSize: "var(--font-sm)",
            fontWeight: 600,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <SettingsIcon size={11} /> Open Settings
        </button>
      )}
    </div>
  );
}
