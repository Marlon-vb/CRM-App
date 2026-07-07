import { useState, useEffect } from "react";
import QRCode from "qrcode";
import { api } from "../lib/api";
import { timeAgo } from "../lib/utils";

/* ── Cadence Settings — per-user setup ───────────────────────────────
   Connect your own Telegram account and AI keys. Everything is stored
   encrypted on this Mac; nothing routes through anyone else — except the
   optional Cadence Cloud section (Phase 4), which publishes the computed
   queue + todos to YOUR Supabase project for the iPhone app.
   The two exported pieces (TelegramConnect, KeyField) are reused by the
   first-run onboarding flow. */

const inputCls = "w-full border rounded-md px-2.5 py-1.5 text-sm";
const inputStyle = {
  borderColor: "var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
};
const primaryBtn = "px-3 py-1.5 rounded-md text-xs font-semibold disabled:opacity-50";
const primaryStyle = { background: "var(--brand)", color: "var(--brand-fg)" };
const ghostBtn = "px-3 py-1.5 rounded-md text-xs font-medium disabled:opacity-50";
const ghostStyle = { background: "var(--surface-3)", color: "var(--text)" };
const hintStyle = { fontSize: "var(--font-base)", color: "var(--text-secondary)", lineHeight: 1.5 };
const linkStyle = { color: "var(--brand)", fontWeight: 500 };

/* External link — opens in the system browser (main.js' window-open handler
   routes target=_blank through shell.openExternal). */
function Ext({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" style={linkStyle}>
      {children}
    </a>
  );
}

/* Profile editor — name, company, role.
   These get substituted into every LLM prompt (Haiku reply drafts, todo
   extraction, promise extraction) so the assistant speaks for THIS user
   instead of a hardcoded persona. All fields optional; sensible generic
   fallbacks kick in if blank. */
function ProfileForm({ initial, onSave }) {
  const [name, setName] = useState(initial.userName || "");
  const [company, setCompany] = useState(initial.userCompany || "");
  const [role, setRole] = useState(initial.userRole || "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const dirty =
    name !== (initial.userName || "") ||
    company !== (initial.userCompany || "") ||
    role !== (initial.userRole || "");

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({
        userName: name.trim(),
        userCompany: company.trim(),
        userRole: role.trim(),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      // Surfaced inline like KeyField does — a silent revert of the Save
      // button would read as success.
      setError(`Couldn't save your profile — ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-2-5)" }}>
        <ProfileField label="Your name" value={name} setValue={setName} placeholder="e.g. Alex" />
        <ProfileField label="Role" value={role} setValue={setRole} placeholder="e.g. BD Lead" />
      </div>
      <ProfileField label="Company" value={company} setValue={setCompany} placeholder="e.g. Acme Markets" />
      <div className="flex items-center" style={{ gap: "var(--space-2)", paddingTop: "var(--space-1)" }}>
        <button
          onClick={handleSave}
          disabled={busy || !dirty}
          className={primaryBtn}
          style={primaryStyle}
        >
          {busy ? "Saving…" : saved ? "Saved" : "Save profile"}
        </button>
        {!dirty && !saved && (
          <span style={{ fontSize: "var(--font-sm)", color: "var(--text-faint)" }}>
            Edit any field to enable Save.
          </span>
        )}
      </div>
      {error && <p style={{ fontSize: "var(--font-sm)", color: "var(--danger-soft)" }}>{error}</p>}
    </div>
  );
}

function ProfileField({ label, value, setValue, placeholder }) {
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

function Section({ title, desc, children }) {
  return (
    <div
      className="p-4 rounded-lg border space-y-3"
      style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
    >
      <div>
        <h3 style={{ fontSize: "var(--font-lg)", fontWeight: 600, color: "var(--text)" }}>{title}</h3>
        {desc && <p style={{ ...hintStyle, marginTop: "var(--space-0-5)" }}>{desc}</p>}
      </div>
      {children}
    </div>
  );
}

/* A secret-key field — type=password, never shows the stored value. */
export function KeyField({ configured, placeholder, onSave }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onSave(value.trim());
      setValue("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          type="password"
          className={inputCls}
          style={inputStyle}
          placeholder={configured ? "•••••• saved — paste a new key to replace" : placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          className={primaryBtn}
          style={primaryStyle}
          disabled={busy || !value.trim()}
          onClick={save}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {saved && <p style={{ fontSize: "var(--font-sm)", color: "var(--success)" }}>Saved.</p>}
      {error && <p style={{ fontSize: "var(--font-sm)", color: "var(--danger-soft)" }}>{error}</p>}
      {configured && !saved && (
        <p style={{ fontSize: "var(--font-sm)", color: "var(--success)" }}>✓ Configured</p>
      )}
    </div>
  );
}

/* The Telegram connect flow — a small state machine:
   idle → (send code) → code → (verify) → [password if 2FA] → connected. */
export function TelegramConnect({ connected, onChanged }) {
  const [step, setStep] = useState("idle");
  const [f, setF] = useState({ apiId: "", apiHash: "", phone: "", code: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const reset = () =>
    setF({ apiId: "", apiHash: "", phone: "", code: "", password: "" });

  const sendCode = async () => {
    setBusy(true);
    setError("");
    try {
      await api.telegramSendCode({
        apiId: f.apiId.trim(),
        apiHash: f.apiHash.trim(),
        phone: f.phone.trim(),
      });
      setStep("code");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api.telegramSignIn({ code: f.code.trim(), password: f.password });
      if (r.needPassword) {
        setStep("password");
      } else {
        reset();
        setStep("idle");
        onChanged();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError("");
    try {
      await api.telegramLogout();
      reset();
      setStep("idle");
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (connected) {
    return (
      <div className="flex items-center justify-between">
        <span style={{ fontSize: "var(--font-md)", color: "var(--success)", fontWeight: 500 }}>
          ✓ Telegram connected
        </span>
        <button className={ghostBtn} style={ghostStyle} disabled={busy} onClick={disconnect}>
          {busy ? "…" : "Disconnect"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {step === "idle" && (
        <>
          <p style={hintStyle}>
            Get your <strong>api_id</strong> and <strong>api_hash</strong> from{" "}
            <Ext href="https://my.telegram.org">my.telegram.org</Ext> → "API
            development tools". They identify the app; you still log into your
            own account.
          </p>
          <input className={inputCls} style={inputStyle} placeholder="api_id"
            value={f.apiId} onChange={set("apiId")} />
          <input className={inputCls} style={inputStyle} placeholder="api_hash"
            value={f.apiHash} onChange={set("apiHash")} />
          <input className={inputCls} style={inputStyle}
            placeholder="Phone number (e.g. +32470123456)"
            value={f.phone} onChange={set("phone")} />
          <button className={primaryBtn} style={primaryStyle}
            disabled={busy || !f.apiId.trim() || !f.apiHash.trim() || !f.phone.trim()}
            onClick={sendCode}>
            {busy ? "Sending…" : "Send code"}
          </button>
        </>
      )}
      {step === "code" && (
        <>
          <p style={hintStyle}>
            Telegram sent a login code to your account — open the Telegram app
            and enter the code below.
          </p>
          <input className={inputCls} style={inputStyle} placeholder="Login code"
            value={f.code} onChange={set("code")} autoFocus />
          <div className="flex gap-2">
            <button className={primaryBtn} style={primaryStyle}
              disabled={busy || !f.code.trim()} onClick={signIn}>
              {busy ? "Verifying…" : "Verify"}
            </button>
            <button className={ghostBtn} style={ghostStyle} disabled={busy}
              onClick={() => { setStep("idle"); setError(""); }}>
              Back
            </button>
          </div>
        </>
      )}
      {step === "password" && (
        <>
          <p style={hintStyle}>
            This account has two-factor authentication — enter your Telegram
            password to finish.
          </p>
          <input type="password" className={inputCls} style={inputStyle}
            placeholder="2FA password" value={f.password} onChange={set("password")} autoFocus />
          <button className={primaryBtn} style={primaryStyle}
            disabled={busy || !f.password} onClick={signIn}>
            {busy ? "Verifying…" : "Sign in"}
          </button>
        </>
      )}
      {error && <p style={{ fontSize: "var(--font-sm)", color: "var(--danger-soft)" }}>{error}</p>}
    </div>
  );
}

/* Cloud publish (Phase 4) — sign in once and the Mac mirrors the computed
   queue + todos to Supabase after every sweep, ready for the iPhone app.
   The phone's actions (complete / snooze / resolve) flow back on the next
   sync. Telegram session and API keys never leave this Mac. */
function CloudSection({ showToast }) {
  const [cloud, setCloud] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // "Use a different project" form — the escape hatch when the bundled
  // default project is gone (deleted) or you want your own.
  const [showProject, setShowProject] = useState(false);
  const [projUrl, setProjUrl] = useState("");
  const [projKey, setProjKey] = useState("");
  // iPhone-setup QR (audit U4): project URL + anon key as a scannable code
  // so the phone never types the ~200-char key. Generated on demand.
  const [qrDataUrl, setQrDataUrl] = useState(null);

  const toggleQr = async () => {
    if (qrDataUrl) { setQrDataUrl(null); return; }
    setError("");
    try {
      const payload = await api.cloudHandoff();
      // Black-on-white regardless of theme — scanners want the contrast.
      setQrDataUrl(await QRCode.toDataURL(JSON.stringify(payload), {
        width: 220, margin: 1, errorCorrectionLevel: "M",
        color: { dark: "#000000ff", light: "#ffffffff" },
      }));
    } catch (e) {
      setError(`Couldn't build the setup code — ${e.message}`);
    }
  };

  const reload = async () => {
    try { setCloud(await api.cloudStatus()); } catch (e) { setError(e.message); }
  };
  useEffect(() => { reload(); }, []);

  const run = async (fn, okMsg) => {
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      await reload();
      if (okMsg && showToast) showToast(okMsg);
      return result;
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!cloud) return <p style={{ fontSize: "var(--font-md)", color: "var(--text-muted)" }}>Loading…</p>;

  const projectHost = cloud.projectUrl ? cloud.projectUrl.replace(/^https:\/\//, "") : "no project configured";

  const projectForm = (
    <div className="space-y-2" style={{ paddingTop: "var(--space-1)" }}>
      <input
        value={projUrl} placeholder="https://<your-ref>.supabase.co"
        onChange={(e) => setProjUrl(e.target.value)} style={inputStyle}
      />
      <input
        value={projKey} placeholder="anon public key (Supabase → Settings → API)"
        onChange={(e) => setProjKey(e.target.value)} style={inputStyle}
      />
      <div className="flex items-center" style={{ gap: "var(--space-2)" }}>
        <button
          className={primaryBtn} style={primaryStyle} disabled={busy || !projUrl || !projKey}
          onClick={() => run(async () => {
            const r = await api.cloudConfig(projUrl.trim(), projKey.trim());
            setShowProject(false); setProjUrl(""); setProjKey("");
            return r;
          }, "Project saved — run the schema there, then sign in")}
        >
          {busy ? "Checking…" : "Save project"}
        </button>
        <button className={ghostBtn} style={ghostStyle} disabled={busy} onClick={() => setShowProject(false)}>
          Cancel
        </button>
      </div>
      <p style={{ fontSize: "var(--font-sm)", color: "var(--text-faint)" }}>
        The URL is validated live before saving. Remember to run
        cloud/supabase-schema.sql in that project's SQL editor once.
      </p>
    </div>
  );

  if (!cloud.signedIn) {
    return (
      <div className="space-y-2">
        <p style={{ fontSize: "var(--font-sm)", color: "var(--text-faint)", fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace" }}>
          Project: {projectHost}
          {" · "}
          <button onClick={() => setShowProject((v) => !v)} disabled={busy}
            style={{ border: "none", background: "none", cursor: "pointer", color: "var(--brand)", padding: 0, font: "inherit" }}>
            {showProject ? "keep this one" : "use a different project"}
          </button>
        </p>
        {showProject && projectForm}
        <input
          type="email" value={email} placeholder="you@company.com" autoComplete="username"
          onChange={(e) => setEmail(e.target.value)} style={inputStyle}
        />
        <input
          type="password" value={password} placeholder="Password" autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)} style={inputStyle}
        />
        <div className="flex items-center" style={{ gap: "var(--space-2)" }}>
          <button
            className={primaryBtn} style={primaryStyle} disabled={busy || !email || !password}
            onClick={() => run(() => api.cloudSignIn(email.trim(), password), "Signed in — first publish is on its way")}
          >
            {busy ? "Working…" : "Sign in"}
          </button>
          <button
            className={ghostBtn} style={ghostStyle} disabled={busy || !email || !password}
            onClick={() => run(async () => {
              const r = await api.cloudSignUp(email.trim(), password);
              if (r.confirmationRequired) setNotice("Check your inbox — confirm the email, then sign in here.");
              return r;
            }, null)}
          >
            Create account
          </button>
        </div>
        {notice && <p style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)" }}>{notice}</p>}
        {error && <p style={{ fontSize: "var(--font-sm)", color: "var(--danger-soft)" }}>{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center" style={{ gap: "var(--space-2)", fontSize: "var(--font-base)", color: "var(--text-secondary)" }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: cloud.enabled ? "var(--success)" : "var(--text-faint)", flexShrink: 0 }} />
        <span style={{ fontWeight: 600, color: "var(--text)" }}>{cloud.email}</span>
        <span style={{ color: "var(--text-faint)" }}>
          {cloud.enabled ? (cloud.lastSyncAt ? `synced ${timeAgo(cloud.lastSyncAt)}` : "waiting for first sync") : "publishing paused"}
        </span>
      </div>
      {cloud.lastError && (
        <p style={{ fontSize: "var(--font-sm)", color: "var(--danger-soft)" }}>
          Last sync failed: {cloud.lastError}
        </p>
      )}
      <div className="flex items-center" style={{ gap: "var(--space-2)" }}>
        <button className={primaryBtn} style={primaryStyle} disabled={busy || !cloud.enabled}
          onClick={() => run(() => api.cloudSyncNow(), "Synced")}>
          {busy ? "Syncing…" : "Sync now"}
        </button>
        <button className={ghostBtn} style={ghostStyle} disabled={busy}
          onClick={() => run(() => api.cloudToggle(!cloud.enabled), cloud.enabled ? "Publishing paused" : "Publishing resumed")}>
          {cloud.enabled ? "Pause" : "Resume"}
        </button>
        <button className={ghostBtn} style={ghostStyle} disabled={busy}
          onClick={() => run(() => api.cloudSignOut(), "Signed out")}>
          Sign out
        </button>
        <button className={ghostBtn} style={ghostStyle} disabled={busy} onClick={toggleQr}>
          {qrDataUrl ? "Hide setup code" : "Set up iPhone"}
        </button>
      </div>
      {qrDataUrl && (
        <div className="flex items-start" style={{ gap: "var(--space-3)", paddingTop: "var(--space-2)", flexWrap: "wrap" }}>
          <img
            src={qrDataUrl}
            alt="Cadence iPhone setup code"
            width={150} height={150}
            style={{ borderRadius: "var(--radius-lg)", background: "#fff", padding: 6, flexShrink: 0 }}
          />
          <div style={{ ...hintStyle, flex: 1, minWidth: 180 }}>
            On the iPhone, open the Cadence app (Expo Go for now) and tap
            <strong> Scan setup code</strong> on the first screen — it fills
            in the project for you. Then sign in with the same email and
            password as here. The code carries only the project address and
            its public key, never your password or session.
          </div>
        </div>
      )}
      {error && <p style={{ fontSize: "var(--font-sm)", color: "var(--danger-soft)" }}>{error}</p>}
    </div>
  );
}

export default function Settings({ showToast, onProfileSaved, mode = "hub" }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const isClient = mode === "client";

  const reload = async () => {
    try {
      setStatus(await api.getSetupStatus());
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    reload();
  }, []);

  return (
    <div style={{ maxWidth: 560 }} className="space-y-4">
      <p style={hintStyle}>
        {isClient
          ? "This Mac tracks your todos from Cadence Cloud. Sign in with the same account as your hub Mac and phone."
          : "Connect Cadence to your own Telegram and AI accounts. Credentials are stored encrypted on this Mac — nothing leaves your machine."}
      </p>
      {error && <p style={{ fontSize: "var(--font-base)", color: "var(--danger-soft)" }}>{error}</p>}
      {!status ? (
        <p style={{ fontSize: "var(--font-md)", color: "var(--text-muted)" }}>Loading…</p>
      ) : isClient ? (
        <>
          <p style={hintStyle}>
            This Mac is a <strong>client</strong> — it reads the todos and
            queue your hub Mac published to Cadence Cloud. Telegram, AI keys,
            and reply drafting live on your hub.
          </p>
          <Section
            title="Cadence Cloud"
            desc="Publishes your queue and todos to your Supabase project after every sweep — the feed the iPhone app reads. Your Telegram session and API keys stay on this Mac."
          >
            <CloudSection showToast={showToast} />
          </Section>
        </>
      ) : (
        <>
          <Section
            title="Your profile"
            desc="Your name, role, and company are folded into every AI prompt so reply drafts and todo extraction speak for you instead of a generic persona. All optional — defaults to a neutral 'the user' if blank."
          >
            <ProfileForm
              initial={status}
              onSave={async (patch) => {
                await api.saveSetupKeys(patch);
                await reload();
                // Bubble up so the parent (App.jsx) can refresh whatever it
                // shows based on the profile — currently the sidebar user card.
                if (onProfileSaved) onProfileSaved();
                if (showToast) showToast("Profile saved");
              }}
            />
          </Section>
          <Section
            title="Telegram"
            desc="Your own account — Cadence reads and replies to your chats as you."
          >
            <TelegramConnect
              connected={status.telegram}
              onChanged={() => {
                reload();
                if (showToast) showToast("Telegram updated");
              }}
            />
          </Section>
          <Section
            title="Anthropic API key"
            desc={
              <>
                Powers AI reply drafting and todo extraction.{" "}
                <Ext href="https://console.anthropic.com/settings/keys">
                  Get a key →
                </Ext>
              </>
            }
          >
            <KeyField
              configured={status.anthropic}
              placeholder="sk-ant-…"
              onSave={async (v) => {
                await api.saveSetupKeys({ anthropicKey: v });
                await reload();
              }}
            />
          </Section>
          <Section
            title="Granola API key"
            desc={
              <>
                Optional — syncs your Granola meeting notes. Get a personal API
                key in the <Ext href="https://granola.ai">Granola</Ext> app
                under Settings.
              </>
            }
          >
            <KeyField
              configured={status.granola}
              placeholder="grn_…"
              onSave={async (v) => {
                await api.saveSetupKeys({ granolaKey: v });
                await reload();
              }}
            />
          </Section>
          <Section
            title="Cadence Cloud"
            desc="Publishes your queue and todos to your Supabase project after every sweep — the feed the iPhone app reads. Your Telegram session and API keys stay on this Mac."
          >
            <CloudSection showToast={showToast} />
          </Section>
          <Section
            title="Start at login"
            desc="Cadence only sweeps and notifies while it's running — starting with your Mac keeps the queue (and the iPhone app) alive without remembering to open it. Applies to the installed app; the setting is saved either way."
          >
            <div className="flex items-center" style={{ gap: "var(--space-2-5)" }}>
              <span style={{ fontSize: "var(--font-md)", color: "var(--text)" }}>
                {status.launchAtLogin ? "Starts when you log in" : "Manual start only"}
              </span>
              <button
                className={ghostBtn}
                style={ghostStyle}
                onClick={async () => {
                  try {
                    await api.saveSetupKeys({ launchAtLogin: status.launchAtLogin ? "0" : "1" });
                    await reload();
                    if (showToast) showToast(status.launchAtLogin ? "Login item removed" : "Cadence will start at login");
                  } catch (e) {
                    if (showToast) showToast(`Couldn't update — ${e.message}`);
                  }
                }}
              >
                {status.launchAtLogin ? "Disable" : "Enable"}
              </button>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
