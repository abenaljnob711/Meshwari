'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePolygonGeoJSON, pointInGeoJSON } = require('../lib/service-coverage');

const square = {
  type: 'Polygon',
  coordinates: [[[42, 12], [44, 12], [44, 14], [42, 14], [42, 12]]]
};

test('accepts valid Polygon and Feature geometries', () => {
  assert.equal(validatePolygonGeoJSON(square), true);
  assert.equal(validatePolygonGeoJSON({ type: 'Feature', geometry: square }), true);
});

test('rejects unsupported, open and malformed geometries', () => {
  assert.equal(validatePolygonGeoJSON({ type: 'Point', coordinates: [43, 13] }), false);
  assert.equal(validatePolygonGeoJSON({ type: 'Polygon', coordinates: [[[42, 12], [44, 12], [44, 14]]] }), false);
  assert.equal(validatePolygonGeoJSON(null), false);
});

test('checks points against polygon boundaries and holes', () => {
  assert.equal(pointInGeoJSON(13, 43, square), true);
  assert.equal(pointInGeoJSON(15, 43, square), false);
  const withHole = { type: 'Polygon', coordinates: [
    square.coordinates[0],
    [[42.5, 12.5], [43.5, 12.5], [43.5, 13.5], [42.5, 13.5], [42.5, 12.5]]
  ] };
  assert.equal(pointInGeoJSON(13, 43, withHole), false);
});

test('treats outer polygon edges and vertices as inside coverage', () => {
  assert.equal(pointInGeoJSON(12, 43, square), true);
  assert.equal(pointInGeoJSON(13, 42, square), true);
  assert.equal(pointInGeoJSON(12, 42, square), true);
});

test('treats hole edges as excluded from coverage', () => {
  const withHole = { type: 'Polygon', coordinates: [
    square.coordinates[0],
    [[42.5, 12.5], [43.5, 12.5], [43.5, 13.5], [42.5, 13.5], [42.5, 12.5]]
  ] };
  assert.equal(pointInGeoJSON(12.5, 43, withHole), false);
  assert.equal(pointInGeoJSON(13, 43, withHole), false);
});

test('supports MultiPolygon and rejects invalid coordinates', () => {
  const multi = { type: 'MultiPolygon', coordinates: [square.coordinates,
    [[[50, 10], [51, 10], [51, 11], [50, 11], [50, 10]]]] };
  assert.equal(pointInGeoJSON(10.5, 50.5, multi), true);
  assert.equal(pointInGeoJSON(0, 500, multi), false);
});
