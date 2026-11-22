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
  return Number(first[0]) === Number(last[0]) && Number(first[1]) === Number(last[1]);
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

function pointInGeoJSON(latitude, longitude, value) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 ||
      !validatePolygonGeoJSON(value)) return false;
  const geometry = value.type === 'Feature' ? value.geometry : value;
  if (geometry.type === 'Polygon') return pointInPolygon(longitude, latitude, geometry.coordinates);
  return geometry.coordinates.some(polygon => pointInPolygon(longitude, latitude, polygon));
}

module.exports = { validatePolygonGeoJSON, pointInGeoJSON };
