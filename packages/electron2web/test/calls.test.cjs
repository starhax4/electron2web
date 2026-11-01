'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCalls } = require('../src/calls.cjs');

function fakeSocket() {
  return { OPEN: 1, readyState: 1, sent: [], send(frame) { this.sent.push(frame); } };
}

test('a call waits for a socket, and only its target may answer it', async () => {
  const sockets = { shell: new Set() };
  const calls = createCalls({ socketsFor: (target) => sockets[target] });
  const result = calls.call('shell', 'ping', { n: 1 });

  const ws = fakeSocket();
  sockets.shell.add(ws);
  calls.redeliver('shell');
  const { id, op, payload } = JSON.parse(ws.sent[0]);
  assert.deepEqual({ op, payload }, { op: 'ping', payload: { n: 1 } });

  calls.settle({ id, value: 'wrong' }, 7);
  calls.settle({ id, value: 'pong' }, 'shell');
  assert.equal(await result, 'pong');
});

test('an unanswered call rejects with ETIMEDOUT', async () => {
  const calls = createCalls({ socketsFor: () => null });
  await assert.rejects(calls.call('shell', 'ping', null, { timeout: 10 }), { code: 'ETIMEDOUT' });
});

test('an error result rejects with its name and message', async () => {
  const ws = fakeSocket();
  const calls = createCalls({ socketsFor: () => new Set([ws]) });
  const result = calls.call('shell', 'boom');
  calls.settle({ id: JSON.parse(ws.sent[0]).id, error: { name: 'TypeError', message: 'bad' } }, 'shell');
  await assert.rejects(result, { name: 'TypeError', message: 'bad' });
});
