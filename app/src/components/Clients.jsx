import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Minus, Archive, ArchiveRestore, Trash2, ChevronRight, ChevronDown } from "lucide-react";
import { api } from "../lib/api";
import { timeAgo } from "../lib/utils";
import { CompanyLogo } from "./atoms/CompanyLogo";

/* ── Clients — the relationship list ─────────────────────────────────
   Cadence's record surface: every tracked relationship on one screen.
   Deliberately simple (no KPIs, no CoinGecko, no news — see BUILD_SPEC):
   name + company, the Telegram binding, how long since the last touch,
   the per-relationship cadence, and archive/delete controls. Rows come
   from suggestions accepted in the Queue or from the inline add form here.

   Fields edit in place (audit C6/M7-UX): click a name or company to type
   over it, click the Telegram badge to rebind, "+ link chat" to attach a
   DM or side room. No modal — the row IS the record.

   Props (from App.jsx):
     relationships  — the list App keeps in state (active + archived)
     refetch        — App's refetchAll; every mutation persists via
                      lib/api.js then refetches so all tabs see the change
     showToast      — confirmation toast (App passes no error variant here,
                      so failures reuse it with the reason in the message)
     focusId        — relationship id another surface asked to "open"
                      (audit U6) — scroll to the row and flash it
     onFocusHandled — ack callback; App nulls focusId so the same id can
                      be requested again later
*/

const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

const inputStyle = {
  background: "var(--surface-3)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-md)",
  padding: "var(--space-1-5) var(--space-2-5)",
  fontSize: "var(--font-md)",
  color: "var(--text)",
  fontFamily: "inherit",
  outline: "none",
  minWidth: 0,
};

/* Compact variants for the in-row mini-forms (rebind / link chat) —
   same shape as Settings' primaryBtn/ghostBtn, one notch smaller. */
const miniInputStyle = {
  ...inputStyle,
  fontSize: "var(--font-sm)",
  padding: "var(--space-1) var(--space-2)",
};
const miniPrimaryBtn = "px-2 py-1 rounded-md text-xs font-semibold disabled:opacity-50";
const miniPrimaryStyle = { background: "var(--brand)", color: "var(--brand-fg)", flexShrink: 0 };
const miniGhostBtn = "px-2 py-1 rounded-md text-xs font-medium disabled:opacity-50";
const miniGhostStyle = { background: "var(--surface-3)", color: "var(--text)", flexShrink: 0 };

/* Case-insensitive substring match over the fields a user thinks of a
   client by — display name, company, and the bound Telegram group. */
const matchesQuery = (rel, q) =>
  [rel.name, rel.company, rel.telegramChat?.group].some((s) => (s || "").toLowerCase().includes(q));

/* Small square icon button — stepper / archive / delete. */
const IconBtn = ({ title, onClick, disabled, danger = false, children }) => (
  <button
    title={title}
    aria-label={title}
    onClick={onClick}
    disabled={disabled}
    style={{
      width: 26, height: 26,
      display: "grid", placeItems: "center",
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border)",
      background: "var(--surface-2)",
      color: danger ? "var(--danger-soft)" : "var(--text-secondary)",
      cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.45 : 1,
      flexShrink: 0,
    }}
  >
    {children}
  </button>
);

/* Telegram binding badge — the group name when bound, "not linked" when the
   sweep has nothing to join on. A chat_id-only binding (accepted suggestion
   whose dialog title changed) still counts as linked. Clicking it (active
   rows only) opens the rebind form in the row. */
const TelegramBadge = ({ telegramChat, onClick }) => {
  const linked = Boolean(telegramChat?.group || telegramChat?.chatId);
  return (
    <button
      onClick={onClick}
      title={
        linked
          ? `Telegram: ${telegramChat.group || `chat ${telegramChat.chatId}`}${onClick ? " — click to rebind or clear" : ""}`
          : `No Telegram binding${onClick ? " — click to add a group name so the sweep can match this chat" : ""}`
      }
      style={{
        display: "inline-flex", alignItems: "center", gap: "var(--space-1)",
        padding: "var(--space-0-5) var(--space-1-5)",
        borderRadius: "var(--radius-pill)",
        border: "none",
        fontSize: "var(--font-xs)", fontFamily: MONO,
        background: linked ? "var(--tone-skyblue-bg)" : "var(--surface-3)",
        color: linked ? "var(--telegram)" : "var(--text-faint)",
        maxWidth: 180, flexShrink: 0,
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor", flexShrink: 0 }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {linked ? (telegramChat.group || "linked") : "not linked"}
      </span>
    </button>
  );
};

/* Cadence stepper — how many days of silence before the queue engine flags
   this relationship as going cold. Backend clamps to 1–365 (CHECK constraint);
   the buttons clamp too so we never send an invalid value. */
const CadenceStepper = ({ value, busy, onSet }) => (
  <div
    className="flex items-center"
    style={{ gap: "var(--space-1)", flexShrink: 0 }}
    title="Follow-up cadence — days of silence before this relationship goes cold"
  >
    <IconBtn title="Shorter cadence" disabled={busy || value <= 1} onClick={() => onSet(value - 1)}>
      <Minus size={11} />
    </IconBtn>
    <span style={{ fontFamily: MONO, fontSize: "var(--font-sm)", color: "var(--text-secondary)", minWidth: 32, textAlign: "center" }}>
      {value}d
    </span>
    <IconBtn title="Longer cadence" disabled={busy || value >= 365} onClick={() => onSet(value + 1)}>
      <Plus size={11} />
    </IconBtn>
  </div>
);

const ClientRow = ({
  rel, busy, focused, onFocusHandled,
  onSetCadence, onArchive, onUnarchive, onDelete,
  onUnlinkChat, onInlineSave, onRebind, onLinkChat,
}) => {
  const archived = Boolean(rel.archivedAt);
  // Newest activity across the primary binding AND linked chats (DMs, side
  // rooms) — a client whose group is quiet but whose DM is live isn't stale.
  const lastActivity = [rel.telegramChat?.lastActivity, ...(rel.chats || []).map((c) => c.lastActivity)]
    .filter(Boolean)
    .sort()
    .pop() || null;
  const linkedChats = rel.chats || [];

  // Inline name/company edit — click the text, type, Enter/blur saves,
  // Escape cancels. Archived rows stay read-only.
  const [editField, setEditField] = useState(null); // null | "name" | "company"
  const [editValue, setEditValue] = useState("");
  // Telegram rebind form (opened from the badge).
  const [rebindOpen, setRebindOpen] = useState(false);
  const [bindGroup, setBindGroup] = useState("");
  const [bindChatId, setBindChatId] = useState("");
  // "+ link chat" mini-form — attach a DM / side room beyond the binding.
  const [chatFormOpen, setChatFormOpen] = useState(false);
  const [chatKind, setChatKind] = useState("dm");
  const [chatName, setChatName] = useState("");
  const [chatContact, setChatContact] = useState("");
  // Focus flash (audit U6) — border lights up brand-colored, fades back.
  const [flash, setFlash] = useState(false);
  const rowRef = useRef(null);
  const flashTimer = useRef(null);

  // Focus highlight: App sets focusId when another surface (queue card,
  // todo chip) wants to "open" this client — the Clients tab IS the record
  // surface, so opening = scroll here and flash the border. We ack via
  // onFocusHandled immediately; the flash timer lives in a ref so the prop
  // flipping back to null doesn't cut the highlight short, and a NEW
  // focusId targeting this row while mounted re-fires cleanly.
  useEffect(() => {
    if (!focused) return;
    rowRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    setFlash(true);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(false), 2000);
    onFocusHandled?.();
  }, [focused, onFocusHandled]);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const startEdit = (field) => {
    if (archived || busy) return;
    setEditField(field);
    setEditValue(field === "name" ? rel.name : rel.company || "");
  };
  const commitEdit = () => {
    const field = editField;
    setEditField(null);
    if (!field) return;
    const next = editValue.trim();
    const current = field === "name" ? rel.name : rel.company || "";
    if (next === current) return;            // no-op edit — skip the round-trip
    if (field === "name" && !next) return;   // name is required — blanking = cancel
    onInlineSave(rel, { [field]: next || null }); // empty company clears it
  };
  const editKeys = (e) => {
    if (e.key === "Enter") e.currentTarget.blur(); // blur commits (single save path)
    else if (e.key === "Escape") setEditField(null); // unmount w/o commit — removal fires no blur
  };
  const editInput = (fontWeight) => (
    <input
      autoFocus
      value={editValue}
      onChange={(e) => setEditValue(e.target.value)}
      onBlur={commitEdit}
      onKeyDown={editKeys}
      style={{ ...miniInputStyle, fontWeight, flex: 1, maxWidth: 260 }}
    />
  );

  const openRebind = () => {
    if (archived) return;
    if (!rebindOpen) {
      // Prefill from the current binding so "edit" starts from reality.
      setBindGroup(rel.telegramChat?.group || "");
      setBindChatId(rel.telegramChat?.chatId != null ? String(rel.telegramChat.chatId) : "");
    }
    setRebindOpen(!rebindOpen);
  };
  const saveRebind = () => {
    const g = bindGroup.trim();
    const cid = bindChatId.trim();
    if (!g && !cid) return; // at least one — an all-null "save" is Clear's job
    setRebindOpen(false);
    onRebind(rel, { telegramGroup: g || null, telegramChatId: cid || null });
  };
  const clearRebind = () => {
    setRebindOpen(false);
    onRebind(rel, { telegramGroup: null, telegramChatId: null }, true);
  };

  const saveLinkChat = () => {
    const g = chatName.trim();
    if (!g) return;
    setChatFormOpen(false);
    onLinkChat(rel, { kind: chatKind, telegramGroup: g, contactName: chatContact.trim() || null });
    setChatName(""); setChatContact(""); setChatKind("dm");
  };

  return (
    <div
      ref={rowRef}
      className="flex items-center"
      style={{
        gap: "var(--space-3)",
        rowGap: "var(--space-2)",
        flexWrap: "wrap", // slim-column window: controls wrap under the name
        padding: "var(--space-2-5) var(--space-3)",
        borderRadius: "var(--radius-lg)",
        border: "1px solid",
        borderColor: flash ? "var(--brand)" : "var(--border)",
        boxShadow: flash ? "0 0 0 1px var(--brand)" : "none",
        transition: "border-color 600ms ease, box-shadow 600ms ease",
        background: "var(--surface-2)",
        opacity: archived ? 0.55 : 1,
      }}
    >
      <CompanyLogo company={rel.name} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="flex items-center" style={{ gap: "var(--space-2)" }}>
          {editField === "name" ? (
            editInput(600)
          ) : (
            <span
              onClick={() => startEdit("name")}
              title={archived ? undefined : "Click to edit name"}
              style={{
                fontSize: "var(--font-md)", fontWeight: 600, color: "var(--text)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                cursor: archived ? "default" : "text",
              }}
            >
              {rel.name}
            </span>
          )}
          <TelegramBadge telegramChat={rel.telegramChat} onClick={archived ? undefined : openRebind} />
        </div>
        {editField === "company" ? (
          <div style={{ marginTop: 1 }}>{editInput(400)}</div>
        ) : (
          <div
            onClick={() => startEdit("company")}
            title={archived ? undefined : "Click to edit company"}
            style={{
              fontSize: "var(--font-sm)", color: "var(--text-muted)", marginTop: 1,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              cursor: archived ? "default" : "text",
            }}
          >
            {rel.company || <span style={{ fontStyle: "italic", color: "var(--text-faint)" }}>No company</span>}
          </div>
        )}
        {/* Telegram rebind — group name and/or chat id (at least one to save;
            the sweep self-heals the chat_id from the name after the first
            match). NOTE: the backend auto-schedules a debounced sweep when a
            PATCH sets a binding (routes.js sweepIfBound → telegram.sweepSoon),
            so fresh insights arrive without waiting for the 30-min timer. */}
        {rebindOpen && !archived && (
          <div className="flex items-center" style={{ gap: "var(--space-1-5)", marginTop: "var(--space-1-5)", flexWrap: "wrap" }}>
            <input
              autoFocus
              style={{ ...miniInputStyle, flex: 1, minWidth: 140 }}
              placeholder="Telegram group name"
              value={bindGroup}
              onChange={(e) => setBindGroup(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveRebind(); else if (e.key === "Escape") setRebindOpen(false); }}
            />
            <input
              style={{ ...miniInputStyle, width: 110, fontFamily: MONO }}
              placeholder="chat id"
              value={bindChatId}
              onChange={(e) => setBindChatId(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveRebind(); else if (e.key === "Escape") setRebindOpen(false); }}
            />
            <button
              className={miniPrimaryBtn} style={miniPrimaryStyle}
              disabled={busy || (!bindGroup.trim() && !bindChatId.trim())}
              onClick={saveRebind}
            >
              Save
            </button>
            <button
              className={miniGhostBtn} style={miniGhostStyle}
              title="Remove the Telegram binding — the sweep stops matching this client"
              disabled={busy || !(rel.telegramChat?.group || rel.telegramChat?.chatId)}
              onClick={clearRebind}
            >
              Clear binding
            </button>
            <button className={miniGhostBtn} style={miniGhostStyle} disabled={busy} onClick={() => setRebindOpen(false)}>
              Cancel
            </button>
          </div>
        )}
        {/* Linked chats beyond the primary binding — DMs with the client's
            people, side rooms. Unlink is instant; the sweep just stops
            reading that chat. The "+ link chat" chip shows even with zero
            linked chats so the surface isn't a dead end. */}
        {(linkedChats.length > 0 || !archived) && (
          <div className="flex items-center" style={{ gap: "var(--space-1)", marginTop: "var(--space-1)", flexWrap: "wrap" }}>
            {linkedChats.map((c) => (
              <span
                key={c.id}
                title={`${c.kind === "dm" ? "Direct chat" : "Linked group"}: ${c.contactName || c.group || `chat ${c.chatId}`}`}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "var(--space-1)",
                  padding: "1px var(--space-1-5)",
                  borderRadius: "var(--radius-pill)",
                  fontSize: "var(--font-xs)", fontFamily: MONO,
                  background: "var(--surface-3)", color: "var(--text-secondary)",
                  maxWidth: 170,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.kind === "dm" ? "@" : "#"} {c.contactName || c.group || c.chatId}
                </span>
                {!archived && (
                  <button
                    title="Unlink this chat"
                    disabled={busy}
                    onClick={() => onUnlinkChat(rel, c)}
                    style={{ border: "none", background: "none", cursor: "pointer", color: "var(--text-faint)", padding: 0, lineHeight: 1 }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {!archived && (
              <button
                title="Link another chat (a DM or side room) to this client"
                disabled={busy}
                onClick={() => setChatFormOpen((v) => !v)}
                style={{
                  display: "inline-flex", alignItems: "center",
                  padding: "1px var(--space-1-5)",
                  borderRadius: "var(--radius-pill)",
                  border: "1px dashed var(--border)",
                  fontSize: "var(--font-xs)", fontFamily: MONO,
                  background: "none", color: "var(--text-faint)",
                  cursor: "pointer",
                }}
              >
                + link chat
              </button>
            )}
          </div>
        )}
        {/* Link-chat mini-form — the dialog name is the sweep's match key
            (self-heals to chat_id after the first match); contact name is
            just the display label for DM chips. */}
        {chatFormOpen && !archived && (
          <div className="flex items-center" style={{ gap: "var(--space-1-5)", marginTop: "var(--space-1-5)", flexWrap: "wrap" }}>
            <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: "var(--radius-pill)", overflow: "hidden", flexShrink: 0 }}>
              {["dm", "group"].map((k) => (
                <button
                  key={k}
                  onClick={() => setChatKind(k)}
                  style={{
                    padding: "2px var(--space-2)",
                    fontSize: "var(--font-xs)", fontFamily: MONO,
                    border: "none", cursor: "pointer",
                    background: chatKind === k ? "var(--brand)" : "transparent",
                    color: chatKind === k ? "var(--brand-fg)" : "var(--text-secondary)",
                  }}
                >
                  {k === "dm" ? "DM" : "group"}
                </button>
              ))}
            </div>
            <input
              autoFocus
              style={{ ...miniInputStyle, flex: 1, minWidth: 130 }}
              placeholder="Chat / dialog name"
              value={chatName}
              onChange={(e) => setChatName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveLinkChat(); else if (e.key === "Escape") setChatFormOpen(false); }}
            />
            <input
              style={{ ...miniInputStyle, width: 140 }}
              placeholder="Contact name (optional)"
              value={chatContact}
              onChange={(e) => setChatContact(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveLinkChat(); else if (e.key === "Escape") setChatFormOpen(false); }}
            />
            <button
              className={miniPrimaryBtn} style={miniPrimaryStyle}
              disabled={busy || !chatName.trim()}
              onClick={saveLinkChat}
            >
              Link
            </button>
            <button className={miniGhostBtn} style={miniGhostStyle} disabled={busy} onClick={() => setChatFormOpen(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
      {/* Last touch — stamped by the sweep and the send route. "—" until the
          first sweep matches this chat. */}
      <span
        title={lastActivity ? `Last Telegram activity ${timeAgo(lastActivity)}` : "No Telegram activity recorded yet"}
        style={{ fontFamily: MONO, fontSize: "var(--font-sm)", color: "var(--text-faint)", width: 64, textAlign: "right", flexShrink: 0 }}
      >
        {lastActivity ? timeAgo(lastActivity) : "—"}
      </span>
      {/* Archived rows lose the stepper — the queue engine skips them, so a
          cadence edit there would be dead weight. */}
      {!archived && <CadenceStepper value={rel.cadenceDays} busy={busy} onSet={(d) => onSetCadence(rel, d)} />}
      {archived ? (
        <IconBtn title="Unarchive" disabled={busy} onClick={() => onUnarchive(rel)}>
          <ArchiveRestore size={12} />
        </IconBtn>
      ) : (
        <IconBtn title="Archive" disabled={busy} onClick={() => onArchive(rel)}>
          <Archive size={12} />
        </IconBtn>
      )}
      <IconBtn title="Delete" disabled={busy} danger onClick={() => onDelete(rel)}>
        <Trash2 size={12} />
      </IconBtn>
    </div>
  );
};

export const Clients = ({ relationships = [], refetch, showToast, focusId = null, onFocusHandled }) => {
  // Inline add form (top of the list).
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [group, setGroup] = useState("");
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState("");
  // Row-level mutation guard — one in-flight mutation at a time per row.
  const [busyId, setBusyId] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  // Search — case-insensitive substring over name / company / Telegram group.
  const [query, setQuery] = useState("");

  const active = useMemo(() => relationships.filter((r) => !r.archivedAt), [relationships]);
  const archived = useMemo(() => relationships.filter((r) => r.archivedAt), [relationships]);

  const q = query.trim().toLowerCase();
  const filteredActive = useMemo(() => (q ? active.filter((r) => matchesQuery(r, q)) : active), [active, q]);
  const filteredArchived = useMemo(() => (q ? archived.filter((r) => matchesQuery(r, q)) : archived), [archived, q]);

  // A focus request may point at a row the current view hides (archived +
  // collapsed, or filtered out by the search) — un-hide it BEFORE the row's
  // own scroll-and-flash effect can run. Unknown ids are acked right away so
  // a stale focusId can't fire a surprise flash if that rel appears later.
  useEffect(() => {
    if (focusId == null) return;
    const rel = relationships.find((r) => r.id === focusId);
    if (!rel) { onFocusHandled?.(); return; }
    if (rel.archivedAt) setShowArchived(true);
    setQuery((cur) => (cur.trim() && !matchesQuery(rel, cur.trim().toLowerCase()) ? "" : cur));
  }, [focusId, relationships, onFocusHandled]);

  // Shared mutate-then-refetch wrapper for row actions. Errors surface via
  // the toast (with the reason) — the list itself stays consistent because
  // nothing here is optimistic.
  const run = async (id, fn, successMsg) => {
    setBusyId(id);
    try {
      await fn();
      await refetch();
      if (successMsg) showToast?.(successMsg);
    } catch (e) {
      showToast?.(`Something went wrong — ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleAdd = async () => {
    const n = name.trim();
    if (!n || adding) return;
    setAdding(true);
    setFormError("");
    try {
      await api.createRelationship({
        name: n,
        company: company.trim() || null,
        telegramGroup: group.trim() || null,
      });
      await refetch();
      setName(""); setCompany(""); setGroup("");
      showToast?.(`Now tracking ${n}`);
    } catch (e) {
      setFormError(e.message);
    } finally {
      setAdding(false);
    }
  };

  const handleSetCadence = (rel, days) =>
    run(rel.id, () => api.setCadence(rel.id, days));
  const handleArchive = (rel) =>
    run(rel.id, () => api.archiveRelationship(rel.id), `${rel.name} archived`);
  const handleUnarchive = (rel) =>
    run(rel.id, () => api.unarchiveRelationship(rel.id), `${rel.name} restored`);
  const handleDelete = (rel) => {
    // FKs do the cleanup: todos/notes unlink (SET NULL), promises cascade.
    if (!window.confirm(`Delete ${rel.name}? Their todos and notes stay but lose the link; open promises are removed. This can't be undone.`)) return;
    run(rel.id, () => api.deleteRelationship(rel.id), `${rel.name} deleted`);
  };

  const handleUnlinkChat = (rel, chat) =>
    run(
      rel.id,
      () => api.removeRelationshipChat(rel.id, chat.id),
      `Unlinked ${chat.contactName || chat.group || "chat"} from ${rel.name}`
    );

  // Inline name/company save (audit C6) — one field per PATCH.
  const handleInlineSave = (rel, patch) =>
    run(rel.id, () => api.updateRelationship(rel.id, patch), "Saved");

  // Telegram rebind (audit M7-UX). NOTE: the backend auto-triggers a
  // debounced sweep whenever a PATCH sets telegramGroup/telegramChatId
  // (routes.js sweepIfBound → telegram.sweepSoon), so the new binding gets
  // insights without waiting for the 30-min timer.
  const handleRebind = (rel, patch, cleared = false) =>
    run(
      rel.id,
      () => api.updateRelationship(rel.id, patch),
      cleared ? `Telegram binding cleared for ${rel.name}` : `Telegram binding saved — sweep scheduled`
    );

  const handleLinkChat = (rel, body) =>
    run(
      rel.id,
      () => api.addRelationshipChat(rel.id, body),
      `Linked ${body.contactName || body.telegramGroup} to ${rel.name}`
    );

  const rowProps = {
    onSetCadence: handleSetCadence,
    onArchive: handleArchive,
    onUnarchive: handleUnarchive,
    onDelete: handleDelete,
    onUnlinkChat: handleUnlinkChat,
    onInlineSave: handleInlineSave,
    onRebind: handleRebind,
    onLinkChat: handleLinkChat,
    onFocusHandled,
  };

  return (
    <div style={{ maxWidth: 720 }} className="space-y-4">
      <div>
        <h2 style={{ fontSize: "var(--font-2xl)", fontWeight: 700, color: "var(--text)" }}>Clients</h2>
        <p style={{ fontSize: "var(--font-base)", color: "var(--text-muted)", marginTop: "var(--space-0-5)" }}>
          {active.length} tracked relationship{active.length === 1 ? "" : "s"} — the
          cadence sets how many days of silence read as going cold in the Queue.
        </p>
      </div>

      {/* Inline add — name required; the Telegram group is the sweep's match
          key (exact dialog name works best; the sweep self-heals to chat_id
          after the first match). Suggestions in the Queue are the other way
          rows get here. */}
      <div
        className="p-3 rounded-lg border space-y-2"
        style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}
      >
        <div className="flex items-center" style={{ gap: "var(--space-2)" }}>
          <input
            style={{ ...inputStyle, flex: 1.2 }}
            placeholder="Name (required)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
          />
          <input
            style={{ ...inputStyle, flex: 1 }}
            placeholder="Company (optional)"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
          />
          <input
            style={{ ...inputStyle, flex: 1 }}
            placeholder="Telegram group (optional)"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
          />
          <button
            className="px-3 py-1.5 rounded-md text-xs font-semibold disabled:opacity-50 inline-flex items-center"
            style={{ background: "var(--brand)", color: "var(--brand-fg)", gap: "var(--space-1)", flexShrink: 0 }}
            disabled={adding || !name.trim()}
            onClick={handleAdd}
          >
            <Plus size={12} /> {adding ? "Adding…" : "Add"}
          </button>
        </div>
        {formError && (
          <p style={{ fontSize: "var(--font-sm)", color: "var(--danger-soft)" }}>{formError}</p>
        )}
      </div>

      {/* Search (audit U6) — filters active AND archived; the count reads
          "matches of total" while a query is live. Escape clears. */}
      {relationships.length > 0 && (
        <div className="flex items-center" style={{ gap: "var(--space-2)" }}>
          <input
            style={{ ...inputStyle, flex: 1 }}
            placeholder="Search by name, company, or Telegram group…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
          />
          {q && (
            <span style={{ fontFamily: MONO, fontSize: "var(--font-sm)", color: "var(--text-faint)", flexShrink: 0 }}>
              {filteredActive.length + filteredArchived.length} of {relationships.length}
            </span>
          )}
        </div>
      )}

      {/* Active relationships */}
      {active.length === 0 ? (
        <div
          className="text-center rounded-lg border"
          style={{ borderColor: "var(--border)", borderStyle: "dashed", padding: "var(--space-12) var(--space-6)", color: "var(--text-muted)", fontSize: "var(--font-md)" }}
        >
          No relationships yet — add one above, or accept a suggestion from the
          Queue's "New conversations" block.
        </div>
      ) : filteredActive.length === 0 ? (
        <div
          className="text-center rounded-lg border"
          style={{ borderColor: "var(--border)", borderStyle: "dashed", padding: "var(--space-6)", color: "var(--text-muted)", fontSize: "var(--font-md)" }}
        >
          No active clients match "{query.trim()}".
        </div>
      ) : (
        <div className="space-y-2">
          {filteredActive.map((rel) => (
            <ClientRow key={rel.id} rel={rel} busy={busyId === rel.id} focused={focusId === rel.id} {...rowProps} />
          ))}
        </div>
      )}

      {/* Archived — collapsed by default; kept out of the queue engine but
          restorable (unarchive) or permanently deletable. Hidden entirely
          when a search matches none of them. */}
      {archived.length > 0 && (!q || filteredArchived.length > 0) && (
        <div style={{ paddingTop: "var(--space-2)" }}>
          <button
            className="flex items-center"
            onClick={() => setShowArchived((v) => !v)}
            style={{
              gap: "var(--space-1-5)", background: "none", border: "none",
              cursor: "pointer", padding: 0,
              fontFamily: MONO, fontSize: "var(--font-xs)", fontWeight: 600,
              textTransform: "uppercase", letterSpacing: "0.1em",
              color: "var(--text-faint)",
            }}
          >
            {showArchived ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Archived ({filteredArchived.length}{q ? ` of ${archived.length}` : ""})
          </button>
          {showArchived && (
            <div className="space-y-2" style={{ marginTop: "var(--space-2)" }}>
              {filteredArchived.map((rel) => (
                <ClientRow key={rel.id} rel={rel} busy={busyId === rel.id} focused={focusId === rel.id} {...rowProps} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Clients;
