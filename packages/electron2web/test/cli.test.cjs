'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

test('--help prints usage and exits 0', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: electron2web/);
});

test('invalid options exit 1 with a reason', () => {
  for (const [args, reason] of [
    [['--port', 'abc'], /Invalid --port/],
    [['--port', '70000'], /Invalid --port/],
    [['--layout', 'grid'], /Invalid --layout/],
    [['--public-host', 'ftp://example.com'], /Invalid --public-host/],
    [['--public-host', 'https://example.com/path'], /Invalid --public-host/],
    [['--bogus'], /Unknown argument: --bogus/],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, reason);
  }
});
