'use strict';

// The shell's socket: window changes go out to every open shell, and the user's panel moves,
// closes and the tab's size come back.
const logger = require('./log.cjs');

// Only what the user can change by handling a panel; visibility stays main's call.
const PANEL_FIELDS = ['focused', 'minimized', 'maximized', 'fullscreen', 'bounds'];

// `sockets` is shared with the main → browser calls, which can target the shell.
function createShellSocket({ layout, windows, calls, sockets }) {
  function broadcast(message) {
    const frame = JSON.stringify(message);
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(frame);
  }
  windows.onChange(broadcast);

  function handleMessage(message) {
    if (message.type === 'viewport') {
      windows.setViewport(message.width, message.height);
    } else if (message.type === 'panel') {
      const changes = {};
      for (const field of PANEL_FIELDS) if (field in (message.changes ?? {})) changes[field] = message.changes[field];
      windows.setView(Number(message.id), changes);
    } else if (message.type === 'close') {
      const state = windows.get(Number(message.id));
      if (state && windows.isAlive(state) && state.options.closable !== false) state.win.close();
    } else if (message.type === 'call-result') {
      calls.settle(message, 'shell');
    }
  }

  function attach(ws) {
    sockets.add(ws);
    ws.on('close', () => {
      sockets.delete(ws);
      calls.redeliver('shell');
    });
    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      // A throw here would reach Electron as an uncaught exception and its crash dialog.
      try {
        handleMessage(message);
      } catch (err) {
        logger.error(`shell: handling '${message.type}' threw:`, err);
      }
    });
    ws.send(JSON.stringify({ type: 'init', layout, windows: windows.all().map(windows.describe) }));
    calls.redeliver('shell');
  }

  return { attach };
}

module.exports = { createShellSocket };
