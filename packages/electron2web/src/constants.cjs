'use strict';

const os = require('node:os');
const path = require('node:path');

module.exports = {
  // Every URL the bridge answers itself lives under this prefix; everything else belongs to
  // the app. (The browser-side code in src/client/ repeats it.)
  PREFIX: '/__electron2web',
  COOKIE: 'electron2web_token',
  // Chrome resolves *.localhost to loopback. The shell lives on app.localhost and each page
  // origin the app loads gets its own o<n>.app.localhost. They all share the site
  // "app.localhost", so the SameSite=Strict auth cookie is still sent inside the shell's iframes.
  SHELL_DOMAIN: 'app.localhost',
  DEFAULT_PORT: 4400,
  LAYOUTS: Object.freeze(['desktop', 'tabs', 'single']),
  // The saved token and the session files.
  DATA_DIR: path.join(os.homedir(), '.electron2web'),
};
