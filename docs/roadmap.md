# Roadmap: full Electron API coverage

**Goal:** run a whole Electron app inside one browser tab, so that both people and AI browser
agents (Playwright, Chrome DevTools MCP, Claude in Chrome and others) can use **every** part of
it, including the parts the OS draws today: dialogs, menus, tray, notifications and extra
windows.

The foundation (phase P0) is built. Everything else below is planned.

## Principles

1. **Everything an app shows ends up in the DOM.** A native file picker that opens on the host
   desktop is invisible to a browser agent and to anyone viewing the tab from another machine.
   Each feature therefore gets a **web surface**: HTML in the tab, with ARIA roles (`dialog`,
   `menu`, `menuitem`, `alert`) so agents can find it in the accessibility tree.
2. **Two surfaces per feature: `web` and `native`.** `web` draws the feature in the tab and is
   the default. `native` opens the real OS UI on the host. Users opt features back to native
   with `--native dialog,notification`.
3. **Main stays real.** The app's main process runs unmodified in real Electron. electron2web
   patches the Electron modules it `require`s; the app's code doesn't change.
4. **Return the shapes Electron returns.** A web message box resolves
   `{ response, checkboxChecked }`; a web open dialog resolves `{ canceled, filePaths }` with
   **real host paths**. App code can't tell the difference.
5. **Fail loudly, never silently.** An API with no fallback logs one clear
   `[electron2web] X is not supported` line and returns a harmless value. It never crashes main.

## Building blocks

These exist today and every planned feature builds on them (see
[How it works](../packages/electron2web/README.md#how-it-works)):

- **Patch registry** (`src/patches/`): one module per Electron API, each
  `{ name, install(electron, { bridge, surface }) }`. New APIs (`menu`, `tray`,
  `notification`, `shell`, `clipboard`, `screen`, `protocol`, …) are added as new modules.
- **Two-way RPC:** besides tab → main IPC, main can call into a window's page or into the shell
  with `bridge.call(target, op, payload)` and await the reply. Calls queue until a tab connects
  and time out after 60 s, so a feature can fall back to `native`.
- **Shell:** one tab holds every window as a panel (`desktop`, `tabs` or `single` layout). Each
  page origin gets its own `o<n>.app.localhost` origin, so storage is shared exactly as in
  Electron.
- **Window state mirroring:** the panels report bounds, focus and visibility to main, so
  `getBounds()`, `isFocused()`, `getFocusedWindow()` and the matching events behave.

## Coverage matrix

Legend: ✅ works · 🟡 partial · — not handled yet · ⛔ throws or no-op · P1–P4 planned phase

### Windows and views

| Electron API | Today | Planned web surface | Phase |
|---|---|---|---|
| `BrowserWindow` with preload | ✅ panel in the shell | | |
| `BrowserWindow` without preload (helpers) | ✅ stays real Electron | Optionally show visible popups as panels | P1 |
| `setTitle`, `page-title-updated` | ✅ | | |
| `setBounds/getBounds/setSize/center/setPosition` | ✅ mirrored | | |
| `minimize/maximize/restore/setFullScreen/isX()` | ✅ (full screen fills the tab) | | |
| `close()`, `close` + `preventDefault`, `closed` | ✅ | | |
| `hide()/show()`, `isVisible()` | ✅ | | |
| `focus()`, `getFocusedWindow()`, `focus/blur` | ✅ | | |
| `parent` + `modal: true` | — | Overlay panel with backdrop; parent blocked | P1 |
| `frame: false`, `-webkit-app-region`, `titleBarOverlay` | — | Drag regions move the panel; controls drawn by the shell | P1 |
| `window.open`, `setWindowOpenHandler`, `did-create-window` | — | Runtime intercepts and asks main's handler; `allow` opens a new panel | P1 |
| `setAlwaysOnTop`, `setOpacity`, `transparent` | — | z-order pin, CSS opacity, transparent panel | P3 |
| `setProgressBar`, `flashFrame`, `setOverlayIcon` | — | Progress strip, title flash, favicon badge | P3 |
| `BrowserView`, `WebContentsView`, `BaseWindow` | ⛔ | Positioned iframes inside the panel | P3 |
| `<webview>` | ⛔ | Custom element wrapping an iframe, proxied | P3 |

### webContents

| Electron API | Today | Planned web surface | Phase |
|---|---|---|---|
| `send`, `ipc.handle/on` | ✅ | | |
| `loadURL`, `loadFile`, `reload` | ✅ | | |
| `did-finish-load`, `dom-ready`, `ready-to-show` | ✅ | | |
| `executeJavaScript` | ✅ (CSP-safe) | `executeJavaScriptInIsolatedWorld` | P1 |
| `getFocusedWebContents` | ✅ | | |
| `print()` | ✅ Chrome's print dialog | | |
| `openDevTools` | ✅ ignored; use Chrome DevTools | | |
| `did-navigate`, `will-navigate`, `did-fail-load` | — | Runtime reports navigations; `will-navigate` asks main first | P1 |
| `insertCSS`, `removeInsertedCSS` | — | RPC to a `<style>` tag | P1 |
| `undo/redo/cut/copy/paste/selectAll` | — | `document.execCommand` in the frame | P1 |
| `goBack/goForward/canGoBack/getURL/isLoading` | 🟡 `getURL` | History state reported by the runtime | P1 |
| `context-menu` event | — | Runtime builds Electron's `params` from `contextmenu` | P1 |
| `before-input-event` | — | keydown/keyup forwarding | P1 |
| `printToPDF()`, `capturePage()` | ⛔ | DOM snapshot rendered by a hidden helper window | P2 |
| `setZoomFactor/Level`, `zoom-changed` | 🟡 renderer only | RPC to CSS zoom | P2 |
| `console-message`, `render-process-gone`, `unresponsive` | — | Forwarded console, socket close, missed heartbeat | P2 |
| `setUserAgent` | — | Opt-in `navigator.userAgent` override | P2 |
| `findInPage` | — | `window.find()` with match counting | P3 |

### IPC and renderer-side modules

| Electron API | Today | Planned web surface | Phase |
|---|---|---|---|
| `ipcRenderer.invoke/send/sendSync/on/once` | ✅ | | |
| `contextBridge.exposeInMainWorld` | ✅ | | |
| `webFrame` zoom / `insertCSS` / `executeJavaScript` | ✅ | | |
| `webUtils.getPathForFile`, `File.path` | 🟡 returns `""` | Real paths for files from web dialogs; dropped files uploaded to a temp folder | P2 |
| `process.env/argv/cwd()` in preload | 🟡 empty | Allowlisted snapshot from main | P2 |
| `clipboard` in renderer | — | `navigator.clipboard`, falling back to main | P2 |
| `ipcRenderer.postMessage`, `MessageChannelMain` | ⛔ | Port proxy over the WebSocket | P3 |
| `contextBridge.exposeInIsolatedWorld` | ⛔ | Same as main world | P3 |
| Node built-ins in preload (`fs`, `os`, …) | ⛔ throws | Node RPC: polyfills for pure modules, proxied calls for the rest (opt-in) | P3 |
| `nodeIntegration: true`, `@electron/remote` | ⛔ | Node RPC exposed as `require` (opt-in) | P3 |

### Main-process modules that show UI

| Electron API | Today | Planned web surface | Phase |
|---|---|---|---|
| `dialog.showMessageBox`, `showErrorBox` | 🟡 native | HTML modal returning `{ response, checkboxChecked }` | P1 |
| `dialog.showOpenDialog`, `showSaveDialog` | 🟡 native | Web file browser backed by main, with real host paths | P1 |
| `dialog.*Sync` | native | Needs the bridge in a worker thread (main is blocked) | P4 |
| `Menu.setApplicationMenu`, menu roles, accelerators | — | Shell menubar; clicks run `item.click` in main | P1 |
| `Menu.popup()` | — | HTML context menu in the right panel | P1 |
| `Notification` | native | In-tab toast with `click`/`action`/`reply` events | P1 |
| `shell.openExternal` | opens on the host | New browser tab | P1 |
| `shell.openPath`, `showItemInFolder` | host | Stays native, plus a toast | P2 |
| `Tray` | — | Icons in the shell menubar | P3 |
| `app.setBadgeCount`, `dock.*` | ⛔ | Favicon badge, title prefix | P3 |

### Main-process modules tied to the tab's environment

| Electron API | Today | Planned web surface | Phase |
|---|---|---|---|
| `app.getPath/getVersion/…`, `fs`, `child_process`, `net`, `safeStorage` | ✅ host | | |
| `protocol.handle`, custom schemes (`app://`) | ⛔ 501 | Route requests to the app's handler in main; rewrite URLs in the page | P2 |
| `file://` URLs inside the page | — | Served for paths under the app folder or handed out by main | P2 |
| CORS (`webSecurity: false`, `session.webRequest`) | — | Cross-origin requests run through `net.fetch` in main | P2 |
| Downloads (`will-download`, `DownloadItem`) | — | Streamed to the tab as a browser download | P2 |
| `clipboard` (main) | host | Follows the tab's clipboard | P2 |
| `screen`, `nativeTheme` | host | Values reported by the tab | P2 |
| `globalShortcut` | host-wide | Tab keydown listener (only while the tab has focus) | P2 |
| Deep links (`open-url`, `second-instance`, `open-file`) | host | Endpoint to fire them from tests | P3 |
| `powerSaveBlocker`, `powerMonitor` | host | Wake Lock API, Page Visibility | P4 |
| `desktopCapturer` | host | `getDisplayMedia` in the tab | P4 |
| `autoUpdater`, `crashReporter`, `TouchBar`, … | host | No-op stubs in dev | P4 |

## Phases

| Phase | Scope | Done when |
|---|---|---|
| **P0 Foundation** ✅ | Patch registry, two-way RPC, shell with panels and per-origin routing, window state mirroring, `--layout` and `--native` flags | The sample app runs in the shell with several windows |
| **P1 Visible UI** | Web dialogs; app menu, roles and accelerators; context menus; `window.open`; modal and frameless windows; notifications; `shell.openExternal`; navigation events; `before-input-event`; edit commands | An agent using only the browser can open a file, use every menu item, answer every dialog and use a modal window |
| **P2 Plumbing** | Custom protocols; `file://` assets; CORS via `net`; downloads; drag-and-drop paths; clipboard; `screen`/`nativeTheme`; `globalShortcut`; `printToPDF`/`capturePage`; crash events | Print, PDF and file flows work from the tab with no native window appearing |
| **P3 Compatibility** | MessagePort IPC; Node RPC (`nodeIntegration`, `@electron/remote`); `BrowserView`/`WebContentsView`/`<webview>`; tray; badges; deep links | An older `nodeIntegration` + `remote` app and a `WebContentsView` app run unchanged |
| **P4 Agent tooling** | Richer `/state` (dialogs, menus); event log; `--headless`; dialog auto-answer rules for tests; sync dialogs via a worker; an MCP server; remaining stubs | An agent can drive a full app flow with only the shell URL |

P1 and P2 come in order. P3 and P4 items are independent and can land in any order after P1.

## Hard limits

Some things can't be made faithful in a browser:

- **Sync dialogs** block Electron's event loop; they can only move to the tab once the bridge
  runs in a worker thread.
- **Global shortcuts** only fire while the tab has focus.
- **True OS windows:** click-through transparency, vibrancy, always-on-top above other apps and
  multi-monitor placement can only be approximated.
- **Native Node addons** in the renderer need the Node RPC and only work if their API can be
  serialized.
- **Screen capture** needs a person to pick the source in Chrome's own picker.
- **Clipboards differ** when the browser runs on another machine; `web` mode follows the tab.
- **Throughput:** every main ↔ renderer call crosses a WebSocket. Fine for UI; heavy streaming
  over IPC is slower than in Electron.
