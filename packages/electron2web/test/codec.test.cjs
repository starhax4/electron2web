'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pack, unpack } = require('../src/codec.cjs');

const roundTrip = (value) => unpack(pack(value));

test('the codec keeps the structured-clone types Electron IPC supports', () => {
  const value = {
    date: new Date('2026-01-02T03:04:05Z'),
    map: new Map([['a', 1]]),
    set: new Set([1, 2]),
    big: 2n ** 70n,
    missing: undefined,
    nested: [{ deep: true }],
  };
  assert.deepEqual(roundTrip(value), value);
});

test('Buffers arrive as Uint8Array, as in Electron', () => {
  const bytes = roundTrip(Buffer.from([1, 2, 3]));
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test('errors and cycles survive', () => {
  const error = roundTrip(new TypeError('boom'));
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'boom');

  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  const copy = roundTrip(cyclic);
  assert.equal(copy.self, copy);
});

test('pack returns a copy, so queued frames are not overwritten', () => {
  const first = pack({ n: 1 });
  pack({ n: 2 });
  assert.deepEqual(unpack(first), { n: 1 });
});
