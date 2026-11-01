'use strict';

// The window registry: what the bridge mirrors of each BrowserWindow (its panel's place and
// state, which page it loads, the tabs showing it), and the BrowserWindow events that follow
// from changes to it. The patched BrowserWindow and the shell both change windows through here.
const logger = require('./log.cjs');
const codec = require('./codec.cjs');
const { getPreload } = require('./bundler.cjs');
const { pathFor, publicPathFor } = require('./origins.cjs');

const VIEW_EVENTS = [
  ['visible', 'show', 'hide'],
  ['focused', 'focus', 'blur'],
  ['minimized', 'minimize', 'restore'],
  ['maximized', 'maximize', 'unmaximize'],
  ['fullscreen', 'enter-full-screen', 'leave-full-screen'],
];

function createWindows({ layout, slotFor }) {
  const windows = new Map();
  const listeners = new Set();
  let viewport = { width: 1280, height: 800 };
  let focusedId = null;
  let focusHistory = [];

  // Listeners get { type: 'window', view } when a window changes and { type: 'removed', id }
  // when it closes. The shell forwards them to every open tab.
  function onChange(listener) {
    listeners.add(listener);
  }

  function notify(message) {
    for (const listener of listeners) listener(message);
  }

  function notifyView(state) {
    notify({ type: 'window', view: describe(state) });
  }

  function get(id) {
    return windows.get(id);
  }

  function all() {
    return [...windows.values()];
  }

  function inSlot(slot) {
    return all().filter((state) => state.slot === slot);
  }

  // The window the single layout shows: the first one that has loaded a page.
  function primary() {
    return all().find((state) => state.target) ?? null;
  }

  // False once the window is closed: its webContents is destroyed and can't be used.
  function isAlive(state) {
    return windows.get(state.id) === state && !state.win.isDestroyed();
  }

  function registerWindow(win, options, handlers) {
    const width = options.width ?? 800;
    const height = options.height ?? 600;
    const state = {
      id: win.id,
      win,
      options,
      handlers,
      target: null,
      slot: null,
      sockets: new Set(),
      shown: false,
      loadWaiters: [],
      // Bumped whenever the shell must point the window's iframe at a new URL.
      nav: 0,
      // Centred by us rather than placed by the app; refitted once the shell reports its size.
      autoPlaced: options.x === undefined || options.y === undefined,
      view: {
        visible: false,
        focused: false,
        minimized: false,
        maximized: false,
        fullscreen: false,
        bounds: { x: options.x ?? centered(viewport.width, width), y: options.y ?? centered(viewport.height, height), width, height },
        title: options.title ?? '',
      },
    };
    // The app's first window opens maximized, as an app's main window usually is. Fixed-size
    // and child windows keep their size; the tabs and single layouts fill the tab anyway.
    const maximized =
      layout === 'desktop' && windows.size === 0 && !options.parent && !options.fullscreen && options.maximizable !== false && options.resizable !== false;
    windows.set(win.id, state);
    // Bundle the preload now, so it is ready by the time the tab asks for it.
    getPreload(options.webPreferences?.preload).catch(() => {});
    if (options.webPreferences?.nodeIntegration) {
      logger.warn(`window ${win.id} uses nodeIntegration — Node APIs in its renderer will not work in the browser.`);
    }
    win.once('closed', () => {
      windows.delete(state.id);
      focusHistory = focusHistory.filter((id) => id !== state.id);
      if (focusedId === state.id) focusedId = null;
      broadcast(state, { type: 'closed' });
      // The page may still be sending (unload handlers, timers); its webContents is gone.
      for (const ws of state.sockets) ws.close(1000, 'window closed');
      notify({ type: 'removed', id: state.id });
      refocus();
    });
    setView(state.id, {
      visible: options.show !== false,
      focused: options.show !== false && options.focusable !== false,
      maximized,
      fullscreen: Boolean(options.fullscreen),
    });
  }

  function view(id) {
    return windows.get(id)?.view ?? {};
  }

  function targetOf(id) {
    return windows.get(id)?.target?.href ?? null;
  }

  function focusedWindowId() {
    return focusedId;
  }

  // Applies a change to a window's mirrored state, fires the matching BrowserWindow
  // events, and tells the shell. Called by the patched BrowserWindow methods and by the
  // shell when the user moves, focuses or minimises a panel.
  function setView(id, changes) {
    const state = windows.get(id);
    if (!state) return;
    logger.debug(`window ${id} state`, JSON.stringify(changes));
    const current = state.view;
    const before = { ...current, bounds: { ...current.bounds } };

    if (changes.bounds) {
      changes = { ...changes, bounds: normalizeBounds({ ...current.bounds, ...changes.bounds }) };
      state.autoPlaced = false;
    }
    if (changes.visible === false || changes.minimized === true) changes = { ...changes, focused: false };
    Object.assign(current, changes);

    if (current.focused && focusedId !== id) {
      const previous = focusedId;
      focusedId = id;
      focusHistory = [...focusHistory.filter((other) => other !== id), id];
      if (windows.has(previous)) setView(previous, { focused: false });
    } else if (!current.focused && focusedId === id) {
      focusedId = null;
    }

    emitViewEvents(state, before, current);
    notifyView(state);
    if (before.focused && !current.focused && focusedId === null && !changes.focused) refocus(id);
  }

  // When the focused window hides, minimises or closes, focus goes to the window used before it.
  function refocus(except) {
    if (focusedId !== null) return;
    const next = [...focusHistory].reverse().find((id) => {
      const other = windows.get(id);
      return id !== except && other?.view.visible && !other.view.minimized;
    });
    if (next !== undefined) setView(next, { focused: true });
  }

  function center(id) {
    const { width, height } = view(id).bounds;
    setView(id, { bounds: { x: centered(viewport.width, width), y: centered(viewport.height, height) } });
  }

  // The shell reports the tab's size; windows we placed are refitted to it.
  function setViewport(width, height) {
    viewport = { width: Number(width) || viewport.width, height: Number(height) || viewport.height };
    for (const state of windows.values()) if (state.autoPlaced) fitToViewport(state.id);
  }

  // Like Electron on a small screen: shrink to the work area, then centre.
  function fitToViewport(id) {
    const bounds = view(id).bounds;
    const width = Math.min(bounds.width, viewport.width);
    const height = Math.min(bounds.height, viewport.height);
    setView(id, { bounds: { x: centered(viewport.width, width), y: centered(viewport.height, height), width, height } });
    windows.get(id).autoPlaced = true;
  }

  function emitViewEvents(state, before, after) {
    for (const [key, on, off] of VIEW_EVENTS) {
      if (before[key] !== after[key]) emitWindow(state, after[key] ? on : off);
    }
    const a = before.bounds;
    const b = after.bounds;
    if (a.width !== b.width || a.height !== b.height) emitWindow(state, 'resize', 'resized');
    if (a.x !== b.x || a.y !== b.y) emitWindow(state, 'move', 'moved');
  }

  function emitWindow(state, ...names) {
    for (const name of names) {
      try {
        state.win.emit(name, { sender: state.win, preventDefault() {} });
      } catch (err) {
        logger.error(`a '${name}' listener on window ${state.id} threw:`, err);
      }
    }
  }

  // The number people and agents see on a window's badge: the lowest one free when the window
  // first shows, so closing windows frees their numbers. (BrowserWindow.id never repeats.)
  function numberOf(state) {
    if (state.number || !state.view.visible || !state.slot) return state.number ?? null;
    const taken = new Set(all().map((other) => other.number));
    state.number = 1;
    while (taken.has(state.number)) state.number++;
    return state.number;
  }

  // What the shell needs to draw a window's panel.
  function describe(state) {
    const { options } = state;
    return {
      id: state.id,
      number: numberOf(state),
      ...state.view,
      host: state.slot?.host ?? null,
      path: pathFor(state),
      publicPath: publicPathFor(state),
      nav: state.nav,
      modal: Boolean(options.modal && options.parent),
      parentId: options.parent?.id ?? null,
      frame: options.frame !== false,
      resizable: options.resizable !== false,
      minimizable: options.minimizable !== false,
      maximizable: options.maximizable !== false,
      closable: options.closable !== false,
      minWidth: options.minWidth ?? 0,
      minHeight: options.minHeight ?? 0,
    };
  }

  function setTarget(id, url) {
    const state = windows.get(id);
    if (!state) return Promise.resolve();
    const previousSlot = state.slot;
    state.target = new URL(url);
    state.slot = slotFor(state.target);
    logger.info(`window ${logger.c.bold(id)} ${logger.c.dim('→')} ${state.target.href}`);
    // Same origin: the page navigates itself. Otherwise the shell repoints the iframe.
    if (state.slot === previousSlot && state.sockets.size > 0) broadcast(state, { type: 'navigate', path: pathFor(state) });
    else state.nav++;
    notifyView(state);
    // Like Electron, loadURL() settles once the page (here: the browser tab) has loaded.
    return new Promise((resolve) => state.loadWaiters.push(resolve));
  }

  function reload(id) {
    const state = windows.get(id);
    if (!state) return;
    if (state.sockets.size > 0) return broadcast(state, { type: 'reload' });
    state.nav++;
    notifyView(state);
  }

  function print(id) {
    const state = windows.get(id);
    if (state) broadcast(state, { type: 'print' });
  }

  // webContents.send(): a message on `channel` to every tab showing the window.
  function push(id, channel, args) {
    const state = windows.get(id);
    if (!state) return;
    let frame;
    try {
      frame = codec.pack({ type: 'push', channel, args });
    } catch (err) {
      logger.warn(`could not serialize message on '${channel}': ${err.message}`);
      return;
    }
    for (const ws of state.sockets) ws.send(frame);
  }

  function broadcast(state, message) {
    const frame = codec.pack(message);
    for (const ws of state.sockets) ws.send(frame);
  }

  return {
    onChange,
    get,
    all,
    inSlot,
    primary,
    isAlive,
    describe,
    registerWindow,
    view,
    targetOf,
    focusedWindowId,
    setView,
    center,
    setViewport,
    setTarget,
    reload,
    print,
    push,
  };
}

function centered(outer, inner) {
  return Math.max(0, Math.round((outer - inner) / 2));
}

function normalizeBounds({ x, y, width, height }) {
  return { x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

module.exports = { createWindows };
