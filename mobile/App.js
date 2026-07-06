/* Cadence mobile — the iPhone companion (Phase 5).
 *
 * A read/act client of what the Mac publishes to Supabase: the computed
 * follow-up queue, todos, promises. Data flows by POLLING (45s while
 * foregrounded + pull-to-refresh) — deliberately no websockets in v1.
 * Actions (done / snooze / complete / resolve) write to the cadence_
 * tables; the Mac's publisher pulls them on its next sync (≤5 min) and
 * republishes. Replies happen IN Telegram via deep links — the Telegram
 * session never leaves the Mac.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { View, Text, TouchableOpacity, AppState, StyleSheet, SafeAreaView } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as SecureStore from "expo-secure-store";
import * as cloud from "./src/lib/cloud";
import LoginScreen from "./src/screens/LoginScreen";
import QueueScreen from "./src/screens/QueueScreen";
import TodosScreen from "./src/screens/TodosScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import { C } from "./src/theme";

const POLL_MS = 45_000;

cloud.init({
  storage: {
    getItem: (k) => SecureStore.getItemAsync(k),
    setItem: (k, v) => SecureStore.setItemAsync(k, v),
    deleteItem: (k) => SecureStore.deleteItemAsync(k),
  },
});

const TABS = [
  ["queue", "Queue"],
  ["todos", "Todos"],
  ["settings", "Settings"],
];

export default function App() {
  const [booted, setBooted] = useState(false);
  const [config, setConfig] = useState(null);
  const [session, setSession] = useState(null);
  const [tab, setTab] = useState("queue");
  const [queue, setQueue] = useState({ items: [], sweptAt: null, hiddenKeys: new Set() });
  const [todos, setTodos] = useState([]);
  const [relationships, setRelationships] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const showToast = useCallback((msg, isError = false) => {
    clearTimeout(toastTimer.current);
    setToast({ msg, isError });
    toastTimer.current = setTimeout(() => setToast(null), isError ? 5000 : 3000);
  }, []);

  const refetch = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const [q, t, r] = await Promise.all([
        cloud.fetchQueue(), cloud.fetchTodos(), cloud.fetchRelationships(),
      ]);
      // A fresh publish recomputed the queue — acted-on cards either
      // vanished server-side or genuinely resurfaced; reset local hiding.
      setQueue((prev) => ({
        ...q,
        hiddenKeys: q.sweptAt !== prev.sweptAt ? new Set() : prev.hiddenKeys,
      }));
      setTodos(t || []);
      setRelationships(r || []);
    } catch (e) {
      if (manual) showToast(e.message, true);
      // silent on background polls — next tick retries
    } finally {
      if (manual) setRefreshing(false);
    }
  }, [showToast]);

  // Boot: restore config + session from SecureStore.
  useEffect(() => {
    (async () => {
      setConfig(await cloud.getConfig());
      setSession(await cloud.getSession());
      setBooted(true);
    })();
  }, []);

  // Poll while signed in and foregrounded; refetch immediately on focus.
  useEffect(() => {
    if (!session) return;
    refetch();
    const interval = setInterval(() => {
      if (AppState.currentState === "active") refetch();
    }, POLL_MS);
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") refetch();
    });
    return () => { clearInterval(interval); sub.remove(); };
  }, [session, refetch]);

  // A queue action succeeded: hide the card now — the Mac's next publish
  // makes it official (or resurfaces it if the snooze already lapsed).
  const handleActed = useCallback((itemKey, msg) => {
    if (itemKey) {
      setQueue((prev) => {
        const hiddenKeys = new Set(prev.hiddenKeys);
        hiddenKeys.add(itemKey);
        return { ...prev, hiddenKeys };
      });
    }
    if (msg) showToast(msg);
  }, [showToast]);

  const handleTodoToggled = useCallback((localId, patch) => {
    setTodos((prev) => prev.map((t) => (t.local_id === localId ? { ...t, ...patch } : t)));
  }, []);

  if (!booted) return <View style={{ flex: 1, backgroundColor: C.bg }} />;

  if (!session) {
    return (
      <>
        <StatusBar style="light" />
        <LoginScreen
          initialConfig={config}
          onSignedIn={async (s) => {
            setConfig(await cloud.getConfig());
            setSession(s);
          }}
        />
      </>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style="light" />
      <View style={{ flex: 1 }}>
        {tab === "queue" && (
          <QueueScreen
            queue={queue} refreshing={refreshing}
            onRefresh={() => refetch(true)}
            onActed={handleActed}
            onError={(m) => showToast(m, true)}
          />
        )}
        {tab === "todos" && (
          <TodosScreen
            todos={todos} relationships={relationships} refreshing={refreshing}
            onRefresh={() => refetch(true)}
            onToggled={handleTodoToggled}
            onError={(m) => showToast(m, true)}
          />
        )}
        {tab === "settings" && (
          <SettingsScreen
            session={session} config={config} sweptAt={queue.sweptAt}
            onSignOut={async () => { await cloud.signOut(); setSession(null); }}
          />
        )}
      </View>

      {toast && (
        <View style={[s.toast, toast.isError && s.toastError]}>
          <Text style={s.toastText}>{toast.msg}</Text>
        </View>
      )}

      <View style={s.tabbar}>
        {TABS.map(([key, label]) => {
          const active = tab === key;
          const badge =
            key === "queue"
              ? (queue.items || []).filter((i) => !(queue.hiddenKeys || new Set()).has(i.key)).length
              : key === "todos"
                ? (todos || []).filter((t) => !t.completed).length
                : 0;
          return (
            <TouchableOpacity key={key} style={s.tab} onPress={() => setTab(key)}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text style={[s.tabText, active && s.tabActive]}>{label}</Text>
                {badge > 0 && (
                  <View style={[s.badge, active && s.badgeActive]}>
                    <Text style={[s.badgeText, active && s.badgeTextActive]}>{badge}</Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  tabbar: {
    flexDirection: "row", borderTopColor: C.border, borderTopWidth: 1,
    backgroundColor: C.surface, paddingBottom: 4,
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: 13 },
  tabText: { color: C.textFaint, fontSize: 13, fontWeight: "600" },
  tabActive: { color: C.brand },
  badge: { backgroundColor: C.surface2, borderRadius: 9, minWidth: 18, paddingHorizontal: 5, paddingVertical: 1, alignItems: "center" },
  badgeActive: { backgroundColor: C.brand },
  badgeText: { color: C.textFaint, fontSize: 11, fontWeight: "800" },
  badgeTextActive: { color: C.brandFg },
  toast: {
    position: "absolute", bottom: 74, left: 20, right: 20, zIndex: 10,
    backgroundColor: C.surface2, borderColor: C.border, borderWidth: 1,
    borderRadius: 12, padding: 13, alignItems: "center",
  },
  toastError: { borderColor: C.danger },
  toastText: { color: C.text, fontSize: 13.5 },
});
