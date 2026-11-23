'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getDrivingDistanceKm } = require('../lib/route-distance');

test('road distance follows origin, every stop, and destination through the route provider', async () => {
  const requests = [];
  const distances = [1500, 2500];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ routes: [{ distanceMeters: distances[requests.length - 1] }] }) };
  };
  const distance = await getDrivingDistanceKm({
    origin: { latitude: 15, longitude: 44 },
    stops: [{ lat: 15.1, lng: 44.1 }],
    destination: { latitude: 15.2, longitude: 44.2 },
    apiKey: 'test-key',
    fetchImpl
  });
  assert.equal(distance, 4);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.origin.location.latLng.latitude, 15);
  assert.equal(requests[0].body.destination.location.latLng.latitude, 15.1);
  assert.equal(requests[1].body.origin.location.latLng.latitude, 15.1);
  assert.equal(requests[1].body.destination.location.latLng.latitude, 15.2);
  assert.equal(requests[0].options.headers['X-Goog-Api-Key'], 'test-key');
  assert.equal(requests[0].body.travelMode, 'DRIVE');
});

test('road distance rounds upward to the nearest tenth of a kilometre', async () => {
  const distance = await getDrivingDistanceKm({
    origin: { lat: 15, lng: 44 },
    destination: { lat: 15.1, lng: 44.1 },
    apiKey: 'test-key',
    fetchImpl: async () => ({ ok: true, json: async () => ({ routes: [{ distanceMeters: 1050 }] }) })
  });
  assert.equal(distance, 1.1);
});

test('trip routing fails closed when provider credentials or a valid route are unavailable', async () => {
  await assert.rejects(
    getDrivingDistanceKm({
      origin: { lat: 15, lng: 44 }, destination: { lat: 15.1, lng: 44.1 }, apiKey: ''
    }),
    error => error.code === 'ROUTING_PROVIDER_NOT_CONFIGURED'
  );
  await assert.rejects(
    getDrivingDistanceKm({
      origin: { lat: 15, lng: 44 }, destination: { lat: 15.1, lng: 44.1 }, apiKey: 'test-key',
      fetchImpl: async () => ({ ok: true, json: async () => ({ routes: [] }) })
    }),
    error => error.code === 'ROUTE_NOT_FOUND'
  );
});
