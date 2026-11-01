'use strict';

// The HTML pages the bridge serves itself. Pure functions: the router supplies the data.
const { PREFIX } = require('./constants.cjs');
const { escapeHtml, page } = require('./http-util.cjs');

// JSON that is safe inside a <script> element.
const inlineJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

// On the public host the windows share the shell's origin and its cookie, so the shell
// doesn't need the token to authorise them.
function shellPage({ token, layout, isPublic }) {
  const config = inlineJson({ token: isPublic ? null : token, layout, public: isPublic });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>electron2web</title><link rel="stylesheet" href="${PREFIX}/shell.css">
<script id="ew-config" type="application/json">${config}</script><script src="${PREFIX}/shell.js" defer></script>
</head><body class="ew-layout-${layout}"></body></html>`;
}

// Navigates from a page on this origin rather than with a 302: if the request came from
// another site (127.0.0.1 → app.localhost), a redirect would still count as cross-site and
// the browser would hold back the Strict cookie on the next request.
function authRedirectPage(next) {
  return `<!doctype html><meta charset="utf-8"><title>electron2web</title><script>location.replace(${inlineJson(next)})</script>`;
}

// rows: { number, id, title, href, visible, tabs, aloneUrl, localOnly } per window. aloneUrl
// opens the window on its own; localOnly marks one this host can't serve.
function controlPage({ appUrl, rows }) {
  const body = rows
    .map((row) => {
      const target = row.href ? escapeHtml(row.href) : '<em>not loaded</em>';
      const link = row.aloneUrl ? `<a href="${escapeHtml(row.aloneUrl)}">open alone</a>` : row.localOnly ? 'local only' : '';
      return `<tr><td>${row.number ?? '–'}</td><td>${row.id}</td><td>${escapeHtml(row.title)}</td><td>${target}</td><td>${row.visible ? 'yes' : 'no'}</td><td>${row.tabs}</td><td>${link}</td></tr>`;
    })
    .join('');
  return page(
    'electron2web',
    `<p><a href="${escapeHtml(appUrl)}">Open the app (all windows)</a></p>
<table><thead><tr><th>Window</th><th>BrowserWindow.id</th><th>Title</th><th>Loads</th><th>Visible</th><th>Tabs</th><th></th></tr></thead><tbody>${body || '<tr><td colspan="7">No windows yet.</td></tr>'}</tbody></table>`,
    3,
  );
}

function notAuthorizedPage() {
  return page('Not authorized', '<p>Open the URL that <code>electron2web</code> printed in your terminal.</p>');
}

function waitingPage() {
  return page('Waiting for the app', '<p>No Electron window has loaded a page yet. This tab refreshes automatically.</p>', 1);
}

function unreachablePage({ origin, servedOrigin }) {
  return page(
    'Not available over the public host',
    `<p>This window loads <code>${escapeHtml(origin ?? '')}</code>. Through <code>--public-host</code> only one
http(s) origin can be served (here <code>${escapeHtml(servedOrigin ?? '')}</code>), plus <code>loadFile()</code> pages.
Open it on this machine instead, with the Open link electron2web printed in its terminal.</p>`,
  );
}

module.exports = { shellPage, authRedirectPage, controlPage, notAuthorizedPage, waitingPage, unreachablePage };
