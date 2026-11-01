# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

```bash
git clone https://github.com/starhax4/electron2web.git
cd electron2web/packages/electron2web && npm install
cd ../../examples/basic-app && npm install
npm run web          # starts the sample app through electron2web
```

Open the printed link in Chrome. The sample app's "IPC checks" table should show 12 × PASS.
Run with `--debug` (edit the `web` script) to log every window change and IPC call.

## Where things live

All paths are under `packages/electron2web/`.

- `bin/cli.js`: argument parsing; starts your command with `NODE_OPTIONS=--require src/hook.cjs`
- `src/hook.cjs`: runs inside Electron's main process and swaps in the patched `electron` module
- `src/patches/`: `BrowserWindow`, `ipcMain` and `dialog` replacements, one module per API
- `src/bridge-server.cjs`: creates the bridge from the parts below and runs its server
  - `src/windows.cjs`: the window registry: panel state, focus, BrowserWindow events
  - `src/renderer-ipc.cjs`: a page's socket: `ipcRenderer` messages into the main process
  - `src/shell-socket.cjs`: the shell's socket: panel moves and window changes
  - `src/calls.cjs`: main → browser calls (`executeJavaScript`, shell requests)
  - `src/router.cjs`: HTTP and WebSocket routing, with the Host, cookie and Origin checks
  - `src/origins.cjs`: which browser origin serves which page, and Host classification
  - `src/proxy.cjs`: forwarding to the app's dev server (HTTP and HMR sockets)
  - `src/pages.cjs`: the bridge's own HTML pages
- `src/http-util.cjs`, `src/session-file.cjs`, `src/loader.cjs`: helpers used by the bridge
- `src/bundler.cjs`: esbuild bundles of the browser runtime and of each preload
- `src/client/runtime.js`: the fake `electron` renderer API inside each page
- `src/client/shell.js` and `shell.css`: the panels and taskbar UI
- `test/`: unit tests (`node --test`, no extra framework)

## Pull requests

- Keep changes focused. Match the surrounding style (CommonJS in `src/`, no build step).
- Run `npm run lint` and `npm test` in `packages/electron2web`, and check the sample app still
  shows 12/12 PASS.
- Add a unit test for logic that doesn't need Electron (see `test/`), and for a new Electron
  API add a check to `examples/basic-app/src/renderer/checks.js` when you can.
- Note user-visible changes in `packages/electron2web/CHANGELOG.md`.

## Reporting bugs

Please include your OS, Electron version, bundler (Vite, webpack, none), the layout, and the
first `[electron2web]` error line from the terminal. Output from `--debug` helps most.
