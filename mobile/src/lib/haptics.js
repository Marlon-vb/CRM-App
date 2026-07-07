/* Haptic feedback, best-effort only — every call is a try/catch no-op so a
   missing native module (simulator, stripped build) can never crash an
   action that already succeeded. */
import * as Haptics from "expo-haptics";

export function tapLight() {
  try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); } catch (e) { /* no-op */ }
}

export function success() {
  try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}); } catch (e) { /* no-op */ }
}

export function warn() {
  try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {}); } catch (e) { /* no-op */ }
}
