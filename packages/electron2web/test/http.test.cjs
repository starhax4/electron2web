'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeNext, readCookie, stripCookie, allowFraming, escapeHtml } = require('../src/http-util.cjs');
const { upstreamHeaders } = require('../src/proxy.cjs');
const { injectLoader } = require('../src/loader.cjs');

test('safeNext keeps same-origin paths and rejects everything else', () => {
  assert.equal(safeNext('/app/?a=1#b'), '/app/?a=1#b');
  for (const value of ['//evil.com', '/\\evil.com', '/\t/evil.com', 'https://evil.com', 'evil', '', null, undefined]) {
    assert.equal(safeNext(value), '/', String(value));
  }
});

test('readCookie and stripCookie handle one cookie among several', () => {
  const req = { headers: { cookie: 'a=1; electron2web_token=abc=def; b=2' } };
  assert.equal(readCookie(req, 'electron2web_token'), 'abc=def');
  assert.equal(readCookie(req, 'missing'), null);
  assert.equal(readCookie({ headers: {} }, 'a'), null);
  assert.equal(stripCookie(req.headers.cookie, 'electron2web_token'), 'a=1; b=2');
  assert.equal(stripCookie('electron2web_token=x', 'electron2web_token'), '');
  assert.equal(stripCookie(undefined, 'electron2web_token'), '');
});

test('allowFraming drops X-Frame-Options and frame-ancestors only', () => {
  const headers = allowFraming({
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
  });
  assert.equal(headers['x-frame-options'], undefined);
  assert.equal(headers['content-security-policy'], "default-src 'self'; script-src 'self'");
});

test('escapeHtml escapes markup and quotes', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&#60;a href=&#34;x&#34;&#62;&#39;&#38;&#39;&#60;/a&#62;');
});

test('upstreamHeaders readdresses the request and hides the bridge from the dev server', () => {
  const target = new URL('http://localhost:5173');
  const headers = upstreamHeaders(
    {
      headers: {
        host: 'o1.app.localhost:4400',
        origin: 'http://o1.app.localhost:4400',
        referer: 'http://o1.app.localhost:4400/page',
        cookie: 'electron2web_token=secret; app=1',
      },
    },
    target,
  );
  assert.equal(headers.host, 'localhost:5173');
  assert.equal(headers.origin, 'http://localhost:5173');
  assert.equal(headers.referer, 'http://localhost:5173/page');
  assert.equal(headers.cookie, 'app=1');

  const fromAuth = upstreamHeaders({ headers: { referer: 'http://o1.app.localhost:4400/__electron2web/auth?token=secret', cookie: 'electron2web_token=secret' } }, target);
  assert.equal(fromAuth.referer, undefined);
  assert.equal(fromAuth.cookie, undefined);
});

test('injectLoader puts the loader first in <head>', () => {
  const slot = { number: 3 };
  const tag = '<script src="/__electron2web/loader.js?slot=3"></script>';
  assert.equal(injectLoader('<html><head lang="en"><title>x</title></head></html>', slot), `<html><head lang="en">${tag}<title>x</title></head></html>`);
  assert.equal(injectLoader('<p>no head</p>', slot), `${tag}<p>no head</p>`);
  assert.equal(injectLoader('<header>x</header>', slot), `${tag}<header>x</header>`);
});
