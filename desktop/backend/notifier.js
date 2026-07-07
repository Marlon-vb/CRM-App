/* Cadence backend — the pulse bridge (audit C3/C4).
 *
 * The backend computes WHAT changed after every sweep; Electron's main
 * process (main.js) registers HOW to surface it — macOS Notification,
 * tray title + dock badge, login item. Standalone `node backend/server.js`
 * runs register nothing and every call here no-ops, so the backend stays
 * Electron-free (same seam philosophy as telegram.setSweepRunner).
 *
 * Notification policy: only NEW reply/recap cards fire — the two kinds
 * where minutes matter. Cold/promise/todo cards wait for the user to open
 * the app. The first observe() after launch seeds silently so a restart
 * never re-announces the whole queue.
 */

let _notify = null;     // ({ title, body }) => void
let _badge = null;      // (count) => void
let _loginItem = null;  // (enabled) => void
let _seenKeys = null;   // null until the first observe() — that one seeds

function setNotifier(fn) { _notify = fn; }
function setBadge(fn) { _badge = fn; }
function setLoginItemApplier(fn) { _loginItem = fn; }

// Routes call this when the launchAtLogin setting flips (and main.js calls
// it once at startup with the persisted value).
function applyLoginItem(enabled) {
  if (!_loginItem) return;
  try { _loginItem(Boolean(enabled)); } catch (e) {
    console.error(`[pulse] login item apply failed: ${e.message}`);
  }
}

// Keep the tray count / dock badge current. Called from observe() and from
// the queue route, so acting on items in the app updates the badge without
// waiting for the next sweep.
function updateBadge(count) {
  if (!_badge) return;
  try { _badge(count); } catch (e) {
    console.error(`[pulse] badge update failed: ${e.message}`);
  }
}

// Called after every completed sweep cycle with the fresh queue build.
function observe(queue) {
  const items = (queue && queue.items) || [];
  updateBadge(items.length);

  const prev = _seenKeys;
  _seenKeys = new Set(items.map((i) => i.key));
  if (prev === null || !_notify) return { notified: 0 };

  const fresh = items.filter(
    (i) => !prev.has(i.key) && (i.kind === "reply" || i.kind === "recap")
  );
  if (!fresh.length) return { notified: 0 };

  let title, body;
  if (fresh.length === 1) {
    const it = fresh[0];
    title = it.kind === "recap"
      ? `Recap owed — ${it.relationshipName}`
      : `Reply owed — ${it.relationshipName}`;
    body = it.why || "";
  } else {
    const names = fresh.map((i) => i.relationshipName).filter(Boolean);
    title = `${fresh.length} new in your queue`;
    body = names.slice(0, 4).join(", ") + (names.length > 4 ? "…" : "");
  }
  try { _notify({ title, body }); } catch (e) {
    console.error(`[pulse] notify failed: ${e.message}`);
  }
  return { notified: fresh.length };
}

module.exports = {
  setNotifier,
  setBadge,
  setLoginItemApplier,
  applyLoginItem,
  updateBadge,
  observe,
};
