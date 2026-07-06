import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { C } from "../theme";

export default function SettingsScreen({ session, config, sweptAt, onSignOut }) {
  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={s.headerTitle}>Settings</Text>

      <View style={s.card}>
        <Text style={s.label}>ACCOUNT</Text>
        <Text style={s.value}>{session.email}</Text>
        <Text style={s.label}>PROJECT</Text>
        <Text style={s.value}>{config ? config.url.replace("https://", "") : "—"}</Text>
        <Text style={s.label}>LAST SWEEP PUBLISHED</Text>
        <Text style={s.value}>{sweptAt ? new Date(sweptAt).toLocaleString() : "waiting for the Mac"}</Text>
      </View>

      <Text style={s.hint}>
        The Mac is the engine: it sweeps Telegram, extracts todos and
        promises, and publishes here after every sweep. Actions you take on
        this phone (done, snooze, complete, resolve) reach the Mac on its
        next sync — within about five minutes. Your Telegram session and
        API keys never leave the Mac.
      </Text>

      <TouchableOpacity style={s.signOut} onPress={onSignOut}>
        <Text style={s.signOutText}>Sign out</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  headerTitle: { color: C.text, fontSize: 24, fontWeight: "700", marginBottom: 14 },
  card: { backgroundColor: C.surface, borderColor: C.border, borderWidth: 1, borderRadius: 14, padding: 16, marginBottom: 14 },
  label: { color: C.textFaint, fontSize: 10, fontWeight: "700", letterSpacing: 1.1, marginTop: 10 },
  value: { color: C.text, fontSize: 15, marginTop: 2 },
  hint: { color: C.textFaint, fontSize: 12.5, lineHeight: 18, marginBottom: 22 },
  signOut: { backgroundColor: C.surface2, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  signOutText: { color: C.danger, fontSize: 15, fontWeight: "600" },
});
