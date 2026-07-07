import { useEffect, useRef, useState } from "react";
import {
  View, Text, SectionList, TouchableOpacity, RefreshControl, Modal,
  Linking, Animated, StyleSheet,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as cloud from "../lib/cloud";
import { telegramLinkCandidates, lastInboundDate, snoozeUntil } from "../lib/telegram-links";
import * as haptics from "../lib/haptics";
import { C, KIND_META, KIND_ORDER, avatarColor, initials, timeAgo } from "../theme";

/* Action buttons render ~36pt tall — hitSlop pads them to the 44pt Apple
   minimum without changing the visuals (audit U8). */
const HIT_SLOP = { top: 10, bottom: 10, left: 10, right: 10 };

function Avatar({ name, size = 38 }) {
  return (
    <View style={{
      width: size, height: size, borderRadius: size * 0.32,
      backgroundColor: avatarColor(name),
      alignItems: "center", justifyContent: "center",
    }}>
      <Text style={{ color: "#0A1626", fontWeight: "800", fontSize: size * 0.38 }}>
        {initials(name)}
      </Text>
    </View>
  );
}

/* Urgency reads at a glance: hot cards (reply owed for days) get an ember
   dot next to the age instead of a wall of identical boxes. */
function heat(urgency) {
  if (urgency >= 140) return { dot: "#E5474D", label: "overdue" };
  if (urgency >= 110) return { dot: "#F5C242", label: "aging" };
  return null;
}

function QueueCard({ item, index, onActed, onError }) {
  const [expanded, setExpanded] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const meta = KIND_META[item.kind] || KIND_META.todo;
  const hot = heat(item.urgency);

  // Staggered entrance — cheap Animated, Expo-Go safe.
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 320,
      delay: Math.min(index, 8) * 45,
      useNativeDriver: true,
    }).start();
  }, [anim, index]);

  const act = async (fn, label, undoFn = null) => {
    setBusy(true);
    try {
      await fn();
      haptics.success();
      onActed(item.key, label, undoFn);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Honest semantics (audit): "Handled" = snooze until tomorrow 09:00, and
  // the toast says so. Bundled TODOS complete; promises are NOT auto-marked
  // kept without an actual send. Every action carries an Undo.
  const handleDone = () => {
    if (item.kind === "todo" && item.todoId != null) {
      return act(
        () => cloud.patchTodo(item.todoId, { completed: true }),
        "Todo completed",
        () => cloud.patchTodo(item.todoId, { completed: false })
      );
    }
    const completedIds = [];
    return act(
      async () => {
        await cloud.upsertSnooze(item.key, "until", snoozeUntil("tomorrow"), null);
        for (const b of item.bundle || []) {
          if (b.type !== "todo") continue;
          try { await cloud.patchTodo(b.id, { completed: true }); completedIds.push(b.id); } catch (e) { /* counted below */ }
        }
      },
      "Handled — back tomorrow 9:00 if still owed",
      async () => {
        await cloud.clearSnooze(item.key);
        for (const id of completedIds) await cloud.patchTodo(id, { completed: false }).catch(() => {});
      }
    );
  };

  const handleSnooze = (option) => {
    setSnoozeOpen(false);
    return act(
      async () => {
        if (option === "after_reply") {
          await cloud.upsertSnooze(item.key, "after_reply", null, lastInboundDate(item));
        } else {
          await cloud.upsertSnooze(item.key, "until", snoozeUntil(option), null);
        }
      },
      "Snoozed 💤",
      () => cloud.clearSnooze(item.key)
    );
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
    <Animated.View style={{
      opacity: anim,
      transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
    }}>
      <TouchableOpacity
        style={[s.card, { borderLeftColor: meta.color }]}
        activeOpacity={0.85}
        onPress={() => {
          if (!expanded) haptics.tapLight();
          setExpanded((v) => !v);
        }}
      >
        <View style={s.cardRow}>
          <Avatar name={item.relationshipName || item.title || "?"} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={s.cardHead}>
              <View style={[s.kindChip, { backgroundColor: meta.tint }]}>
                <Text style={[s.kindText, { color: meta.color }]}>{meta.icon} {meta.label}</Text>
              </View>
              {hot && (
                <View style={s.heat}>
                  <View style={[s.heatDot, { backgroundColor: hot.dot }]} />
                  <Text style={[s.heatText, { color: hot.dot }]}>{hot.label}</Text>
                </View>
              )}
              {item.chatCount > 1 ? <Text style={s.chatCount}>{item.chatCount} chats</Text> : null}
            </View>
            <Text style={s.name} numberOfLines={1}>
              {item.relationshipName || item.title || item.key}
            </Text>
            {item.why ? <Text style={s.why}>{item.why}</Text> : null}
          </View>
        </View>

        {item.actionSummary ? <Text style={s.summary}>“{item.actionSummary}”</Text> : null}

        {expanded && (
          <View style={s.detail}>
            {(item.messages || []).slice(0, 5).slice().reverse().map((m) => (
              <View key={m.id} style={[s.bubble, m.is_me ? s.bubbleMe : s.bubbleThem]}>
                <Text style={s.bubbleSender}>{m.is_me ? "you" : m.sender || "them"} · {timeAgo(m.date)}</Text>
                <Text style={s.bubbleText}>{m.text}</Text>
              </View>
            ))}
            {(item.bundle || []).length > 0 && (
              <View style={s.bundleBox}>
                <Text style={s.bundleTitle}>CLEARS WITH THIS</Text>
                {(item.bundle || []).map((b) => (
                  <Text key={`${b.type}:${b.id}`} style={s.bundle}>
                    {b.type === "todo" ? "☑" : "◆"} {b.label}
                  </Text>
                ))}
              </View>
            )}
            {item.noteSummary ? (
              <Text style={s.note} numberOfLines={6}>{item.noteSummary}</Text>
            ) : null}
            <TouchableOpacity
              onPress={copyContext} hitSlop={HIT_SLOP}
              accessibilityRole="button" accessibilityLabel="Copy conversation"
            >
              <Text style={s.copy}>⧉ Copy conversation</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={s.actions}>
          {item.activeChatId ? (
            <TouchableOpacity
              style={[s.btn, s.btnTelegram]} disabled={busy} onPress={openTelegram} hitSlop={HIT_SLOP}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.relationshipName || item.title || "chat"} in Telegram`}
            >
              <Text style={s.btnTelegramText}>Open in Telegram</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={[s.btn, s.btnDone]} disabled={busy} onPress={handleDone} hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={item.kind === "todo" ? "Complete todo" : `Mark ${item.relationshipName || item.title || "item"} handled until tomorrow`}
          >
            <Text style={s.btnDoneText}>{busy ? "…" : item.kind === "todo" ? "Done" : "Handled"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.btn} disabled={busy} hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={`Snooze ${item.relationshipName || item.title || "item"}`}
            onPress={() => { haptics.tapLight(); setSnoozeOpen(true); }}
          >
            <Text style={s.btnText}>Snooze</Text>
          </TouchableOpacity>
        </View>

        <Modal transparent visible={snoozeOpen} animationType="fade" onRequestClose={() => setSnoozeOpen(false)}>
          <TouchableOpacity style={s.modalBack} activeOpacity={1} onPress={() => setSnoozeOpen(false)}>
            <View style={s.modalSheet}>
              <Text style={s.modalTitle}>Snooze {item.relationshipName || ""}</Text>
              {[["tonight", "🌙  Tonight 18:00"], ["tomorrow", "☀️  Tomorrow 09:00"],
                ["nextweek", "📅  Next week"], ["after_reply", "✦  After they reply"]].map(([opt, label]) => (
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
    </Animated.View>
  );
}

export default function QueueScreen({ queue, sync, refreshing, onRefresh, onActed, onError }) {
  const hidden = queue.hiddenKeys || new Set();
  const visible = (queue.items || []).filter((i) => !hidden.has(i.key));

  // Honest states (audit C1): "All clear" is only earned by a successful
  // fetch. Before that it's "checking"; on persistent failure it's an
  // error; and old data gets a staleness banner instead of quiet confidence.
  const neverFetched = !sync?.lastFetchAt;
  const fetchFailing = Boolean(sync?.lastError);
  const publishAgeMs = sync?.lastPublishAt ? Date.now() - new Date(sync.lastPublishAt).getTime() : null;
  const macQuiet = publishAgeMs != null && publishAgeMs > 90 * 60 * 1000; // > 3 sweep intervals
  const banner = fetchFailing
    ? { color: "#E5747A", text: `Can't reach Cadence Cloud — showing ${neverFetched ? "nothing" : "old data"}, not zero. Pull to retry.` }
    : macQuiet
      ? { color: "#F5C242", text: `The Mac hasn't published in ${Math.round(publishAgeMs / 3600000)}h — is it running?` }
      : null;
  const sections = KIND_ORDER
    .map((kind) => ({
      title: KIND_META[kind].label,
      kind,
      data: visible.filter((i) => i.kind === kind),
    }))
    .filter((sec) => sec.data.length > 0);

  const counts = KIND_ORDER
    .map((kind) => ({ kind, n: visible.filter((i) => i.kind === kind).length }))
    .filter((c) => c.n > 0);
  const eta = visible.reduce((m, i) => m + (i.kind === "todo" ? 2 : 3), 0);

  return (
    <View style={{ flex: 1 }}>
      <View style={s.header}>
        <View>
          <Text style={s.headerTitle}>
            {neverFetched ? "Checking…" : visible.length === 0 ? (fetchFailing ? "Unknown" : "All clear") : `${visible.length} need you`}
          </Text>
          <Text style={s.headerMeta}>
            {visible.length > 0 ? `≈${eta} min to clear · ` : ""}
            {queue.sweptAt
              ? `swept ${timeAgo(queue.sweptAt)}`
              : sync?.lastPublishAt
                ? `published ${timeAgo(sync.lastPublishAt)}`
                : "waiting for the Mac"}
          </Text>
        </View>
      </View>

      {banner && (
        <View style={[s.banner, { borderColor: banner.color }]}>
          <Text style={[s.bannerText, { color: banner.color }]}>{banner.text}</Text>
        </View>
      )}

      {counts.length > 1 && (
        <View style={s.statStrip}>
          {counts.map(({ kind, n }) => (
            <View key={kind} style={[s.stat, { backgroundColor: KIND_META[kind].tint }]}>
              <Text style={[s.statText, { color: KIND_META[kind].color }]}>
                {KIND_META[kind].icon} {n}
              </Text>
            </View>
          ))}
        </View>
      )}

      <SectionList
        sections={sections}
        keyExtractor={(i) => i.key}
        renderItem={({ item, index }) => (
          <QueueCard item={item} index={index} onActed={onActed} onError={onError} />
        )}
        renderSectionHeader={({ section }) => (
          <View style={s.sectionRow}>
            <View style={[s.sectionDot, { backgroundColor: KIND_META[section.kind].color }]} />
            <Text style={s.section}>{section.title}</Text>
            <Text style={s.sectionCount}>{section.data.length}</Text>
          </View>
        )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.textFaint} />}
        contentContainerStyle={{ padding: 16, paddingBottom: 90, paddingTop: 4 }}
        ListEmptyComponent={
          neverFetched || fetchFailing ? (
            <View style={s.empty}>
              <Text style={s.emptyEmoji}>{fetchFailing ? "📡" : "⏳"}</Text>
              <Text style={s.emptyBig}>{fetchFailing ? "Can't reach the cloud." : "Checking…"}</Text>
              <Text style={s.emptyText}>
                {fetchFailing
                  ? "This is a connection problem, not an empty queue. Pull to retry."
                  : "Fetching your queue from Cadence Cloud."}
              </Text>
            </View>
          ) : (
            <View style={s.empty}>
              <Text style={s.emptyEmoji}>🎾</Text>
              <Text style={s.emptyBig}>Queue zero.</Text>
              <Text style={s.emptyText}>
                Every conversation is where it should be. Go enjoy it — the Mac
                is watching your chats.
              </Text>
            </View>
          )
        }
        stickySectionHeadersEnabled={false}
      />
    </View>
  );
}

const s = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 },
  banner: {
    marginHorizontal: 16, marginBottom: 6, borderWidth: 1, borderRadius: 10,
    paddingVertical: 8, paddingHorizontal: 12, backgroundColor: "rgba(0,0,0,0.25)",
  },
  bannerText: { fontSize: 12.5, fontWeight: "600", lineHeight: 17 },
  headerTitle: { color: C.text, fontSize: 26, fontWeight: "800", letterSpacing: -0.5 },
  headerMeta: { color: C.textFaint, fontSize: 12.5, marginTop: 2 },
  statStrip: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 6 },
  stat: { borderRadius: 20, paddingVertical: 5, paddingHorizontal: 11 },
  statText: { fontSize: 12.5, fontWeight: "700" },
  sectionRow: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 16, marginBottom: 7 },
  sectionDot: { width: 7, height: 7, borderRadius: 4 },
  section: { color: C.textSecondary, fontSize: 12, fontWeight: "700", letterSpacing: 1.1, textTransform: "uppercase" },
  sectionCount: { color: C.textFaint, fontSize: 12, fontWeight: "700" },
  card: {
    backgroundColor: C.surface, borderColor: C.border, borderWidth: 1,
    borderLeftWidth: 3, borderRadius: 16, padding: 14, marginBottom: 10,
  },
  cardRow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  kindChip: { borderRadius: 12, paddingVertical: 2, paddingHorizontal: 8 },
  kindText: { fontSize: 10.5, fontWeight: "800", letterSpacing: 0.6 },
  heat: { flexDirection: "row", alignItems: "center", gap: 4 },
  heatDot: { width: 6, height: 6, borderRadius: 3 },
  heatText: { fontSize: 10.5, fontWeight: "700" },
  chatCount: { color: C.textFaint, fontSize: 11, marginLeft: "auto" },
  name: { color: C.text, fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
  why: { color: C.textSecondary, fontSize: 13, marginTop: 2, lineHeight: 18 },
  summary: { color: C.textFaint, fontSize: 12.5, fontStyle: "italic", marginTop: 8 },
  detail: { marginTop: 12, borderTopColor: C.border, borderTopWidth: 1, paddingTop: 10 },
  bubble: { borderRadius: 12, padding: 9, marginBottom: 6, maxWidth: "94%" },
  bubbleThem: { backgroundColor: C.surface2, alignSelf: "flex-start" },
  bubbleMe: { backgroundColor: "rgba(127,180,232,0.16)", alignSelf: "flex-end" },
  bubbleSender: { color: C.textFaint, fontSize: 10.5, marginBottom: 2 },
  bubbleText: { color: C.text, fontSize: 13.5, lineHeight: 19 },
  bundleBox: { backgroundColor: "rgba(245,194,66,0.08)", borderRadius: 10, padding: 10, marginTop: 4 },
  bundleTitle: { color: C.warning, fontSize: 10, fontWeight: "800", letterSpacing: 1, marginBottom: 4 },
  bundle: { color: C.textSecondary, fontSize: 13, marginTop: 2 },
  note: { color: C.textSecondary, fontSize: 12.5, lineHeight: 18, marginTop: 8 },
  copy: { color: C.brand, fontSize: 13, marginTop: 10, fontWeight: "600" },
  actions: { flexDirection: "row", gap: 8, marginTop: 12 },
  btn: { backgroundColor: C.surface3, borderRadius: 20, paddingVertical: 9, paddingHorizontal: 15 },
  btnText: { color: C.textSecondary, fontSize: 13, fontWeight: "700" },
  btnTelegram: { backgroundColor: C.telegram, flexGrow: 1, alignItems: "center" },
  btnTelegramText: { color: "#04121F", fontSize: 13.5, fontWeight: "800" },
  btnDone: { backgroundColor: "rgba(76,195,138,0.16)" },
  btnDoneText: { color: C.success, fontSize: 13, fontWeight: "800" },
  modalBack: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: C.surface2, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 14, paddingBottom: 36 },
  modalTitle: { color: C.textFaint, fontSize: 12, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase", paddingHorizontal: 10, paddingBottom: 6 },
  modalRow: { paddingVertical: 14, paddingHorizontal: 10 },
  modalText: { color: C.text, fontSize: 16 },
  empty: { alignItems: "center", paddingTop: 70 },
  emptyEmoji: { fontSize: 44, marginBottom: 10 },
  emptyBig: { color: C.text, fontSize: 22, fontWeight: "800", marginBottom: 6 },
  emptyText: { color: C.textFaint, fontSize: 13.5, textAlign: "center", paddingHorizontal: 44, lineHeight: 19 },
});
