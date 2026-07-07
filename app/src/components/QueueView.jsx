/* Cadence — Queue view (ported from PipeWise Phase FU).
 *
 * The follow-up work surface: a prioritized rail of conversation items
 * (replies owed, recaps due, promises, todos, cooling relationships) and a
 * one-at-a-time stage with an AI draft ready to send.
 *
 * Data flow (changed from PipeWise): the BACKEND owns the Telegram cache
 * now — this view self-fetches GET /api/followups/queue and refetches when
 * App bumps the `sweepStamp` prop after a sweep lands. Drafts are fetched
 * lazily per item: replies via /api/relationships/:id/draft-reply, recaps
 * via /api/followups/draft-recap.
 *
 * Send is CONFIRM-FIRST: clicking "Send" starts a 2-second undo window
 * before the message actually goes to Telegram. Sending a bundled card also
 * completes its todos and resolves its promises — one send clears all.
 *
 * The rail top hosts the "New conversations" block — pending suggestions
 * from the sweep's unknown-dialog scan. Track creates a relationship from
 * the suggestion; Dismiss suppresses the group from future sweeps.
 *
 * Keyboard: D = done/handled · S = snooze menu · → = skip · Esc = close menu.
 */
import { Component, useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Send, Clock, Sparkles, CheckCircle2, ChevronRight, RefreshCw,
} from "lucide-react";
import { api } from "../lib/api";
import { CompanyLogo } from "./atoms/CompanyLogo";

const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

const KIND_META = {
  reply:   { label: "You owe",   color: "var(--danger)",   icon: "↩" },
  recap:   { label: "Recap due", color: "var(--granola)",  icon: "◉" },
  promise: { label: "Promises",  color: "var(--warning)",  icon: "⚑" },
  todo:    { label: "Todos",     color: "var(--warning)",  icon: "☐" },
  cold:    { label: "Cooling",   color: "var(--text-muted)", icon: "❄" },
};
const KIND_ORDER = ["reply", "recap", "promise", "todo", "cold"];

function timeAgo(iso) {
  if (!iso) return "";
  const h = Math.max(0, (Date.now() - new Date(iso).getTime()) / 3600e3);
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

// Snooze target timestamps.
function snoozeUntil(option) {
  const d = new Date();
  if (option === "tonight") { d.setHours(18, 0, 0, 0); if (d.getTime() < Date.now()) d.setTime(Date.now() + 4 * 3600e3); }
  else if (option === "tomorrow") { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
  else if (option === "nextweek") { d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); }
  return d.toISOString();
}

/* Error boundary — a render crash inside the Queue must degrade to an
   inline error card, never unmount the whole app (React 18 clears the
   root on uncaught render errors — that reads as a "blank screen"). */
class QueueErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error("[Queue] render crash:", error);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "var(--space-8)", maxWidth: 560 }}>
          <div style={{ fontSize: "var(--font-xl)", fontWeight: 700, color: "var(--text)", marginBottom: "var(--space-2)" }}>
            The Queue hit a snag
          </div>
          <div style={{ fontSize: "var(--font-md)", color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: "var(--space-3)" }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ background: "var(--brand)", color: "var(--brand-fg)", border: "none", borderRadius: "var(--radius-lg)", padding: "var(--space-2) var(--space-4)", fontSize: "var(--font-base)", fontWeight: 600, cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const QueueViewInner = ({
  sweepStamp,         // App bumps this after each sweep lands → refetch
  onQueueChanged,     // notify App so the sidebar badge stays fresh
  onTodosChanged,     // refresh App's todos state after bundle completion
  onSuggestionsChanged, // accept/dismiss changed relationships/suggestions — App refetches
  onOpenClient,       // open a relationship in the Clients tab
  onSyncNow,          // manual Telegram sweep (App's triggerSweep)
  showToast,
  showErrorToast,
}) => {
  const [queue, setQueue] = useState(null);     // { items, summary, sweptAt }
  const [fetchError, setFetchError] = useState(null); // last failed queue fetch
  const [loading, setLoading] = useState(true);
  const [currentKey, setCurrentKey] = useState(null);
  const [drafts, setDrafts] = useState({});     // key → { text, loading, error }
  // Send state is KEYED to the item it belongs to — a pending send on card A
  // must never paint (or block) card B's button.
  const [sendState, setSendState] = useState({ phase: "idle", key: null }); // phase: idle | confirming | sending | sent
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [clearedCount, setClearedCount] = useState(0);
  const [suggestions, setSuggestions] = useState([]);  // pending new-conversation suggestions
  const [suggestionBusy, setSuggestionBusy] = useState(null); // id in flight
  const [snoozed, setSnoozed] = useState([]);           // parked items (drawer)
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  // The armed-but-not-yet-fired send. Everything needed to fire it lives here
  // so flush paths (unmount, arming a send elsewhere) don't depend on
  // component state that may already have moved on.
  const pendingSend = useRef(null); // { itemKey, relationshipId, text, bundle, timer }
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  const items = queue?.items || [];
  const current = items.find((i) => i.key === currentKey) || items[0] || null;

  /* ── fetch the queue (backend-owned cache — GET, no payload) ──
     A failed fetch must NEVER paint the celebratory zero state — the
     audit's top Mac finding. `fetchError` renders its own card and the
     zero state requires a successful fetch. */
  const refetch = useCallback(async (keepCurrent = true) => {
    try {
      const data = await api.followupsQueue();
      setQueue(data);
      setFetchError(null);
      onQueueChanged?.(data.summary);
      setCurrentKey((prev) =>
        keepCurrent && data.items.some((i) => i.key === prev)
          ? prev
          : (data.items[0]?.key ?? null)
      );
    } catch (err) {
      setFetchError(err.message);
    } finally {
      setLoading(false);
    }
  }, [onQueueChanged]);

  /* ── fetch pending suggestions (rail bottom) — best-effort, a failure
        here must never block the queue itself ── */
  const refetchSuggestions = useCallback(async () => {
    try {
      const data = await api.listSuggestions();
      setSuggestions(Array.isArray(data) ? data : data?.suggestions || []);
    } catch {
      /* non-blocking — the block simply stays as-is */
    }
  }, []);

  /* ── snoozed drawer (audit C7): parked items stop being invisible ── */
  const refetchSnoozed = useCallback(async () => {
    try {
      setSnoozed(await api.listSnoozes());
    } catch {
      /* non-blocking */
    }
  }, []);

  useEffect(() => { refetch(); }, [refetch, sweepStamp]);
  useEffect(() => { refetchSuggestions(); }, [refetchSuggestions, sweepStamp]);
  useEffect(() => { refetchSnoozed(); }, [refetchSnoozed, sweepStamp]);

  /* ── on-demand draft generation (explicit button, not automatic — an
        LLM call per card-view was wasteful and made cards feel slow) ── */
  const generateDraft = useCallback((item) => {
    if (!item || item.kind === "todo") return;
    if (!item.relationshipId && item.kind !== "recap") return;
    const key = item.key;
    if (draftsRef.current[key]?.loading) return;
    setDrafts((d) => ({ ...d, [key]: { text: "", loading: true } }));
    // Drafts target the item's active chat (multi-chat: the DM or room the
    // reply is actually owed in), not blindly the primary binding.
    const chatTarget = item.activeChatId != null ? { chatId: item.activeChatId } : {};
    const load = item.kind === "recap"
      ? api.draftRecap(item.noteId).then((r) => r.draft)
      : api.draftReply(item.relationshipId, item.kind === "cold"
          ? { ...chatTarget, instructions: "The conversation has gone quiet — write a warm re-opener referencing where things left off." }
          : item.kind === "promise"
            ? { ...chatTarget, instructions: `Deliver on this open promise: "${(item.bundle.find(b => b.type === "promise") || {}).label || ""}". Apologize briefly for the delay.` }
            : chatTarget).then((r) => r.draft);
    load
      .then((text) => setDrafts((d) => ({ ...d, [key]: { text, loading: false } })))
      .catch((err) => setDrafts((d) => ({
        // The backend's 503 messages already carry the right guidance
        // ("key not set — add it in Settings" vs "API call failed: …") —
        // don't flatten a transient API failure into setup advice.
        ...d, [key]: { text: "", loading: false, error: err.message || "Draft failed" },
      })));
  }, []);

  /* ── advance to the next pending item ── */
  const advance = useCallback((removedKey) => {
    setQueue((q) => {
      if (!q) return q;
      const rest = q.items.filter((i) => i.key !== removedKey);
      const idx = q.items.findIndex((i) => i.key === removedKey);
      const next = rest[Math.min(idx, rest.length - 1)] || null;
      setCurrentKey(next?.key ?? null);
      const summary = { ...q.summary, queueSize: rest.length };
      onQueueChanged?.(summary);
      return { ...q, items: rest, summary };
    });
    setClearedCount((c) => c + 1);
    setSendState({ phase: "idle", key: null });
    setSnoozeOpen(false);
  }, [onQueueChanged]);

  /* ── clear the bundle (todos + promises) after a successful send ── */
  const clearBundle = useCallback(async (item) => {
    const jobs = [];
    for (const b of item.bundle || []) {
      if (b.type === "todo") jobs.push(api.updateTodo(b.id, { completed: true }).catch(() => {}));
      if (b.type === "promise") jobs.push(api.resolvePromise(b.id, "kept").catch(() => {}));
    }
    if (jobs.length) {
      await Promise.all(jobs);
      onTodosChanged?.();
    }
  }, [onTodosChanged]);

  /* ── confirm-first send ──
     The 2s window is an UNDO affordance, not a hidden fuse: once the user
     confirmed a send, it must either fire or be explicitly cancelled —
     never silently dropped (unmount) and never fire after the user chose a
     contradicting resolution (mark handled / snooze) for that item. */

  // Fire the armed send NOW. `updateLocal:false` is the unmount path — it
  // only touches App-level callbacks, never this component's state.
  const firePendingSend = useCallback(async (updateLocal = true) => {
    const p = pendingSend.current;
    if (!p) return;
    pendingSend.current = null;
    clearTimeout(p.timer);
    if (updateLocal) setSendState({ phase: "sending", key: p.itemKey });
    try {
      await api.sendMessage(p.relationshipId, p.text, p.chatId ?? null);
      await clearBundle({ bundle: p.bundle });
      const n = (p.bundle || []).length;
      showToast?.(n > 0 ? `Sent — cleared ${n + 1} items` : "Sent · logged to timeline");
      if (updateLocal) {
        setSendState({ phase: "sent", key: p.itemKey });
        setTimeout(() => advance(p.itemKey), 600);
      }
    } catch (err) {
      if (updateLocal) setSendState({ phase: "idle", key: null });
      showErrorToast?.(`Send failed — ${err.message}`);
    }
  }, [clearBundle, advance, showToast, showErrorToast]);

  const cancelPendingSend = useCallback((toast = false) => {
    const p = pendingSend.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingSend.current = null;
    setSendState({ phase: "idle", key: null });
    if (toast) showToast?.("Send cancelled");
  }, [showToast]);

  const handleSend = useCallback(() => {
    if (!current || !current.relationshipId) return;
    const p = pendingSend.current;
    if (p && p.itemKey === current.key) {    // second click = undo
      cancelPendingSend();
      return;
    }
    // A send armed on ANOTHER card was confirmed — honor it now rather than
    // orphaning its timer, then arm the new one.
    if (p) firePendingSend();
    if (sendState.key === current.key && sendState.phase !== "idle") return;
    const text = (draftsRef.current[current.key]?.text || "").trim();
    if (!text) return;
    const item = current;
    const timer = setTimeout(() => firePendingSend(), 2000);
    pendingSend.current = {
      itemKey: item.key,
      relationshipId: item.relationshipId,
      chatId: item.activeChatId ?? null,
      text,
      bundle: item.bundle || [],
      timer,
    };
    setSendState({ phase: "confirming", key: item.key });
  }, [current, sendState, cancelPendingSend, firePendingSend]);

  /* ── done / handled without sending ──
     Honest semantics (audit M8/U3): "handled" is a snooze until tomorrow
     09:00 and the toast says so; bundled TODOS complete (handled implies
     done-by-other-means) but promises are NOT auto-marked kept — that only
     happens on an actual send. Everything is undoable from the toast. */
  const handleDone = useCallback(async () => {
    if (!current) return;
    const item = current;
    // Choosing "handled" while a send is armed on this item contradicts the
    // send — cancel it audibly instead of letting it fire behind their back.
    if (pendingSend.current?.itemKey === item.key) cancelPendingSend(true);
    try {
      if (item.kind === "todo") {
        await api.updateTodo(item.todoId, { completed: true });
        onTodosChanged?.();
        showToast?.("Todo completed", {
          label: "Undo",
          fn: async () => {
            await api.updateTodo(item.todoId, { completed: false });
            onTodosChanged?.();
            refetch();
          },
        });
      } else {
        // Mark handled = park until tomorrow morning so it doesn't re-surface today.
        await api.followupsSnooze(item.key, "until", snoozeUntil("tomorrow"));
        const completedTodoIds = [];
        for (const b of item.bundle || []) {
          if (b.type !== "todo") continue;
          try {
            await api.updateTodo(b.id, { completed: true });
            completedTodoIds.push(b.id);
          } catch (e) { /* best-effort */ }
        }
        if (completedTodoIds.length) onTodosChanged?.();
        const extra = completedTodoIds.length
          ? ` (+${completedTodoIds.length} todo${completedTodoIds.length === 1 ? "" : "s"} completed)`
          : "";
        showToast?.(`Handled — back tomorrow 9:00 if still owed${extra}`, {
          label: "Undo",
          fn: async () => {
            await api.followupsUnsnooze(item.key);
            for (const id of completedTodoIds) {
              await api.updateTodo(id, { completed: false }).catch(() => {});
            }
            onTodosChanged?.();
            refetch();
            refetchSnoozed();
          },
        });
        refetchSnoozed();
      }
      advance(item.key);
    } catch (err) {
      showErrorToast?.(`Failed — ${err.message}`);
    }
  }, [current, advance, refetch, refetchSnoozed, cancelPendingSend, onTodosChanged, showToast, showErrorToast]);

  const handleSnooze = useCallback(async (option) => {
    if (!current) return;
    const item = current;
    setSnoozeOpen(false);
    if (pendingSend.current?.itemKey === item.key) cancelPendingSend(true);
    const undo = {
      label: "Undo",
      fn: async () => {
        await api.followupsUnsnooze(item.key);
        refetch();
        refetchSnoozed();
      },
    };
    try {
      if (option === "after_reply") {
        const lastInbound = item.lastInbound?.date || item.lastActivity || null;
        await api.followupsSnooze(item.key, "after_reply", null, lastInbound);
        showToast?.("Snoozed until they reply", undo);
      } else {
        await api.followupsSnooze(item.key, "until", snoozeUntil(option));
        showToast?.("Snoozed", undo);
      }
      refetchSnoozed();
      advance(item.key);
    } catch (err) {
      showErrorToast?.(`Snooze failed — ${err.message}`);
    }
  }, [current, advance, refetch, refetchSnoozed, cancelPendingSend, showToast, showErrorToast]);

  // Skip / rail navigation deliberately do NOT touch a pending send — the
  // user confirmed it, and send state is keyed to its own card, so moving
  // around the queue neither cancels the send nor repaints other buttons.
  const skip = useCallback(() => {
    if (!items.length || !current) return;
    const idx = items.findIndex((i) => i.key === current.key);
    setCurrentKey(items[(idx + 1) % items.length].key);
    setSnoozeOpen(false);
  }, [items, current]);

  /* ── new-conversation suggestions: Track / Dismiss ── */
  const handleTrackSuggestion = useCallback(async (s) => {
    if (suggestionBusy != null) return;      // one accept in flight at a time
    setSuggestionBusy(s.id);
    try {
      await api.acceptSuggestion(s.id);
      setSuggestions((list) => list.filter((x) => x.id !== s.id));
      showToast?.(
        s.attachRelationshipId != null
          ? `Linked ${s.suggestedName || "chat"} to ${s.company || "client"}`
          : `Now tracking ${s.suggestedName || s.telegramGroup}`
      );
      refetch();
      // The accept created a relationship — App must refresh its
      // relationships/suggestions state or the new client is invisible on
      // the Clients tab (and in Todos chips) until the next sweep.
      onSuggestionsChanged?.();
    } catch (err) {
      showErrorToast?.(`Track failed — ${err.message}`);
    } finally {
      setSuggestionBusy(null);
    }
  }, [suggestionBusy, refetch, onSuggestionsChanged, showToast, showErrorToast]);

  const handleDismissSuggestion = useCallback(async (s) => {
    if (suggestionBusy != null) return;
    setSuggestionBusy(s.id);
    try {
      await api.dismissSuggestion(s.id);
      setSuggestions((list) => list.filter((x) => x.id !== s.id));
      onSuggestionsChanged?.();
    } catch (err) {
      showErrorToast?.(`Dismiss failed — ${err.message}`);
    } finally {
      setSuggestionBusy(null);
    }
  }, [suggestionBusy, onSuggestionsChanged, showErrorToast]);

  /* ── keyboard — Cadence has no peek/palette overlays, so the only
        guard left is "don't steal keys from form fields" ── */
  useEffect(() => {
    const onKey = (e) => {
      if (["TEXTAREA", "INPUT", "SELECT"].includes(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === "d") { e.preventDefault(); handleDone(); }
      else if (k === "s") { e.preventDefault(); setSnoozeOpen((o) => !o); }
      else if (k === "arrowright") { e.preventDefault(); skip(); }
      else if (k === "escape") setSnoozeOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleDone, skip]);

  // Unmount (tab switch) during the undo window: FLUSH the confirmed send
  // instead of silently dropping it — the UI already said "Sending…".
  // Ref indirection keeps this unmount-only regardless of callback identity.
  const flushRef = useRef(firePendingSend);
  flushRef.current = firePendingSend;
  useEffect(() => () => { flushRef.current(false); }, []);

  /* ── confetti on queue-zero (easter egg carried over from PipeWise) ── */
  const firedConfetti = useRef(false);
  useEffect(() => {
    if (!loading && queue && items.length === 0 && clearedCount > 0 && !firedConfetti.current) {
      firedConfetti.current = true;
      const colors = ["#ACC4DE", "#4CC38A", "#FFA057", "#F5C242", "#60A5FA"];
      for (let i = 0; i < 60; i++) {
        const c = document.createElement("div");
        c.className = "pw-confetti";
        c.style.left = `${Math.random() * 100}vw`;
        c.style.width = c.style.height = `${4 + Math.random() * 5}px`;
        c.style.background = colors[i % colors.length];
        c.style.animationDuration = `${1.4 + Math.random() * 1.6}s`;
        c.style.animationDelay = `${Math.random() * 0.5}s`;
        document.body.appendChild(c);
        setTimeout(() => c.remove(), 3600);
      }
    }
    if (items.length > 0) firedConfetti.current = false;
  }, [loading, queue, items.length, clearedCount]);

  /* ── grouped rail ── */
  const grouped = useMemo(() => {
    const g = {};
    for (const it of items) (g[it.kind] ||= []).push(it);
    return g;
  }, [items]);

  const draft = current ? drafts[current.key] : null;

  /* ════════ render ════════ */
  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--space-20)", color: "var(--text-muted)", gap: "var(--space-2)" }}>
        <RefreshCw size={14} className="pw-spin" /> Building your queue…
      </div>
    );
  }

  return (
    <div>
      {/* ── QUEUE HEADER — data age is the core trust signal ── */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
        <span style={{ fontSize: "var(--font-md)", fontWeight: 700, color: "var(--text)" }}>
          {items.length > 0 ? `${items.length} item${items.length === 1 ? "" : "s"}` : "Queue"}
        </span>
        {queue?.summary?.etaMinutes > 0 && (
          <span style={{ fontFamily: MONO, fontSize: "var(--font-2xs)", color: "var(--text-faint)" }}>
            ≈{queue.summary.etaMinutes} min
          </span>
        )}
        <span style={{ fontFamily: MONO, fontSize: "var(--font-2xs)", color: "var(--text-faint)", marginLeft: "auto" }}>
          {queue?.sweptAt ? `synced ${timeAgo(queue.sweptAt)}` : "no sweep yet"}
        </span>
        <button
          onClick={() => { onSyncNow?.(); }}
          title="Sweep Telegram now"
          style={{
            display: "inline-flex", alignItems: "center", gap: "var(--space-1)",
            fontSize: "var(--font-xs)", fontWeight: 600, color: "var(--text-secondary)",
            background: "var(--surface-2)", border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)", padding: "var(--space-1) var(--space-2)",
            cursor: "pointer",
          }}
        >
          <RefreshCw size={11} /> Sync
        </button>
      </div>

      {/* A failed fetch gets its own card — never the celebration. */}
      {fetchError && (
        <div style={{
          display: "flex", alignItems: "center", gap: "var(--space-3)",
          border: "1px solid var(--danger-soft)", borderRadius: "var(--radius-xl)",
          background: "var(--tone-red-bg)", color: "var(--tone-red-fg)",
          padding: "var(--space-3) var(--space-4)", marginBottom: "var(--space-3)",
        }}>
          <span style={{ fontSize: "var(--font-base)", fontWeight: 600, flex: 1 }}>
            Couldn't build the queue — {fetchError}. Showing an error, not an empty queue.
          </span>
          <button
            onClick={() => { setLoading(true); refetch(); }}
            style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "var(--space-1) var(--space-2-5)", fontSize: "var(--font-sm)", fontWeight: 600, cursor: "pointer" }}
          >
            Retry
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "flex-start" }}>
      {/* ── RAIL ── */}
      <aside style={{ width: 280, flexShrink: 0 }}>
        {/* ── NEW CONVERSATIONS — pending suggestions from the sweep.
            Deliberately ABOVE the queue groups (audit U9): a new client
            appearing is the growth moment, and buried under a 38-item rail
            it was invisible. ── */}
        {suggestions.length > 0 && (
          <div style={{ marginBottom: "var(--space-3)", paddingBottom: "var(--space-2)", borderBottom: "1px solid var(--border-subtle)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1-5)", padding: "var(--space-1) var(--space-2) var(--space-1-5)" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--telegram)" }} />
              <span style={{ fontFamily: MONO, fontSize: "var(--font-2xs)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.13em", color: "var(--telegram)" }}>Suggested clients</span>
              <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: "var(--font-2xs)", color: "var(--text-faint)" }}>{suggestions.length}</span>
            </div>
            {suggestions.map((s) => (
              <div key={s.id} style={{ padding: "var(--space-2) var(--space-2-5)", borderRadius: "var(--radius-lg)", border: "1px solid var(--border-subtle)", background: "var(--surface)", marginBottom: "var(--space-2)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                  <CompanyLogo company={s.suggestedName || s.telegramGroup} small />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "block", fontSize: "var(--font-base)", fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {s.suggestedName || s.telegramGroup}
                    </span>
                    <span style={{ display: "block", fontFamily: MONO, fontSize: "var(--font-2xs)", color: "var(--text-faint)", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {s.attachRelationshipId != null
                        ? `DM · attach to ${s.company || "client"}`
                        : s.source === "granola"
                        ? "via Granola"
                        : (s.telegramGroup && s.telegramGroup !== s.suggestedName ? s.telegramGroup : "via Telegram")}
                      {s.messageCount != null ? ` · ${s.messageCount} message${s.messageCount === 1 ? "" : "s"}` : ""}
                    </span>
                  </span>
                </div>
                {s.firstMessage && (
                  <div style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)", lineHeight: 1.45, marginTop: "var(--space-1-5)" }}>
                    “{s.firstMessage.slice(0, 140)}{s.firstMessage.length > 140 ? "…" : ""}”
                  </div>
                )}
                <div style={{ display: "flex", gap: "var(--space-1-5)", marginTop: "var(--space-2)" }}>
                  <button
                    onClick={() => handleTrackSuggestion(s)}
                    disabled={suggestionBusy != null}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "var(--space-1)",
                      background: "var(--brand-tint-2)", color: "var(--brand)", border: "1px solid var(--brand-border)",
                      borderRadius: "var(--radius-md)", padding: "var(--space-1) var(--space-2-5)",
                      fontSize: "var(--font-sm)", fontWeight: 600, cursor: "pointer",
                      opacity: suggestionBusy === s.id ? 0.6 : 1,
                    }}
                  >
                    {suggestionBusy === s.id ? "Tracking…" : "+ Track"}
                  </button>
                  <button
                    onClick={() => handleDismissSuggestion(s)}
                    disabled={suggestionBusy != null}
                    style={{
                      display: "inline-flex", alignItems: "center",
                      background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)",
                      borderRadius: "var(--radius-md)", padding: "var(--space-1) var(--space-2-5)",
                      fontSize: "var(--font-sm)", cursor: "pointer",
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {KIND_ORDER.map((kind) => {
          const list = grouped[kind];
          if (!list?.length) return null;
          const meta = KIND_META[kind];
          return (
            <div key={kind} style={{ marginBottom: "var(--space-3)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1-5)", padding: "var(--space-1) var(--space-2) var(--space-1-5)" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: meta.color }} />
                <span style={{ fontFamily: MONO, fontSize: "var(--font-2xs)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.13em", color: meta.color }}>{meta.label}</span>
                <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: "var(--font-2xs)", color: "var(--text-faint)" }}>{list.length}</span>
              </div>
              {list.map((it) => {
                const isCurrent = current && it.key === current.key;
                return (
                  <button
                    key={it.key}
                    onClick={() => { setCurrentKey(it.key); setSnoozeOpen(false); }}
                    className="pw-qitem"
                    style={{
                      display: "flex", alignItems: "flex-start", gap: "var(--space-2)", width: "100%",
                      textAlign: "left", padding: "var(--space-2) var(--space-2-5)",
                      borderRadius: "var(--radius-lg)", border: "1px solid",
                      borderColor: isCurrent ? "var(--border)" : "transparent",
                      background: isCurrent ? "var(--surface)" : "transparent",
                      boxShadow: isCurrent ? "var(--shadow-card)" : "none",
                      cursor: "pointer",
                    }}
                  >
                    {it.relationshipName
                      ? <CompanyLogo company={it.company || it.relationshipName} small />
                      : <span style={{ width: 26, height: 26, borderRadius: "var(--radius-lg)", background: "var(--tone-amber-bg)", color: "var(--warning-soft)", display: "grid", placeItems: "center", fontSize: 12, flexShrink: 0 }}>☐</span>}
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: "var(--space-1-5)", fontSize: "var(--font-base)", fontWeight: 600, color: "var(--text)" }}>
                        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.relationshipName || it.title}</span>
                        {(it.bundle?.length || 0) > 0 && (
                          <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 600, background: "var(--brand-tint-2)", color: "var(--brand)", borderRadius: "var(--radius-xs)", padding: "1px 5px", flexShrink: 0 }}>
                            ×{it.bundle.length + 1}
                          </span>
                        )}
                      </span>
                      <span style={{ display: "block", fontSize: "var(--font-sm)", color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 }}>
                        {it.why}
                      </span>
                    </span>
                    <span style={{ fontFamily: MONO, fontSize: "var(--font-2xs)", color: it.kind === "reply" ? "var(--danger-soft)" : "var(--text-faint)", flexShrink: 0, paddingTop: 2 }}>
                      {timeAgo(it.lastActivity || it.dueDate)}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {queue?.sweptAt === null && (
          <div style={{ fontSize: "var(--font-sm)", color: "var(--text-faint)", padding: "var(--space-2-5)", lineHeight: 1.5 }}>
            Waiting for the first Telegram sweep — reply detection sharpens once it lands.
          </div>
        )}

        {/* ── SNOOZED DRAWER — parked items, visible and reversible ── */}
        {snoozed.length > 0 && (
          <div style={{ marginTop: "var(--space-4)", paddingTop: "var(--space-3)", borderTop: "1px solid var(--border-subtle)" }}>
            <button
              onClick={() => setSnoozedOpen((o) => !o)}
              style={{
                display: "flex", alignItems: "center", gap: "var(--space-1-5)", width: "100%",
                padding: "var(--space-1) var(--space-2)", background: "none", border: "none", cursor: "pointer",
              }}
            >
              <Clock size={11} style={{ color: "var(--text-faint)" }} />
              <span style={{ fontFamily: MONO, fontSize: "var(--font-2xs)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.13em", color: "var(--text-faint)" }}>
                Snoozed
              </span>
              <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: "var(--font-2xs)", color: "var(--text-faint)" }}>
                {snoozed.length} {snoozedOpen ? "▾" : "▸"}
              </span>
            </button>
            {snoozedOpen && snoozed.map((s) => (
              <div key={s.itemKey} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-1-5) var(--space-2)", borderRadius: "var(--radius-md)" }}>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "block", fontSize: "var(--font-sm)", color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {s.label}
                  </span>
                  <span style={{ display: "block", fontFamily: MONO, fontSize: "var(--font-2xs)", color: "var(--text-faint)" }}>
                    {s.mode === "after_reply" ? "until they reply" : s.until ? `until ${new Date(s.until).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : s.mode}
                  </span>
                </span>
                <button
                  onClick={async () => {
                    try {
                      await api.followupsUnsnooze(s.itemKey);
                      refetchSnoozed();
                      refetch();
                      showToast?.("Unsnoozed — back in the queue");
                    } catch (err) {
                      showErrorToast?.(`Unsnooze failed — ${err.message}`);
                    }
                  }}
                  style={{ fontSize: "var(--font-xs)", fontWeight: 600, color: "var(--brand)", background: "var(--brand-tint-2)", border: "1px solid var(--brand-border)", borderRadius: "var(--radius-md)", padding: "2px var(--space-2)", cursor: "pointer", flexShrink: 0 }}
                >
                  Wake
                </button>
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* ── STAGE ── */}
      <div style={{ flex: 1, maxWidth: 660, minWidth: 0 }}>
        {!current ? (
          // The celebration REQUIRES a successful fetch — an errored fetch
          // renders the error card above and nothing here.
          fetchError ? null : (
          <div className="pw-reveal" style={{ textAlign: "center", padding: "var(--space-16) var(--space-5)" }}>
            <div className="pw-ball" style={{ fontSize: 40, display: "inline-block" }}>🎾</div>
            <h2 style={{ fontSize: "var(--font-3xl)", fontWeight: 800, letterSpacing: "-0.03em", margin: "var(--space-3) 0 var(--space-2)", color: "var(--text)" }}>
              Queue cleared
            </h2>
            <p style={{ fontSize: "var(--font-md)", color: "var(--text-secondary)", maxWidth: 400, margin: "0 auto", lineHeight: 1.6 }}>
              {clearedCount > 0
                ? `${clearedCount} item${clearedCount === 1 ? "" : "s"} handled this session. Nothing owed, nothing cooling, nothing slipping.`
                : "Nothing needs you right now — every conversation is within cadence."}
            </p>
          </div>
          )
        ) : (
          <div key={current.key} className="pw-stage-in">
            {/* why banner */}
            <div style={{
              display: "inline-flex", alignItems: "center", gap: "var(--space-2)",
              fontSize: "var(--font-sm)", fontWeight: 600, borderRadius: "var(--radius-pill)",
              padding: "var(--space-1) var(--space-3)", marginBottom: "var(--space-3)",
              background: current.kind === "reply" ? "var(--tone-red-bg)" : current.kind === "recap" ? "var(--granola-soft)" : current.kind === "cold" ? "var(--surface-2)" : "var(--tone-amber-bg)",
              color: current.kind === "reply" ? "var(--tone-red-fg)" : current.kind === "recap" ? "var(--granola)" : current.kind === "cold" ? "var(--text-secondary)" : "var(--tone-amber-fg)",
              border: "1px solid var(--border)",
            }}>
              {KIND_META[current.kind]?.icon} {current.why}
            </div>

            {/* name + meta */}
            <h1 style={{ fontSize: "var(--font-4xl)", fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text)", cursor: current.relationshipId ? "pointer" : "default" }}
                onClick={() => current.relationshipId && onOpenClient?.(current.relationshipId)}
                title={current.relationshipId ? "Open in Clients" : undefined}>
              {current.relationshipName || current.title}
            </h1>
            {current.relationshipId && (
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", margin: "var(--space-2) 0 var(--space-4)", fontSize: "var(--font-base)", color: "var(--text-secondary)", flexWrap: "wrap" }}>
                {current.company && <span>{current.company}</span>}
                {current.contact && <span>{current.contact}</span>}
                {current.cadenceDays != null && (
                  <span style={{ fontFamily: MONO, fontSize: "var(--font-xs)", color: "var(--text-faint)" }}>cadence {current.cadenceDays}d</span>
                )}
              </div>
            )}

            {/* context: last inbound or note summary */}
            {current.kind === "recap" && current.noteSummary && (
              <div style={{ background: "var(--surface)", border: "1px solid var(--granola-border)", borderRadius: "var(--radius-2xl)", padding: "var(--space-3) var(--space-4)", marginBottom: "var(--space-3)" }}>
                <div style={{ fontFamily: MONO, fontSize: "var(--font-2xs)", color: "var(--granola)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "var(--space-1-5)" }}>
                  ◉ {current.noteTitle} · Granola
                </div>
                <div style={{ fontSize: "var(--font-base)", color: "var(--text-secondary)", lineHeight: 1.55, maxHeight: 130, overflow: "hidden" }}>
                  {current.noteSummary.replace(/[#*_>]/g, "").slice(0, 420)}…
                </div>
              </div>
            )}
            {/* Conversation context — every relationship card gets the last
                messages plus a "what was last discussed" one-liner, so cooling
                cards aren't blind. messages[0] is newest; render oldest-first. */}
            {current.relationshipId && (
              <div style={{ marginBottom: "var(--space-3)" }}>
                {current.actionSummary && (
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--font-base)", color: "var(--text-secondary)", marginBottom: "var(--space-2)" }}>
                    <span style={{ fontFamily: MONO, fontSize: "var(--font-2xs)", color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.1em", flexShrink: 0 }}>Last discussed</span>
                    <span style={{ fontWeight: 500, color: "var(--text)" }}>{current.actionSummary}</span>
                  </div>
                )}
                {(current.messages || []).length > 0 ? (
                  <div style={{ borderLeft: "2px solid var(--telegram)", paddingLeft: "var(--space-3)", display: "flex", flexDirection: "column", gap: "var(--space-1-5)" }}>
                    {current.messages.slice(0, 3).slice().reverse().map((m, i) => (
                      <div key={i}>
                        <div style={{ fontFamily: MONO, fontSize: "var(--font-2xs)", color: m.is_me ? "var(--brand)" : "var(--telegram)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>
                          {m.is_me ? "You" : m.sender || "Them"} · {timeAgo(m.date)} ago
                        </div>
                        <div style={{ fontSize: "var(--font-base)", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                          {(m.text || "").slice(0, 260)}{(m.text || "").length > 260 ? "…" : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: "var(--font-sm)", color: "var(--text-faint)" }}>
                    No cached messages for this chat — run a Telegram sync to pull context.
                  </div>
                )}
              </div>
            )}
            {current.kind === "todo" && current.notes && (
              <div style={{ fontSize: "var(--font-md)", color: "var(--text-secondary)", marginBottom: "var(--space-3)", lineHeight: 1.5 }}>{current.notes}</div>
            )}

            {/* bundle */}
            {(current.bundle?.length || 0) > 0 && (
              <div style={{ background: "var(--brand-tint)", border: "1px dashed var(--brand-border)", borderRadius: "var(--radius-2xl)", padding: "var(--space-2-5) var(--space-3-5, 14px)", marginBottom: "var(--space-3)" }}>
                <div style={{ fontFamily: MONO, fontSize: "var(--font-2xs)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--brand)", marginBottom: "var(--space-1-5)" }}>
                  Clearing this also clears {current.bundle.length} more
                </div>
                {current.bundle.map((b) => (
                  <div key={`${b.type}:${b.id}`} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--font-base)", color: "var(--text-secondary)", padding: "2px 0" }}>
                    <CheckCircle2 size={12} style={{ color: "var(--success-soft)", flexShrink: 0 }} />
                    <span>{b.type === "promise" ? "Promise: " : "Todo: "}{b.label}{b.dueHint ? ` (${b.dueHint})` : ""}</span>
                  </div>
                ))}
              </div>
            )}

            {/* draft / actions */}
            {current.kind !== "todo" && current.relationshipId ? (
              <div style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-2xl)", boxShadow: "var(--shadow-card)", overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-2-5) var(--space-4)", borderBottom: "1px solid var(--border-subtle)", fontSize: "var(--font-sm)", fontWeight: 600, color: draft && !draft.loading && !draft.error ? "var(--success-soft)" : "var(--text-secondary)" }}>
                  <Sparkles size={12} /> {draft && !draft.loading && !draft.error
                    ? (current.kind === "recap" ? "Recap drafted from Granola notes" : "Draft ready")
                    : (current.kind === "recap" ? "Recap" : "Reply")}
                  <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: "var(--font-2xs)", color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 400 }}>
                    your voice
                  </span>
                </div>
                {!draft ? (
                  /* On-demand generation — no LLM call until asked */
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2-5)", padding: "var(--space-4)" }}>
                    <button
                      onClick={() => generateDraft(current)}
                      style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)", background: "var(--brand-tint-2)", color: "var(--brand)", border: "1px solid var(--brand-border)", borderRadius: "var(--radius-lg)", padding: "var(--space-2) var(--space-4)", fontSize: "var(--font-base)", fontWeight: 600, cursor: "pointer" }}
                    >
                      <Sparkles size={13} /> Generate {current.kind === "recap" ? "recap" : "draft"}
                    </button>
                    <button
                      onClick={() => setDrafts((d) => ({ ...d, [current.key]: { text: "", loading: false } }))}
                      style={ghostBtn}
                    >
                      Write manually
                    </button>
                    <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: "var(--font-2xs)", color: "var(--text-faint)" }}>
                      uses voice files + chat context
                    </span>
                  </div>
                ) : draft.loading ? (
                  <div style={{ padding: "var(--space-5)", color: "var(--text-muted)", fontSize: "var(--font-md)", display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                    <RefreshCw size={13} className="pw-spin" /> Drafting in your voice…
                  </div>
                ) : draft.error ? (
                  <div style={{ padding: "var(--space-4)", display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                    <span style={{ color: "var(--warning-soft)", fontSize: "var(--font-md)", flex: 1 }}>{draft.error}</span>
                    <button onClick={() => generateDraft(current)} style={ghostBtn}>Retry</button>
                  </div>
                ) : (
                  <textarea
                    autoFocus={draft.text === ""}
                    placeholder={`Write your message to ${current.relationshipName}…`}
                    value={draft.text || ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [current.key]: { ...d[current.key], text: e.target.value } }))}
                    style={{ width: "100%", border: "none", background: "none", resize: "vertical", padding: "var(--space-3) var(--space-4)", fontSize: "var(--font-md)", lineHeight: 1.6, color: "var(--text)", minHeight: 96, outline: "none", fontFamily: "inherit" }}
                  />
                )}
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-2-5) var(--space-4)", borderTop: "1px solid var(--border-subtle)", position: "relative" }}>
                  {(() => {
                    // Send state only paints on the card it belongs to.
                    const phase = sendState.key === current.key ? sendState.phase : "idle";
                    return (
                  <button
                    onClick={handleSend}
                    disabled={!draft || draft.loading || !!draft.error || !(draft.text || "").trim() || phase === "sending" || phase === "sent"}
                    className={phase === "confirming" ? "pw-send-confirming" : ""}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: "var(--space-2)", justifyContent: "center",
                      minWidth: 180, position: "relative", overflow: "hidden",
                      borderRadius: "var(--radius-lg)", padding: "var(--space-2) var(--space-4)",
                      fontSize: "var(--font-base)", fontWeight: 600, border: "none", cursor: "pointer",
                      background: phase === "sent" ? "var(--success)" : phase === "confirming" ? "var(--warning)" : "var(--brand)",
                      color: phase === "sent" ? "#06281A" : phase === "confirming" ? "#2A1402" : "var(--brand-fg)",
                      opacity: !draft || draft.loading || draft.error || !(draft.text || "").trim() ? 0.5 : 1,
                    }}
                  >
                    {phase === "confirming" && <span className="pw-undo-fill" />}
                    <Send size={13} style={{ position: "relative" }} />
                    <span style={{ position: "relative" }}>
                      {phase === "confirming" ? "Sending… click to undo"
                        : phase === "sending" ? "Sending…"
                        : phase === "sent" ? "✓ Sent · logged"
                        : "Send via Telegram"}
                    </span>
                  </button>
                    );
                  })()}
                  <button onClick={() => setSnoozeOpen((o) => !o)} style={ghostBtn}><Clock size={12} /> Snooze ▾</button>
                  <button onClick={handleDone} style={ghostBtn}>Mark handled</button>
                  <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: "var(--font-2xs)", color: "var(--text-faint)" }}>
                    2s undo window · auto-logs
                  </span>
                  {snoozeOpen && (
                    <div style={{ position: "absolute", bottom: 44, left: 190, width: 230, zIndex: 20, background: "var(--surface-2)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-xl)", boxShadow: "var(--shadow-popover)", padding: "var(--space-1)" }}>
                      {[["tonight", "Tonight 18:00"], ["tomorrow", "Tomorrow 09:00"], ["nextweek", "Next week"], ["after_reply", "✦ After they reply"]].map(([opt, label]) => (
                        <button key={opt} onClick={() => handleSnooze(opt)} className="pw-snooze-opt"
                          style={{ display: "block", width: "100%", textAlign: "left", padding: "var(--space-2) var(--space-2-5)", borderRadius: "var(--radius-md)", fontSize: "var(--font-base)", color: opt === "after_reply" ? "var(--brand)" : "var(--text-secondary)", fontWeight: opt === "after_reply" ? 600 : 400, background: "none", border: "none", cursor: "pointer" }}>
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              /* todo card actions */
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", position: "relative" }}>
                <button onClick={handleDone} style={{ ...ghostBtn, background: "var(--success)", color: "#06281A", border: "none", fontWeight: 600, padding: "var(--space-2) var(--space-4)" }}>
                  <CheckCircle2 size={13} /> Done
                </button>
                <button onClick={() => setSnoozeOpen((o) => !o)} style={ghostBtn}><Clock size={12} /> Snooze ▾</button>
                {snoozeOpen && (
                  <div style={{ position: "absolute", top: 40, left: 90, width: 220, zIndex: 20, background: "var(--surface-2)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-xl)", boxShadow: "var(--shadow-popover)", padding: "var(--space-1)" }}>
                    {[["tonight", "Tonight 18:00"], ["tomorrow", "Tomorrow 09:00"], ["nextweek", "Next week"]].map(([opt, label]) => (
                      <button key={opt} onClick={() => handleSnooze(opt)} className="pw-snooze-opt"
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "var(--space-2) var(--space-2-5)", borderRadius: "var(--radius-md)", fontSize: "var(--font-base)", color: "var(--text-secondary)", background: "none", border: "none", cursor: "pointer" }}>
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* key hints */}
            <div style={{ display: "flex", justifyContent: "center", gap: "var(--space-4)", marginTop: "var(--space-4)", fontSize: "var(--font-sm)", color: "var(--text-faint)" }}>
              <span><kbd className="pw-kbd">D</kbd> done</span>
              <span><kbd className="pw-kbd">S</kbd> snooze</span>
              <span><kbd className="pw-kbd">→</kbd> skip <ChevronRight size={10} style={{ display: "inline" }} /></span>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
};

const ghostBtn = {
  display: "inline-flex", alignItems: "center", gap: "var(--space-1-5)",
  borderRadius: "var(--radius-lg)", padding: "var(--space-2) var(--space-3)",
  fontSize: "var(--font-base)", border: "1px solid var(--border)",
  color: "var(--text-secondary)", background: "transparent", cursor: "pointer",
};

export const QueueView = (props) => (
  <QueueErrorBoundary>
    <QueueViewInner {...props} />
  </QueueErrorBoundary>
);

export default QueueView;
