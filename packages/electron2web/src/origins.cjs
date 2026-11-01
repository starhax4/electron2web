'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const logger = require('./log.cjs');
const { PREFIX, SHELL_DOMAIN } = require('./constants.cjs');

// Maps the app's page origins onto browser origins the bridge serves, and tells which of
// them a request was addressed to.
//
// Locally, each page origin the app loads (or each folder, for file:// pages) gets its own
// o<n>.app.localhost origin, so windows on the same origin share localStorage and cookies, as
// they do in Electron.
//
// --public-host is the address a tunnel or reverse proxy (cloudflared, ngrok, nginx, ...)
// serves the bridge on. A tunnel gives one hostname, so there the first http(s) origin is
// served at the root (dev servers use absolute paths) and loadFile() folders under
// PREFIX/s<n> (their builds use relative paths). Any further http(s) origin has no place
// there; its windows stay local-only.
function createOrigins({ port, publicUrl }) {
  const shellHost = `${SHELL_DOMAIN}:${port}`;
  const legacyHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const publicOrigin = publicUrl ? new URL(publicUrl).origin : null;
  const publicHost = publicOrigin ? new URL(publicOrigin).host : null;
  const publicDefaultPort = publicOrigin?.startsWith('https:') ? '443' : '80';

  const slots = new Map();
  const slotsByNumber = new Map();
  let rootSlot = null;

  function slotFor(target) {
    const root = target.protocol === 'file:' ? path.dirname(fileURLToPath(target)) : null;
    const key = root ? `file:${root}` : target.origin;
    let slot = slots.get(key);
    if (!slot) {
      const number = slots.size + 1;
      const isHttp = target.protocol === 'http:' || target.protocol === 'https:';
      const publicBase = root ? `${PREFIX}/s${number}` : isHttp && !rootSlot ? '' : null;
      slot = { number, root, origin: root ? null : target.origin, protocol: target.protocol, host: `o${number}.${SHELL_DOMAIN}:${port}`, publicBase };
      if (publicBase === '') rootSlot = slot;
      slots.set(key, slot);
      slotsByNumber.set(number, slot);
    }
    return slot;
  }

  function isPublicHost(host) {
    return publicHost !== null && (host === publicHost || host === `${publicHost}:${publicDefaultPort}`);
  }

  // Returns { kind: 'shell' | 'public' | 'legacy' | 'slot', slot? }, or null for a Host the
  // bridge doesn't serve. Checking Host is what blocks DNS-rebinding pages.
  function classifyHost(req) {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (host === shellHost) return { kind: 'shell' };
    if (isPublicHost(host)) return { kind: 'public' };
    if (legacyHosts.has(host)) {
      // A proxy that rewrites Host to the upstream address (nginx's default) still names the
      // public host here. Only local processes can reach this address, and a page can't set
      // the header cross-origin without a CORS preflight, which the bridge never grants.
      const forwarded = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim().toLowerCase();
      if (isPublicHost(forwarded)) return { kind: 'public' };
      if (req.headers['x-forwarded-for']) hintOnce('proxied', `a request came through a proxy as ${host}. To use electron2web through a tunnel or proxy, start it with --public-host <its public URL>.`);
      return { kind: 'legacy' };
    }
    const sub = host.endsWith(`.${shellHost}`) ? /^o(\d+)$/.exec(host.slice(0, -shellHost.length - 1)) : null;
    const slot = sub ? slotsByNumber.get(Number(sub[1])) : null;
    if (slot) return { kind: 'slot', slot };
    if (req.headers['x-forwarded-for']) hintOnce(`host:${host}`, `refused a proxied request for host '${host}'. If that is your tunnel, restart with --public-host https://${host}`);
    return null;
  }

  const hinted = new Set();
  function hintOnce(key, message) {
    if (hinted.has(key)) return;
    hinted.add(key);
    logger.warn(message);
  }

  return {
    shellHost,
    publicOrigin,
    slotFor,
    slotByNumber: (number) => slotsByNumber.get(number),
    rootSlot: () => rootSlot,
    classifyHost,
  };
}

// The path a window loads inside its slot's origin.
function pathFor(state) {
  const target = state.target;
  if (!target) return '/';
  if (target.protocol !== 'file:') return target.pathname + target.search + target.hash;
  const relative = path.relative(state.slot.root, fileURLToPath(target)).split(path.sep).map(encodeURIComponent).join('/');
  return `/${relative}${target.search}${target.hash}`;
}

// The path a window loads on the public host, or null when its origin can't be served there.
function publicPathFor(state) {
  const base = state.slot?.publicBase;
  return base == null ? null : base + pathFor(state);
}

module.exports = { createOrigins, pathFor, publicPathFor };
