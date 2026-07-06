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

const { app, BrowserWindow, shell, dialog } = require("electron");
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

// Defaults to the Node backend's own origin; override with CADENCE_URL=…
// to point at a Vite dev server during frontend work.
const CADENCE_URL = process.env.CADENCE_URL || "http://localhost:3456";

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
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

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
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
