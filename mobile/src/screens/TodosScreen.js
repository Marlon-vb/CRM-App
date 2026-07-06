import { View, Text, SectionList, TouchableOpacity, RefreshControl, StyleSheet } from "react-native";
import * as cloud from "../lib/cloud";
import { C } from "../theme";

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
  ["overdue", "Overdue"], ["today", "Today"], ["week", "This week"],
  ["later", "Later"], ["none", "No date"],
];

/* Read/act todos: complete + star sync back to the Mac (applied on its
   next sync ≤5 min; the Mac stays the only place todos are created). */
export default function TodosScreen({ todos, relationships, refreshing, onRefresh, onToggled, onError }) {
  const relById = new Map((relationships || []).map((r) => [r.local_id, r]));
  const open = (todos || []).filter((t) => !t.completed);
  const sections = BUCKETS
    .map(([key, title]) => ({
      title,
      data: open
        .filter((t) => bucketOf(t.due_date) === key)
        .sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0)),
    }))
    .filter((sec) => sec.data.length > 0);

  const toggle = async (todo, patch) => {
    onToggled(todo.local_id, patch); // optimistic
    try {
      await cloud.patchTodo(todo.local_id, patch);
    } catch (e) {
      onToggled(todo.local_id, {
        completed: todo.completed, starred: todo.starred,
      }); // rollback
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
        renderItem={({ item: t }) => {
          const rel = t.relationship_local_id != null ? relById.get(t.relationship_local_id) : null;
          return (
            <View style={s.row}>
              <TouchableOpacity
                style={s.check}
                onPress={() => toggle(t, { completed: true })}
              >
                <Text style={{ color: C.textFaint, fontSize: 16 }}>○</Text>
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={s.task}>{t.task}</Text>
                {rel ? <Text style={s.rel}>{rel.name}</Text> : null}
              </View>
              <TouchableOpacity onPress={() => toggle(t, { starred: !t.starred })}>
                <Text style={{ color: t.starred ? C.warning : C.textFaint, fontSize: 16 }}>
                  {t.starred ? "★" : "☆"}
                </Text>
              </TouchableOpacity>
            </View>
          );
        }}
        renderSectionHeader={({ section }) => <Text style={s.section}>{section.title}</Text>}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.textFaint} />}
        contentContainerStyle={{ padding: 16, paddingBottom: 90 }}
        ListEmptyComponent={
          <View style={s.empty}>
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
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  headerTitle: { color: C.text, fontSize: 24, fontWeight: "700" },
  headerMeta: { color: C.textFaint, fontSize: 12 },
  section: { color: C.textFaint, fontSize: 11, fontWeight: "700", letterSpacing: 1.1, textTransform: "uppercase", marginTop: 14, marginBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", backgroundColor: C.surface, borderColor: C.border, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8, gap: 10 },
  check: { padding: 2 },
  task: { color: C.text, fontSize: 15 },
  rel: { color: C.textFaint, fontSize: 12, marginTop: 1 },
  empty: { alignItems: "center", paddingTop: 90 },
  emptyBig: { color: C.text, fontSize: 20, fontWeight: "700", marginBottom: 6 },
  emptyText: { color: C.textFaint, fontSize: 13, textAlign: "center", paddingHorizontal: 40 },
});
