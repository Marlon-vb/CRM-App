import { useRef } from "react";
import { View, Text, SectionList, TouchableOpacity, RefreshControl, StyleSheet } from "react-native";
// Classic Animated-based Swipeable — ReanimatedSwipeable needs reanimated,
// which this app deliberately doesn't carry.
import { Swipeable } from "react-native-gesture-handler";
import * as cloud from "../lib/cloud";
import * as haptics from "../lib/haptics";
import { C, avatarColor, initials } from "../theme";

/* The check circle (22pt) and star (~25pt) sit under Apple's 44pt minimum —
   hitSlop pads the touch target without changing the visuals (audit U8). */
const HIT_SLOP = { top: 10, bottom: 10, left: 10, right: 10 };

function bucketOf(dueDate) {
  if (!dueDate) return "none";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(`${dueDate}T00:00:00`);
  const days = Math.round((due - today) / 86400000);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 7) return "week";
  return "later";
}

const BUCKETS = [
  ["overdue", "Overdue", "#E5747A"],
  ["today", "Today", "#F5C242"],
  ["week", "This week", "#7FB4E8"],
  ["later", "Later", "#9FB0C9"],
  ["none", "No date", "#5E7190"],
];

const PRIORITY_COLOR = { high: "#E5747A", medium: "#F5C242", low: "#5E7190" };

/* Row lives in its own component so each row owns a swipe ref (audit U10).
   Swipe-right = the check circle, exact same toggle path (haptic + undo
   toast included). Close via ref before acting — a rollback or undo re-shows
   this row and it must render closed. No left-swipe action on todos. */
function TodoRow({ t, rel, onToggle }) {
  const swipeRef = useRef(null);
  const complete = () => {
    swipeRef.current?.close();
    onToggle(t, { completed: true });
  };
  return (
    <Swipeable
      ref={swipeRef}
      friction={2}
      renderLeftActions={() => (
        <TouchableOpacity
          style={s.swipeComplete}
          onPress={complete}
          accessibilityRole="button"
          accessibilityLabel={`Complete "${t.task}"`}
        >
          <Text style={s.swipeCompleteText}>Complete</Text>
        </TouchableOpacity>
      )}
      onSwipeableOpen={complete}
    >
      <View style={s.row}>
        <TouchableOpacity
          style={[s.check, { borderColor: PRIORITY_COLOR[t.priority] || C.textFaint }]}
          onPress={() => onToggle(t, { completed: true })}
          hitSlop={HIT_SLOP}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: false }}
          accessibilityLabel={`Complete "${t.task}"`}
        >
          {/* Priority is otherwise border-color-only — high gets a "!"
              so it survives color-blindness (audit U8). */}
          {t.priority === "high" ? <Text style={s.checkBang}>!</Text> : null}
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.task}>{t.task}</Text>
          {rel ? (
            <View style={s.relRow}>
              <View style={[s.relDot, { backgroundColor: avatarColor(rel.name) }]}>
                <Text style={s.relDotText}>{initials(rel.name)}</Text>
              </View>
              <Text style={s.rel}>{rel.name}</Text>
            </View>
          ) : null}
        </View>
        <TouchableOpacity
          style={s.star} hitSlop={HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={`${t.starred ? "Unstar" : "Star"} "${t.task}"`}
          onPress={() => { haptics.tapLight(); onToggle(t, { starred: !t.starred }); }}
        >
          <Text style={{ color: t.starred ? C.warning : C.textFaint, fontSize: 17 }}>
            {t.starred ? "★" : "☆"}
          </Text>
        </TouchableOpacity>
      </View>
    </Swipeable>
  );
}

/* Read/act todos: complete + star sync back to the Mac (applied on its
   next sync ≤5 min; the Mac stays the only place todos are created). */
export default function TodosScreen({ todos, relationships, refreshing, onRefresh, onToggled, onNotify, onError }) {
  const relById = new Map((relationships || []).map((r) => [r.local_id, r]));
  const open = (todos || []).filter((t) => !t.completed);
  const sections = BUCKETS
    .map(([key, title, color]) => ({
      title, color,
      data: open
        .filter((t) => bucketOf(t.due_date) === key)
        .sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0)),
    }))
    .filter((sec) => sec.data.length > 0);

  const toggle = async (todo, patch) => {
    onToggled(todo.local_id, patch); // optimistic
    try {
      await cloud.patchTodo(todo.local_id, patch);
      // Completing removes the row instantly — a mis-tap needs a way back.
      if (patch.completed) {
        haptics.success();
        onNotify?.("Todo completed", async () => {
          await cloud.patchTodo(todo.local_id, { completed: false });
          onToggled(todo.local_id, { completed: false });
        });
      }
    } catch (e) {
      onToggled(todo.local_id, { completed: todo.completed, starred: todo.starred }); // rollback
      onError(e.message);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Todos</Text>
        <Text style={s.headerMeta}>{open.length} open</Text>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(t) => String(t.local_id)}
        renderItem={({ item: t }) => (
          <TodoRow
            t={t}
            rel={t.relationship_local_id != null ? relById.get(t.relationship_local_id) : null}
            onToggle={toggle}
          />
        )}
        renderSectionHeader={({ section }) => (
          <View style={s.sectionRow}>
            <View style={[s.sectionDot, { backgroundColor: section.color }]} />
            <Text style={s.section}>{section.title}</Text>
            <Text style={s.sectionCount}>{section.data.length}</Text>
          </View>
        )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.textFaint} />}
        contentContainerStyle={{ padding: 16, paddingBottom: 90, paddingTop: 4 }}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyEmoji}>☑️</Text>
            <Text style={s.emptyBig}>Nothing open.</Text>
            <Text style={s.emptyText}>New todos come from the Mac's extraction — pull to refresh.</Text>
          </View>
        }
        stickySectionHeadersEnabled={false}
      />
    </View>
  );
}

const s = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8, flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  headerTitle: { color: C.text, fontSize: 26, fontWeight: "800", letterSpacing: -0.5 },
  headerMeta: { color: C.textFaint, fontSize: 12.5 },
  sectionRow: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 16, marginBottom: 7 },
  sectionDot: { width: 7, height: 7, borderRadius: 4 },
  section: { color: C.textSecondary, fontSize: 12, fontWeight: "700", letterSpacing: 1.1, textTransform: "uppercase" },
  sectionCount: { color: C.textFaint, fontSize: 12, fontWeight: "700" },
  row: {
    flexDirection: "row", alignItems: "center", backgroundColor: C.surface,
    borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 12,
    marginBottom: 8, gap: 12,
  },
  // Swipe panel mirrors the row metrics (radius 14, 8pt gap) so the revealed
  // action reads as part of the row, not a floating chip.
  swipeComplete: { backgroundColor: C.success, borderRadius: 14, marginBottom: 8, justifyContent: "center", paddingHorizontal: 22 },
  swipeCompleteText: { color: "#0A1626", fontSize: 13.5, fontWeight: "800" },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  checkBang: { color: PRIORITY_COLOR.high, fontSize: 12, fontWeight: "800", lineHeight: 15 },
  task: { color: C.text, fontSize: 15, lineHeight: 20 },
  relRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 },
  relDot: { width: 16, height: 16, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  relDotText: { color: "#0A1626", fontSize: 8, fontWeight: "800" },
  rel: { color: C.textFaint, fontSize: 12 },
  star: { padding: 4 },
  empty: { alignItems: "center", paddingTop: 70 },
  emptyEmoji: { fontSize: 44, marginBottom: 10 },
  emptyBig: { color: C.text, fontSize: 22, fontWeight: "800", marginBottom: 6 },
  emptyText: { color: C.textFaint, fontSize: 13.5, textAlign: "center", paddingHorizontal: 44, lineHeight: 19 },
});
