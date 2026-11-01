'use strict';

// Forwards requests and WebSocket upgrades (e.g. Vite's HMR socket) to the app's dev server.
const http = require('node:http');
const https = require('node:https');
const logger = require('./log.cjs');
const { PREFIX, COOKIE } = require('./constants.cjs');
const { injectLoader } = require('./loader.cjs');
const { send, startBody, allowFraming, rejectUpgrade, stripCookie } = require('./http-util.cjs');

function createProxy() {
  // Dev-server requests reuse connections, and connect straight to the address that worked
  // last time: "localhost" resolves to ::1 first, and a dev server listening on 127.0.0.1
  // only would otherwise cost a failed IPv6 attempt on every new connection.
  const agents = {
    'http:': new http.Agent({ keepAlive: true, maxSockets: 64 }),
    'https:': new https.Agent({ keepAlive: true, maxSockets: 64 }),
  };
  const upstreamAddresses = new Map();

  function upstreamRequest(target, options, onResponse) {
    const client = target.protocol === 'https:' ? https : http;
    const known = upstreamAddresses.get(target.host);
    const request = client.request(
      {
        ...options,
        protocol: target.protocol,
        hostname: known ?? target.hostname,
        servername: target.hostname,
        port: target.port,
        agent: options.agent ?? agents[target.protocol],
      },
      onResponse,
    );
    if (!known) {
      request.once('socket', (socket) => {
        socket.once('connect', () => {
          if (socket.remoteAddress) upstreamAddresses.set(target.host, socket.remoteAddress);
        });
      });
    }
    return request;
  }

  // HTML gets the loader injected and its anti-framing headers dropped; everything else is
  // piped through unchanged.
  function proxyHttp(slot, req, res, retried = false) {
    const target = new URL(slot.origin);
    const headers = upstreamHeaders(req, target);
    delete headers['accept-encoding'];

    const upstream = upstreamRequest(target, { method: req.method, path: req.url, headers }, (upRes) => {
      const isHtml = (upRes.headers['content-type'] ?? '').includes('text/html');
      if (!isHtml) {
        upRes.pipe(startBody(req, res, upRes.statusCode, { ...upRes.headers }));
        return;
      }
      const chunks = [];
      upRes.on('data', (chunk) => chunks.push(chunk));
      upRes.on('end', () => {
        const body = injectLoader(Buffer.concat(chunks).toString('utf8'), slot);
        const outHeaders = allowFraming({ ...upRes.headers });
        delete outHeaders['content-length'];
        startBody(req, res, upRes.statusCode, outHeaders).end(body);
      });
    });
    upstream.on('error', (err) => {
      // A kept-alive connection the dev server closed just as we reused it: send it again on
      // a fresh one (only bodiless requests, whose body isn't already spent).
      const bodiless = req.method === 'GET' || req.method === 'HEAD';
      if (upstream.reusedSocket && bodiless && !retried && !res.headersSent && err.code === 'ECONNRESET') {
        return proxyHttp(slot, req, res, true);
      }
      upstreamAddresses.delete(target.host);
      logger.debug(`proxy ${req.method} ${req.url} → ${target.origin} failed: ${err.message}`);
      if (res.headersSent) return res.destroy();
      send(res, 502, `electron2web could not reach ${target.origin}: ${err.message}`);
    });
    if (retried) upstream.end();
    else req.pipe(upstream);
  }

  function proxyUpgrade(target, req, socket, head) {
    const upstream = upstreamRequest(target, { method: req.method, path: req.url, headers: upstreamHeaders(req, target), agent: false });
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = ['HTTP/1.1 101 Switching Protocols'];
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.on('error', () => socket.destroy());
      socket.on('close', () => upSocket.destroy());
      upSocket.pipe(socket).pipe(upSocket);
    });
    upstream.on('response', (upRes) => {
      upRes.resume();
      rejectUpgrade(socket, upRes.statusCode);
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  }

  return { proxyHttp, proxyUpgrade };
}

// The request's headers as the dev server should see them: addressed to its own origin, and
// without anything that belongs to the bridge (its auth cookie, Referers to its pages).
function upstreamHeaders(req, target) {
  const headers = { ...req.headers, host: target.host };
  if (headers.origin) headers.origin = target.origin;
  if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, target.origin);
  // Never pass on the bridge's own pages (the /auth URL holds the token).
  if (headers.referer?.startsWith(`${target.origin}${PREFIX}`)) delete headers.referer;
  const cookie = stripCookie(headers.cookie, COOKIE);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  return headers;
}

module.exports = { createProxy, upstreamHeaders };
