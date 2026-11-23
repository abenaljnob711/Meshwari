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
    assert.match(ui, new RegExp('id="' + id + '"'));
  }
  assert.match(ui, /data-page="passengerHomePanel"/);
  assert.match(ui, /data-page="passengerTripsPanel"/);
  assert.match(ui, /data-page="passengerAccountPanel"/);
});

test('passenger-only renderer does not contain driver wallet or vehicle controls', () => {
  const ui = passengerRenderer();
  for (const forbidden of ['walletHistory', 'walletToggle', 'vehicleChangeForm', 'vehicleHistory', 'id="duty"']) {
    assert.equal(ui.includes(forbidden), false, 'driver-only control leaked into passenger UI: ' + forbidden);
  }
});

test('passenger account, notification, GPS and trip controls have event handlers', () => {
  const ui = passengerRenderer();
  const bindings = [
    ['passengerNotifications', /passengerNotifications['"]).onclicks*=s*showNotifications/],
    ['passengerNotificationAction', /passengerNotificationAction['"]).onclicks*=s*showNotifications/],
    ['passengerProfileAction', /passengerProfileAction['"]).onclicks*=/],
    ['passengerPaymentAction', /passengerPaymentAction['"]).onclicks*=/],
    ['passengerSupportAction', /passengerSupportAction['"]).onclicks*=/],
    ['passengerThemeToggle', /themeButton.onclicks*=/],
    ['settingsToggle', /settingsToggle['"]).onclicks*=/],
    ['passengerGpsTop', /passengerGpsTop['"]).onclicks*=/],
    ['refreshPassengerHistory', /refreshPassengerHistory['"]).onclicks*=/]
  ];
  for (const [id, handler] of bindings) {
    assert.match(ui, new RegExp('id="' + id + '"'), 'missing passenger control: ' + id);
    assert.match(ui, handler, 'missing event handler for passenger control: ' + id);
  }
  for (const id of ['searchDestination', 'voiceSearchDestination', 'addTripStop', 'trip', 'recenterTripMap']) {
    assert.match(ui, new RegExp('id="' + id + '"'));
  }
  assert.match(ui, /initPassengerTripUI()/);
});

test('passenger trip history is restricted to the authenticated passenger', () => {
  const routeStart = serverJs.indexOf("app.get('/api/passenger/trips/history'");
  assert.notEqual(routeStart, -1);
  const route = serverJs.slice(routeStart, routeStart + 1500);
  assert.match(route, /auth,s*role\('passenger'\)/);
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
