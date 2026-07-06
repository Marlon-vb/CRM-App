import { useMemo, useState } from "react";
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

   Props (from App.jsx):
     relationships — the list App keeps in state (active + archived)
     refetch       — App's refetchAll; every mutation persists via
                     lib/api.js then refetches so all tabs see the change
     showToast     — confirmation toast (App passes no error variant here,
                     so failures reuse it with the reason in the message)
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
   whose dialog title changed) still counts as linked. */
const TelegramBadge = ({ telegramChat }) => {
  const linked = Boolean(telegramChat?.group || telegramChat?.chatId);
  return (
    <span
      title={linked ? `Telegram: ${telegramChat.group || `chat ${telegramChat.chatId}`}` : "No Telegram binding — add a group name so the sweep can match this chat"}
      style={{
        display: "inline-flex", alignItems: "center", gap: "var(--space-1)",
        padding: "var(--space-0-5) var(--space-1-5)",
        borderRadius: "var(--radius-pill)",
        fontSize: "var(--font-xs)", fontFamily: MONO,
        background: linked ? "var(--tone-skyblue-bg)" : "var(--surface-3)",
        color: linked ? "var(--telegram)" : "var(--text-faint)",
        maxWidth: 180, flexShrink: 0,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor", flexShrink: 0 }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {linked ? (telegramChat.group || "linked") : "not linked"}
      </span>
    </span>
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

const ClientRow = ({ rel, busy, onSetCadence, onArchive, onUnarchive, onDelete }) => {
  const archived = Boolean(rel.archivedAt);
  const lastActivity = rel.telegramChat?.lastActivity;
  return (
    <div
      className="flex items-center"
      style={{
        gap: "var(--space-3)",
        padding: "var(--space-2-5) var(--space-3)",
        borderRadius: "var(--radius-lg)",
        border: "1px solid var(--border)",
        background: "var(--surface-2)",
        opacity: archived ? 0.55 : 1,
      }}
    >
      <CompanyLogo company={rel.name} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="flex items-center" style={{ gap: "var(--space-2)" }}>
          <span style={{ fontSize: "var(--font-md)", fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {rel.name}
          </span>
          <TelegramBadge telegramChat={rel.telegramChat} />
        </div>
        <div style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {rel.company || <span style={{ fontStyle: "italic", color: "var(--text-faint)" }}>No company</span>}
        </div>
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

export const Clients = ({ relationships = [], refetch, showToast }) => {
  // Inline add form (top of the list).
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [group, setGroup] = useState("");
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState("");
  // Row-level mutation guard — one in-flight mutation at a time per row.
  const [busyId, setBusyId] = useState(null);
  const [showArchived, setShowArchived] = useState(false);

  const active = useMemo(() => relationships.filter((r) => !r.archivedAt), [relationships]);
  const archived = useMemo(() => relationships.filter((r) => r.archivedAt), [relationships]);

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

  const rowProps = {
    onSetCadence: handleSetCadence,
    onArchive: handleArchive,
    onUnarchive: handleUnarchive,
    onDelete: handleDelete,
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

      {/* Active relationships */}
      {active.length === 0 ? (
        <div
          className="text-center rounded-lg border"
          style={{ borderColor: "var(--border)", borderStyle: "dashed", padding: "var(--space-12) var(--space-6)", color: "var(--text-muted)", fontSize: "var(--font-md)" }}
        >
          No relationships yet — add one above, or accept a suggestion from the
          Queue's "New conversations" block.
        </div>
      ) : (
        <div className="space-y-2">
          {active.map((rel) => (
            <ClientRow key={rel.id} rel={rel} busy={busyId === rel.id} {...rowProps} />
          ))}
        </div>
      )}

      {/* Archived — collapsed by default; kept out of the queue engine but
          restorable (unarchive) or permanently deletable. */}
      {archived.length > 0 && (
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
            Archived ({archived.length})
          </button>
          {showArchived && (
            <div className="space-y-2" style={{ marginTop: "var(--space-2)" }}>
              {archived.map((rel) => (
                <ClientRow key={rel.id} rel={rel} busy={busyId === rel.id} {...rowProps} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Clients;
