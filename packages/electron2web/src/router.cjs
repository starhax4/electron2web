'use strict';

// The bridge's HTTP and WebSocket routing. Every request passes the Host check (which blocks
// DNS-rebinding pages) and the auth cookie; state-changing ones also pass an Origin check.
// Then it is the shell, a bridge endpoint, a loadFile() folder, or the app's dev server.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { timingSafeEqual } = require('node:crypto');
const { WebSocketServer } = require('ws');
const codec = require('./codec.cjs');
const logger = require('./log.cjs');
const { getRuntime, getPreload, getSourceMap } = require('./bundler.cjs');
const { PREFIX, COOKIE } = require('./constants.cjs');
const { pathFor, publicPathFor } = require('./origins.cjs');
const { loaderScript, injectLoader } = require('./loader.cjs');
const pages = require('./pages.cjs');
const { mimeOf, send, sendHtml, redirect, startBody, sendText, sendCached, serveStatic, rejectUpgrade, readBody, readCookie, safeNext } = require('./http-util.cjs');

const CLIENT_DIR = path.join(__dirname, 'client');
const SHELL_ASSETS = new Set([`${PREFIX}/shell.js`, `${PREFIX}/shell.css`]);
// Endpoints a window's page calls with ?win=<id>.
const WINDOW_ENDPOINTS = new Set(['boot.js', 'preload.js', 'sync', 'exec'].map((name) => `${PREFIX}/${name}`));
// Bridge paths that carry a parameter.
const FILE_SLOT_PATH = new RegExp(`^${PREFIX}/s(\\d+)(/.*)$`);
const RUNTIME_PATH = new RegExp(`^${PREFIX}/runtime\\.(\\w+)\\.js$`);
const SOURCE_MAP_PATH = new RegExp(`^${PREFIX}/map/(\\w+)\\.js\\.map$`);

function createRouter({ token, layout, authUrl, origins, proxy, windows, calls, ipc, shell }) {
  const { shellHost, publicOrigin, slotByNumber, rootSlot, classifyHost } = origins;
  const tokenBuffer = Buffer.from(token);
  const wss = new WebSocketServer({ noServer: true });
  // Through a tunnel, IPC replies cross a slow upload link; compress the larger frames there.
  // (Locally, compression would only add latency.)
  const wssPublic = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } });
  const socketServerFor = (host) => (host.kind === 'public' ? wssPublic : wss);

  // ---------------------------------------------------------------- auth

  function tokenMatches(value) {
    if (!value) return false;
    const candidate = Buffer.from(value);
    return candidate.length === tokenBuffer.length && timingSafeEqual(candidate, tokenBuffer);
  }

  // Requests that change state must come from the page's own origin.
  function sameOrigin(req, host) {
    const expected = host.kind === 'public' ? publicOrigin : `http://${String(req.headers.host).toLowerCase()}`;
    return req.headers.origin === expected;
  }

  // Whether a window's page may talk to the bridge from this host: on an o<n> host only that
  // slot's windows; on the public host (one origin for all) any window served there.
  function windowAllowed(host, state) {
    if (!state?.slot) return false;
    return host.kind === 'public' ? state.slot.publicBase != null : state.slot === host.slot;
  }

  // ---------------------------------------------------------------- HTTP

  async function handleRequest(req, res) {
    const host = classifyHost(req);
    if (!host) return send(res, 403, 'Forbidden host. To reach electron2web through a tunnel or proxy, start it with --public-host <its URL>.');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const isPublic = host.kind === 'public';

    if (url.pathname === `${PREFIX}/auth`) {
      if (!tokenMatches(url.searchParams.get('token'))) return send(res, 401, 'Invalid token');
      // No cookie on 127.0.0.1/localhost: cookies ignore ports, so every local server would get it.
      if (host.kind === 'legacy') return redirect(res, authUrl(shellHost, '/'));
      const secure = isPublic && publicOrigin.startsWith('https:') ? '; Secure' : '';
      res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${secure}`);
      return sendHtml(res, 200, pages.authRedirectPage(safeNext(url.searchParams.get('next'))));
    }

    if (!tokenMatches(readCookie(req, COOKIE))) return sendHtml(res, 401, pages.notAuthorizedPage());

    // Not on the app's own origins: its links carry the token, and the app's scripts could read them.
    if ((url.pathname === PREFIX || url.pathname === `${PREFIX}/`) && host.kind !== 'slot') {
      return sendHtml(res, 200, controlPage(isPublic));
    }
    if (url.pathname === `${PREFIX}/ping`) return send(res, 200, 'ok');
    if (url.pathname === `${PREFIX}/state`) return send(res, 200, JSON.stringify(stateJson(), null, 2), 'application/json');

    if (isPublic) return handlePublic(host, req, url, res);
    if (host.kind === 'slot') return handleSlot(host.slot, host, req, url, res);

    // `/?__ew_win=<id>` shows that one window on its own, without the shell.
    const requested = windows.get(Number(url.searchParams.get('__ew_win')));
    if (requested?.slot) return redirect(res, authUrl(requested.slot.host, pathFor(requested)));
    // Old bookmarks (127.0.0.1 / localhost) move to the shell.
    if (host.kind === 'legacy') return redirect(res, authUrl(shellHost, '/'));

    if (url.pathname === '/') {
      if (layout !== 'single') return sendHtml(res, 200, pages.shellPage({ token, layout, isPublic: false }));
      const state = windows.primary();
      if (state) return redirect(res, authUrl(state.slot.host, pathFor(state)));
      return sendHtml(res, 503, pages.waitingPage());
    }
    if (SHELL_ASSETS.has(url.pathname)) return serveStatic(path.join(CLIENT_DIR, path.basename(url.pathname)), req, res);
    return send(res, 404, 'Not found');
  }

  // The public host: the shell lives at PREFIX/app, loadFile() folders at PREFIX/s<n>/, and
  // everything else belongs to the root slot (the app's dev server).
  async function handlePublic(host, req, url, res) {
    const pathname = url.pathname;
    req.ewCompress = true;
    if (pathname === `${PREFIX}/app`) {
      if (layout !== 'single') return sendHtml(res, 200, pages.shellPage({ token, layout, isPublic: true }));
      const state = windows.primary();
      if (!state) return sendHtml(res, 503, pages.waitingPage());
      const target = publicPathFor(state);
      return target ? redirect(res, target) : sendHtml(res, 200, unreachablePage(state));
    }
    if (SHELL_ASSETS.has(pathname)) return serveStatic(path.join(CLIENT_DIR, path.basename(pathname)), req, res);
    if (pathname === `${PREFIX}/unreachable`) {
      const state = windows.get(Number(url.searchParams.get('win')));
      return state ? sendHtml(res, 200, unreachablePage(state)) : send(res, 404, 'Not found');
    }
    const fileSlot = FILE_SLOT_PATH.exec(pathname);
    if (fileSlot) {
      const slot = slotByNumber(Number(fileSlot[1]));
      return slot?.root ? serveFile(slot, req, fileSlot[2], res) : send(res, 404, 'Not found');
    }
    if (pathname.startsWith(`${PREFIX}/`)) return handleEndpoint(host, req, url, res);
    if (!rootSlot()) return send(res, 404, 'Not found');
    return proxy.proxyHttp(rootSlot(), req, res);
  }

  async function handleSlot(slot, host, req, url, res) {
    if (url.pathname.startsWith(`${PREFIX}/`)) return handleEndpoint(host, req, url, res);
    if (slot.protocol === 'file:') return serveFile(slot, req, url.pathname, res);
    if (slot.protocol === 'http:' || slot.protocol === 'https:') return proxy.proxyHttp(slot, req, res);
    return send(res, 501, `electron2web cannot serve ${slot.protocol} URLs yet`);
  }

  // Endpoints a window's page calls. On the public host every slot shares one origin, so
  // loader.js learns its slot from the query rather than the host.
  async function handleEndpoint(host, req, url, res) {
    if (url.pathname === `${PREFIX}/loader.js`) {
      const slot = host.kind === 'slot' ? host.slot : slotByNumber(Number(url.searchParams.get('slot')));
      const ids = slot ? windows.inSlot(slot).map((state) => state.id) : [];
      const runtime = `${PREFIX}/runtime.${(await getRuntime()).hash}.js`;
      return send(res, 200, loaderScript(ids, runtime), 'text/javascript');
    }
    // The runtime's URL carries its hash, so the browser keeps it for good.
    const runtimeFile = RUNTIME_PATH.exec(url.pathname);
    if (runtimeFile) {
      const runtime = await getRuntime();
      if (runtime.hash !== runtimeFile[1]) return send(res, 404, 'Not found');
      return sendCached(req, res, runtime.code, 'text/javascript; charset=utf-8', { etag: `"${runtime.hash}"`, immutable: true });
    }
    const mapFile = SOURCE_MAP_PATH.exec(url.pathname);
    if (mapFile) {
      const map = getSourceMap(mapFile[1]);
      return map ? sendCached(req, res, map, 'application/json; charset=utf-8', { etag: `"${mapFile[1]}"`, immutable: true }) : send(res, 404, 'Not found');
    }

    if (!WINDOW_ENDPOINTS.has(url.pathname)) return send(res, 404, 'Not found');
    const state = windows.get(Number(url.searchParams.get('win')));
    if (!windowAllowed(host, state)) {
      if (url.pathname === `${PREFIX}/sync`) return send(res, 410, 'the window was closed');
      return send(res, 404, `console.error('[electron2web] unknown window');`, 'text/javascript');
    }
    if (url.pathname === `${PREFIX}/boot.js`) {
      const base = host.kind === 'public' ? state.slot.publicBase : '';
      return sendCached(req, res, `globalThis.__ELECTRON2WEB__ = ${JSON.stringify(bootConfig(state, base))};\n`, 'text/javascript; charset=utf-8');
    }
    if (url.pathname === `${PREFIX}/preload.js`) {
      // Rebuilt only when one of its source files changed; otherwise the browser gets a 304.
      const preload = await getPreload(state.options.webPreferences?.preload);
      return sendCached(req, res, preload.code, 'text/javascript; charset=utf-8', { etag: `"${preload.hash}"` });
    }
    if (url.pathname === `${PREFIX}/exec`) {
      const script = calls.execScript(url.searchParams.get('key'));
      return script ? send(res, 200, script, 'text/javascript') : send(res, 404, 'Not found');
    }
    if (req.method !== 'POST' || !sameOrigin(req, host)) return send(res, 403, 'Forbidden');
    return handleSync(state, req, res);
  }

  // ipcRenderer.sendSync() posts here and blocks the page until the reply.
  async function handleSync(state, req, res) {
    if (!windows.isAlive(state)) return send(res, 410, 'The window was closed');
    const value = ipc.sendSync(state, codec.unpack(await readBody(req)));
    send(res, 200, Buffer.from(codec.pack({ value })).toString('base64'), 'text/plain');
  }

  // base: the path the window's slot is served under in this tab ('' except for loadFile()
  // folders on the public host), so navigations from main land in the right place.
  function bootConfig(state, base) {
    const prefs = state.options.webPreferences ?? {};
    return {
      winId: state.id,
      base,
      contextIsolated: prefs.contextIsolation !== false,
      sandboxed: prefs.sandbox ?? !prefs.nodeIntegration,
      platform: process.platform,
      versions: {
        node: process.versions.node,
        chrome: process.versions.chrome,
        electron: process.versions.electron,
        v8: process.versions.v8,
      },
    };
  }

  function serveFile(slot, req, pathname, res) {
    const root = slot.root;
    let relative = decodeURIComponent(pathname.slice(1));
    if (relative === '') {
      const first = windows.inSlot(slot)[0];
      if (!first) return send(res, 404, 'Not found');
      relative = path.relative(root, fileURLToPath(first.target));
    }
    const file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden path');

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return send(res, 404, 'Not found');
      const type = mimeOf(file);
      if (type.startsWith('text/html')) {
        return fs.readFile(file, 'utf8', (readErr, html) => {
          if (readErr) return send(res, 500, readErr.message);
          sendText(req, res, 200, injectLoader(html, slot), type);
        });
      }
      const etag = `W/"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'no-cache' });
        return res.end();
      }
      fs.createReadStream(file).pipe(startBody(req, res, 200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-cache', etag }));
    });
  }

  // ---------------------------------------------------------------- pages

  // Machine-readable view of every window, for tests and browser agents.
  function stateJson() {
    const focusedId = windows.focusedWindowId();
    return {
      layout,
      focusedWindowId: focusedId,
      focusedWindowNumber: windows.get(focusedId)?.number ?? null,
      windows: windows.all().map((state) => ({ ...windows.describe(state), url: state.target?.href ?? null })),
    };
  }

  function controlPage(isPublic) {
    const aloneUrl = (state) => {
      if (!isPublic) return authUrl(state.slot.host, pathFor(state));
      const target = publicPathFor(state);
      if (target === null) return null;
      const url = new URL(target, publicOrigin);
      url.searchParams.set('__ew_win', String(state.id));
      return url.pathname + url.search + url.hash;
    };
    const rows = windows.all().map((state) => {
      const alone = state.slot ? aloneUrl(state) : null;
      return {
        number: state.number,
        id: state.id,
        title: state.view.title || state.win.getTitle(),
        href: state.target?.href ?? null,
        visible: state.view.visible,
        tabs: state.sockets.size,
        aloneUrl: alone,
        localOnly: Boolean(state.slot) && !alone,
      };
    });
    return pages.controlPage({ appUrl: isPublic ? `${PREFIX}/app` : authUrl(shellHost, '/'), rows });
  }

  function unreachablePage(state) {
    return pages.unreachablePage({ origin: state.target?.origin, servedOrigin: rootSlot()?.origin });
  }

  // ---------------------------------------------------------------- WebSocket upgrades

  function handleUpgrade(req, socket, head) {
    socket.on('error', () => socket.destroy());
    // A throw here (a malformed URL, say) would reach Electron as an uncaught exception.
    try {
      upgrade(req, socket, head);
    } catch (err) {
      logger.error(`upgrade ${req.url} failed:`, err);
      socket.destroy();
    }
  }

  function upgrade(req, socket, head) {
    const host = classifyHost(req);
    if (!host) return rejectUpgrade(socket, 403);
    if (!tokenMatches(readCookie(req, COOKIE))) return rejectUpgrade(socket, 401);
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Browsers don't apply CORS to WebSockets; the Origin check is what keeps other sites out.
    if ((host.kind === 'shell' || host.kind === 'public') && url.pathname === `${PREFIX}/shell`) {
      if (!sameOrigin(req, host)) return rejectUpgrade(socket, 403);
      return socketServerFor(host).handleUpgrade(req, socket, head, shell.attach);
    }
    if (host.kind !== 'slot' && host.kind !== 'public') return rejectUpgrade(socket, 404);

    if (url.pathname === `${PREFIX}/ipc`) {
      if (!sameOrigin(req, host)) return rejectUpgrade(socket, 403);
      const state = windows.get(Number(url.searchParams.get('win')));
      if (!windowAllowed(host, state)) return rejectUpgrade(socket, 404);
      return socketServerFor(host).handleUpgrade(req, socket, head, (ws) => ipc.attach(state, ws));
    }

    // Anything else (e.g. Vite's HMR socket) goes to the dev server.
    const slot = host.kind === 'slot' ? host.slot : rootSlot();
    if (!slot?.origin) return rejectUpgrade(socket, 404);
    proxy.proxyUpgrade(new URL(slot.origin), req, socket, head);
  }

  function closeSockets() {
    for (const client of [...wss.clients, ...wssPublic.clients]) client.terminate();
  }

  return { handleRequest, handleUpgrade, closeSockets };
}

module.exports = { createRouter };
