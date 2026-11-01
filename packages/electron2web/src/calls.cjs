'use strict';

// Main → browser calls: main asks a window's page (target = window id) or the shell
// (target = 'shell') to do something and reply. Calls wait for a tab to connect; after the
// timeout they reject with code ETIMEDOUT so callers can fall back to native behaviour.
const { randomBytes } = require('node:crypto');
const codec = require('./codec.cjs');

const CALL_TIMEOUT_MS = 60_000;

// socketsFor(target): the open sockets of that window, or of the shell.
function createCalls({ socketsFor }) {
  const calls = new Map();
  let nextCallId = 1;
  // Code for executeJavaScript(), fetched by the page as a same-origin <script src>.
  const execScripts = new Map();

  function call(target, op, payload, { timeout = CALL_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const id = nextCallId++;
      const timer = setTimeout(() => {
        calls.delete(id);
        const err = new Error(`[electron2web] no browser tab answered '${op}' within ${timeout / 1000}s`);
        reject(Object.assign(err, { code: 'ETIMEDOUT' }));
      }, timeout);
      calls.set(id, { target, message: { type: 'call', id, op, payload }, socket: null, resolve, reject, timer });
      deliver(id);
    });
  }

  function socketFor(target) {
    const sockets = socketsFor(target);
    if (!sockets) return null;
    return [...sockets].reverse().find((ws) => ws.readyState === ws.OPEN) ?? null;
  }

  function deliver(id) {
    const pending = calls.get(id);
    const socket = socketFor(pending.target);
    pending.socket = socket;
    if (!socket) return;
    socket.send(pending.target === 'shell' ? JSON.stringify(pending.message) : codec.pack(pending.message));
  }

  // A new socket picks up calls that were queued (or sent to a socket that has since closed).
  function redeliver(target) {
    for (const [id, pending] of calls) {
      if (pending.target === target && (!pending.socket || pending.socket.readyState !== pending.socket.OPEN)) deliver(id);
    }
  }

  // `from` is the window id (or 'shell') of the socket the result came in on: only the target
  // of a call may answer it.
  function settle({ id, value, error }, from) {
    const pending = calls.get(id);
    if (!pending || pending.target !== from) return;
    calls.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(Object.assign(new Error(error.message), { name: error.name ?? 'Error' }));
    else pending.resolve(value);
  }

  // Runs from a script rather than eval, because the page's CSP usually blocks eval.
  async function executeJavaScript(id, code) {
    const key = randomBytes(12).toString('hex');
    let body;
    // Only parsed here, never run: an expression's value is returned, statements run as they are.
    try {
      new Function(`return (${code}\n)`);
      body = `return (${code}\n);`;
    } catch {
      body = `${code}\n`;
    }
    execScripts.set(key, `globalThis.__electron2webExec(${JSON.stringify(key)}, async () => {\n${body}});`);
    try {
      return await call(id, 'executeJavaScript', { key });
    } finally {
      execScripts.delete(key);
    }
  }

  return { call, redeliver, settle, executeJavaScript, execScript: (key) => execScripts.get(key) };
}

module.exports = { createCalls };
