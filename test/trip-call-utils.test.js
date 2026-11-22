'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createTripCallIceServers } = require('../lib/trip-call-utils');

test('provides STUN fallback when TURN credentials are not configured', () => {
  assert.deepEqual(createTripCallIceServers({ userId: 42 }), [
    { urls: ['stun:stun.l.google.com:19302'] }
  ]);
});

test('builds time-limited coturn shared-secret credentials without exposing the secret', () => {
  const now = 1_800_000_000;
  const secret = 'test-turn-shared-secret';
  const result = createTripCallIceServers({
    turnUrls: ' turn:turn.example.net:3478?transport=udp, turns:turn.example.net:5349?transport=tcp ',
    sharedSecret: secret,
    userId: 42,
    nowSeconds: now
  });

  assert.equal(result.length, 2);
  assert.deepEqual(result[1].urls, [
    'turn:turn.example.net:3478?transport=udp',
    'turns:turn.example.net:5349?transport=tcp'
  ]);
  assert.equal(result[1].username, (now + 12 * 60 * 60) + ':42');
  assert.equal(
    result[1].credential,
    crypto.createHmac('sha1', secret).update(result[1].username).digest('base64')
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('does not enable TURN when either URL list or shared secret is missing', () => {
  assert.equal(createTripCallIceServers({ turnUrls: 'turn:turn.example.net:3478', userId: 7 }).length, 1);
  assert.equal(createTripCallIceServers({ sharedSecret: 'secret', userId: 7 }).length, 1);
});
