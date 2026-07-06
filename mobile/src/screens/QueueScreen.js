import { useState } from "react";
import {
  View, Text, SectionList, TouchableOpacity, RefreshControl, Modal,
  Linking, StyleSheet,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as cloud from "../lib/cloud";
import { telegramLinkCandidates, lastInboundDate, snoozeUntil } from "../lib/telegram-links";
import { C, KIND_META, KIND_ORDER } from "../theme";

function timeAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/* One queue card. Expand for messages + bundle; actions mirror the Mac:
   Done = snooze until tomorrow 09:00 (todos complete instead), Snooze
   menu incl. after-they-reply, Open in Telegram via deep link. The Mac
   applies phone actions on its next sync (≤5 min), so acted-on cards
   hide locally right away. */
function QueueCard({ item, onActed, onError }) {
  const [expanded, setExpanded] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const meta = KIND_META[item.kind] || KIND_META.todo;

  const act = async (fn, label) => {
    setBusy(true);
    try {
      await fn();
      onActed(item.key, label);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDone = () =>
    act(async () => {
      if (item.kind === "todo" && item.todoId != null) {
        await cloud.patchTodo(item.todoId, { completed: true });
      } else {
        await cloud.upsertSnooze(item.key, "until", snoozeUntil("tomorrow"), null);
        for (const b of item.bundle || []) {
          if (b.type === "todo") await cloud.patchTodo(b.id, { completed: true }).catch(() => {});
          if (b.type === "promise") await cloud.resolvePromise(b.id, "kept").catch(() => {});
        }
      }
    }, "Done — the Mac applies it on its next sync");

  const handleSnooze = (option) => {
    setSnoozeOpen(false);
    return act(async () => {
      if (option === "after_reply") {
        await cloud.upsertSnooze(item.key, "after_reply", null, lastInboundDate(item));
      } else {
        await cloud.upsertSnooze(item.key, "until", snoozeUntil(option), null);
      }
    }, "Snoozed");
  };

  const openTelegram = async () => {
    const msgId = item.messages && item.messages[0] ? item.messages[0].id : null;
    for (const url of telegramLinkCandidates(item.activeChatId, msgId)) {
      try {
        const ok = await Linking.canOpenURL(url);
        if (ok) { await Linking.openURL(url); return; }
      } catch (e) { /* next candidate */ }
    }
    onError("Couldn't open Telegram — is it installed?");
  };

  const copyContext = async () => {
    const lines = (item.messages || []).slice().reverse()
      .map((m) => `${m.is_me ? "me" : m.sender || "them"}: ${m.text}`);
    await Clipboard.setStringAsync(lines.join("\n"));
    onActed(null, "Conversation copied");
  };

  return (
    <TouchableOpacity style={s.card} activeOpacity={0.85} onPress={() => setExpanded((v) => !v)}>
      <View style={s.cardHead}>
        <Text style={[s.kind, { color: meta.color }]}>{meta.icon} {meta.label.toUpperCase()}</Text>
        {item.chatCount > 1 ? <Text style={s.chatCount}>{item.chatCount} chats</Text> : null}
      </View>
      <Text style={s.name}>{item.relationshipName || item.title || item.key}</Text>
      {item.why ? <Text style={s.why}>{item.why}</Text> : null}
      {item.actionSummary ? <Text style={s.summary}>{item.actionSummary}</Text> : null}

      {expanded && (
        <View style={s.detail}>
          {(item.messages || []).slice(0, 5).slice().reverse().map((m) => (
            <Text key={m.id} style={s.msg}>
              <Text style={{ color: m.is_me ? C.brand : C.textSecondary, fontWeight: "600" }}>
                {m.is_me ? "me" : m.sender || "them"}:{" "}
              </Text>
              <Text style={{ color: C.text }}>{m.text}</Text>
            </Text>
          ))}
          {(item.bundle || []).map((b) => (
            <Text key={`${b.type}:${b.id}`} style={s.bundle}>
              {b.type === "todo" ? "☑" : "◆"} {b.label}
            </Text>
          ))}
          {item.noteSummary ? (
            <Text style={s.note} numberOfLines={6}>{item.noteSummary}</Text>
          ) : null}
          <TouchableOpacity onPress={copyContext}>
            <Text style={s.copy}>Copy conversation</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={s.actions}>
        {item.activeChatId ? (
          <TouchableOpacity style={[s.btn, s.btnTelegram]} disabled={busy} onPress={openTelegram}>
            <Text style={s.btnTelegramText}>Open in Telegram</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity style={s.btn} disabled={busy} onPress={handleDone}>
          <Text style={s.btnText}>{busy ? "…" : "Done"}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.btn} disabled={busy} onPress={() => setSnoozeOpen(true)}>
          <Text style={s.btnText}>Snooze</Text>
        </TouchableOpacity>
      </View>

      <Modal transparent visible={snoozeOpen} animationType="fade" onRequestClose={() => setSnoozeOpen(false)}>
        <TouchableOpacity style={s.modalBack} activeOpacity={1} onPress={() => setSnoozeOpen(false)}>
          <View style={s.modalSheet}>
            {[["tonight", "Tonight 18:00"], ["tomorrow", "Tomorrow 09:00"],
              ["nextweek", "Next week"], ["after_reply", "✦ After they reply"]].map(([opt, label]) => (
              <TouchableOpacity key={opt} style={s.modalRow} onPress={() => handleSnooze(opt)}>
                <Text style={[s.modalText, opt === "after_reply" && { color: C.brand, fontWeight: "700" }]}>
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </TouchableOpacity>
  );
}

export default function QueueScreen({ queue, refreshing, onRefresh, onActed, onError }) {
  const hidden = queue.hiddenKeys || new Set();
  const sections = KIND_ORDER
    .map((kind) => ({
      title: KIND_META[kind].label,
      data: (queue.items || []).filter((i) => i.kind === kind && !hidden.has(i.key)),
    }))
    .filter((sec) => sec.data.length > 0);

  return (
    <View style={{ flex: 1 }}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Queue</Text>
        <Text style={s.headerMeta}>
          {queue.sweptAt ? `swept ${timeAgo(queue.sweptAt)}` : "waiting for the Mac's first publish"}
        </Text>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(i) => i.key}
        renderItem={({ item }) => <QueueCard item={item} onActed={onActed} onError={onError} />}
        renderSectionHeader={({ section }) => <Text style={s.section}>{section.title}</Text>}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.textFaint} />}
        contentContainerStyle={{ padding: 16, paddingBottom: 90 }}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyBig}>All clear.</Text>
            <Text style={s.emptyText}>
              Nothing needs you — or the Mac hasn't published yet. Pull to refresh.
            </Text>
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
  card: { backgroundColor: C.surface, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 10 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  kind: { fontSize: 11, fontWeight: "800", letterSpacing: 0.8 },
  chatCount: { color: C.textFaint, fontSize: 11 },
  name: { color: C.text, fontSize: 17, fontWeight: "700" },
  why: { color: C.textSecondary, fontSize: 13, marginTop: 2 },
  summary: { color: C.textFaint, fontSize: 12, fontStyle: "italic", marginTop: 3 },
  detail: { marginTop: 10, borderTopColor: C.border, borderTopWidth: 1, paddingTop: 10 },
  msg: { fontSize: 13, lineHeight: 19, marginBottom: 3 },
  bundle: { color: C.warning, fontSize: 13, marginTop: 4 },
  note: { color: C.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 6 },
  copy: { color: C.brand, fontSize: 13, marginTop: 8 },
  actions: { flexDirection: "row", gap: 8, marginTop: 12 },
  btn: { backgroundColor: C.surface2, borderRadius: 9, paddingVertical: 8, paddingHorizontal: 14 },
  btnText: { color: C.text, fontSize: 13, fontWeight: "600" },
  btnTelegram: { backgroundColor: C.telegram },
  btnTelegramText: { color: "#04121F", fontSize: 13, fontWeight: "700" },
  modalBack: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: C.surface2, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 12, paddingBottom: 34 },
  modalRow: { paddingVertical: 14, paddingHorizontal: 10 },
  modalText: { color: C.text, fontSize: 16 },
  empty: { alignItems: "center", paddingTop: 90 },
  emptyBig: { color: C.text, fontSize: 20, fontWeight: "700", marginBottom: 6 },
  emptyText: { color: C.textFaint, fontSize: 13, textAlign: "center", paddingHorizontal: 40 },
});
