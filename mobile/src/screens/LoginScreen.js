import { useRef, useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, ScrollView, StyleSheet,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as cloud from "../lib/cloud";
import * as haptics from "../lib/haptics";
import { C } from "../theme";

/* First-run: project (URL + anon key, persisted once) then account.
   Same two-step shape as the Mac's Settings → Cadence Cloud. */
export default function LoginScreen({ initialConfig, onSignedIn }) {
  const [hasConfig, setHasConfig] = useState(Boolean(initialConfig));
  const [url, setUrl] = useState(initialConfig ? initialConfig.url : "");
  const [anonKey, setAnonKey] = useState(initialConfig ? initialConfig.anonKey : "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [scanning, setScanning] = useState(false);
  const [camDenied, setCamDenied] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false); // latch — the scanner fires every frame a code is visible

  const run = async (fn) => {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const saveProject = (u, k) => run(async () => {
    await cloud.setConfig(u, k);
    setHasConfig(true);
  });

  const openScanner = async () => {
    setCamDenied(false);
    let p = permission;
    if (!p || !p.granted) p = await requestPermission();
    if (!p || !p.granted) { setCamDenied(true); return; }
    scannedRef.current = false;
    setScanning(true);
  };

  // The Mac's Settings QR encodes {"cadence":1,"url":...,"anonKey":...}.
  // Anything else (a menu, a wifi code) is silently ignored — keep scanning.
  const onScan = ({ data }) => {
    if (scannedRef.current) return;
    let payload;
    try { payload = JSON.parse(data); } catch (e) { return; }
    if (!payload || payload.cadence !== 1) return;
    const u = String(payload.url || "").trim();
    const k = String(payload.anonKey || "").trim();
    if (!u.startsWith("https://") || !k) return;
    scannedRef.current = true;
    setUrl(u); setAnonKey(k);
    setScanning(false);
    haptics.success();
    saveProject(u, k); // same path as the manual button — on failure the fields stay prefilled
  };

  if (scanning) {
    return (
      <View style={s.scanWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={onScan}
        />
        <View style={s.scanOverlay} pointerEvents="box-none">
          <Text style={s.scanHint}>
            Point at the QR code in the Mac app{"\n"}Settings → Cadence Cloud
          </Text>
          <TouchableOpacity style={s.scanCancel} onPress={() => setScanning(false)}>
            <Text style={s.scanCancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: C.bg }}
    >
      <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
        <View style={s.logo}><Text style={s.logoText}>C</Text></View>
        <Text style={s.title}>Cadence</Text>
        <Text style={s.sub}>
          Your follow-up queue, from your Mac. Sign in with the same account
          as Settings → Cadence Cloud.
        </Text>

        {!hasConfig ? (
          <>
            <Text style={s.label}>SUPABASE PROJECT</Text>
            <TouchableOpacity
              style={[s.primary, busy && s.disabled]} disabled={busy}
              onPress={openScanner}
            >
              <Text style={s.primaryText}>Scan setup code</Text>
            </TouchableOpacity>
            {camDenied ? (
              <Text style={s.error}>
                Camera access denied — enter the values manually or enable it
                in iOS Settings.
              </Text>
            ) : null}
            <Text style={[s.hint, { marginBottom: 12 }]}>
              The Mac shows the code in Settings → Cadence Cloud. Or type the
              values from Supabase → Settings → API:
            </Text>
            <TextInput
              style={s.input} value={url} onChangeText={setUrl}
              placeholder="https://<ref>.supabase.co" placeholderTextColor={C.textFaint}
              autoCapitalize="none" autoCorrect={false} keyboardType="url"
            />
            <TextInput
              style={s.input} value={anonKey} onChangeText={setAnonKey}
              placeholder="anon public key" placeholderTextColor={C.textFaint}
              autoCapitalize="none" autoCorrect={false}
            />
            <TouchableOpacity
              style={[s.primary, (!url || !anonKey || busy) && s.disabled]}
              disabled={!url || !anonKey || busy}
              onPress={() => saveProject(url, anonKey)}
            >
              <Text style={s.primaryText}>{busy ? "Checking…" : "Save project"}</Text>
            </TouchableOpacity>
            <Text style={s.hint}>Checked live before saving.</Text>
          </>
        ) : (
          <>
            <Text style={s.label}>ACCOUNT</Text>
            <TextInput
              style={s.input} value={email} onChangeText={setEmail}
              placeholder="you@company.com" placeholderTextColor={C.textFaint}
              autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
              autoComplete="username"
            />
            <TextInput
              style={s.input} value={password} onChangeText={setPassword}
              placeholder="Password" placeholderTextColor={C.textFaint}
              secureTextEntry autoComplete="current-password"
            />
            <TouchableOpacity
              style={[s.primary, (!email || !password || busy) && s.disabled]}
              disabled={!email || !password || busy}
              onPress={() => run(async () => {
                const session = await cloud.signIn(email.trim(), password);
                onSignedIn(session);
              })}
            >
              <Text style={s.primaryText}>{busy ? "Working…" : "Sign in"}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.ghost} disabled={busy}
              onPress={() => setHasConfig(false)}
            >
              <Text style={s.ghostText}>Change project</Text>
            </TouchableOpacity>
          </>
        )}

        {notice ? <Text style={s.notice}>{notice}</Text> : null}
        {error ? <Text style={s.error}>{error}</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: "center", padding: 28 },
  logo: {
    width: 52, height: 52, borderRadius: 14, backgroundColor: C.brand,
    alignItems: "center", justifyContent: "center", marginBottom: 12,
  },
  logoText: { color: C.brandFg, fontSize: 26, fontWeight: "800" },
  title: { color: C.text, fontSize: 28, fontWeight: "700", marginBottom: 6 },
  sub: { color: C.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: 24 },
  label: { color: C.textFaint, fontSize: 11, fontWeight: "700", letterSpacing: 1.2, marginBottom: 8 },
  input: {
    backgroundColor: C.surface, borderColor: C.border, borderWidth: 1,
    borderRadius: 10, color: C.text, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, marginBottom: 10,
  },
  primary: {
    backgroundColor: C.brand, borderRadius: 10, paddingVertical: 13,
    alignItems: "center", marginTop: 4,
  },
  primaryText: { color: C.brandFg, fontSize: 15, fontWeight: "700" },
  ghost: { paddingVertical: 12, alignItems: "center" },
  ghostText: { color: C.textSecondary, fontSize: 14 },
  disabled: { opacity: 0.45 },
  hint: { color: C.textFaint, fontSize: 12, lineHeight: 17, marginTop: 10 },
  notice: { color: C.textSecondary, fontSize: 13, marginTop: 12 },
  error: { color: C.danger, fontSize: 13, marginTop: 12 },
  scanWrap: { flex: 1, backgroundColor: "#000" },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject, justifyContent: "space-between",
    alignItems: "center", paddingTop: 84, paddingBottom: 56,
  },
  scanHint: {
    color: "#fff", fontSize: 15, lineHeight: 22, textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.8)", textShadowRadius: 6,
  },
  scanCancel: {
    backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 22,
    paddingHorizontal: 28, paddingVertical: 12,
  },
  scanCancelText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
