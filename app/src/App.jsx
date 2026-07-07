import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { QueueView } from "./components/QueueView";
import { Todos } from "./components/Todos";
import { Clients } from "./components/Clients";
import Settings from "./components/Settings";
import Onboarding from "./components/Onboarding";
import { api } from "./lib/api";
import { NAV } from "./constants";
import { Toast } from "./components/atoms/Toast";
import { SetupBanner } from "./components/atoms/SetupBanner";
import { ThemeToggle } from "./components/atoms/ThemeToggle";

// Tabs that map 1:1 to URL paths (#/queue, #/todos, …). Cadence has no
// deep-link overlays — anything unknown just lands on the default tab.
const ROUTE_TABS = new Set(["queue", "todos", "clients", "settings"]);
const DEFAULT_TAB = "queue";

// The backend sweeps on its own 30-min timer (server.js); this constant only
// drives the client-side staleness check on focus/visibility resume, so it
// matches desktop/backend/config.js SWEEP_INTERVAL_MS.
// One problem banner at a time — highest-priority failure wins. Missing
// keys are deliberately NOT problems here (SetupBanner owns "not set up
// yet"); this surface is for things that WERE working and silently died.
function deriveHealthProblem(health) {
  if (!health) return null;
  const deps = health.deps || {};
  if (health.telegram?.configured && deps.sweep?.error) {
    return { action: "sweep", text: `Telegram sync is failing — ${deps.sweep.error}` };
  }
  if (health.cloud?.signedIn === false && /expired/i.test(health.cloud?.lastError || "")) {
    return { action: "settings", text: "Cadence Cloud session expired — the iPhone is no longer updating." };
  }
  if (health.cloud?.signedIn && health.cloud?.lastError) {
    return { action: "settings", text: `Cloud publish is failing — ${health.cloud.lastError}` };
  }
  if (health.anthropic?.configured && deps.todos?.error) {
    return { action: "settings", text: `Todo/draft AI is failing — ${deps.todos.error}` };
  }
  if (health.granola?.configured && deps.granola?.error) {
    return { action: "settings", text: `Granola sync is failing — ${deps.granola.error}` };
  }
  return null;
}

const SWEEP_STALE_MS = 30 * 60 * 1000;
const PROGRESS_POLL_MS = 400;
// Steady-state check for the backend's 30-min timer sweeps, which complete
// with no frontend event — cheap (two local GETs) at once a minute.
const SWEEP_WATCH_MS = 60 * 1000;

// ── Compact shell ──
// Cadence's default window is a slim todo-list column (main.js opens at
// 480px). Below this breakpoint the left sidebar becomes a top icon bar
// and the Queue goes single-column (list ⇄ detail). 860 = sidebar (220) +
// rail (280) + the narrowest usable detail pane.
const COMPACT_BP = 860;
function useCompact() {
  const [compact, setCompact] = useState(() => window.innerWidth < COMPACT_BP);
  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth < COMPACT_BP);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return compact;
}

// Derive the active tab from the URL pathname. "/" → queue.
function _tabFromPath(pathname) {
  const seg = (pathname || "/").split("/").filter(Boolean)[0] || "";
  if (ROUTE_TABS.has(seg)) return seg;
  return DEFAULT_TAB;
}

export default function Cadence() {
  // Routing — tab + sidebar-highlight are both derived from the URL so
  // deep-links work and the browser back button does the right thing.
  const location = useLocation();
  const navigate = useNavigate();
  const compact = useCompact();
  const tab = _tabFromPath(location.pathname);
  const setTab = useCallback((key) => {
    if (ROUTE_TABS.has(key)) navigate(`/${key}`);
  }, [navigate]);

  // ── Core state ──
  const [relationships, setRelationships] = useState([]);
  const [todos, setTodos] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  // Follow-up queue summary — drives the Queue sidebar badge. QueueView owns
  // the item list (it self-fetches) and pushes summary updates here via
  // onQueueChanged as items get cleared, so the badge tracks live.
  const [fuSummary, setFuSummary] = useState(null);
  const [toast, setToast] = useState(null);

  // ── Backend connection state ──
  const [backendStatus, setBackendStatus] = useState("loading");

  // ── First-run setup gate ──
  // "checking" → splash; "needed" → onboarding wizard; "ready" → the app.
  const [setupState, setSetupState] = useState("checking");
  // User profile from onboarding/Settings — drives the sidebar user card.
  // Refetched after the Settings tab saves any profile field so the card
  // updates live.
  const [userProfile, setUserProfile] = useState({ userName: "", userRole: "", userCompany: "" });

  // ── Telegram sweep progress ──
  // Real-percentage progress for the top-of-content bar, driven by polling
  // GET /api/chats/progress every 400ms while a sweep runs (ours OR the
  // backend's 30-min timer sweep — we attach to whatever is in flight).
  // `active` controls the bar's visibility; `pct` is 0–100. We cap at 99%
  // until GET /api/chats/last shows a fresh sweptAt, then snap to 100% and
  // fade after 600ms.
  const [sweepProgress, setSweepProgress] = useState({ active: false, pct: 0, phase: "" });
  // Dependency health from GET /api/health (refreshed on the watcher tick).
  // Drives the persistent problem banner — one banner, highest priority
  // failure wins, so a broken morning reads as one clear instruction.
  const [health, setHealth] = useState(null);
  // Bumped to the new sweptAt each time a sweep completes while the app is
  // open — QueueView refetches its queue whenever this changes.
  const [sweepStamp, setSweepStamp] = useState(null);
  // Baseline for "did a NEW sweep land" + the focus-staleness check. A ref
  // (not state) so the poll closure always reads the current value.
  const lastSweptAtRef = useRef(null);
  const progressPollRef = useRef(null);

  // Toast helpers — declared before any useCallback that lists them in its
  // dependency array (dep arrays are evaluated at render time; a below-the-
  // fold declaration is a TDZ ReferenceError → blank app).

  // Toast, optionally with an action button ({label, fn}) — the undo
  // mechanism every destructive triage path now rides on. Action toasts
  // linger longer so the user can actually reach the button.
  const showToast = useCallback((msg, action = null) => {
    setToast({ msg, action, kind: "success" });
    setTimeout(() => setToast(null), action ? 6000 : 3000);
  }, []);

  // Error toast — same shape but rendered with a red icon and border so
  // failed calls don't look like cheerful success confirmations. Stays a
  // touch longer (5s) since the user usually needs to read the reason.
  const showErrorToast = useCallback((msg) => {
    setToast({ msg, action: null, kind: "error" });
    setTimeout(() => setToast(null), 5000);
  }, []);

  // ── Initial load: relationships + todos + suggestions from API ──
  const refetchAll = useCallback(async () => {
    try {
      const [r, t, s] = await Promise.all([
        api.listRelationships(), api.listTodos(), api.listSuggestions(),
      ]);
      setRelationships(r);
      setTodos(t);
      setSuggestions(s);
      setBackendStatus("ok");
      return true;
    } catch (err) {
      console.warn("Backend unavailable:", err.message);
      setBackendStatus("offline");
      return false;
    }
  }, []);

  // Sidebar Queue badge — GET /api/followups/queue is cheap (backend-owned
  // cache, no Telegram round-trip), so refreshing the summary after every
  // sweep keeps the badge honest without QueueView being mounted.
  const refreshQueueSummary = useCallback(async () => {
    try {
      const data = await api.followupsQueue();
      setFuSummary(data.summary);
    } catch { /* backend offline / engine unavailable — badge stays off */ }
  }, []);

  // ── Sweep machinery ──

  const stopProgressPoll = useCallback(() => {
    if (progressPollRef.current) {
      clearInterval(progressPollRef.current);
      progressPollRef.current = null;
    }
  }, []);

  // A sweep finished (a fresh sweptAt is confirmed in hand): snap the bar to
  // 100%, fade after 600ms, and refresh everything the sweep can change —
  // queue summary, suggestions, telegram_last_activity on relationships, and
  // todos (the server runs extraction after each sweep).
  const finishSweep = useCallback((sweptAt) => {
    stopProgressPoll();
    lastSweptAtRef.current = sweptAt;
    setSweepProgress({ active: true, pct: 100, phase: "Complete" });
    setTimeout(() => setSweepProgress((prev) => ({ ...prev, active: false })), 600);
    setSweepStamp(sweptAt); // QueueView refetches on this
    refreshQueueSummary();
    refetchAll();
  }, [stopProgressPoll, refreshQueueSummary, refetchAll]);

  // Poll the in-memory progress slot every 400ms. `prevSweptAt` is the
  // baseline — completion is confirmed by /api/chats/last reporting a NEWER
  // sweptAt, never by the progress status alone, so the bar can't claim
  // "done" before the swept data is actually readable.
  const startProgressPoll = useCallback((prevSweptAt) => {
    stopProgressPoll();
    setSweepProgress({ active: true, pct: 0, phase: "Starting" });
    progressPollRef.current = setInterval(async () => {
      try {
        const p = await api.chatsProgress();
        if (p.status === "running") {
          const pct = p.total > 0
            ? Math.min(99, Math.round((p.current / p.total) * 100))
            : 5; // pre-total: show a sliver so the bar reads as "working"
          setSweepProgress({ active: true, pct, phase: p.phase || "" });
          return;
        }
        // Not running any more — confirm completion via the cache.
        const last = await api.chatsLast();
        if (last?.sweptAt && last.sweptAt !== prevSweptAt) {
          finishSweep(last.sweptAt);
        } else if (p.status === "error") {
          stopProgressPoll();
          setSweepProgress((prev) => ({ ...prev, active: false }));
          showErrorToast(`Telegram sync failed${p.error ? ` — ${p.error}` : ""}`);
        }
        // idle/done without a new sweptAt yet → keep polling (capped at 99).
      } catch { /* transient poll error — keep trying */ }
    }, PROGRESS_POLL_MS);
  }, [stopProgressPoll, finishSweep, showErrorToast]);

  // Kick off a sweep (or attach to one already running — the backend replies
  // 202 {alreadyRunning:true} and the poll picks it up either way).
  const triggerSweep = useCallback(async () => {
    if (progressPollRef.current) return; // already tracking a sweep
    const prev = lastSweptAtRef.current;
    startProgressPoll(prev);
    try {
      await api.sweepChats();
    } catch (err) {
      // 503 = Telegram not configured; anything else = real failure. Either
      // way the bar comes down — the queue still builds from todos alone.
      stopProgressPoll();
      setSweepProgress((prevP) => ({ ...prevP, active: false }));
      if (err.status !== 503) showErrorToast(`Telegram sync failed — ${err.message}`);
    }
  }, [startProgressPoll, stopProgressPoll, showErrorToast]);

  // ── Setup gate ──
  // Fetch + apply setup status. Pulled out into a callback so the Settings
  // tab can re-trigger it after the user edits their profile (so the sidebar
  // user card refreshes without a full reload). On a backend error, fall
  // through to the app (it shows its own offline state).
  const refreshSetupStatus = useCallback(async () => {
    try {
      const s = await api.getSetupStatus();
      setSetupState(s.telegram || s.onboarded ? "ready" : "needed");
      setUserProfile({ userName: s.userName || "", userRole: s.userRole || "", userCompany: s.userCompany || "" });
    } catch (e) {
      setSetupState("ready");
    }
  }, []);

  useEffect(() => { refreshSetupStatus(); }, [refreshSetupStatus]);

  // Onboarding finished (or skipped) — it persists the `onboarded` flag
  // before calling onDone, so refetching status won't flip the gate back;
  // it just pulls the freshly saved profile for the sidebar card.
  const handleOnboardingDone = useCallback(() => {
    setSetupState("ready");
    refreshSetupStatus();
  }, [refreshSetupStatus]);

  // ── Boot sequence ──
  // refetchAll → read the sweep cache + progress: attach to an in-flight
  // sweep (server.js kicks one off at startup when its cache is stale), or
  // trigger one ourselves if the last sweep is stale/missing. Runs on mount
  // (once setup is ready) and again from the offline screen's Retry button.
  const bootstrap = useCallback(async () => {
    const ok = await refetchAll();
    if (!ok) return;
    refreshQueueSummary();
    try {
      const last = await api.chatsLast();
      lastSweptAtRef.current = last?.sweptAt || null;
      const progress = await api.chatsProgress();
      if (progress.status === "running") {
        startProgressPoll(lastSweptAtRef.current);
      } else {
        const stale = !last?.sweptAt ||
          Date.now() - new Date(last.sweptAt).getTime() > SWEEP_STALE_MS;
        if (stale) triggerSweep();
      }
    } catch { /* Telegram unconfigured — queue still builds from todos */ }
  }, [refetchAll, refreshQueueSummary, startProgressPoll, triggerSweep]);

  useEffect(() => {
    if (setupState !== "ready") return;
    bootstrap();
  }, [setupState, bootstrap]);

  // Clear any in-flight progress poll on unmount.
  useEffect(() => stopProgressPoll, [stopProgressPoll]);

  // ── Staleness re-sweep on focus/visibility resume ──
  // The backend's own 30-min timer covers the steady state; this catches the
  // "Mac slept overnight, app regains focus" case so the queue isn't built
  // from yesterday's conversations.
  useEffect(() => {
    if (setupState !== "ready" || backendStatus === "offline") return;
    const onVisibilityChange = () => {
      if (document.hidden) return;
      const last = lastSweptAtRef.current;
      const stale = !last || Date.now() - new Date(last).getTime() > SWEEP_STALE_MS;
      if (stale) triggerSweep();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onVisibilityChange);
    };
  }, [setupState, backendStatus, triggerSweep]);

  // ── Steady-state watcher for backend timer sweeps + dependency health ──
  // The server sweeps on its own 30-min timer; without this, a focused app
  // left open never learns those sweeps landed and the queue goes stale.
  // On a new sweptAt: refresh the same state finishSweep would, minus the
  // progress-bar flash (a background refresh the user didn't ask for
  // shouldn't animate). If a sweep is mid-flight, attach the live bar.
  // The same tick reads /api/health so a dead Telegram session / broken
  // key / stalled cloud sync surfaces as a persistent banner instead of
  // the queue silently going stale.
  useEffect(() => {
    if (setupState !== "ready" || backendStatus === "offline") return;
    const tick = async () => {
      try {
        setHealth(await api.health());
      } catch { /* backend hiccup — banner keeps last known state */ }
      if (progressPollRef.current) return; // already tracking a sweep
      try {
        const progress = await api.chatsProgress();
        if (progress.status === "running") {
          startProgressPoll(lastSweptAtRef.current);
          return;
        }
        const last = await api.chatsLast();
        if (last?.sweptAt && last.sweptAt !== lastSweptAtRef.current) {
          lastSweptAtRef.current = last.sweptAt;
          setSweepStamp(last.sweptAt); // QueueView refetches on this
          refreshQueueSummary();
          refetchAll();
        }
      } catch { /* backend hiccup — next tick retries */ }
    };
    tick(); // immediate first read so banners don't wait a minute
    const id = setInterval(tick, SWEEP_WATCH_MS);
    return () => clearInterval(id);
  }, [setupState, backendStatus, startProgressPoll, refreshQueueSummary, refetchAll]);

  // ── Identity-stable callbacks for the tab views ──
  // Inline arrows at the render site would change identity on every App
  // render and re-trigger the views' refetch effects in a loop.
  const handleQueueChanged = useCallback((summary) => setFuSummary(summary), []);
  const handleTodosChanged = useCallback(async () => {
    try { setTodos(await api.listTodos()); } catch { /* keep stale list */ }
  }, []);
  const handleSuggestionsChanged = useCallback(async () => {
    // Accepting a suggestion also creates a relationship — refresh both so
    // the new client appears on the Clients tab (and in Todos chips) now,
    // not after the next sweep.
    try { setSuggestions(await api.listSuggestions()); } catch { /* keep stale list */ }
    try { setRelationships(await api.listRelationships()); } catch { /* keep stale list */ }
  }, []);
  // Open a relationship: Cadence has no detail modal — the Clients tab IS
  // the record surface. The id scrolls-to + flashes the row (audit U6).
  const [focusClientId, setFocusClientId] = useState(null);
  const handleOpenClient = useCallback((relId = null) => {
    setFocusClientId(relId ?? null);
    setTab("clients");
  }, [setTab]);
  const handleClientFocusHandled = useCallback(() => setFocusClientId(null), []);
  const openSettings = useCallback(() => setTab("settings"), [setTab]);

  // Sidebar badge: todos that need attention today (overdue, due today, or My Day)
  const todoBadgeCount = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return todos.filter(t => {
      if (t.completed) return false;
      if (t.myDay) return true;
      if (!t.dueDate) return false;
      const p = String(t.dueDate).split("-");
      if (p.length !== 3) return false;
      return new Date(+p[0], +p[1] - 1, +p[2]) <= today;
    }).length;
  }, [todos]);

  if (setupState === "checking") {
    return (
      <div
        className="flex items-center justify-center"
        style={{ minHeight: "100vh", background: "var(--surface)", color: "var(--text-muted)", fontSize: "var(--font-md)" }}
      >Loading Cadence…</div>
    );
  }
  if (setupState === "needed") return <Onboarding onDone={handleOnboardingDone} />;
  return (
    <div className="flex" style={{ minHeight: "100vh" }}>
      {/* Window drag region — strip at the very top so the user can grab the
          window and drag it. Pairs with main.js titleBarStyle: 'hiddenInset',
          which hides the native title bar. Height matches the macOS traffic-
          light row (~28px). pointer-events:none so widgets below still receive
          clicks. */}
      <div
        style={{
          position: "fixed", top: 0, left: 0, right: 0, height: 28,
          WebkitAppRegion: "drag", pointerEvents: "none", zIndex: 100,
        }}
      />
      <div
        className={`w-full flex overflow-hidden${compact ? " flex-col" : ""}`}
        style={{ height: "100vh", background: "transparent" }}
      >

        {/* Compact top bar — the slim-column shell. Sits below the 28px drag
            strip (which also clears the traffic lights), full width: wordmark,
            icon tabs with badges, profile chip, theme toggle. */}
        {compact && (
          <div
            className="flex items-center"
            style={{
              flexShrink: 0,
              gap: "var(--space-1)",
              padding: "var(--space-7) var(--space-2-5) var(--space-1-5)",
              background: "var(--sidebar-bg)",
              backdropFilter: "blur(24px) saturate(140%)",
              WebkitBackdropFilter: "blur(24px) saturate(140%)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <div
              aria-hidden="true"
              style={{
                width: 20, height: 20, borderRadius: "var(--radius-md)",
                background: "linear-gradient(135deg, var(--brand), var(--brand-soft))",
                color: "var(--brand-fg)", display: "grid", placeItems: "center",
                fontSize: "var(--font-sm)", fontWeight: 700, flexShrink: 0,
                marginRight: "var(--space-1-5)",
              }}
            >
              C
            </div>
            {NAV.map(item => {
              const Icon = item.icon;
              const active = tab === item.key;
              const badgeCount = !item.dynamicBadge ? 0
                : item.key === "queue" ? (fuSummary?.queueSize || 0)
                : item.key === "todos" ? todoBadgeCount : 0;
              return (
                <button
                  key={item.key}
                  onClick={() => setTab(item.key)}
                  title={item.label}
                  aria-label={badgeCount > 0 ? `${item.label} (${badgeCount})` : item.label}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: "var(--space-1)",
                    padding: "var(--space-1-5) var(--space-2)",
                    borderRadius: "var(--radius-md)", border: "none",
                    background: active ? "var(--surface-2)" : "transparent",
                    color: active ? "var(--text)" : "var(--text-secondary)",
                    boxShadow: active ? "inset 0 0 0 1px var(--border-strong)" : "none",
                    cursor: "pointer", fontSize: "var(--font-sm)", fontWeight: 600,
                  }}
                >
                  <Icon size={14} style={{ opacity: 0.85 }} />
                  {badgeCount > 0 && (
                    <span style={{ fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: "var(--font-xs)", color: active ? "var(--text-faint)" : "inherit" }}>
                      {badgeCount}
                    </span>
                  )}
                </button>
              );
            })}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "var(--space-1-5)" }}>
              <div
                onClick={openSettings}
                title={userProfile.userName?.trim() ? `${userProfile.userName} — open Settings` : "Open Settings"}
                style={{
                  width: 24, height: 24, borderRadius: "var(--radius-md)",
                  background: "var(--brand-tint-2)", color: "var(--brand-soft)",
                  display: "grid", placeItems: "center",
                  fontSize: "var(--font-xs)", fontWeight: 600, cursor: "pointer",
                }}
              >
                {userProfile.userName?.trim()
                  ? userProfile.userName.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join("")
                  : "·"}
              </div>
              <ThemeToggle />
            </div>
          </div>
        )}

        {/* Sidebar — glassy chrome that lets the bg gradient bleed through.
            Top padding clears the macOS traffic-light cluster now that the
            native title bar is hidden (main.js titleBarStyle: 'hiddenInset'). */}
        {!compact && (
        <div
          className="flex flex-col"
          style={{
            width: 220, flexShrink: 0,
            background: "var(--sidebar-bg)",
            backdropFilter: "blur(24px) saturate(140%)",
            WebkitBackdropFilter: "blur(24px) saturate(140%)",
            borderRight: "1px solid var(--border)",
            padding: "var(--space-9) var(--space-3) var(--space-4)",
          }}
        >
          {/* Wordmark */}
          <div
            style={{
              display: "flex", alignItems: "center", gap: "var(--space-2-5)",
              padding: "0 var(--space-1) var(--space-4)",
              borderBottom: "1px solid var(--border)",
              marginBottom: "var(--space-3)",
              cursor: "default", userSelect: "none",
            }}
          >
            <div
              aria-hidden="true"
              style={{
                width: 22, height: 22, borderRadius: "var(--radius-md)",
                background: "linear-gradient(135deg, var(--brand), var(--brand-soft))",
                color: "var(--brand-fg)",
                display: "grid", placeItems: "center",
                fontSize: "var(--font-md)", fontWeight: 700, flexShrink: 0,
                boxShadow: "0 0 0 1px rgba(255,255,255,0.05), 0 4px 12px var(--accent-glow)",
              }}
            >
              C
            </div>
            <span style={{ fontWeight: 600, letterSpacing: "-0.02em", fontSize: "var(--font-lg)", color: "var(--text)" }}>Cadence</span>
          </div>

          {/* Nav */}
          <nav style={{ flex: 1, overflowY: "auto" }}>
            {NAV.map(item => {
              const Icon = item.icon;
              const active = tab === item.key;
              const badgeCount = !item.dynamicBadge ? 0
                : item.key === "queue" ? (fuSummary?.queueSize || 0)
                : item.key === "todos" ? todoBadgeCount : 0;
              return (
                <button
                  key={item.key}
                  onClick={() => setTab(item.key)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center",
                    gap: "var(--space-2)",
                    padding: "var(--space-1-5) var(--space-2-5)",
                    marginBottom: "var(--space-0-5)",
                    borderRadius: "var(--radius-md)",
                    background: active ? "var(--surface-2)" : "transparent",
                    color: active ? "var(--text)" : "var(--text-secondary)",
                    boxShadow: active ? "inset 0 0 0 1px var(--border-strong)" : "none",
                    cursor: "pointer", fontSize: "var(--font-md)",
                    position: "relative", border: "none", textAlign: "left",
                  }}
                  onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = "var(--surface-2)"; e.currentTarget.style.color = "var(--text)"; } }}
                  onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-secondary)"; } }}
                >
                  {/* Active state — 2px left accent rail */}
                  {active && (
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute", left: -12, top: 6, bottom: 6, width: 2,
                        background: "var(--brand)",
                        borderRadius: "0 var(--radius-xs) var(--radius-xs) 0",
                      }}
                    />
                  )}
                  <Icon size={14} style={{ opacity: 0.85, flexShrink: 0 }} />
                  <span>{item.label}</span>
                  {badgeCount > 0 && (
                    <span
                      style={{
                        marginLeft: "auto",
                        fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
                        fontSize: "var(--font-xs)", color: "var(--text-faint)",
                      }}
                    >{badgeCount}</span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Sidebar footer — profile mini-card + theme toggle */}
          <div
            style={{
              marginTop: "auto", borderTop: "1px solid var(--border)",
              display: "flex", alignItems: "center", gap: "var(--space-2)",
              padding: "var(--space-3) var(--space-1-5) var(--space-0-5)",
            }}
          >
            {/* Profile card — name/role/company from the onboarding profile.
                Falls back to neutral defaults so the card never looks broken
                before the user fills in Settings → Your profile. Clicking it
                opens Settings. */}
            {(() => {
              const name = userProfile.userName?.trim();
              const role = userProfile.userRole?.trim();
              const company = userProfile.userCompany?.trim();
              const displayName = name || "Set up your profile";
              // Initials from the first two name parts: "Marlon Van Beek" → MV,
              // "Alex" → A. Empty profile → a neutral dot.
              const initials = name
                ? name.split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join("")
                : "·";
              // Secondary line: "Role at Company" / just one / nothing.
              const secondary = role && company
                ? `${role} at ${company}`
                : (role || company || (name ? "Add your role in Settings" : ""));
              return (
                <div
                  onClick={openSettings}
                  title="Open Settings"
                  style={{
                    display: "flex", alignItems: "center", gap: "var(--space-2)",
                    minWidth: 0, flex: 1, cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      width: 26, height: 26, borderRadius: "var(--radius-md)",
                      background: "var(--brand-tint-2)", color: "var(--brand-soft)",
                      display: "grid", placeItems: "center",
                      fontSize: "var(--font-sm)", fontWeight: 600, flexShrink: 0,
                    }}
                  >
                    {initials}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: "var(--font-base)", fontWeight: 500,
                        color: name ? "var(--text)" : "var(--text-muted)",
                        fontStyle: name ? "normal" : "italic",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}
                    >
                      {displayName}
                    </div>
                    {secondary && (
                      <div
                        style={{
                          fontSize: "var(--font-sm)", color: "var(--text-faint)",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}
                      >
                        {secondary}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
            <ThemeToggle />
          </div>
        </div>
        )}

        {/* Main. min-h-0 matters: in the compact COLUMN layout, flex
            children default to min-height:auto and grow to content height —
            the outer overflow-hidden clips them and the inner overflow-auto
            never scrolls. (min-w-0 is the same fix for the row layout.) */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Top-of-page Telegram sync bar — real percentage, visible from
              every tab. Driven by polling /api/chats/progress (see the sweep
              machinery above). Sits above the scroll container so it pins to
              the very top of the content column. */}
          <div
            className={`cadence-progress${sweepProgress.active ? " is-active" : ""}`}
            role="progressbar"
            aria-label="Syncing Telegram"
            aria-valuenow={sweepProgress.pct} aria-valuemin={0} aria-valuemax={100}
          >
            <div className="cadence-progress__fill" style={{ width: `${sweepProgress.pct}%` }} />
          </div>

          {/* Persistent dependency-failure banner — one at a time, highest
              priority first. This is what stands between "Telegram died
              Tuesday" and "the queue looked healthy all week". */}
          {(() => {
            const problem = deriveHealthProblem(health);
            if (!problem) return null;
            return (
              <div
                className="flex items-center gap-3 px-4 py-2 border-b"
                style={{ background: "var(--tone-amber-bg)", borderColor: "var(--border)", color: "var(--warning)" }}
                role="alert"
              >
                <span style={{ fontSize: "var(--font-sm)", fontWeight: 600, flex: 1, minWidth: 0 }}>
                  {problem.text}
                </span>
                {problem.action === "sweep" ? (
                  <button
                    onClick={triggerSweep}
                    className="px-2.5 py-1 rounded-md text-xs font-semibold"
                    style={{ background: "var(--surface)", color: "var(--text)" }}
                  >
                    Retry sync
                  </button>
                ) : (
                  <button
                    onClick={openSettings}
                    className="px-2.5 py-1 rounded-md text-xs font-semibold"
                    style={{ background: "var(--surface)", color: "var(--text)" }}
                  >
                    Open Settings
                  </button>
                )}
              </div>
            );
          })()}

          {/* Content */}
          <div className={`flex-1 overflow-auto ${compact ? "p-3" : "p-6"}`}>
            {backendStatus === "offline" && (
              <div className="h-full flex items-center justify-center">
                <div
                  className="max-w-md w-full text-center px-6 py-10 rounded-2xl border"
                  style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
                >
                  <div
                    className="w-12 h-12 mx-auto mb-4 rounded-full flex items-center justify-center"
                    style={{ background: "var(--tone-amber-bg)", color: "var(--warning)" }}
                  >
                    <AlertTriangle size={22} />
                  </div>
                  <h3 className="text-base font-semibold mb-1" style={{ color: "var(--text)" }}>Backend offline</h3>
                  <p className="text-sm mb-5" style={{ color: "var(--text-muted)" }}>
                    Cadence can't reach its local backend on port 3456. If you're
                    running from source, launch it with{" "}
                    <code style={{ color: "var(--text-secondary)" }}>./dev_launch.command</code>,
                    then hit Retry.
                  </p>
                  <button
                    onClick={bootstrap}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                    style={{ background: "var(--brand)", color: "var(--brand-fg)" }}
                  >
                    <RefreshCw size={13} /> Retry connection
                  </button>
                </div>
              </div>
            )}

            {/* QUEUE VIEW — follow-up engine work surface. Self-fetches
                GET /api/followups/queue; refetches when sweepStamp changes
                (a sweep completed). suggestions/onSuggestionsChanged feed the
                "New conversations" block at the rail bottom. */}
            {backendStatus !== "offline" && tab === "queue" && (
              <>
                <SetupBanner require="telegram" onOpenSettings={openSettings} />
                <SetupBanner require="anthropic" onOpenSettings={openSettings} />
                <QueueView
                  compact={compact}
                  sweepStamp={sweepStamp}
                  suggestions={suggestions}
                  onSuggestionsChanged={handleSuggestionsChanged}
                  onQueueChanged={handleQueueChanged}
                  onTodosChanged={handleTodosChanged}
                  onOpenClient={handleOpenClient}
                  onSyncNow={triggerSweep}
                  showToast={showToast}
                  showErrorToast={showErrorToast}
                />
              </>
            )}

            {/* TODOS VIEW */}
            {backendStatus !== "offline" && tab === "todos" && (
              <>
                <SetupBanner require="anthropic" onOpenSettings={openSettings} />
                <Todos
                  relationships={relationships}
                  todos={todos}
                  setTodos={setTodos}
                  onOpenClient={handleOpenClient}
                  showToast={showToast}
                />
              </>
            )}

            {/* CLIENTS VIEW */}
            {backendStatus !== "offline" && tab === "clients" && (
              <Clients
                relationships={relationships}
                refetch={refetchAll}
                showToast={showToast}
                focusId={focusClientId}
                onFocusHandled={handleClientFocusHandled}
              />
            )}

            {/* SETTINGS VIEW */}
            {backendStatus !== "offline" && tab === "settings" && (
              <Settings showToast={showToast} onProfileSaved={refreshSetupStatus} />
            )}
          </div>
        </div>
      </div>

      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
