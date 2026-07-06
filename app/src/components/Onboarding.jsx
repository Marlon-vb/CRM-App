import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { TelegramConnect, KeyField } from "./Settings";

/* ── First-run onboarding ────────────────────────────────────────────
   Shown by App.jsx when the per-user setup isn't done yet. A 4-step
   wizard: welcome → who you are → connect Telegram → optional AI keys.
   Each step after the first has Back; profile / Telegram / keys can all
   be skipped. Finishing or skipping sets the `onboarded` flag (same
   settings-store contract as PipeWise: saveSetupKeys({onboarded:"true"}),
   status() exposes it as a boolean) so the wizard doesn't reappear. */

const primaryBtn = "px-4 py-2 rounded-md text-sm font-semibold disabled:opacity-50";
const primaryStyle = { background: "var(--brand)", color: "var(--brand-fg)" };
const ghostBtn = "px-3 py-2 rounded-md text-sm font-medium";
const ghostStyle = { background: "var(--surface-3)", color: "var(--text)" };
const linkBtn = "text-sm font-medium px-1";
const linkStyle = { color: "var(--text-muted)", background: "none" };
const heading = { fontSize: "var(--font-xl)", fontWeight: 700, color: "var(--text)" };
const body = { fontSize: "var(--font-md)", color: "var(--text-secondary)", lineHeight: 1.55 };
const fieldLabel = { fontSize: "var(--font-base)", fontWeight: 600, color: "var(--text)" };
const hint = { fontSize: "var(--font-sm)", color: "var(--text-muted)", lineHeight: 1.5, margin: "2px 0 6px" };
const hintFaint = { color: "var(--text-faint)" };
const extLinkStyle = { color: "var(--brand)", fontWeight: 500, textDecoration: "none" };

// External link — opens in the system browser (main.js routes target=_blank
// through shell.openExternal so the click leaves the Electron window).
function Ext({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={extLinkStyle}>
      {children}
    </a>
  );
}

function OnbField({ label, value, setValue, placeholder }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <span style={{
        fontSize: "var(--font-xs)", fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
        fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
        color: "var(--text-faint)",
      }}>
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        style={{
          background: "var(--surface-3)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)", padding: "var(--space-2) var(--space-2-5)",
          fontSize: "var(--font-md)", color: "var(--text)",
          fontFamily: "inherit", outline: "none",
        }}
      />
    </label>
  );
}

function Dots({ step, total = 4 }) {
  return (
    <div className="flex justify-center gap-1.5 pt-1">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: "var(--radius-pill)",
            background: i === step ? "var(--brand)" : "var(--surface-3)",
          }}
        />
      ))}
    </div>
  );
}

export default function Onboarding({ onDone }) {
  const [step, setStep] = useState(0);

  // Profile fields — captured in step 1; saved on Continue or skipped blank.
  const [profileName, setProfileName] = useState("");
  const [profileCompany, setProfileCompany] = useState("");
  const [profileRole, setProfileRole] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [finishing, setFinishing] = useState(false);
  // Save failures are surfaced inline, never swallowed — a silent failure
  // here loses the user's profile or makes the wizard reappear next launch.
  const [saveError, setSaveError] = useState(null);

  // A stale error from one step shouldn't haunt the next (Skip/Back jump
  // steps without going through a save handler).
  useEffect(() => { setSaveError(null); }, [step]);

  const saveProfileAndAdvance = async (next) => {
    setSavingProfile(true);
    setSaveError(null);
    try {
      await api.saveSetupKeys({
        userName: profileName.trim(),
        userCompany: profileCompany.trim(),
        userRole: profileRole.trim(),
      });
      setStep(next); // only advance once the profile actually saved
    } catch (e) {
      setSaveError(`Couldn't save your profile — ${e.message}. Try again, or Skip.`);
    } finally {
      setSavingProfile(false);
    }
  };

  // When Telegram connects, re-check status and advance to AI keys.
  const onTelegramChanged = async () => {
    setSaveError(null);
    try {
      const s = await api.getSetupStatus();
      if (s.telegram) setStep(3);
    } catch (e) {
      setSaveError(`Couldn't confirm the Telegram connection — ${e.message}`);
    }
  };

  // End onboarding — mark it done so the wizard doesn't reappear. If the
  // flag fails to save, stay open and show the error: closing anyway would
  // bring the wizard back on next launch with no explanation.
  const finish = async () => {
    setFinishing(true);
    setSaveError(null);
    try {
      await api.saveSetupKeys({ onboarded: "true" });
      onDone();
    } catch (e) {
      setSaveError(`Couldn't finish setup — ${e.message}. Check the backend is running and try again.`);
    } finally {
      setFinishing(false);
    }
  };

  return (
    <div
      className="flex items-center justify-center"
      style={{ minHeight: "100vh", background: "var(--surface)", padding: "var(--space-6)" }}
    >
      <div
        className="rounded-xl border space-y-4"
        style={{
          width: 460,
          maxWidth: "100%",
          background: "var(--surface-2)",
          borderColor: "var(--border)",
          padding: "var(--space-7)",
        }}
      >
        {step === 0 && (
          <div className="space-y-3 text-center">
            {/* Wordmark tile — same gradient "C" as the sidebar (App.jsx);
                Cadence ships no bitmap logo asset. */}
            <div
              aria-hidden="true"
              style={{
                width: 44, height: 44, margin: "0 auto",
                borderRadius: "var(--radius-lg)",
                background: "linear-gradient(135deg, var(--brand), var(--brand-soft))",
                color: "var(--brand-fg)",
                display: "grid", placeItems: "center",
                fontSize: "var(--font-3xl)", fontWeight: 700,
                boxShadow: "0 0 0 1px rgba(255,255,255,0.05), 0 4px 12px var(--accent-glow)",
              }}
            >
              C
            </div>
            <h1 style={{ fontSize: "var(--font-2xl)", fontWeight: 700, color: "var(--text)" }}>
              Welcome to Cadence
            </h1>
            <p style={body}>
              Never miss a follow-up. Cadence reads your Telegram conversations
              and Granola meetings and keeps one list of who to reply to, what
              you promised, and who's going cold. A couple of quick steps to
              connect your accounts — everything is stored encrypted on this
              Mac and never leaves it.
            </p>
            <button className={primaryBtn} style={primaryStyle} onClick={() => setStep(1)}>
              Get started
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <h1 style={heading}>Tell us about yourself</h1>
            <p style={body}>
              We weave your name, role, and company into every AI prompt — so
              reply drafts and todo extraction sound like you, not a generic
              persona. All optional; you can edit these any time in Settings.
            </p>
            <div className="space-y-2">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-2-5)" }}>
                <OnbField label="Your name" value={profileName} setValue={setProfileName} placeholder="e.g. Alex" />
                <OnbField label="Role" value={profileRole} setValue={setProfileRole} placeholder="e.g. BD Lead" />
              </div>
              <OnbField label="Company" value={profileCompany} setValue={setProfileCompany} placeholder="e.g. Acme Markets" />
            </div>
            <div className="flex items-center justify-between pt-1">
              <button className={ghostBtn} style={ghostStyle} onClick={() => setStep(0)}>
                ← Back
              </button>
              <div className="flex items-center" style={{ gap: "var(--space-2)" }}>
                <button className={linkBtn} style={linkStyle} onClick={() => setStep(2)}>
                  Skip →
                </button>
                <button
                  className={primaryBtn}
                  style={primaryStyle}
                  disabled={savingProfile}
                  onClick={() => saveProfileAndAdvance(2)}
                >
                  {savingProfile ? "Saving…" : "Continue"}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <h1 style={heading}>Connect Telegram</h1>
            <p style={body}>
              Cadence builds your follow-up queue from your Telegram chats —
              connect your account, or skip and do it later in Settings.
            </p>
            <TelegramConnect connected={false} onChanged={onTelegramChanged} />
            <div className="flex items-center justify-between pt-1">
              <button className={ghostBtn} style={ghostStyle} onClick={() => setStep(1)}>
                ← Back
              </button>
              <button className={linkBtn} style={linkStyle} onClick={() => setStep(3)}>
                Skip for now →
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <h1 style={heading}>AI keys</h1>
            <p style={body}>
              Optional — add them now or later in Settings. Both keys stay
              encrypted on this Mac and are only used by Cadence.
            </p>
            <div className="space-y-1">
              <label style={fieldLabel}>Anthropic API key</label>
              <p style={hint}>
                Powers AI reply drafting and todo extraction.{" "}
                <Ext href="https://console.anthropic.com/settings/keys">
                  Get a key →
                </Ext>{" "}
                <span style={hintFaint}>
                  (sign in / sign up → "Create Key" → starts with <code>sk-ant-…</code>)
                </span>
              </p>
              <KeyField
                configured={false}
                placeholder="sk-ant-…"
                onSave={(v) => api.saveSetupKeys({ anthropicKey: v })}
              />
            </div>
            <div className="space-y-1" style={{ marginTop: "var(--space-3)" }}>
              <label style={fieldLabel}>Granola API key</label>
              <p style={hint}>
                Optional — syncs your Granola meeting notes so todos can be
                extracted from them too.{" "}
                <Ext href="https://granola.ai">Open Granola →</Ext>{" "}
                <span style={hintFaint}>
                  (in the Granola app → Settings → API → create a personal key,
                  starts with <code>grn_…</code>)
                </span>
              </p>
              <KeyField
                configured={false}
                placeholder="grn_…"
                onSave={(v) => api.saveSetupKeys({ granolaKey: v })}
              />
            </div>
            <div className="flex items-center justify-between pt-1">
              <button className={ghostBtn} style={ghostStyle} onClick={() => setStep(2)}>
                ← Back
              </button>
              <button className={primaryBtn} style={primaryStyle} disabled={finishing} onClick={finish}>
                {finishing ? "Finishing…" : "Finish →"}
              </button>
            </div>
          </div>
        )}

        {saveError && (
          <p
            role="alert"
            style={{
              color: "var(--danger, #e5484d)",
              fontSize: "var(--font-sm)",
              marginTop: "var(--space-3)",
            }}
          >
            {saveError}
          </p>
        )}

        <Dots step={step} />
      </div>
    </div>
  );
}
