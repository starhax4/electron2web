'use strict';

// Small HTTP helpers for the bridge: responses, caching, compression, cookies and pages.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
};

const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

// The bridge's own responses never send a Referer onward: URLs like /auth?token=… must not
// reach the app's page (document.referrer), its analytics, or its servers.
function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(body);
}

function sendHtml(res, status, body) {
  send(res, status, body, MIME['.html']);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end();
}

// Through a tunnel every byte crosses this machine's upload link, which is often slow, and
// dev bundles are mostly text that gzip shrinks about 5x. So on the public host, compress
// text bodies (the router sets req.ewCompress). Returns the stream to write the body to.
const COMPRESSIBLE = /^(text\/(?!event-stream)|application\/(javascript|json|xml|wasm|manifest\+json)|image\/svg\+xml)|\+(json|xml)\b/i;

function startBody(req, res, status, headers) {
  const compress =
    req.ewCompress &&
    req.method !== 'HEAD' &&
    status !== 204 &&
    status !== 304 &&
    !headers['content-encoding'] &&
    COMPRESSIBLE.test(String(headers['content-type'] ?? '')) &&
    acceptsGzip(req);
  if (!compress) {
    res.writeHead(status, headers);
    return res;
  }
  delete headers['content-length'];
  headers['content-encoding'] = 'gzip';
  headers.vary = headers.vary ? `${headers.vary}, Accept-Encoding` : 'Accept-Encoding';
  res.writeHead(status, headers);
  const gzip = zlib.createGzip();
  gzip.pipe(res);
  return gzip;
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
}

function sendText(req, res, status, body, type) {
  startBody(req, res, status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
}

// Sends a body the browser may keep: it revalidates with If-None-Match and gets a 304 while
// the content is unchanged. `immutable` is for URLs that change whenever their content does.
// Bodies compressed for the public host are kept, so repeat requests skip the gzip work.
const gzipped = new Map();
const GZIP_CACHE_SIZE = 32;

async function sendCached(req, res, body, type, { etag, immutable = false } = {}) {
  etag ??= `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const headers = { etag, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['content-type'] = type;
  if (!req.ewCompress || req.method === 'HEAD' || !acceptsGzip(req)) {
    res.writeHead(200, headers);
    return res.end(body);
  }
  let zipped = gzipped.get(etag);
  if (!zipped) {
    zipped = await new Promise((resolve, reject) => zlib.gzip(body, (err, out) => (err ? reject(err) : resolve(out))));
    gzipped.set(etag, zipped);
    if (gzipped.size > GZIP_CACHE_SIZE) gzipped.delete(gzipped.keys().next().value);
  }
  res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': zipped.length });
  res.end(zipped);
}

function serveStatic(file, req, res) {
  fs.readFile(file, (err, body) => {
    if (err) return send(res, 404, 'Not found');
    sendCached(req, res, body, mimeOf(file));
  });
}

function rejectUpgrade(socket, status) {
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\nConnection: close\r\n\r\n`);
}

const MAX_BODY = 64 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function stripCookie(header, name) {
  if (!header) return '';
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${name}=`))
    .join('; ');
}

// Pages are shown inside the shell's iframes, so drop headers that forbid framing.
function allowFraming(headers) {
  delete headers['x-frame-options'];
  const csp = headers['content-security-policy'];
  if (csp) {
    headers['content-security-policy'] = String(csp)
      .split(';')
      .filter((directive) => !/^\s*frame-ancestors\b/i.test(directive))
      .join(';');
  }
  return headers;
}

// Only a path on the same origin. Parsing (not prefix checks) catches tricks like "/\t/evil.com".
function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  try {
    const base = 'http://same.invalid';
    const url = new URL(value, base);
    return url.origin === base ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// A minimal standalone page for the bridge's own screens (control page, errors).
function page(title, body, refreshSeconds) {
  const refresh = refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : '';
  return `<!doctype html><html><head><meta charset="utf-8">${refresh}<title>${escapeHtml(title)}</title>
<style>body{font:14px system-ui,sans-serif;margin:2rem;color:#222}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.4rem .7rem;text-align:left}code{background:#f2f2f2;padding:0 .3rem}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

module.exports = {
  mimeOf,
  send,
  sendHtml,
  redirect,
  startBody,
  sendText,
  sendCached,
  serveStatic,
  rejectUpgrade,
  readBody,
  readCookie,
  stripCookie,
  allowFraming,
  safeNext,
  escapeHtml,
  page,
};
