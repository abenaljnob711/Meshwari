'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const passengerHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/build-apk.yml'), 'utf8');

function passengerRenderer() {
  const start = passengerHtml.indexOf('function renderPassengerHome()');
  const end = passengerHtml.indexOf('\nlet tripInteractionTimer', start);
  assert.notEqual(start, -1, 'passenger renderer must exist');
  assert.notEqual(end, -1, 'passenger renderer boundary must exist');
  return passengerHtml.slice(start, end);
}

test('passenger app has separate home, trips and account pages', () => {
  const ui = passengerRenderer();
  for (const id of ['passengerHomePanel', 'passengerTripsPanel', 'passengerAccountPanel']) {
    assert.ok(ui.includes('id="' + id + '"'), 'missing page: ' + id);
  }
  for (const id of ['passengerHomePanel', 'passengerTripsPanel', 'passengerAccountPanel']) {
    assert.ok(ui.includes('data-page="' + id + '"'), 'missing navigation entry: ' + id);
  }
});

test('passenger-only renderer excludes driver wallet and vehicle controls', () => {
  const ui = passengerRenderer();
  for (const forbidden of ['walletHistory', 'walletToggle', 'vehicleChangeForm', 'vehicleHistory', 'id="duty"']) {
    assert.equal(ui.includes(forbidden), false, 'driver-only control leaked into passenger UI: ' + forbidden);
  }
});

test('passenger account and notification controls have event handlers', () => {
  const ui = passengerRenderer();
  const bindings = [
    ["passengerNotifications", /passengerNotifications'\)\.onclick\s*=\s*showNotifications/],
    ["passengerNotificationAction", /passengerNotificationAction'\)\.onclick\s*=\s*showNotifications/],
    ["passengerProfileAction", /passengerProfileAction'\)\.onclick\s*=/],
    ["passengerPaymentAction", /passengerPaymentAction'\)\.onclick\s*=/],
    ["passengerSupportAction", /passengerSupportAction'\)\.onclick\s*=/],
    ["passengerGpsTop", /passengerGpsTop'\)\.onclick\s*=/],
    ["refreshPassengerHistory", /refreshPassengerHistory'\)\.onclick\s*=/],
    ["settingsToggle", /settingsToggle'\)\.onclick\s*=/],
    ["saveAccountLock", /saveAccountLock'\)\.onclick\s*=/]
  ];
  for (const [id, handler] of bindings) {
    assert.ok(ui.includes('id="' + id + '"'), 'missing control: ' + id);
    assert.match(ui, handler, 'missing handler: ' + id);
  }
  assert.match(ui, /themeButton\.onclick\s*=/, 'theme toggle has no handler');
});

test('passenger trip controls are connected to their real handlers', () => {
  const initStart = passengerHtml.indexOf('function initPassengerTripUI()');
  const initEnd = passengerHtml.indexOf('\nasync function startTripVoiceSearch', initStart);
  assert.notEqual(initStart, -1);
  assert.notEqual(initEnd, -1);
  const init = passengerHtml.slice(initStart, initEnd);
  for (const handler of [
    /searchDestination'\)\.onclick\s*=/,
    /voiceSearchDestination'\)\.onclick\s*=/,
    /speakTripDirections'\)\.onclick\s*=/,
    /addTripStop'\)\.onclick\s*=/,
    /trip'\)\.onclick\s*=/,
    /recenterTripMap'\)\.onclick\s*=/
  ]) assert.match(init, handler, 'a visible trip control has no click handler');
  assert.match(init, /pickupField\.onclick\s*=\s*locateTripPickup/);
  assert.match(init, /locateTripPickup\(\)/);
});

test('passenger trip history is restricted to the authenticated passenger', () => {
  const routeStart = serverJs.indexOf("app.get('/api/passenger/trips/history'");
  assert.notEqual(routeStart, -1);
  const route = serverJs.slice(routeStart, routeStart + 1500);
  assert.match(route, /auth,\s*role\('passenger'\)/);
  assert.match(route, /WHERE t\.passenger_id=\$1/);
  assert.match(route, /req\.user\.sub/);
});

test('APK workflow builds distinct passenger and driver variants', () => {
  assert.match(workflow, /const APP_VARIANT='passenger'/);
  assert.match(workflow, /const APP_VARIANT='driver'/);
  assert.match(workflow, /build\/passenger/);
  assert.match(workflow, /build\/driver/);
  assert.match(workflow, /https:\/\/meshwari\.onrender\.com\/api/);
});

test('passenger trip endpoints never expose the driver real name, plate or vehicle text', () => {
  const activeStart = serverJs.indexOf("app.get('/api/passenger/trips'");
  const historyStart = serverJs.indexOf("app.get('/api/passenger/trips/history'");
  const driverTripsStart = serverJs.indexOf("app.get('/api/driver/trips'");
  assert.ok(activeStart >= 0 && historyStart > activeStart && driverTripsStart > historyStart);
  const active = serverJs.slice(activeStart, historyStart);
  const history = serverJs.slice(historyStart, driverTripsStart);
  for (const route of [active, history]) {
    assert.match(route, /سائق-/);
    assert.match(route, /vehicle_image_url/);
    assert.doesNotMatch(route, /a\.full_name\s+AS\s+driver_name/);
    assert.doesNotMatch(route, /d\.plate_number/);
    assert.doesNotMatch(route, /d\.car_type|d\.car_model|d\.car_color/);
  }
});

test('passenger UI renders driver identity in a separate privacy card with a vehicle image', () => {
  assert.match(passengerHtml, /function tripDriverPrivacyCard\(trip\)/);
  assert.match(passengerHtml, /trip-driver-private-card/);
  assert.match(passengerHtml, /trip-driver-vehicle-image/);
  assert.match(passengerHtml, /tripDriverPrivacyCard\(trip\)/);
  assert.match(passengerHtml, /trip\.vehicle_image_url/);
  assert.doesNotMatch(passengerHtml, /trip\.car_type,trip\.car_model,trip\.car_color/);
});
