'use strict';

function finiteCoordinate(point) {
  return Array.isArray(point) && (point.length === 2 || point.length === 3) &&
    point.every(value => typeof value === 'number' && Number.isFinite(value)) &&
    Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
}

const MAX_BOUNDARY_VERTICES = 250000;

function validateRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4 || !ring.every(finiteCoordinate)) return false;
  const first = ring[0], last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return false;
  const distinct = new Set(ring.slice(0, -1).map(point => point[0] + ',' + point[1]));
  if (distinct.size < 3) return false;
  let twiceArea = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    twiceArea += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Number.isFinite(twiceArea) && Math.abs(twiceArea) > 1e-12;
}

function validatePolygonGeoJSON(value) {
  let geometry = value;
  if (geometry && geometry.type === 'Feature') geometry = geometry.geometry;
  if (!geometry || typeof geometry !== 'object') return false;
  let vertexCount = 0;
  const validRing = ring => {
    if (!Array.isArray(ring) || ring.length < 4) return false;
    vertexCount += ring.length;
    return vertexCount <= MAX_BOUNDARY_VERTICES && validateRing(ring);
  };
  if (geometry.type === 'Polygon') {
    return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 &&
      geometry.coordinates.every(validRing);
  }
  if (geometry.type === 'MultiPolygon') {
    return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 &&
      geometry.coordinates.every(polygon => Array.isArray(polygon) && polygon.length > 0 &&
        polygon.every(validRing));
  }
  return false;
}

function pointInRing(longitude, latitude, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]), yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]), yj = Number(ring[j][1]);
    const cross = (longitude - xi) * (yj - yi) - (latitude - yi) * (xj - xi);
    const scale = Math.max(1, Math.abs(xj - xi), Math.abs(yj - yi));
    const withinBounds = longitude >= Math.min(xi, xj) - 1e-10 &&
      longitude <= Math.max(xi, xj) + 1e-10 &&
      latitude >= Math.min(yi, yj) - 1e-10 &&
      latitude <= Math.max(yi, yj) + 1e-10;
    if (Math.abs(cross) <= 1e-10 * scale && withinBounds) return true;
    const crosses = ((yi > latitude) !== (yj > latitude)) &&
      (longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(longitude, latitude, rings) {
  if (!rings.length || !pointInRing(longitude, latitude, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(longitude, latitude, rings[i])) return false;
  }
  return true;
}

// GeoJSON rows are immutable within a coverage snapshot. Cache validation and
// bounding boxes so nearby-driver filtering does not rescan every boundary vertex
// for every driver returned by the database.
const preparedGeometryCache = new WeakMap();

function prepareGeometry(value) {
  if (!value || typeof value !== 'object') return null;
  const cached = preparedGeometryCache.get(value);
  if (cached) return cached;
  if (!validatePolygonGeoJSON(value)) {
    const invalid = { valid: false };
    preparedGeometryCache.set(value, invalid);
    return invalid;
  }
  const geometry = value.type === 'Feature' ? value.geometry : value;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const polygon of polygons) for (const ring of polygon) for (const point of ring) {
    minLng = Math.min(minLng, point[0]);
    minLat = Math.min(minLat, point[1]);
    maxLng = Math.max(maxLng, point[0]);
    maxLat = Math.max(maxLat, point[1]);
  }
  const prepared = { valid: true, geometry, minLng, minLat, maxLng, maxLat };
  preparedGeometryCache.set(value, prepared);
  return prepared;
}

function pointInGeoJSON(latitude, longitude, value) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return false;
  const prepared = prepareGeometry(value);
  if (!prepared?.valid || longitude < prepared.minLng || longitude > prepared.maxLng ||
      latitude < prepared.minLat || latitude > prepared.maxLat) return false;
  const { geometry } = prepared;
  if (geometry.type === 'Polygon') return pointInPolygon(longitude, latitude, geometry.coordinates);
  return geometry.coordinates.some(polygon => pointInPolygon(longitude, latitude, polygon));
}

function resolveCountryCoverageMatches(latitude, longitude, areas) {
  if (!Array.isArray(areas)) return { status: 'invalid', countryCodes: [], matches: [] };
  const matches = areas.filter(area =>
    area && area.country_code != null && pointInGeoJSON(latitude, longitude, area.geojson)
  );
  const countryCodes = [...new Set(matches.map(area => String(area.country_code).trim().toUpperCase()))]
    .filter(Boolean).sort();
  return {
    status: countryCodes.length === 0 ? 'unmatched' : countryCodes.length === 1 ? 'unique' : 'ambiguous',
    countryCodes,
    matches
  };
}

function resolveEnabledCountryCoverageMatches(latitude, longitude, areas) {
  if (!Array.isArray(areas)) return { status: 'invalid', countryCodes: [], matches: [] };
  const enabledAreas = areas.filter(area =>
    area && area.country_enabled === true && area.area_enabled === true
  );
  return resolveCountryCoverageMatches(latitude, longitude, enabledAreas);
}


function hasSingleCountryCoverage(coverages) {
  if (!Array.isArray(coverages) || coverages.length === 0) return false;
  const codes = coverages.map(item =>
    typeof item?.countryCode === 'string' ? item.countryCode.trim().toUpperCase() : ''
  );
  return codes.every(Boolean) && codes.every(code => code === codes[0]);
}

function resolveServiceCoverageFromSnapshot(latitude, longitude, snapshot) {
  const areas = Array.isArray(snapshot?.areas) ? snapshot.areas : [];
  const matches = areas.filter(area => pointInGeoJSON(latitude, longitude, area.geojson));
  const enabled = resolveEnabledCountryCoverageMatches(latitude, longitude, areas);

  if (enabled.status === 'ambiguous') {
    return {
      enforced: Boolean(snapshot?.enforced),
      allowed: !snapshot?.enforced,
      countryCode: null,
      countryName: null,
      regionName: null,
      countryCodes: enabled.countryCodes,
      reason: 'ambiguous_country_coverage'
    };
  }

  const match = enabled.status === 'unique' ? enabled.matches[0] : matches[0];
  if (!match) return {
    enforced: Boolean(snapshot?.enforced),
    allowed: !snapshot?.enforced,
    countryCode: null,
    countryName: null,
    regionName: null,
    reason: snapshot?.enforced ? 'coverage_unavailable' : 'coverage_not_configured'
  };

  const allowed = Boolean(match.country_enabled && match.area_enabled);
  return {
    enforced: Boolean(snapshot?.enforced),
    allowed: snapshot?.enforced ? allowed : true,
    countryCode: String(match.country_code).trim(),
    countryName: match.country_name,
    regionName: match.region_name,
    reason: !match.country_enabled ? 'country_disabled' : (!match.area_enabled ? 'area_disabled' : null)
  };
}

module.exports = {
  validatePolygonGeoJSON,
  pointInGeoJSON,
  resolveCountryCoverageMatches,
  resolveEnabledCountryCoverageMatches,
  resolveServiceCoverageFromSnapshot,
  hasSingleCountryCoverage
};
