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

test('rejects service boundaries exceeding the vertex safety limit', () => {
  const ring = Array.from({ length: 250001 }, (_, index) => [index % 2, Math.floor(index / 2) % 2]);
  ring[ring.length - 1] = ring[0];
  assert.equal(validatePolygonGeoJSON({ type: 'Polygon', coordinates: [ring] }), false);
});

test('rejects coordinate strings, booleans and malformed dimensions', () => {
  assert.equal(validatePolygonGeoJSON({ type: 'Polygon', coordinates: [[
    ['42', 12], [44, 12], [44, 14], ['42', 14], ['42', 12]
  ]] }), false);
  assert.equal(validatePolygonGeoJSON({ type: 'Polygon', coordinates: [[
    [42, 12], [44, 12], [44, 14], [42, 14, 0, 1], [42, 12]
  ]] }), false);
  assert.equal(validatePolygonGeoJSON({ type: 'Polygon', coordinates: [[
    [42, 12], [44, 12], [44, 14], [42, 14], [42, 12]
  ]] }), true);
});

test('rejects degenerate rings with fewer than three distinct points or zero area', () => {
  assert.equal(validatePolygonGeoJSON({ type: 'Polygon', coordinates: [[[1, 1], [1, 1], [1, 1], [1, 1]]] }), false);
  assert.equal(validatePolygonGeoJSON({ type: 'Polygon', coordinates: [[[1, 1], [2, 2], [3, 3], [1, 1]]] }), false);
  assert.equal(validatePolygonGeoJSON({ type: 'Polygon', coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] }), true);
});

test('supports MultiPolygon and rejects invalid coordinates', () => {
  const multi = { type: 'MultiPolygon', coordinates: [square.coordinates,
    [[[50, 10], [51, 10], [51, 11], [50, 11], [50, 10]]]] };
  assert.equal(pointInGeoJSON(10.5, 50.5, multi), true);
  assert.equal(pointInGeoJSON(0, 500, multi), false);
});

test('caches prepared boundary geometry and rejects points outside its bounding box', () => {
  assert.equal(pointInGeoJSON(13, 43, square), true);
  assert.equal(pointInGeoJSON(13, 80, square), false);
  assert.equal(pointInGeoJSON(13, 43, square), true);
});

test('supports cached Feature and MultiPolygon geometries', () => {
  const feature = { type: 'Feature', geometry: square };
  const multi = { type: 'MultiPolygon', coordinates: [square.coordinates,
    [[[50, 10], [51, 10], [51, 11], [50, 11], [50, 10]]]] };
  assert.equal(pointInGeoJSON(13, 43, feature), true);
  assert.equal(pointInGeoJSON(10.5, 50.5, multi), true);
  assert.equal(pointInGeoJSON(10.5, 60, multi), false);
});


test('resolves a unique country when multiple matching areas belong to that country', () => {
  const { resolveCountryCoverageMatches } = require('../lib/service-coverage');
  const adjacentSameCountry = [
    { country_code: 'YE', geojson: square, region_name: 'A' },
    { country_code: 'YE', geojson: square, region_name: 'B' }
  ];
  const result = resolveCountryCoverageMatches(13, 43, adjacentSameCountry);
  assert.equal(result.status, 'unique');
  assert.deepEqual(result.countryCodes, ['YE']);
  assert.equal(result.matches.length, 2);
});

test('reports overlapping polygons from different countries as ambiguous', () => {
  const { resolveCountryCoverageMatches } = require('../lib/service-coverage');
  const result = resolveCountryCoverageMatches(13, 43, [
    { country_code: 'YE', geojson: square },
    { country_code: 'SA', geojson: square }
  ]);
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.countryCodes, ['SA', 'YE']);
  assert.equal(result.matches.length, 2);
});

test('reports unmatched points and rejects invalid area collections', () => {
  const { resolveCountryCoverageMatches } = require('../lib/service-coverage');
  assert.deepEqual(resolveCountryCoverageMatches(30, 43, [
    { country_code: 'YE', geojson: square }
  ]), { status: 'unmatched', countryCodes: [], matches: [] });
  assert.deepEqual(resolveCountryCoverageMatches(13, 43, null),
    { status: 'invalid', countryCodes: [], matches: [] });
});

test('normalizes country codes and ignores rows without a country code', () => {
  const { resolveCountryCoverageMatches } = require('../lib/service-coverage');
  const result = resolveCountryCoverageMatches(13, 43, [
    { country_code: ' ye ', geojson: square },
    { country_code: null, geojson: square }
  ]);
  assert.equal(result.status, 'unique');
  assert.deepEqual(result.countryCodes, ['YE']);
  assert.equal(result.matches.length, 1);
});


test('country resolution ignores disabled countries and disabled areas', () => {
  const { resolveEnabledCountryCoverageMatches } = require('../lib/service-coverage');
  const result = resolveEnabledCountryCoverageMatches(13, 43, [
    { country_code: 'YE', country_enabled: true, area_enabled: true, geojson: square },
    { country_code: 'SA', country_enabled: false, area_enabled: true, geojson: square },
    { country_code: 'OM', country_enabled: true, area_enabled: false, geojson: square }
  ]);
  assert.equal(result.status, 'unique');
  assert.deepEqual(result.countryCodes, ['YE']);
  assert.equal(result.matches.length, 1);
});

test('enabled country resolver reports ambiguity only among enabled service areas', () => {
  const { resolveEnabledCountryCoverageMatches } = require('../lib/service-coverage');
  const result = resolveEnabledCountryCoverageMatches(13, 43, [
    { country_code: 'YE', country_enabled: true, area_enabled: true, geojson: square },
    { country_code: 'SA', country_enabled: true, area_enabled: true, geojson: square },
    { country_code: 'OM', country_enabled: false, area_enabled: true, geojson: square }
  ]);
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.countryCodes, ['SA', 'YE']);
});


test('enforced coverage rejects points overlapping enabled areas in different countries', () => {
  const { resolveServiceCoverageFromSnapshot } = require('../lib/service-coverage');
  const result = resolveServiceCoverageFromSnapshot(13, 43, {
    enforced: true,
    areas: [
      { country_code: 'YE', country_name: 'Yemen', country_enabled: true, area_enabled: true, region_name: 'A', geojson: square },
      { country_code: 'SA', country_name: 'Saudi Arabia', country_enabled: true, area_enabled: true, region_name: 'B', geojson: square }
    ]
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'ambiguous_country_coverage');
  assert.equal(result.countryCode, null);
  assert.deepEqual(result.countryCodes, ['SA', 'YE']);
});

test('non-enforced coverage preserves permissive access while exposing ambiguous country', () => {
  const { resolveServiceCoverageFromSnapshot } = require('../lib/service-coverage');
  const result = resolveServiceCoverageFromSnapshot(13, 43, {
    enforced: false,
    areas: [
      { country_code: 'YE', country_enabled: true, area_enabled: true, geojson: square },
      { country_code: 'SA', country_enabled: true, area_enabled: true, geojson: square }
    ]
  });
  assert.equal(result.allowed, true);
  assert.equal(result.countryCode, null);
  assert.equal(result.reason, 'ambiguous_country_coverage');
});

test('coverage resolver still reports disabled country or area when no enabled match exists', () => {
  const { resolveServiceCoverageFromSnapshot } = require('../lib/service-coverage');
  const country = resolveServiceCoverageFromSnapshot(13, 43, {
    enforced: true,
    areas: [{ country_code: 'YE', country_enabled: false, area_enabled: true, geojson: square }]
  });
  assert.equal(country.allowed, false);
  assert.equal(country.reason, 'country_disabled');
  const area = resolveServiceCoverageFromSnapshot(13, 43, {
    enforced: true,
    areas: [{ country_code: 'YE', country_enabled: true, area_enabled: false, geojson: square }]
  });
  assert.equal(area.allowed, false);
  assert.equal(area.reason, 'area_disabled');
});
