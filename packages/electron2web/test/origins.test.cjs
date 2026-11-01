'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createOrigins, pathFor, publicPathFor } = require('../src/origins.cjs');

const request = (host, headers = {}) => ({ headers: { host, ...headers } });

test('classifyHost accepts the shell and legacy loopback hosts on its own port', () => {
  const { classifyHost } = createOrigins({ port: 4400 });
  assert.deepEqual(classifyHost(request('app.localhost:4400')), { kind: 'shell' });
  assert.deepEqual(classifyHost(request('APP.localhost:4400')), { kind: 'shell' });
  assert.deepEqual(classifyHost(request('127.0.0.1:4400')), { kind: 'legacy' });
  assert.deepEqual(classifyHost(request('localhost:4400')), { kind: 'legacy' });
});

test('classifyHost refuses foreign hosts (DNS rebinding) and other ports', () => {
  const { classifyHost } = createOrigins({ port: 4400 });
  assert.equal(classifyHost(request('evil.example')), null);
  assert.equal(classifyHost(request('app.localhost:4401')), null);
  assert.equal(classifyHost(request('127.0.0.1:80')), null);
  assert.equal(classifyHost(request(undefined)), null);
});

test('classifyHost only accepts slot subdomains that exist', () => {
  const { classifyHost, slotFor } = createOrigins({ port: 4400 });
  assert.equal(classifyHost(request('o1.app.localhost:4400')), null);
  const slot = slotFor(new URL('http://localhost:5173/'));
  assert.deepEqual(classifyHost(request('o1.app.localhost:4400')), { kind: 'slot', slot });
  assert.equal(classifyHost(request('o1.app.localhost:9999')), null);
  assert.equal(classifyHost(request('o2.app.localhost:4400')), null);
  assert.equal(classifyHost(request('x.o1.app.localhost:4400')), null);
  assert.equal(classifyHost(request('.app.localhost:4400')), null);
});

test('classifyHost recognises the public host, with or without its default port', () => {
  const { classifyHost } = createOrigins({ port: 4400, publicUrl: 'https://abc.trycloudflare.com' });
  assert.deepEqual(classifyHost(request('abc.trycloudflare.com')), { kind: 'public' });
  assert.deepEqual(classifyHost(request('abc.trycloudflare.com:443')), { kind: 'public' });
  assert.equal(classifyHost(request('abc.trycloudflare.com:80')), null);
  assert.equal(classifyHost(request('xyz.trycloudflare.com')), null);
});

test('X-Forwarded-Host names the public host only on loopback addresses', () => {
  const { classifyHost } = createOrigins({ port: 4400, publicUrl: 'https://abc.trycloudflare.com' });
  const forwarded = { 'x-forwarded-host': 'abc.trycloudflare.com' };
  assert.deepEqual(classifyHost(request('127.0.0.1:4400', forwarded)), { kind: 'public' });
  assert.equal(classifyHost(request('evil.example', forwarded)), null);
  assert.deepEqual(classifyHost(request('127.0.0.1:4400', { 'x-forwarded-host': 'evil.example' })), { kind: 'legacy' });
});

test('slotFor gives one slot per page origin, and per folder for file:// pages', () => {
  const { slotFor } = createOrigins({ port: 4400 });
  const dev = slotFor(new URL('http://localhost:5173/index.html'));
  assert.equal(slotFor(new URL('http://localhost:5173/other.html')), dev);
  assert.equal(dev.host, 'o1.app.localhost:4400');

  const dir = path.resolve('build');
  const file = slotFor(pathToFileURL(path.join(dir, 'index.html')));
  assert.notEqual(file, dev);
  assert.equal(file.root, dir);
  assert.equal(slotFor(pathToFileURL(path.join(dir, 'about.html'))), file);
});

test('on the public host the first http origin is served at the root, file folders under /s<n>', () => {
  const { slotFor, rootSlot } = createOrigins({ port: 4400, publicUrl: 'https://abc.trycloudflare.com' });
  const first = slotFor(new URL('http://localhost:5173/'));
  const second = slotFor(new URL('http://localhost:3000/'));
  const file = slotFor(pathToFileURL(path.resolve('build', 'index.html')));
  assert.equal(rootSlot(), first);
  assert.equal(first.publicBase, '');
  assert.equal(second.publicBase, null);
  assert.equal(file.publicBase, `/__electron2web/s${file.number}`);
});

test('pathFor and publicPathFor locate a window inside its slot', () => {
  const { slotFor } = createOrigins({ port: 4400 });
  const web = { target: new URL('http://localhost:5173/app/?q=1#top') };
  web.slot = slotFor(web.target);
  assert.equal(pathFor(web), '/app/?q=1#top');
  assert.equal(publicPathFor(web), '/app/?q=1#top');

  const target = pathToFileURL(path.resolve('build', 'sub dir', 'page.html'));
  target.hash = 'x';
  const file = { target, slot: slotFor(pathToFileURL(path.resolve('build', 'index.html'))) };
  assert.equal(pathFor(file), '/sub%20dir/page.html#x');

  assert.equal(pathFor({ target: null }), '/');
  assert.equal(publicPathFor({ target: null, slot: null }), null);
});
