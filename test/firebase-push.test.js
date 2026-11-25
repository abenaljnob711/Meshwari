'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const {
  loadServiceAccount,
  createServiceAccountAssertion,
  resetFirebaseTokenCache,
  sendFirebasePush
} = require('../lib/firebase-push');

test('rejects malformed Firebase service account JSON', () => {
  assert.throws(() => loadServiceAccount('{bad-json'));
});

test('requires Firebase service account signing fields', () => {
  assert.throws(() => loadServiceAccount(JSON.stringify({ project_id: 'mesh' })));
});

test('creates a verifiable RS256 service-account assertion', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = {
    client_email: 'push@mesh.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: 'mesh-project'
  };
  const token = createServiceAccountAssertion(account, 1800000000);
  const [header, claims, signature] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'RS256');
  const payload = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(payload.iss, account.client_email);
  assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(payload.exp - payload.iat, 3600);
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(header + '.' + claims);
  verifier.end();
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true);
});

test('does not claim to send a push when Firebase is not configured', async () => {
  const result = await sendFirebasePush(
    { token: 'device', title: 'Test', body: 'Test' },
    { serviceAccount: null }
  );
  assert.deepEqual(result, {
    configured: false,
    sent: false,
    reason: 'firebase_not_configured'
  });
});

test('sends a notification through FCM HTTP v1 after obtaining OAuth token', async () => {
  resetFirebaseTokenCache();
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = {
    client_email: 'push@mesh.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: 'mesh-project'
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('oauth2.googleapis.com')) {
      return { ok: true, json: async () => ({ access_token: 'test-access-token', expires_in: 3600 }) };
    }
    return { ok: true, json: async () => ({ name: 'projects/mesh-project/messages/123' }) };
  };
  const result = await sendFirebasePush(
    { token: 'device-token', title: 'Trip', body: 'New trip', data: { tripId: 12 } },
    { serviceAccount: account, fetchImpl }
  );
  assert.equal(result.sent, true);
  assert.equal(calls.length, 2);
  const payload = JSON.parse(calls[1].options.body);
  assert.equal(payload.message.token, 'device-token');
  assert.equal(payload.message.data.tripId, '12');
  assert.equal(payload.message.android.priority, 'HIGH');
});

test('marks only FCM UNREGISTERED responses as invalid device tokens', async () => {
  resetFirebaseTokenCache();
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = {
    client_email: 'push@mesh.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: 'mesh-project'
  };
  const fetchImpl = async url => {
    if (url.includes('oauth2.googleapis.com')) {
      return { ok: true, json: async () => ({ access_token: 'test-access-token', expires_in: 3600 }) };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })
    };
  };
  const result = await sendFirebasePush(
    { token: 'expired-device-token', title: 'Test', body: 'Test' },
    { serviceAccount: account, fetchImpl }
  );
  assert.equal(result.sent, false);
  assert.equal(result.invalidToken, true);
  assert.equal(result.reason, 'UNREGISTERED');
});

test('does not classify generic FCM INVALID_ARGUMENT responses as invalid device tokens', async () => {
  resetFirebaseTokenCache();
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = {
    client_email: 'push@mesh.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: 'mesh-project'
  };
  const fetchImpl = async url => {
    if (url.includes('oauth2.googleapis.com')) {
      return { ok: true, json: async () => ({ access_token: 'test-access-token', expires_in: 3600 }) };
    }
    return { ok: false, status: 400, json: async () => ({ error: { status: 'INVALID_ARGUMENT' } }) };
  };
  const result = await sendFirebasePush(
    { token: 'possibly-valid-device-token', title: 'Test', body: 'Test' },
    { serviceAccount: account, fetchImpl }
  );
  assert.equal(result.sent, false);
  assert.equal(result.invalidToken, false);
  assert.equal(result.reason, 'INVALID_ARGUMENT');
});

test('device-token registration transfers ownership only to the authenticated account', () => {
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const start = server.indexOf("app.post('/api/notifications/devices'");
  const end = server.indexOf("app.delete('/api/notifications/devices'", start);
  const endpoint = server.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(endpoint, /app\.post\('\/api\/notifications\/devices',\s*auth/);
  assert.match(endpoint, /const recipient = notificationRecipient\(req\)/);
  assert.match(endpoint, /ON CONFLICT\(device_token\) DO UPDATE SET[\s\S]*recipient_type=EXCLUDED\.recipient_type[\s\S]*recipient_id=EXCLUDED\.recipient_id/);
  assert.doesNotMatch(endpoint, /return res\.status\(409\)/);
});
