'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync(require.resolve('../' + path), 'utf8');
const client = read('public/index.html');
const workflow = read('.github/workflows/build-apk.yml');
const server = read('server.js');

test('the shared passenger/driver client registers native FCM after authenticated home rendering', () => {
  assert.match(client, /async function registerMeshwariPush\(\)/);
  assert.match(client, /if\(!push\|\|!token\|\|!account\)return/);
  assert.match(client, /push\.addListener\('registration',[\s\S]*?api\('\/notifications\/devices',[\s\S]*?'POST'\)/);
  assert.match(client, /async function startMeshwariNotifications\(\)[\s\S]*?registerMeshwariPush\(\)/);
  assert.match(client, /startMeshwariNotifications\(\)/);
  assert.match(client, /const APP_VARIANT='all'/);
  assert.match(client, /APP_VARIANT==='passenger'\|\|APP_VARIANT==='driver'/);
});

test('the APK workflow builds a native push bundle for both passenger and driver APKs', () => {
  assert.match(workflow, /@capacitor\/push-notifications/);
  assert.match(workflow, /npx esbuild push-entry\.js --bundle --format=iife --outfile=public\/push-bundle\.js/);
  assert.match(workflow, /npx esbuild push-entry\.js --bundle --format=iife --outfile=driver-build\/push-bundle\.js/);
  assert.match(workflow, /FIREBASE_GOOGLE_SERVICES_PASSENGER_BASE64/);
  assert.match(workflow, /FIREBASE_GOOGLE_SERVICES_DRIVER_BASE64/);
  assert.match(workflow, /build\/\$app\/android\/app\/google-services\.json/);
});

test('admin APK deliberately excludes the native push bundle while passenger and driver retain it', () => {
  assert.match(workflow, /Admin push bundle must be disabled in diagnostic build/);
  assert.match(workflow, /html = html\.replace\('<script src="push-bundle\.js"><\/script>', ''\)/);
  assert.match(workflow, /Create passenger Android project[\s\S]*?push-bundle\.js/);
  assert.match(workflow, /Create driver Android project[\s\S]*?push-bundle\.js/);
});

test('device registration and notification inbox are authenticated server endpoints', () => {
  assert.match(server, /app\.post\('\/api\/notifications\/devices',\s*auth/);
  assert.match(server, /app\.delete\('\/api\/notifications\/devices',\s*auth/);
  assert.match(server, /app\.get\('\/api\/notifications',\s*auth/);
  assert.match(server, /app\.patch\('\/api\/notifications\/:id\/read',\s*auth/);
  assert.match(server, /WHERE device_token=\$1 AND recipient_type=\$2 AND recipient_id=\$3/);
});
