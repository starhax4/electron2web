'use strict';

// A window page's socket: the renderer's ipcRenderer.send/invoke and page events arrive here
// and are delivered to the app's main process as Electron would deliver them.
const logger = require('./log.cjs');
const codec = require('./codec.cjs');

function createRendererIpc({ electron, windows, calls, globalHandlers }) {
  function makeEvent(state) {
    const contents = state.win.webContents;
    const frame = {
      url: state.target?.href ?? '',
      origin: state.target?.origin ?? '',
      processId: -1,
      routingId: -1,
      frameTreeNodeId: -1,
      parent: null,
      send: (channel, ...args) => windows.push(state.id, channel, args),
    };
    frame.top = frame;
    return {
      sender: contents,
      senderFrame: frame,
      frameId: -1,
      processId: -1,
      ports: [],
      returnValue: undefined,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      reply: (channel, ...args) => windows.push(state.id, channel, args),
    };
  }

  // Electron delivers renderer messages to webContents.ipc first, then ipcMain.
  function emitIpc(state, channel, event, args) {
    state.win.webContents.ipc.emit(channel, event, ...args);
    electron.ipcMain.emit(channel, event, ...args);
  }

  async function handleInvoke(state, ws, { id, channel, args }) {
    const started = performance.now();
    let reply;
    try {
      const handler = state.handlers.get(channel) ?? globalHandlers.get(channel);
      if (!handler) throw new Error(`No handler registered for '${channel}'`);
      reply = { type: 'result', id, value: await handler(makeEvent(state), ...args) };
    } catch (err) {
      reply = { type: 'result', id, error: serializeError(err) };
    }
    let frame;
    try {
      frame = codec.pack(reply);
    } catch (err) {
      frame = codec.pack({ type: 'result', id, error: { name: 'Error', message: `An object could not be cloned. (${err.message})` } });
    }
    if (ws.readyState === ws.OPEN) ws.send(frame);
    logger.debug(`window ${state.id} invoke '${channel}' ${reply.error ? 'failed' : 'ok'} in ${(performance.now() - started).toFixed(1)}ms (${frame.length} bytes)`);
  }

  function handleLifecycle(state, eventName) {
    const contents = state.win.webContents;
    const event = { sender: contents, preventDefault() {} };
    if (eventName === 'dom-ready') {
      contents.emit('dom-ready', event);
    } else if (eventName === 'did-finish-load') {
      if (!state.shown) {
        state.shown = true;
        state.win.emit('ready-to-show', event);
      }
      contents.emit('did-finish-load', event);
      for (const resolve of state.loadWaiters.splice(0)) resolve();
    }
  }

  // Electron's window title follows the page title unless a listener prevents it.
  function handleTitle(state, title) {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    state.win.webContents.emit('page-title-updated', event, title, true);
    state.win.emit('page-title-updated', event, title, true);
    if (!event.defaultPrevented) windows.setView(state.id, { title });
  }

  function handleMessage(state, ws, message) {
    if (message.type === 'invoke') {
      handleInvoke(state, ws, message);
    } else if (message.type === 'send') {
      logger.debug(`window ${state.id} send '${message.channel}'`);
      emitIpc(state, message.channel, makeEvent(state), message.args);
    } else if (message.type === 'lifecycle') {
      handleLifecycle(state, message.event);
    } else if (message.type === 'title') {
      handleTitle(state, String(message.title));
    } else if (message.type === 'focus') {
      if (state.view.visible && !state.view.focused) windows.setView(state.id, { focused: true, minimized: false });
    }
  }

  function attach(state, ws) {
    state.sockets.add(ws);
    ws.on('close', () => {
      state.sockets.delete(ws);
      calls.redeliver(state.id);
    });
    ws.on('message', (data) => {
      let message;
      try {
        message = codec.unpack(data);
      } catch (err) {
        logger.warn(`dropped malformed message: ${err.message}`);
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'call-result') return calls.settle(message, state.id);
      if (!windows.isAlive(state)) {
        logger.debug(`window ${state.id} is closed; dropped its '${message.type}' message`);
        if (message.type === 'invoke' && ws.readyState === ws.OPEN) {
          ws.send(codec.pack({ type: 'result', id: message.id, error: { name: 'Error', message: 'The window was closed' } }));
        }
        return;
      }
      // A throw here would reach Electron as an uncaught exception and its crash dialog.
      try {
        handleMessage(state, ws, message);
      } catch (err) {
        logger.error(`window ${state.id}: handling '${message.type}'${message.channel ? ` on '${message.channel}'` : ''} threw:`, err);
      }
    });
    calls.redeliver(state.id);
  }

  // ipcRenderer.sendSync(): delivered like send(), answered with event.returnValue.
  function sendSync(state, { channel, args }) {
    const event = makeEvent(state);
    emitIpc(state, channel, event, args);
    return event.returnValue;
  }

  return { attach, sendSync };
}

function serializeError(err) {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { name: 'Error', message: String(err) };
}

module.exports = { createRendererIpc };
