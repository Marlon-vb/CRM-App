/* Cadence desktop — Electron main process.
 *
 * Opens the native window on the Node backend's own URL
 * (http://localhost:3456). The Express backend (backend/server.js) serves
 * BOTH the /api routes AND the built React frontend (app/dist) — one origin,
 * no Vite dev proxy.
 *
 * Electron starts the Node backend itself — `npm start` runs everything:
 *   npm --prefix app run build      build the frontend once → app/dist
 *   cd desktop && npm start         starts the backend + opens this window
 *
 * Set CADENCE_URL=http://localhost:5173 to point at a live Vite dev server
 * instead (for frontend work); the backend still starts on :3456.
 */

const {
  app, BrowserWindow, shell, dialog,
  Notification, Tray, Menu, nativeImage,
} = require("electron");
const path = require("path");

// Packaged mode: redirect data + bundled assets to OS-standard locations.
// Must run BEFORE requiring the backend — config.js reads these at load time.
// No seeding in Cadence: dev and packaged both start empty; relationships
// arrive via the in-app add form, suggestions, or the Phase 3 importer.
if (app.isPackaged) {
  // Lets backend modules distinguish packaged from dev without depending
  // on Electron (e.g. server.js suppresses the dev token log).
  process.env.CADENCE_PACKAGED = "1";
  const userData = app.getPath("userData");
  process.env.CADENCE_DATA_DIR = userData;
  process.env.CADENCE_DB_PATH = path.join(userData, "cadence.db");
  process.env.CADENCE_FRONTEND_DIST = path.join(process.resourcesPath, "frontend");
}

const backend = require("./backend/server");
const auth = require("./backend/auth");
const notifier = require("./backend/notifier");
const settings = require("./backend/settings");
const { DATA_DIR } = require("./backend/config");
const fs = require("fs");

// Defaults to the Node backend's own origin; override with CADENCE_URL=…
// to point at a Vite dev server during frontend work.
const CADENCE_URL = process.env.CADENCE_URL || "http://localhost:3456";

let mainWindow = null;

// ── window bounds persistence ──
// Cadence lives as a slim todo-list column (~quarter of a laptop screen),
// but whatever size the user drags it to should stick across launches.
const _BOUNDS_FILE = path.join(DATA_DIR, "window-state.json");

function _loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(_BOUNDS_FILE, "utf8"));
    if (Number.isFinite(b.width) && Number.isFinite(b.height)) return b;
  } catch { /* first launch / unreadable — use defaults */ }
  return null;
}

let _boundsTimer = null;
function _saveBoundsSoon() {
  clearTimeout(_boundsTimer);
  _boundsTimer = setTimeout(() => {
    if (!mainWindow) return;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(_BOUNDS_FILE, JSON.stringify(mainWindow.getBounds()));
    } catch { /* best-effort */ }
  }, 500);
}

function createWindow() {
  const saved = _loadBounds();
  mainWindow = new BrowserWindow({
    // Default: a narrow, tall column — a todo list, not a dashboard. The
    // frontend shell collapses to its compact layout below 860px, so the
    // default lands well inside compact mode. Drag it wider and the full
    // rail + detail layout comes back (and the size persists).
    width: saved?.width ?? 480,
    height: saved?.height ?? 940,
    x: saved?.x,
    y: saved?.y,
    minWidth: 380,
    minHeight: 560,
    title: "Cadence",
    show: false, // revealed on ready-to-show to avoid a blank flash
    // Hide the native title bar but keep the macOS traffic-light buttons
    // (close / min / max) in their standard inset position. The app paints
    // edge-to-edge underneath them. A CSS drag region at the top of App.jsx
    // (-webkit-app-region: drag) lets the user grab + move the window.
    titleBarStyle: "hiddenInset",
    // Window-chrome fallback color shown during resize before React paints —
    // match the dark theme's deep surface so there's no white flash.
    backgroundColor: "#0c0c10",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Hand the per-launch API token to the (sandboxed) preload — it
      // reads process.argv and exposes window.cadence.apiToken.
      additionalArguments: [`--cadence-token=${auth.TOKEN}`],
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  mainWindow.loadURL(CADENCE_URL);

  // The Vite dev server may not be up yet — retry the load until it is.
  mainWindow.webContents.on("did-fail-load", () => {
    setTimeout(() => {
      if (mainWindow) mainWindow.loadURL(CADENCE_URL);
    }, 1000);
  });

  // Open external links (LinkedIn, Twitter, etc.) in the system browser
  // rather than inside the app window. Scheme allowlist: a crafted link in
  // a Telegram message (file:, smb:, custom app schemes) must not reach
  // shell.openExternal — that hands it to the OS, which may launch
  // arbitrary protocol handlers.
  const _SAFE_SCHEMES = new Set(["https:", "http:", "mailto:"]);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (_SAFE_SCHEMES.has(new URL(url).protocol)) shell.openExternal(url);
    } catch {
      /* unparseable URL → drop */
    }
    return { action: "deny" };
  });

  // Navigation lock: the app frame must never leave its own origin.
  // Without this, injected content could set window.location and walk the
  // frame (with the preload bridge still attached) to an attacker origin.
  const appOrigin = new URL(CADENCE_URL).origin;
  mainWindow.webContents.on("will-navigate", (event, url) => {
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {
      /* unparseable → block */
    }
    if (origin !== appOrigin) event.preventDefault();
  });

  mainWindow.on("resize", _saveBoundsSoon);
  mainWindow.on("move", _saveBoundsSoon);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function focusWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ── the pulse: tray + badge + notifications + login item (audit C3/C4) ──
// Cadence's promise is proactive — a sweep that finds a new reply owed must
// reach the user without the app being open. The backend diffs queue builds
// (backend/notifier.js) and calls back into the hooks registered here.

// Template tray icon (metronome dot), generated programmatically — the repo
// ships no image assets. Template = macOS recolors it for menubar theme.
const _TRAY_PNG_16 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAeUlEQVR4nJWRyxGAIAxEXyPUwdn+6Ca1cLEZHZKIQXTUzSGQ3ckXfmChsLFRWGYyIUoeJqSRXge62RolMtGWpde2QCWrz1SPeC/FvxnU48LWbihQ9W0CPIfMggODIJYwXErEJo2+NBnHrJ0MY35Y1Ouqz2MJcn+sR+xz1XQ38bwOzAAAAABJRU5ErkJggg==";
const _TRAY_PNG_32 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAQAAADZc7J/AAAA6ElEQVR4nM1VuxHDIAx9wzCDZ2AHdqB070Vo2cE9I1EnR3x2kEBATC6Xp8ZGH6SHEMA/Y4GBhYXB8qmrhkfEI5MIDz26705cc9n7uVjR+RTbct+67km2+7s3s1iG3ZNUuJCpq9PJoAsTB3V9K7hCzw7VM/X6Wj3/ElZm4WmAyHZHEQAsi9giUFUDKGaVEWmIIlzrNAAQiJ2ROsCJAWgRth+AQwwglcAhliCRSNEgUTrGVgGRKuuNlKPTSPVWfiffbeX6ZQpwcIy6Q4rL9IXrPD1QMD/SxrJoDlXMj/UDUw9Lnsvtp+2XeAJYB866HUd4lwAAAABJRU5ErkJggg==";

let tray = null;
let trayCount = 0;

function _trayMenu() {
  return Menu.buildFromTemplate([
    {
      label: trayCount > 0
        ? `${trayCount} item${trayCount === 1 ? "" : "s"} need you`
        : "Queue is clear",
      enabled: false,
    },
    { type: "separator" },
    { label: "Open Cadence", click: focusWindow },
    {
      label: "Sync now",
      click: () => {
        // Full sweep cycle via the runner server.js registered; safe no-op
        // when Telegram isn't configured yet.
        try { require("./backend/telegram").sweepSoon(); } catch { /* best-effort */ }
      },
    },
    { type: "separator" },
    { label: "Quit Cadence", click: () => app.quit() },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${_TRAY_PNG_16}`);
  icon.addRepresentation({
    scaleFactor: 2,
    dataURL: `data:image/png;base64,${_TRAY_PNG_32}`,
  });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Cadence");
  tray.setContextMenu(_trayMenu());
}

function registerPulse() {
  notifier.setNotifier(({ title, body }) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on("click", focusWindow);
    n.show();
  });
  notifier.setBadge((count) => {
    trayCount = count;
    if (app.dock) app.dock.setBadge(count > 0 ? String(count) : "");
    if (tray) {
      tray.setTitle(count > 0 ? ` ${count}` : "");
      tray.setContextMenu(_trayMenu());
    }
  });
  // Login item registration only makes sense for the packaged .app — in dev
  // it would point launchd at the bare Electron binary.
  notifier.setLoginItemApplier((enabled) => {
    if (!app.isPackaged) return;
    app.setLoginItemSettings({ openAtLogin: enabled });
  });
  notifier.applyLoginItem(settings.status().launchAtLogin);
}

app.whenReady().then(async () => {
  // Start the Node backend before opening the window, so the app is up by
  // the time the renderer loads :3456.
  try {
    await backend.start();
  } catch (err) {
    dialog.showErrorBox(
      "Cadence — backend failed to start",
      String(err && err.message ? err.message : err)
    );
    app.quit();
    return;
  }
  createWindow();
  createTray();
  registerPulse();
});

// macOS apps stay alive when all windows close; other platforms quit.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Best-effort backend cleanup (Telegram disconnect) on quit.
app.on("will-quit", () => {
  try {
    backend.shutdown();
  } catch (e) {
    /* best-effort */
  }
});
