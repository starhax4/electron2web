'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindows } = require('../src/windows.cjs');
const { createOrigins } = require('../src/origins.cjs');

let nextId = 1;
function fakeWindow() {
  const win = new EventEmitter();
  win.id = nextId++;
  win.isDestroyed = () => false;
  win.events = [];
  const emit = win.emit.bind(win);
  win.emit = (name, ...args) => {
    win.events.push(name);
    return emit(name, ...args);
  };
  return win;
}

function setup(layout = 'desktop') {
  const windows = createWindows({ layout, slotFor: createOrigins({ port: 4400 }).slotFor });
  const messages = [];
  windows.onChange((message) => messages.push(message));
  const open = (options = {}) => {
    const win = fakeWindow();
    windows.registerWindow(win, options, new Map());
    return win;
  };
  return { windows, messages, open };
}

test('a shown window takes focus from the previous one, which blurs', () => {
  const { windows, open } = setup();
  const first = open();
  const second = open();
  assert.equal(windows.focusedWindowId(), second.id);
  assert.equal(windows.view(first.id).focused, false);
  assert.ok(first.events.includes('blur'));
  assert.ok(second.events.includes('focus'));
});

test('hiding or closing the focused window gives focus back to the one used before it', () => {
  const { windows, messages, open } = setup();
  const first = open();
  const second = open();
  windows.setView(second.id, { visible: false });
  assert.equal(windows.focusedWindowId(), first.id);

  windows.setView(second.id, { visible: true, focused: true });
  second.emit('closed');
  assert.equal(windows.focusedWindowId(), first.id);
  assert.deepEqual(messages.at(-2), { type: 'removed', id: second.id });
});

test('only the first desktop window opens maximized', () => {
  const { windows, open } = setup();
  const main = open();
  const child = open({ parent: main });
  assert.equal(windows.view(main.id).maximized, true);
  assert.equal(windows.view(child.id).maximized, false);
  const tabs = setup('tabs');
  assert.equal(tabs.windows.view(tabs.open().id).maximized, false);
});

test('bounds changes fire move and resize, and are rounded', () => {
  const { windows, open } = setup();
  const win = open({ x: 0, y: 0, width: 400, height: 300 });
  win.events.length = 0;
  windows.setView(win.id, { bounds: { x: 10.4, width: 500.6 } });
  assert.deepEqual(windows.view(win.id).bounds, { x: 10, y: 0, width: 501, height: 300 });
  assert.deepEqual(win.events, ['resize', 'resized', 'move', 'moved']);
});

test('badge numbers are the lowest free once a window has a page', () => {
  const { windows, open } = setup();
  const [a, b] = [open(), open()];
  windows.setTarget(a.id, 'http://localhost:5173/');
  windows.setTarget(b.id, 'http://localhost:5173/other');
  assert.deepEqual([a, b].map((win) => windows.describe(windows.get(win.id)).number), [1, 2]);
  a.emit('closed');
  const c = open();
  windows.setTarget(c.id, 'http://localhost:5173/');
  assert.equal(windows.describe(windows.get(c.id)).number, 1);
});
