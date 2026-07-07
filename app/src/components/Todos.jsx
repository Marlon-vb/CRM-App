import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Plus, RefreshCw, Loader2, Star, Trash2, Check, MessageCircle,
  Sun, ListTodo, ListChecks, ChevronDown, ChevronRight, X, Briefcase, ArrowUpRight, Calendar, FileText,
} from "lucide-react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api } from "../lib/api";
import { parseDuePhrase } from "../lib/dateparse";

const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/* ── Date helpers — all comparisons are local-date based ── */
const pad = (n) => String(n).padStart(2, "0");
function parseDate(s) {
  if (!s) return null;
  const p = String(s).split("-");
  if (p.length !== 3) return null;
  const d = new Date(+p[0], +p[1] - 1, +p[2]);
  return Number.isNaN(d.getTime()) ? null : d;
}
function daysFromToday(s) {
  const d = parseDate(s);
  if (!d) return null;
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return Math.round((d - t) / 86400000);
}
function bucketOf(dueDate) {
  const n = daysFromToday(dueDate);
  if (n == null) return "none";
  if (n < 0) return "overdue";
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n <= 7) return "week";
  return "later";
}
function fmtDue(dueDate) {
  const n = daysFromToday(dueDate);
  if (n == null) return null;
  if (n < 0) return `${Math.abs(n)}d overdue`;
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  const d = parseDate(dueDate);
  if (n <= 7) return d.toLocaleDateString("en-GB", { weekday: "short" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/* ── Static metadata ──
   Section order (top → bottom): newest first, then overdue, then date buckets. */
const GROUPS = [
  { key: "none",     label: "New",       color: "var(--brand)" },
  { key: "overdue",  label: "Overdue",   color: "var(--danger-soft)" },
  { key: "today",    label: "Today",     color: "var(--info-soft)" },
  { key: "tomorrow", label: "Tomorrow",  color: "var(--brand-soft)" },
  { key: "week",     label: "This Week", color: "var(--text-secondary)" },
  { key: "later",    label: "Later",     color: "var(--text-muted)" },
];
const PRIORITY = {
  high:   { color: "var(--danger-soft)",  label: "High" },
  medium: { color: "var(--warning-soft)", label: "Medium" },
  low:    { color: "var(--text-faint)",   label: "Low" },
};

/* Auto-extracted todos carry a source — show a small icon for it.
   Granola gets its own color so meeting-note todos read distinctly from chat ones. */
const SOURCE_ICON = {
  telegram: { Icon: MessageCircle, color: "var(--telegram)", label: "From Telegram" },
  granola:  { Icon: FileText,      color: "var(--granola)",  label: "From a Granola note" },
};
const SOURCE_ACCENT = {
  telegram: { border: "var(--telegram)", tint: "rgba(56,189,248,0.05)" },
  granola:  { border: "var(--granola)",  tint: "var(--granola-soft)" },
};

/* ── Loading skeleton row ── */
const SkeletonRow = () => (
  <div
    className="animate-pulse"
    style={{
      display: "flex", alignItems: "center", gap: "var(--space-3)",
      padding: "var(--space-2-5) var(--space-3)", borderRadius: "var(--radius-lg)",
      background: "var(--surface)", border: "1px solid var(--border)",
    }}
  >
    <div style={{ width: 18, height: 18, borderRadius: "50%", background: "var(--surface-3)", flexShrink: 0 }} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ height: 9, width: "55%", borderRadius: "var(--radius-sm)", background: "var(--surface-3)" }} />
      <div style={{ height: 7, width: "30%", borderRadius: "var(--radius-sm)", background: "var(--surface-2)", marginTop: "var(--space-2)" }} />
    </div>
  </div>
);

/* ── Empty state ── */
const EmptyState = ({ view }) => (
  <div className="flex flex-col items-center justify-center" style={{ padding: "var(--space-16) var(--space-4)", textAlign: "center" }}>
    <div style={{
      width: 56, height: 56, borderRadius: "50%",
      background: "var(--brand-tint-2)", display: "grid", placeItems: "center",
      marginBottom: "var(--space-4)",
    }}>
      <ListTodo size={26} style={{ color: "var(--brand)" }} />
    </div>
    <p style={{ fontSize: "var(--font-lg)", fontWeight: 600, color: "var(--text)", margin: 0 }}>
      {view === "myday" ? "Nothing for today" : "No tasks yet"}
    </p>
    <p style={{ fontSize: "var(--font-base)", color: "var(--text-muted)", marginTop: "var(--space-1)", maxWidth: 320 }}>
      {view === "myday"
        ? "Tasks due today or added to My Day will show up here."
        : "Add one above, or refresh from Telegram to pull in follow-ups from your chats."}
    </p>
  </div>
);

/* ── Round checkbox with a satisfying check-off ── */
const Checkbox = ({ done, onToggle }) => {
  const [pop, setPop] = useState(false);
  const prevDone = useRef(done);
  useEffect(() => {
    if (done && !prevDone.current) {
      setPop(true);
      const id = setTimeout(() => setPop(false), 320);
      prevDone.current = done;
      return () => clearTimeout(id);
    }
    prevDone.current = done;
  }, [done]);

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={pop ? "todo-check-pop" : ""}
      title={done ? "Mark as not done" : "Mark as done"}
      style={{
        width: 19, height: 19, borderRadius: "50%", flexShrink: 0,
        border: `1.5px solid ${done ? "var(--success)" : "var(--border-strong)"}`,
        background: done ? "var(--success)" : "transparent",
        cursor: "pointer", display: "grid", placeItems: "center", padding: 0,
        transition: "background 160ms ease, border-color 160ms ease",
      }}
    >
      <Check
        size={12}
        strokeWidth={3.5}
        style={{
          color: "#fff",
          opacity: done ? 1 : 0,
          transform: done ? "scale(1)" : "scale(0.4)",
          transition: "opacity 140ms ease, transform 160ms cubic-bezier(.34,1.56,.64,1)",
        }}
      />
    </button>
  );
};

/* ── One todo row ── */
function TodoRow({
  todo, selected, focused, editing, completing, relationship,
  onSelect, onToggle, onStar, onDelete, onStartEdit, onCommitEdit, onCancelEdit, onOpenClient,
  draggable,
}) {
  const [hover, setHover] = useState(false);
  const [text, setText] = useState(todo.task);
  const editRef = useRef(null);
  // @dnd-kit sortable handle. Disabled while editing (so input keys / clicks
  // don't get hijacked) and on completed rows (they're frozen anyway).
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: todo.id,
    data: { bucket: bucketOf(todo.dueDate) },
    disabled: !draggable || editing || todo.completed,
  });

  useEffect(() => { if (editing) { setText(todo.task); setTimeout(() => editRef.current?.focus(), 0); } }, [editing, todo.task]);

  const src = SOURCE_ICON[todo.source];
  const accent = SOURCE_ACCENT[todo.source];
  const pri = PRIORITY[todo.priority] || PRIORITY.medium;
  const due = fmtDue(todo.dueDate);
  const overdue = bucketOf(todo.dueDate) === "overdue";

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={completing ? "todo-completing" : (!todo.completed ? "todo-row" : undefined)}
      onClick={() => onSelect(todo.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "flex-start", gap: "var(--space-2-5)",
        padding: "var(--space-2-5) var(--space-3)", borderRadius: "var(--radius-lg)",
        background: selected
          ? "var(--surface-2)"
          : (accent ? accent.tint : "var(--surface)"),
        border: `1px solid ${selected ? "var(--brand-border)" : "var(--border)"}`,
        borderLeft: accent ? `3px solid ${accent.border}` : undefined,
        boxShadow: focused && !selected ? "inset 0 0 0 1px var(--border-strong)" : "none",
        cursor: editing ? "text" : "pointer",
        opacity: isDragging ? 0.4 : (todo.completed ? 0.6 : (todo._pending ? 0.55 : 1)),
        transform: CSS.Transform.toString(transform),
        transition: transition || "background 120ms ease, border-color 120ms ease, opacity 200ms ease",
        touchAction: "none",
      }}
    >
      <div style={{ paddingTop: 1 }}>
        <Checkbox done={todo.completed} onToggle={() => onToggle(todo)} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input
            ref={editRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => onCommitEdit(todo.id, text)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); onCommitEdit(todo.id, text); }
              if (e.key === "Escape") { e.preventDefault(); onCancelEdit(); }
            }}
            style={{
              width: "100%", fontSize: "var(--font-md)", fontWeight: 500, color: "var(--text)",
              background: "var(--surface-3)", border: "1px solid var(--brand-border)",
              borderRadius: "var(--radius-sm)", padding: "var(--space-1) var(--space-2)", outline: "none",
            }}
          />
        ) : (
          <div
            onClick={(e) => { e.stopPropagation(); onStartEdit(todo.id); }}
            style={{
              fontSize: "var(--font-md)", fontWeight: 500, lineHeight: 1.4,
              color: todo.completed ? "var(--text-muted)" : "var(--text)",
              textDecoration: todo.completed ? "line-through" : "none",
              wordBreak: "break-word",
            }}
            title="Click to edit"
          >
            {todo.task}
          </div>
        )}

        {/* Meta line */}
        <div className="flex items-center" style={{ gap: "var(--space-2)", marginTop: "var(--space-1)", flexWrap: "wrap" }}>
          {due && (
            <span style={{
              fontSize: "var(--font-xs)", fontFamily: MONO, fontWeight: 600,
              color: overdue ? "var(--danger-soft)" : "var(--text-muted)",
            }}>
              {due}
            </span>
          )}
          {src && (
            <src.Icon size={10} style={{ color: src.color, flexShrink: 0 }} aria-label={src.label} />
          )}
          {relationship ? (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenClient?.(relationship.id); }}
              className="inline-flex items-center"
              style={{
                gap: "var(--space-1)", padding: "1px 6px", borderRadius: "var(--radius-sm)", maxWidth: 170,
                background: "var(--brand-tint-2)", border: "1px solid var(--brand-border)",
                color: "var(--brand)", fontSize: "var(--font-xs)", fontWeight: 500, cursor: "pointer",
              }}
              title={`Open ${relationship.name}`}
            >
              <Briefcase size={10} style={{ flexShrink: 0 }} />
              <span className="truncate">{relationship.name}</span>
            </button>
          ) : todo.sourceConversation ? (
            <span className="truncate" style={{ fontSize: "var(--font-xs)", color: "var(--text-faint)", maxWidth: 170 }}>
              {todo.sourceConversation}
            </span>
          ) : null}
          {todo.priority !== "low" && (
            <span className="inline-flex items-center" style={{ gap: "var(--space-1)" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: pri.color }} />
              <span style={{ fontSize: "var(--font-xs)", color: "var(--text-faint)" }}>{pri.label}</span>
            </span>
          )}
        </div>
      </div>

      {/* Right actions */}
      <div className="flex items-center" style={{ gap: "var(--space-0-5)", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => onStar(todo)}
          title={todo.starred ? "Unstar" : "Mark important"}
          style={{
            padding: "var(--space-1)", borderRadius: "var(--radius-sm)", border: "none", background: "transparent", cursor: "pointer",
            color: todo.starred ? "var(--warning-soft)" : "var(--text-faint)",
            opacity: todo.starred || hover ? 1 : 0,
            transition: "opacity 120ms ease",
          }}
        >
          <Star size={14} fill={todo.starred ? "var(--warning-soft)" : "none"} />
        </button>
        <button
          onClick={() => onDelete(todo)}
          title="Delete task"
          style={{
            padding: "var(--space-1)", borderRadius: "var(--radius-sm)", border: "none", background: "transparent", cursor: "pointer",
            color: "var(--text-faint)", opacity: hover ? 1 : 0,
            transition: "opacity 120ms ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger-soft)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

/* ── Detail pane ── */
function DetailPane({ todo, relationship, onClose, onPatch, onDelete, onOpenClient }) {
  const [task, setTask] = useState(todo.task);
  const [notes, setNotes] = useState(todo.notes || "");
  useEffect(() => { setTask(todo.task); setNotes(todo.notes || ""); }, [todo.id]);

  const Label = ({ children }) => (
    <div style={{
      fontSize: "var(--font-xs)", fontFamily: MONO, fontWeight: 600, letterSpacing: "0.08em",
      textTransform: "uppercase", color: "var(--text-faint)", marginBottom: "var(--space-2)",
    }}>
      {children}
    </div>
  );

  return (
    <div style={{
      width: 320, flexShrink: 0, alignSelf: "flex-start",
      background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: "var(--radius-2xl)", padding: "var(--space-4)", position: "sticky", top: 0,
      display: "flex", flexDirection: "column", gap: "var(--space-4)",
    }}>
      <div className="flex items-center justify-between">
        <span style={{ fontSize: "var(--font-base)", fontWeight: 700, color: "var(--text)", letterSpacing: "-0.01em" }}>
          Task details
        </span>
        <button
          onClick={onClose}
          style={{ padding: "var(--space-1)", borderRadius: "var(--radius-sm)", border: "none", background: "transparent", cursor: "pointer", color: "var(--text-faint)" }}
        >
          <X size={15} />
        </button>
      </div>

      {/* Task text */}
      <div>
        <Label>Task</Label>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onBlur={() => { const t = task.trim(); if (t && t !== todo.task) onPatch(todo.id, { task: t }); else setTask(todo.task); }}
          rows={2}
          style={{
            width: "100%", fontSize: "var(--font-md)", fontWeight: 500, color: "var(--text)",
            background: "var(--surface-2)", border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)", padding: "var(--space-2) var(--space-2-5)", outline: "none", resize: "vertical",
            fontFamily: "inherit", lineHeight: 1.45,
          }}
        />
      </div>

      {/* Quick toggles */}
      <div className="flex items-center" style={{ gap: "var(--space-2)" }}>
        <button
          onClick={() => onPatch(todo.id, { myDay: !todo.myDay })}
          className="inline-flex items-center"
          style={{
            gap: "var(--space-1-5)", padding: "var(--space-1-5) var(--space-2-5)", borderRadius: "var(--radius-md)", fontSize: "var(--font-sm)", fontWeight: 600, cursor: "pointer",
            background: todo.myDay ? "var(--brand-tint-2)" : "var(--surface-2)",
            color: todo.myDay ? "var(--brand)" : "var(--text-secondary)",
            border: `1px solid ${todo.myDay ? "var(--brand-border)" : "var(--border)"}`,
          }}
        >
          <Sun size={12} /> {todo.myDay ? "In My Day" : "Add to My Day"}
        </button>
        <button
          onClick={() => onPatch(todo.id, { starred: !todo.starred })}
          title={todo.starred ? "Unstar" : "Mark important"}
          style={{
            padding: "var(--space-1-5)", borderRadius: "var(--radius-md)", cursor: "pointer",
            background: todo.starred ? "var(--tone-amber-bg)" : "var(--surface-2)",
            color: todo.starred ? "var(--warning-soft)" : "var(--text-faint)",
            border: `1px solid ${todo.starred ? "rgba(247,104,8,0.30)" : "var(--border)"}`,
          }}
        >
          <Star size={13} fill={todo.starred ? "var(--warning-soft)" : "none"} />
        </button>
      </div>

      {/* Priority */}
      <div>
        <Label>Priority</Label>
        <div className="flex" style={{ gap: "var(--space-1-5)" }}>
          {["high", "medium", "low"].map((p) => {
            const active = todo.priority === p;
            return (
              <button
                key={p}
                onClick={() => onPatch(todo.id, { priority: p })}
                className="flex-1 inline-flex items-center justify-center"
                style={{
                  gap: "var(--space-1-5)", padding: "5px 0", borderRadius: "var(--radius-md)", fontSize: "var(--font-sm)", fontWeight: 600, cursor: "pointer",
                  background: active ? "var(--surface-3)" : "var(--surface-2)",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  border: `1px solid ${active ? "var(--border-strong)" : "var(--border)"}`,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: PRIORITY[p].color }} />
                {PRIORITY[p].label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Due date */}
      <div>
        <Label>Due date</Label>
        <div className="flex items-center" style={{ gap: "var(--space-1-5)" }}>
          <input
            type="date"
            value={todo.dueDate || ""}
            onChange={(e) => onPatch(todo.id, { dueDate: e.target.value || null })}
            style={{
              flex: 1, fontSize: "var(--font-base)", color: "var(--text)",
              background: "var(--surface-2)", border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)", padding: "var(--space-1-5) var(--space-2)", outline: "none", fontFamily: "inherit",
            }}
          />
          {todo.dueDate && (
            <button
              onClick={() => onPatch(todo.id, { dueDate: null })}
              title="Clear due date"
              style={{ padding: "var(--space-1-5)", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-faint)", cursor: "pointer" }}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Notes */}
      <div>
        <Label>Notes</Label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => { if (notes !== (todo.notes || "")) onPatch(todo.id, { notes }); }}
          rows={3}
          placeholder="Add a note…"
          style={{
            width: "100%", fontSize: "var(--font-base)", color: "var(--text)",
            background: "var(--surface-2)", border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)", padding: "var(--space-2) var(--space-2-5)", outline: "none", resize: "vertical",
            fontFamily: "inherit", lineHeight: 1.45,
          }}
        />
      </div>

      {/* Linked client */}
      {relationship && (
        <div>
          <Label>Linked client</Label>
          <button
            onClick={() => onOpenClient?.(relationship.id)}
            className="flex items-center"
            style={{
              width: "100%", gap: "var(--space-2)", padding: "var(--space-2) var(--space-2-5)", borderRadius: "var(--radius-md)",
              background: "var(--surface-2)", border: "1px solid var(--border)",
              cursor: "pointer", textAlign: "left",
            }}
            title={`Open ${relationship.name}`}
          >
            <Briefcase size={13} style={{ color: "var(--brand)", flexShrink: 0 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="truncate" style={{ fontSize: "var(--font-base)", fontWeight: 600, color: "var(--text)" }}>
                {relationship.name}
              </div>
              {relationship.company && (
                <div className="truncate" style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)" }}>
                  {relationship.company}
                </div>
              )}
            </div>
            <ArrowUpRight size={13} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
          </button>
        </div>
      )}

      {/* Source — Telegram chat or Granola note */}
      {(todo.source === "telegram" || todo.source === "granola") && (
        <div>
          <Label>{todo.source === "granola" ? "From a Granola note" : "From Telegram"}</Label>
          <div style={{
            background: "var(--surface-2)", border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md)", padding: "var(--space-2) var(--space-2-5)",
          }}>
            <div className="flex items-center" style={{ gap: "var(--space-1-5)", marginBottom: todo.sourceSnippet ? 5 : 0 }}>
              {todo.source === "granola"
                ? <FileText size={11} style={{ color: "var(--brand-soft)", flexShrink: 0 }} />
                : <MessageCircle size={11} style={{ color: "var(--telegram)", flexShrink: 0 }} />}
              <span className="truncate" style={{ fontSize: "var(--font-sm)", fontWeight: 600, color: "var(--text-secondary)" }}>
                {todo.sourceConversation || (todo.source === "granola" ? "Meeting note" : "Telegram chat")}
              </span>
            </div>
            {todo.sourceSnippet && (
              <p style={{ fontSize: "var(--font-sm)", fontStyle: "italic", color: "var(--text-muted)", margin: 0, lineHeight: 1.45 }}>
                "{todo.sourceSnippet}"
              </p>
            )}
          </div>
        </div>
      )}

      <button
        onClick={() => onDelete(todo)}
        className="inline-flex items-center justify-center"
        style={{
          gap: "var(--space-1-5)", padding: "7px 0", borderRadius: "var(--radius-md)", fontSize: "var(--font-base)", fontWeight: 600, cursor: "pointer",
          background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--danger-soft)"; e.currentTarget.style.borderColor = "rgba(229,72,77,0.35)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.borderColor = "var(--border)"; }}
      >
        <Trash2 size={13} /> Delete task
      </button>
    </div>
  );
}

/* ═══════════════════ MAIN ═══════════════════ */
export const Todos = ({ relationships = [], todos = [], setTodos, onOpenClient, showToast }) => {
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState("myday");           // "myday" | "all"
  const [selectedId, setSelectedId] = useState(null);
  const [focusedId, setFocusedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [newTask, setNewTask] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const [completing, setCompleting] = useState(() => new Set()); // ids mid check-off animation
  // @dnd-kit sensors. 5px activation distance — short enough that a small
  // mouse jiggle starts the drag (todo rows aren't tightly clickable like
  // queue cards), long enough that a clean click on the checkbox / row body
  // still registers as a click instead.
  const todoSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const inputRef = useRef(null);
  const todosRef = useRef([]);   // live mirror of `todos` — stale-free rollback snapshots
  const timersRef = useRef([]);  // pending check-off timers, cleared on unmount

  // App.jsx owns the canonical todo list; mirror it into a ref so optimistic
  // rollbacks always snapshot the latest state.
  useEffect(() => { todosRef.current = todos; }, [todos]);
  // clear any in-flight check-off timers if the tab unmounts mid-animation
  useEffect(() => () => timersRef.current.forEach(clearTimeout), []);

  /* ── Mutations (optimistic, rollback on error) ── */
  const patchTodo = useCallback(async (id, patch) => {
    // snapshot just this row so a failed update never clobbers unrelated todos
    const prevTodo = todosRef.current.find((t) => t.id === id) || null;
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    try {
      const updated = await api.updateTodo(id, patch);
      setTodos((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch (e) {
      if (prevTodo) setTodos((prev) => prev.map((t) => (t.id === id ? prevTodo : t)));
      showToast?.(`Update failed — ${e.message}`);
    }
  }, [showToast]);

  const toggleComplete = useCallback((todo) => {
    const next = !todo.completed;
    patchTodo(todo.id, { completed: next });
    if (next) {
      // hold the row in place briefly so the check-off animation reads,
      // then let it re-home into the Completed section
      setCompleting((prev) => new Set(prev).add(todo.id));
      const timer = setTimeout(() => {
        setCompleting((prev) => {
          const s = new Set(prev);
          s.delete(todo.id);
          return s;
        });
        timersRef.current = timersRef.current.filter((t) => t !== timer);
      }, 360);
      timersRef.current.push(timer);
    } else {
      setCompleting((prev) => {
        if (!prev.has(todo.id)) return prev;
        const s = new Set(prev);
        s.delete(todo.id);
        return s;
      });
    }
  }, [patchTodo]);

  const removeTodo = useCallback(async (todo) => {
    const snapshot = todos;
    setTodos((prev) => prev.filter((t) => t.id !== todo.id));
    if (selectedId === todo.id) setSelectedId(null);
    if (focusedId === todo.id) setFocusedId(null);
    try {
      await api.deleteTodo(todo.id);
      // The backend soft-deletes, so undo is a tombstone flip — surface it.
      showToast?.("Task deleted", {
        label: "Undo",
        fn: async () => {
          await api.restoreTodo(todo.id);
          setTodos(await api.listTodos());
        },
      });
    } catch (e) {
      setTodos(snapshot);
      showToast?.(`Delete failed — ${e.message}`);
    }
  }, [todos, selectedId, focusedId, showToast]);

  const addTodo = useCallback(async () => {
    const { task, dueDate } = parseDuePhrase(newTask);
    if (!task) return;
    setNewTask("");
    const tempId = -Date.now();
    const temp = {
      id: tempId, task, source: "manual", sourceRef: null, sourceConversation: "",
      sourceSnippet: "", relationshipId: null, dueDate: dueDate || null, priority: "medium",
      starred: false, myDay: view === "myday", sortOrder: 0,
      completed: false, completedAt: null, notes: "",
      createdAt: new Date().toISOString(), _pending: true,
    };
    setTodos((prev) => [temp, ...prev]);
    try {
      const created = await api.createTodo({ task, dueDate: dueDate || null, myDay: view === "myday" });
      setTodos((prev) => prev.map((t) => (t.id === tempId ? created : t)));
    } catch (e) {
      setTodos((prev) => prev.filter((t) => t.id !== tempId));
      showToast?.(`Couldn't add task — ${e.message}`);
    }
  }, [newTask, view, showToast]);

  const commitEdit = useCallback((id, text) => {
    setEditingId(null);
    const t = text.trim();
    const cur = todos.find((x) => x.id === id);
    if (t && cur && t !== cur.task) patchTodo(id, { task: t });
  }, [todos, patchTodo]);

  const runRefresh = useCallback(async ({ silent = false } = {}) => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await api.refreshTodos();
      const fresh = await api.listTodos();
      setTodos(fresh);
      const n = res.inserted?.length || 0;
      // On a silent auto-run, only speak up when there's something new.
      if (!silent || n > 0) {
        showToast?.(
          res.cached
            ? "Already up to date — last scan was under 30 min ago"
            : n > 0
            ? `${n} new todo${n === 1 ? "" : "s"} from Telegram & Granola`
            : "Scan complete — no new action items found"
        );
      }
    } catch (e) {
      if (silent) {
        console.warn("Auto Telegram extraction skipped:", e.message);
      } else {
        // A 503 carries the backend's own setup guidance (Telegram not
        // connected vs Anthropic key missing vs API failure) — show it
        // verbatim rather than guessing the cause here and guessing wrong.
        showToast?.(e.status === 503 ? e.message : `Refresh failed — ${e.message}`);
      }
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, showToast]);

  // Auto-scan Telegram once when the tab opens (spec: extraction on tab load).
  // The backend caches results for 30 min, so re-opening the tab stays cheap.
  const didAutoRefresh = useRef(false);
  useEffect(() => {
    if (didAutoRefresh.current) return;
    didAutoRefresh.current = true;
    runRefresh({ silent: true });
  }, [runRefresh]);

  /* ── Drag to reorder (within a group) ──
     @dnd-kit drag end. Constraints kept from the HTML5 era:
       1. Only reorder within the same date-bucket section. Drops across
          buckets are a no-op — moving "due tomorrow" into "overdue" should
          edit the date, not reorder.
       2. Optimistic + rollback on api.reorderTodos failure. */
  const handleDragEnd = useCallback((event) => {
    const activeId = event.active?.id;
    const overId = event.over?.id;
    if (activeId == null || overId == null || activeId === overId) return;
    const from = todos.findIndex((t) => t.id === activeId);
    const to = todos.findIndex((t) => t.id === overId);
    if (from < 0 || to < 0) return;
    if (bucketOf(todos[from].dueDate) !== bucketOf(todos[to].dueDate)) return;
    const snapshot = todos;
    const arr = arrayMove(todos, from, to);
    setTodos(arr);
    api.reorderTodos(arr.map((t) => t.id)).catch((e) => {
      setTodos(snapshot);
      showToast?.(`Reorder failed — ${e.message}`);
    });
  }, [todos, showToast]);

  /* ── Keyboard shortcuts: n / Enter / Delete ── */
  useEffect(() => {
    const onKey = (e) => {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === "Enter" && focusedId != null) {
        const t = todos.find((x) => x.id === focusedId);
        if (t) { e.preventDefault(); toggleComplete(t); }
      } else if (e.key === "Delete" && focusedId != null) {
        const t = todos.find((x) => x.id === focusedId);
        if (t) { e.preventDefault(); removeTodo(t); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focusedId, todos, toggleComplete, removeTodo]);

  /* ── Derived lists ── */
  // Resolve a todo's linked relationship — Telegram-extracted todos carry a
  // relationshipId when their source chat maps to a tracked relationship.
  const relationshipById = useMemo(() => {
    const m = {};
    for (const r of relationships) m[r.id] = r;
    return m;
  }, [relationships]);

  // A task mid check-off animation stays in the active list until the
  // animation finishes — then it moves to Completed.
  const active = useMemo(
    () => todos.filter((t) => !t.completed || completing.has(t.id)),
    [todos, completing]
  );
  const completed = useMemo(
    () => todos.filter((t) => t.completed && !completing.has(t.id))
      .slice()
      .sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || ""))),
    [todos, completing]
  );

  const inMyDay = (t) => {
    const b = bucketOf(t.dueDate);
    return t.myDay || b === "today" || b === "overdue";
  };

  const grouped = useMemo(() => {
    const pool = view === "myday" ? active.filter(inMyDay) : active;
    return GROUPS.map((g) => {
      let items = pool.filter((t) => bucketOf(t.dueDate) === g.key);
      // Every bucket honors the todos array order (sort_order — the backend
      // already floats new items to the top via min-1), with starred pinned
      // first. Re-sorting "New" by createdAt here would silently discard
      // drag-reorders in that bucket the moment the memo re-ran.
      items = items.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0));
      return { ...g, items };
    }).filter((g) => g.items.length > 0);
  }, [active, view]);

  const activeCount = view === "myday" ? active.filter(inMyDay).length : active.length;
  const selectedTodo = todos.find((t) => t.id === selectedId) || null;

  const selectRow = (id) => { setSelectedId(id); setFocusedId(id); };

  // Live-detected due date from the add-box text ("Send deck Friday")
  const parsedNew = useMemo(() => parseDuePhrase(newTask), [newTask]);

  /* ── Render ── */
  return (
    <div style={{ display: "flex", gap: "var(--space-4)", height: "100%", alignItems: "flex-start" }}>
      {/* LEFT — list */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        {/* Controls: view toggle + refresh */}
        <div className="flex items-center justify-between" style={{ gap: "var(--space-3)", flexWrap: "wrap" }}>
          <div className="flex items-center" style={{ gap: "var(--space-1)", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "var(--space-1)" }}>
            {[
              { k: "myday", label: "My Day", Icon: Sun },
              { k: "all", label: "All Tasks", Icon: ListChecks },
            ].map(({ k, label, Icon }) => (
              <button
                key={k}
                onClick={() => setView(k)}
                className="inline-flex items-center"
                style={{
                  gap: "var(--space-1-5)", padding: "var(--space-1-5) var(--space-3)", borderRadius: "var(--radius-md)", fontSize: "var(--font-base)", fontWeight: 600, cursor: "pointer",
                  background: view === k ? "var(--surface)" : "transparent",
                  color: view === k ? "var(--text)" : "var(--text-muted)",
                  border: `1px solid ${view === k ? "var(--border)" : "transparent"}`,
                }}
              >
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>

          <div className="flex items-center" style={{ gap: "var(--space-2-5)" }}>
            {refreshing && (
              <span className="inline-flex items-center" style={{ gap: "var(--space-1-5)", fontSize: "var(--font-sm)", fontFamily: MONO, color: "var(--text-faint)" }}>
                <Loader2 size={11} className="animate-spin" /> SCANNING
              </span>
            )}
            <button
              onClick={() => runRefresh()}
              disabled={refreshing}
              className="inline-flex items-center"
              style={{
                gap: "var(--space-1-5)", padding: "var(--space-1-5) var(--space-2-5)", borderRadius: "var(--radius-md)", fontSize: "var(--font-base)", fontWeight: 600,
                background: "var(--surface-2)", color: "var(--text-secondary)",
                border: "1px solid var(--border)", cursor: refreshing ? "default" : "pointer",
                opacity: refreshing ? 0.6 : 1,
              }}
              title="Scan recent Telegram chats and Granola notes for new action items"
            >
              <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>

        {/* Add task */}
        <div
          className="flex items-center"
          style={{
            gap: "var(--space-2-5)", padding: "var(--space-2-5) var(--space-3)", borderRadius: "var(--radius-lg)",
            background: "var(--surface)", border: "1px solid var(--border)",
          }}
        >
          <Plus size={16} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTodo(); } }}
            placeholder="Add a task — try 'Send deck Friday'"
            style={{
              flex: 1, fontSize: "var(--font-md)", color: "var(--text)", background: "transparent",
              border: "none", outline: "none",
            }}
          />
          {parsedNew.dueDate && (
            <span
              className="inline-flex items-center"
              style={{
                gap: "var(--space-1)", padding: "var(--space-0-5) var(--space-2)", borderRadius: "var(--radius-sm)", flexShrink: 0,
                background: "var(--brand-tint-2)", border: "1px solid var(--brand-border)",
                color: "var(--brand)", fontSize: "var(--font-xs)", fontWeight: 600,
              }}
              title={`Due date detected — ${parsedNew.dueDate}`}
            >
              <Calendar size={10} /> {fmtDue(parsedNew.dueDate)}
            </span>
          )}
          <span style={{ fontSize: "var(--font-xs)", fontFamily: MONO, color: "var(--text-disabled)" }}>
            n
          </span>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--space-4)", paddingRight: "var(--space-0-5)" }}>
          <DndContext
            sensors={todoSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <>
              {refreshing && (
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                  {[0, 1].map((i) => <SkeletonRow key={i} />)}
                </div>
              )}

              {activeCount === 0 && !refreshing ? (
                <EmptyState view={view} />
              ) : (
                grouped.map((g) => (
                  <div key={g.key}>
                    <div className="flex items-center" style={{ gap: "var(--space-2)", marginBottom: "var(--space-2)", padding: "0 2px" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: g.color, flexShrink: 0 }} />
                      <span style={{
                        fontSize: "var(--font-sm)", fontWeight: 700, letterSpacing: "0.07em",
                        textTransform: "uppercase", color: "var(--text-secondary)", fontFamily: MONO,
                      }}>
                        {g.label}
                      </span>
                      <span style={{
                        fontSize: "var(--font-xs)", fontFamily: MONO, color: "var(--text-faint)",
                        border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "0 5px",
                      }}>
                        {g.items.length}
                      </span>
                    </div>
                    {/* Within-bucket sortable. Cross-bucket drags get detected
                        in handleDragEnd (different bucket → no-op), but having
                        a SortableContext per group keeps the animation cues
                        local to the section being reordered. */}
                    <SortableContext items={g.items.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1-5)" }}>
                        {g.items.map((t) => (
                          <TodoRow
                            key={t.id}
                            todo={t}
                            selected={selectedId === t.id}
                            focused={focusedId === t.id}
                            editing={editingId === t.id}
                            completing={completing.has(t.id)}
                            relationship={t.relationshipId ? relationshipById[t.relationshipId] : null}
                            draggable
                            onSelect={selectRow}
                            onOpenClient={onOpenClient}
                            onToggle={toggleComplete}
                            onStar={(todo) => patchTodo(todo.id, { starred: !todo.starred })}
                            onDelete={removeTodo}
                            onStartEdit={(id) => { setEditingId(id); setFocusedId(id); }}
                            onCommitEdit={commitEdit}
                            onCancelEdit={() => setEditingId(null)}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </div>
                ))
              )}

              {/* Completed */}
              {completed.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowCompleted((s) => !s)}
                    className="flex items-center"
                    style={{
                      gap: "var(--space-2)", padding: "var(--space-1) var(--space-0-5)", background: "transparent", border: "none",
                      cursor: "pointer", color: "var(--text-muted)",
                    }}
                  >
                    {showCompleted ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span style={{ fontSize: "var(--font-sm)", fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", fontFamily: MONO }}>
                      Completed
                    </span>
                    <span style={{
                      fontSize: "var(--font-xs)", fontFamily: MONO, color: "var(--text-faint)",
                      border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "0 5px",
                    }}>
                      {completed.length}
                    </span>
                  </button>
                  {showCompleted && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1-5)", marginTop: "var(--space-2)" }}>
                      {completed.map((t) => (
                        <TodoRow
                          key={t.id}
                          todo={t}
                          selected={selectedId === t.id}
                          focused={focusedId === t.id}
                          editing={editingId === t.id}
                          relationship={t.relationshipId ? relationshipById[t.relationshipId] : null}
                          draggable={false}
                          onSelect={selectRow}
                          onOpenClient={onOpenClient}
                          onToggle={toggleComplete}
                          onStar={(todo) => patchTodo(todo.id, { starred: !todo.starred })}
                          onDelete={removeTodo}
                          onStartEdit={(id) => { setEditingId(id); setFocusedId(id); }}
                          onCommitEdit={commitEdit}
                          onCancelEdit={() => setEditingId(null)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          </DndContext>
        </div>
      </div>

      {/* RIGHT — detail pane */}
      {selectedTodo && (
        <DetailPane
          key={selectedTodo.id}
          todo={selectedTodo}
          relationship={selectedTodo.relationshipId ? relationshipById[selectedTodo.relationshipId] : null}
          onClose={() => setSelectedId(null)}
          onPatch={patchTodo}
          onDelete={removeTodo}
          onOpenClient={onOpenClient}
        />
      )}
    </div>
  );
};

export default Todos;
