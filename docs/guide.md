# User guide

electron2web runs a whole Electron app in a normal Chrome tab, while the app's real Electron
main process keeps running hidden in the background. Every app window becomes a panel inside
that one tab, and IPC (`invoke`, `send`, `sendSync`, `webContents.send`) is carried between
the two over a local WebSocket.

This guide covers installing, running the sample app, using it with your own app, remote
access and troubleshooting. For the full option list, the agent API and how it works inside,
see the [package README](../packages/electron2web/README.md).

- [Requirements](#requirements)
- [Install](#install)
- [Try the sample app](#try-the-sample-app)
- [Use it with your own app](#use-it-with-your-own-app)
- [Use it from another machine](#use-it-from-another-machine)
- [Troubleshooting](#troubleshooting)

## Requirements

- Node.js 18 or newer
- Google Chrome, Edge or another Chromium browser (they resolve `*.localhost` to your own
  machine, which electron2web relies on)
- An Electron app you run in dev mode

## Install

Globally, straight from the latest GitHub release:

```bash
npm install -g --allow-remote=all https://github.com/starhax4/electron2web/releases/latest/download/electron2web.tgz
```

(`--allow-remote=all` is needed from npm 12 on to install a tarball by URL.) To remove it:
`npm uninstall -g electron2web`.

Or per app, as a dev dependency:

```bash
npm install -D --allow-remote=all https://github.com/starhax4/electron2web/releases/latest/download/electron2web.tgz
```

> npm may print `install scripts blocked` warnings for `esbuild` / `msgpackr-extract`. They're
> harmless: electron2web works without them.

## Try the sample app

`examples/basic-app` is a small electron-vite app that tests the bridge on itself.

```bash
git clone https://github.com/starhax4/electron2web.git
cd electron2web/packages/electron2web && npm install
cd ../../examples/basic-app && npm install
npm run web
```

npm 11+ blocks install scripts, and Electron needs its install script to download its binary.
If Electron fails to start, run `node node_modules/electron/install.js` once.

Wait until the terminal prints:

```
[electron2web] ready. Open this in Chrome: (Electron up in 0.4s · layout desktop · port 4400)

  ➜  Open:          http://app.localhost:4400/__electron2web/auth?token=xxxxxxxx&next=%2F
  ➜  Windows:       http://app.localhost:4400/__electron2web/
  ➜  State JSON:    http://app.localhost:4400/__electron2web/state
  ➜  Session file:  C:\Users\you\.electron2web\session.json
```

Open the **Open** URL in Chrome, or start with `--open` to have it opened for you.

> Don't open the `http://localhost:5173` link Vite prints. That page has no Electron behind it:
> the UI shows up, but there's no data from main (`window.api` is undefined).

You should see:

- a **Clock from main** counting up every second (pushed from the main process);
- **12 rows of PASS** in the IPC checks table;
- **Open native file dialog**, which opens a real OS file picker;
- **Open a second window**, which opens a second panel you can drag, resize, minimize and close;
- **Print this window**, which opens Chrome's print dialog;
- a **taskbar** with one entry per window. Click to focus, × or middle-click to close. The dot
  on the right shows whether the tab is connected to Electron.

Things to try:

| Do this | Expected |
|---|---|
| Edit `src/renderer/style.css` | Style updates instantly (HMR) |
| Edit `src/main/index.js` and save | Red banner, Electron restarts, the tab reloads by itself |
| Press F12 | Chrome DevTools on your Electron UI |
| Open `http://app.localhost:4400/__electron2web/` | Control page listing the app's windows |
| Open `http://app.localhost:4400/__electron2web/state` | Every window's state as JSON |

After the first visit the token is remembered in `~/.electron2web/token`, so
`http://app.localhost:4400/` keeps working across restarts.

## Use it with your own app

Wrap the command that normally starts your app:

```bash
electron2web -- npm start
electron2web -- npm run dev
electron2web -- electron-forge start
electron2web                  # runs "npx electron ."
```

(Use `npx electron2web` if you installed it per app.) The `--` is optional. Give each app its
own port to run several at once: `electron2web --port 4401 -- npm start`.

Or add a script next to your existing one:

```json
"scripts": {
  "dev": "electron-vite dev --watch",
  "web": "electron2web -- electron-vite dev --watch"
}
```

Don't put `electron2web` inside the `start` script itself if you also wrap `npm start`; it
would call itself in a loop.

### Your app works best if

- the main process is **CommonJS** (`require`); electron-vite's default output is fine;
- it uses a **preload** with `contextBridge.exposeInMainWorld(...)` and `ipcRenderer`;
- the preload only imports `electron`, not `fs`, `path`, `child_process` and so on;
- it runs in **dev mode**, not as a packaged `.exe` / `.app`.

### Which windows move to the browser

Only windows created **with a preload** are shown in Chrome, each as a panel in the shell.
Moving, resizing, focusing, minimizing, maximizing and closing a panel updates the real
window's state in main, so `getBounds()`, `isFocused()`, `BrowserWindow.getFocusedWindow()`
and events like `focus`, `resize` and `close` behave as in Electron.

Windows without a preload stay normal Electron windows: hidden print/PDF helper windows keep
working, and popups for external links open as real windows.

Printing:

- `webContents.print()` on a window shown in Chrome opens **Chrome's** print dialog.
- Printing through a hidden helper window (`loadFile(pdf)` + `window.print()`, or
  `printToPDF`) runs in real Electron, so you get the **native** print dialog.
- `printToPDF()` on a window shown in Chrome isn't supported. Do it in a helper window.

What isn't supported yet is listed in the
[package README](../packages/electron2web/README.md#not-supported-yet); planned work is in the
[roadmap](roadmap.md).

## Use it from another machine

Start a tunnel to the bridge port, then pass the tunnel's public URL to `--public-host`:

```bash
cloudflared tunnel --url http://localhost:4400
electron2web --public-host https://<the-name-it-printed>.trycloudflare.com -- npm run dev
```

`ngrok http 4400` and `npx localtunnel --port 4400` work the same way. The tunnel can start
before or after electron2web. electron2web then prints a second link,
`https://…/__electron2web/auth?token=…`; open that on the other machine.

How it differs from local use:

- All windows share the one tunnel hostname. The app's dev server is served at `/` and
  `loadFile()` pages under `/__electron2web/s<n>/`. If the app loads a **second** http(s)
  origin, those windows show a "not available over the public host" note; they still work
  locally.
- Windows on different origins share storage there (locally each origin keeps its own).
- The tunnel must pass the original `Host` header (cloudflared, ngrok and localtunnel do by
  default). Behind nginx, either keep it (`proxy_set_header Host $host;`) or send
  `X-Forwarded-Host`, and forward WebSocket upgrades:

  ```nginx
  location / {
    proxy_pass http://127.0.0.1:4400;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1d;
  }
  ```

Without `--public-host`, a tunnel gets `403 Forbidden host`, and the terminal tells you which
`--public-host` to pass.

> **Anyone with that link controls your app's main process** (files, shell, everything main
> can do). Share it only with people you trust. For a longer-lived tunnel, put a login in front
> (for example Cloudflare Access), and run `electron2web --new-token` to revoke old links.

## Troubleshooting

| Problem | Fix |
|---|---|
| `'electron2web' is not recognized` / `command not found` | Not installed globally. Install it (see [Install](#install)), or use `npx electron2web` in an app that has it as a dev dependency. Open a new terminal after installing. |
| `Cannot find module 'ws'` / `missing dependencies: ws, msgpackr, esbuild` | You installed the `packages/electron2web` folder, which npm only symlinks. Install the release tarball instead, or run `npm install` inside `packages/electron2web`. |
| UI shows but no data from main (clock stays `–`) | You opened the dev server's own link (e.g. Vite's `localhost:5173`). Open the `app.localhost:4400/__electron2web/auth?token=…` URL instead. |
| `app.localhost` doesn't load | Your browser doesn't resolve `*.localhost` to your own machine. Use Chrome or Edge. |
| An AI browser agent can't see the app's buttons | Its tool may not read inside iframes. Use `--layout single`, or open one window alone from the control page. |
| Page says **Not authorized** | Open the full URL with `?token=` from the terminal again. |
| `Forbidden host` through a tunnel or proxy | Start with `--public-host <the tunnel's URL>`. Behind nginx, also keep the `Host` header. |
| `could not listen on 127.0.0.1:4400` | An old run is still alive. Close it, or use `--port 4401`. On Windows, end leftover `electron.exe` processes if needed. |
| `Electron failed to install correctly` | Run `node node_modules/electron/install.js` in the app folder. |
| Console: `preload imports Node module 'fs'…` | Your preload uses Node APIs that can't run in a browser. Move that code into main behind an `ipcMain.handle`. |
| Main changes don't restart Electron | electron-vite needs `--watch`: `electron-vite dev --watch`. |
| A window pops up as a real Electron window | Expected for windows without a preload (see [Which windows move to the browser](#which-windows-move-to-the-browser)). If every window does, the hook didn't load: start the app through `electron2web`, which sets `NODE_OPTIONS`. |

When reporting a bug, include your OS, Electron version, bundler, layout and the first
`[electron2web]` error line. Running with `--debug` logs every window change and IPC call.
