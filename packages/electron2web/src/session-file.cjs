'use strict';

// The ready URLs, for scripts and agents that start electron2web in the background:
// session.json for the latest run, session-<port>.json for each run, so two apps on
// different ports don't hide each other.
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./constants.cjs');

// Returns the path of session.json, or null if it couldn't be written.
function writeSessionFile(session) {
  const body = `${JSON.stringify(session, null, 2)}\n`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, `session-${session.port}.json`), body, { mode: 0o600 });
    fs.writeFileSync(path.join(DATA_DIR, 'session.json'), body, { mode: 0o600 });
    return path.join(DATA_DIR, 'session.json');
  } catch {
    return null;
  }
}

// On quit, remove the files that still describe this process (not a newer run's).
function removeSessionFiles(port) {
  for (const name of [`session-${port}.json`, 'session.json']) {
    const file = path.join(DATA_DIR, name);
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file);
    } catch {}
  }
}

module.exports = { writeSessionFile, removeSessionFiles };
