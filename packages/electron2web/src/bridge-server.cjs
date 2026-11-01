'use strict';

// The bridge: runs inside Electron's main process, serves the app's windows to the browser,
// and carries IPC and window state between them. Started by hook.cjs; this file wires the
// parts together and runs the server:
//   windows.cjs       the window registry and BrowserWindow events
//   calls.cjs         main → browser calls (dialogs, executeJavaScript)
//   renderer-ipc.cjs  a window page's socket: ipcRenderer messages into main
//   shell-socket.cjs  the shell's socket: panels and window changes
//   router.cjs        HTTP and WebSocket routing, auth
const http = require('node:http');
const fs = require('node:fs');
const { getRuntime } = require('./bundler.cjs');
const logger = require('./log.cjs');
const { PREFIX, LAYOUTS } = require('./constants.cjs');
const { createOrigins } = require('./origins.cjs');
const { createProxy } = require('./proxy.cjs');
const { createWindows } = require('./windows.cjs');
const { createCalls } = require('./calls.cjs');
const { createRendererIpc } = require('./renderer-ipc.cjs');
const { createShellSocket } = require('./shell-socket.cjs');
const { createRouter } = require('./router.cjs');
const { writeSessionFile, removeSessionFiles } = require('./session-file.cjs');
const { send } = require('./http-util.cjs');

function createBridge({ electron, port, token, layout, publicUrl }) {
  if (!token) {
    throw new Error('[electron2web] ELECTRON2WEB_TOKEN is missing — start the app through the electron2web CLI.');
  }
  if (!LAYOUTS.includes(layout)) throw new Error(`[electron2web] unknown layout '${layout}' (use desktop, tabs or single)`);

  const origins = createOrigins({ port, publicUrl });
  const { shellHost, publicOrigin } = origins;
  const authUrl = (host, next) => `http://${host}${PREFIX}/auth?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
  const publicAuthUrl = (next) => `${publicOrigin}${PREFIX}/auth?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;

  // ipcMain.handle() handlers; per-window ones live on each window's state.
  const globalHandlers = new Map();
  const shellSockets = new Set();
  const windows = createWindows({ layout, slotFor: origins.slotFor });
  const calls = createCalls({ socketsFor: (target) => (target === 'shell' ? shellSockets : windows.get(target)?.sockets) });
  const ipc = createRendererIpc({ electron, windows, calls, globalHandlers });
  const shell = createShellSocket({ layout, windows, calls, sockets: shellSockets });
  const router = createRouter({ token, layout, authUrl, origins, proxy: createProxy(), windows, calls, ipc, shell });

  const server = http.createServer((req, res) => {
    router.handleRequest(req, res).catch((err) => {
      logger.error(`request ${req.url} failed:`, err);
      if (!res.headersSent) send(res, 500, `electron2web: ${err?.message ?? err} (details in the terminal)`);
      else res.destroy();
    });
  });
  server.on('upgrade', router.handleUpgrade);

  // electron-vite restarts Electron on main-process changes; the old process may hold the port briefly.
  let attempts = 0;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && ++attempts < 40) return setTimeout(() => server.listen(port, '127.0.0.1'), 250);
    logger.error(`could not listen on 127.0.0.1:${port}: ${err.message}`);
    if (err.code === 'EADDRINUSE') logger.warn(`is another electron2web still running? Stop it or pass --port <n>.`);
  });
  server.once('listening', () => {
    const session = {
      pid: process.pid,
      port,
      layout,
      url: authUrl(shellHost, '/'),
      publicUrl: publicOrigin ? publicAuthUrl(`${PREFIX}/app`) : null,
      windowsUrl: `http://${shellHost}${PREFIX}/`,
      stateUrl: `http://${shellHost}${PREFIX}/state`,
      startedAt: new Date().toISOString(),
    };
    const sessionFile = writeSessionFile(session);
    // --open: the CLI leaves a marker; whichever Electron process removes it opens the browser,
    // so restarts (electron-vite --watch) don't open another tab.
    const openMarker = process.env.ELECTRON2WEB_OPEN;
    if (openMarker) {
      fs.unlink(openMarker, (err) => {
        if (!err) electron.shell.openExternal(session.url).catch((openErr) => logger.warn(`could not open the browser: ${openErr.message}`));
      });
    }
    printReady({ session, sessionFile, layout, port, publicOrigin });
  });
  server.listen(port, '127.0.0.1');
  getRuntime().catch((err) => logger.error('could not bundle the browser runtime:', err));

  electron.app.once('will-quit', () => {
    router.closeSockets();
    server.close();
    removeSessionFiles(port);
  });

  // What the patched electron module uses.
  return {
    globalHandlers,
    registerWindow: windows.registerWindow,
    setTarget: windows.setTarget,
    reload: windows.reload,
    print: windows.print,
    push: windows.push,
    log: logger.info,
    view: windows.view,
    setView: windows.setView,
    center: windows.center,
    targetOf: windows.targetOf,
    focusedWindowId: windows.focusedWindowId,
    call: calls.call,
    executeJavaScript: calls.executeJavaScript,
  };
}

// Printed after the dev server's own output, which advertises its direct URL (e.g. Vite's
// localhost:5173). That URL skips the bridge, so window.api won't exist there.
function printReady({ session, sessionFile, layout, port, publicOrigin }) {
  const { c } = logger;
  const row = (label, value, note = '') => `  ${c.green('➜')}  ${c.bold(label.padEnd(15))}${value}${note && `  ${c.dim(note)}`}\n`;
  console.log(
    `\n${c.cyan('[electron2web]')} ${c.bold.green('ready.')} Open this in Chrome: ` +
      c.dim(`(Electron up in ${process.uptime().toFixed(1)}s · layout ${layout} · port ${port})`) +
      '\n\n' +
      row('Open:', logger.url(session.url)) +
      (publicOrigin ? row('Remote:', logger.url(session.publicUrl), `through ${publicOrigin}`) : '') +
      row('Windows:', c.cyan(session.windowsUrl), 'list, open one alone') +
      row('State JSON:', c.cyan(session.stateUrl), 'for tests and agents') +
      (sessionFile ? row('Session file:', c.cyan(sessionFile), 'these URLs, for scripts') : '') +
      `\n  ${c.dim("Not the dev server's own localhost link: it has no Electron behind it.")}\n` +
      (process.env.ELECTRON2WEB_DEBUG ? `  ${c.dim('debug on: window state and IPC calls are logged')}\n` : '') +
      (publicOrigin ? `  ${c.yellow.bold('!')} ${c.yellow("Anyone with the Remote link controls this app's main process (files, shell). Share it carefully.")}\n` : ''),
  );
}

module.exports = { createBridge };
