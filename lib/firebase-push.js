'use strict';

const crypto = require('crypto');
let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

function loadServiceAccount(raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  if (!raw) return null;
  let account;
  try {
    account = JSON.parse(raw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must be valid JSON');
  }
  if (!account.client_email || !account.private_key || !account.project_id) {
    throw new Error('Firebase service account JSON is missing required fields');
  }
  return account;
}

function createServiceAccountAssertion(account, nowSeconds = Math.floor(Date.now() / 1000)) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: nowSeconds + 3600
  });
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return unsigned + '.' + signer.sign(account.private_key).toString('base64url');
}

async function getFirebaseAccessToken(account, fetchImpl = globalThis.fetch, nowMs = Date.now()) {
  if (cachedAccessToken && cachedAccessTokenExpiresAt > nowMs + 60000) return cachedAccessToken;
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: createServiceAccountAssertion(account, Math.floor(nowMs / 1000))
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) {
    throw new Error('Firebase OAuth token request failed: ' + (result.error_description || result.error || response.status));
  }
  cachedAccessToken = result.access_token;
  cachedAccessTokenExpiresAt = nowMs + Math.max(60, Number(result.expires_in || 3600)) * 1000;
  return cachedAccessToken;
}

async function sendFirebasePush(
  { token, title, body, data = {} },
  { serviceAccount = loadServiceAccount(), fetchImpl = globalThis.fetch } = {}
) {
  if (!serviceAccount) return { configured: false, sent: false, reason: 'firebase_not_configured' };
  const accessToken = await getFirebaseAccessToken(serviceAccount, fetchImpl);
  const safeData = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, String(value)])
  );
  const response = await fetchImpl(
    'https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(serviceAccount.project_id) + '/messages:send',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data: safeData,
          android: {
            priority: 'HIGH',
            notification: {
              channel_id: 'meshwari_updates',
              sound: 'default',
              default_vibrate_timings: true
            }
          }
        }
      })
    }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = result.error?.details?.find(item => item.errorCode)?.errorCode ||
      result.error?.status || 'FCM_ERROR';
    return { configured: true, sent: false, invalidToken: code === 'UNREGISTERED', reason: code };
  }
  return { configured: true, sent: true, messageName: result.name || null };
}

function resetFirebaseTokenCache() {
  cachedAccessToken = null;
  cachedAccessTokenExpiresAt = 0;
}

module.exports = {
  loadServiceAccount,
  createServiceAccountAssertion,
  getFirebaseAccessToken,
  sendFirebasePush,
  resetFirebaseTokenCache
};
