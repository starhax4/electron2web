'use strict';

const { PREFIX } = require('./constants.cjs');

// Browser code: stringified into loader.js, which runs first in every page served for a
// window. Works out which window this frame belongs to, then loads that window's runtime and
// preload ahead of the page's own scripts. The shell names each iframe `__ew:<id>`; a plain tab
// uses ?__ew_win=<id>.
function loader(ids, prefix, runtime) {
  const fromName = /^__ew:(\d+)$/.exec(window.name)?.[1];
  // Electron runs preloads in the main frame only, so skip the page's own same-origin subframes.
  // (On the public host the shell shares the page's origin; its frames are the named ones.)
  try {
    if (!fromName && window.parent !== window && window.parent.location.host === location.host) return;
  } catch {}
  const fromQuery = new URLSearchParams(location.search).get('__ew_win');
  // An explicit ?__ew_win wins: window.name survives navigations within the same tab.
  const id = [fromQuery, fromName].map(Number).find((n) => ids.includes(n)) ?? ids[0];
  if (id === undefined) return console.error('[electron2web] no Electron window is loading this page');
  window.name = `__ew:${id}`;
  // eslint-disable-next-line no-useless-escape -- `<\/script>` keeps the source safe to inline in HTML
  document.write(`<script src="${prefix}/boot.js?win=${id}"><\/script><script src="${runtime}"><\/script><script src="${prefix}/preload.js?win=${id}"><\/script>`);
}

// The body of loader.js for the windows `ids` of one slot.
function loaderScript(ids, runtimeUrl) {
  return `(${loader})(${JSON.stringify(ids)}, ${JSON.stringify(PREFIX)}, ${JSON.stringify(runtimeUrl)});`;
}

// Adds the loader as the first script in the page's <head>. It is an external script, so a
// `script-src 'self'` CSP still allows it.
function injectLoader(html, slot) {
  const tag = `<script src="${PREFIX}/loader.js?slot=${slot.number}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) return tag + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + tag + html.slice(at);
}

module.exports = { loaderScript, injectLoader };
