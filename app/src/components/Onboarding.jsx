import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { TelegramConnect, KeyField } from "./Settings";

/* ── First-run onboarding ────────────────────────────────────────────
   Shown by App.jsx when setup isn't done. First it asks how this Mac
   will be used:

     HUB    — the full app (this Mac owns Telegram, sweeps, computes the
              queue, publishes to Cadence Cloud). The original wizard:
              welcome → profile → Telegram → AI keys.
     CLIENT — a second Mac that just tracks todos your hub published.
              No Telegram, no keys — it connects to Cadence Cloud and
              reads/acts (exactly like the iPhone). Flow: project → sign in.

   Picking a mode persists `appMode` immediately (so the backend + the
   publisher's isHub guard flip before anything else happens — a client
   must never publish). `mode` prop is the already-chosen mode, so a
   client whose session lapsed re-enters straight at Cloud sign-in. */

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
const cloudInput = {
  background: "var(--surface-3)", border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)", padding: "var(--space-2) var(--space-2-5)",
  fontSize: "var(--font-md)", color: "var(--text)", fontFamily: "inherit",
  outline: "none", width: "100%",
};

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
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} style={cloudInput} />
    </label>
  );
}

function Dots({ step, total }) {
  return (
    <div className="flex justify-center gap-1.5 pt-1">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          style={{
            width: 6, height: 6, borderRadius: "var(--radius-pill)",
            background: i === step ? "var(--brand)" : "var(--surface-3)",
          }}
        />
      ))}
    </div>
  );
}

// A pickable mode card for the first screen.
function ModeCard({ title, desc, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-left rounded-lg border w-full disabled:opacity-50"
      style={{
        background: "var(--surface-3)", borderColor: "var(--border)",
        padding: "var(--space-3-5)", cursor: disabled ? "default" : "pointer",
      }}
    >
      <div style={{ fontSize: "var(--font-md)", fontWeight: 700, color: "var(--text)", marginBottom: "var(--space-1)" }}>
        {title}
      </div>
      <div style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)", lineHeight: 1.5 }}>
        {desc}
      </div>
    </button>
  );
}

export default function Onboarding({ onDone, mode = "hub" }) {
  // phase: "choose" (mode picker) | "hub" (full wizard) | "client" (cloud).
  // A client whose session lapsed comes back straight to the client flow.
  const [phase, setPhase] = useState(mode === "client" ? "client" : "choose");
  const [step, setStep] = useState(1); // hub wizard: 1 profile · 2 telegram · 3 keys

  // Hub profile fields — saved on Continue or skipped blank.
  const [profileName, setProfileName] = useState("");
  const [profileCompany, setProfileCompany] = useState("");
  const [profileRole, setProfileRole] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [finishing, setFinishing] = useState(false);

  // Client cloud-connect fields.
  const [cfgUrl, setCfgUrl] = useState("");
  const [cfgKey, setCfgKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [cEmail, setCEmail] = useState("");
  const [cPassword, setCPassword] = useState("");
  const [clientBusy, setClientBusy] = useState(false);

  // Save failures surfaced inline, never swallowed.
  const [saveError, setSaveError] = useState(null);
  useEffect(() => { setSaveError(null); }, [step, phase]);

  // ── mode choice ──
  const chooseHub = async () => {
    setSaveError(null);
    try {
      await api.saveSetupKeys({ appMode: "hub" });
      setPhase("hub"); setStep(1);
    } catch (e) {
      setSaveError(`Couldn't start setup — ${e.message}`);
    }
  };
  const chooseClient = async () => {
    setSaveError(null);
    try {
      // Persist client mode NOW — this flips the publisher's isHub guard off
      // before we sign in, so the sign-in's publishSoon() can never push.
      await api.saveSetupKeys({ appMode: "client" });
      setPhase("client");
    } catch (e) {
      setSaveError(`Couldn't start setup — ${e.message}`);
    }
  };

  // ── hub wizard ──
  const saveProfileAndAdvance = async (next) => {
    setSavingProfile(true);
    setSaveError(null);
    try {
      await api.saveSetupKeys({
        userName: profileName.trim(),
        userCompany: profileCompany.trim(),
        userRole: profileRole.trim(),
      });
      setStep(next);
    } catch (e) {
      setSaveError(`Couldn't save your profile — ${e.message}. Try again, or Skip.`);
    } finally {
      setSavingProfile(false);
    }
  };
  const onTelegramChanged = async () => {
    setSaveError(null);
    try {
      const s = await api.getSetupStatus();
      if (s.telegram) setStep(3);
    } catch (e) {
      setSaveError(`Couldn't confirm the Telegram connection — ${e.message}`);
    }
  };
  const finishHub = async () => {
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

  // ── client wizard ──
  const saveCloudConfig = async () => {
    setClientBusy(true);
    setSaveError(null);
    try {
      await api.cloudConfig(cfgUrl.trim(), cfgKey.trim()); // validated live before saving
      setConfigured(true);
    } catch (e) {
      setSaveError(`Couldn't reach that project — ${e.message}`);
    } finally {
      setClientBusy(false);
    }
  };
  const clientSignIn = async () => {
    setClientBusy(true);
    setSaveError(null);
    try {
      await api.cloudSignIn(cEmail.trim(), cPassword);
      await api.saveSetupKeys({ onboarded: "true" }); // appMode already "client"
      onDone();
    } catch (e) {
      setSaveError(`Couldn't sign in — ${e.message}`);
    } finally {
      setClientBusy(false);
    }
  };

  const Wordmark = () => (
    <div
      aria-hidden="true"
      style={{
        width: 44, height: 44, margin: "0 auto", borderRadius: "var(--radius-lg)",
        background: "linear-gradient(135deg, var(--brand), var(--brand-soft))",
        color: "var(--brand-fg)", display: "grid", placeItems: "center",
        fontSize: "var(--font-3xl)", fontWeight: 700,
        boxShadow: "0 0 0 1px rgba(255,255,255,0.05), 0 4px 12px var(--accent-glow)",
      }}
    >
      C
    </div>
  );

  return (
    <div
      className="flex items-center justify-center"
      style={{ minHeight: "100vh", background: "var(--surface)", padding: "var(--space-6)" }}
    >
      <div
        className="rounded-xl border space-y-4"
        style={{
          width: 460, maxWidth: "100%", background: "var(--surface-2)",
          borderColor: "var(--border)", padding: "var(--space-7)",
        }}
      >
        {/* ── mode choice ── */}
        {phase === "choose" && (
          <div className="space-y-3 text-center">
            <Wordmark />
            <h1 style={{ fontSize: "var(--font-2xl)", fontWeight: 700, color: "var(--text)" }}>
              Welcome to Cadence
            </h1>
            <p style={body}>
              How will you use this Mac? You can change this later in Settings.
            </p>
            <div className="space-y-2 text-left" style={{ paddingTop: "var(--space-1)" }}>
              <ModeCard
                title="This is my main Mac (hub)"
                desc="Connect Telegram and your AI keys. Cadence reads your chats and meetings, builds the queue, and publishes it to your phone and any client Macs."
                onClick={chooseHub}
              />
              <ModeCard
                title="Track my todos from here (client)"
                desc="A second Mac that reads the todos and queue your hub already publishes. No Telegram or keys — just sign in to Cadence Cloud. Nothing here can affect your hub."
                onClick={chooseClient}
              />
            </div>
          </div>
        )}

        {/* ── HUB: profile ── */}
        {phase === "hub" && step === 1 && (
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
              <button className={ghostBtn} style={ghostStyle} onClick={() => setPhase("choose")}>
                ← Back
              </button>
              <div className="flex items-center" style={{ gap: "var(--space-2)" }}>
                <button className={linkBtn} style={linkStyle} onClick={() => setStep(2)}>
                  Skip →
                </button>
                <button className={primaryBtn} style={primaryStyle} disabled={savingProfile} onClick={() => saveProfileAndAdvance(2)}>
                  {savingProfile ? "Saving…" : "Continue"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── HUB: Telegram ── */}
        {phase === "hub" && step === 2 && (
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

        {/* ── HUB: keys ── */}
        {phase === "hub" && step === 3 && (
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
                <Ext href="https://console.anthropic.com/settings/keys">Get a key →</Ext>{" "}
                <span style={hintFaint}>(sign in / sign up → "Create Key" → starts with <code>sk-ant-…</code>)</span>
              </p>
              <KeyField configured={false} placeholder="sk-ant-…" onSave={(v) => api.saveSetupKeys({ anthropicKey: v })} />
            </div>
            <div className="space-y-1" style={{ marginTop: "var(--space-3)" }}>
              <label style={fieldLabel}>Granola API key</label>
              <p style={hint}>
                Optional — syncs your Granola meeting notes so todos can be
                extracted from them too.{" "}
                <Ext href="https://granola.ai">Open Granola →</Ext>{" "}
                <span style={hintFaint}>(Granola app → Settings → API → create a personal key, <code>grn_…</code>)</span>
              </p>
              <KeyField configured={false} placeholder="grn_…" onSave={(v) => api.saveSetupKeys({ granolaKey: v })} />
            </div>
            <div className="flex items-center justify-between pt-1">
              <button className={ghostBtn} style={ghostStyle} onClick={() => setStep(2)}>
                ← Back
              </button>
              <button className={primaryBtn} style={primaryStyle} disabled={finishing} onClick={finishHub}>
                {finishing ? "Finishing…" : "Finish →"}
              </button>
            </div>
          </div>
        )}

        {/* ── CLIENT: connect Cadence Cloud ── */}
        {phase === "client" && !configured && (
          <div className="space-y-3">
            <h1 style={heading}>Connect to Cadence Cloud</h1>
            <p style={body}>
              Point this Mac at the same project your hub publishes to. The
              quickest way: on your hub Mac open{" "}
              <strong>Settings → Cadence Cloud → Set up iPhone</strong> — the
              two values under the QR code are what you paste here (they're
              also what you used on the phone).
            </p>
            <div className="space-y-2">
              <OnbField label="Project URL" value={cfgUrl} setValue={setCfgUrl} placeholder="https://<ref>.supabase.co" />
              <OnbField label="Anon key" value={cfgKey} setValue={setCfgKey} placeholder="eyJhbGci…" />
            </div>
            <div className="flex items-center justify-between pt-1">
              <button className={ghostBtn} style={ghostStyle} onClick={() => setPhase("choose")}>
                ← Back
              </button>
              <button
                className={primaryBtn} style={primaryStyle}
                disabled={clientBusy || !cfgUrl.trim() || !cfgKey.trim()}
                onClick={saveCloudConfig}
              >
                {clientBusy ? "Checking…" : "Continue"}
              </button>
            </div>
          </div>
        )}

        {/* ── CLIENT: sign in ── */}
        {phase === "client" && configured && (
          <div className="space-y-3">
            <h1 style={heading}>Sign in</h1>
            <p style={body}>
              Use the same email and password as your hub Mac and phone. This
              Mac will read your todos and queue — it never touches Telegram
              and can't change anything on your hub.
            </p>
            <div className="space-y-2">
              <input
                type="email" value={cEmail} placeholder="you@company.com" autoComplete="username"
                onChange={(e) => setCEmail(e.target.value)} style={cloudInput}
              />
              <input
                type="password" value={cPassword} placeholder="Password" autoComplete="current-password"
                onChange={(e) => setCPassword(e.target.value)} style={cloudInput}
              />
            </div>
            <div className="flex items-center justify-between pt-1">
              <button className={ghostBtn} style={ghostStyle} onClick={() => setConfigured(false)}>
                ← Back
              </button>
              <button
                className={primaryBtn} style={primaryStyle}
                disabled={clientBusy || !cEmail.trim() || !cPassword}
                onClick={clientSignIn}
              >
                {clientBusy ? "Signing in…" : "Sign in →"}
              </button>
            </div>
          </div>
        )}

        {saveError && (
          <p role="alert" style={{ color: "var(--danger, #e5484d)", fontSize: "var(--font-sm)", marginTop: "var(--space-3)" }}>
            {saveError}
          </p>
        )}

        {phase === "hub" && <Dots step={step - 1} total={3} />}
      </div>
    </div>
  );
}
