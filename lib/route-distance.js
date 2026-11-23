'use strict';

class RouteDistanceError extends Error {
  constructor(message, code, status = 503) {
    super(message);
    this.name = 'RouteDistanceError';
    this.code = code;
    this.status = status;
  }
}

function validatePoint(point, label) {
  const latitude = Number(point?.latitude ?? point?.lat);
  const longitude = Number(point?.longitude ?? point?.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new RouteDistanceError('Route coordinates are invalid: ' + label, 'ROUTE_COORDINATES_INVALID', 400);
  }
  return { latitude, longitude };
}

async function getDrivingDistanceKm({ origin, destination, stops = [], apiKey, fetchImpl = globalThis.fetch }) {
  if (!String(apiKey || '').trim()) {
    throw new RouteDistanceError(
      'خدمة حساب مسار الطريق غير مهيأة. أضف GOOGLE_MAPS_API_KEY قبل استقبال طلبات الرحلات.',
      'ROUTING_PROVIDER_NOT_CONFIGURED'
    );
  }
  if (typeof fetchImpl !== 'function') {
    throw new RouteDistanceError('خدمة الاتصال بمسارات الطرق غير متاحة على الخادم.', 'ROUTING_PROVIDER_UNAVAILABLE');
  }
  const points = [
    validatePoint(origin, 'origin'),
    ...stops.map((point, index) => validatePoint(point, 'stop ' + (index + 1))),
    validatePoint(destination, 'destination')
  ];
  let totalMeters = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const response = await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': String(apiKey).trim(),
        'X-Goog-FieldMask': 'routes.distanceMeters'
      },
      body: JSON.stringify({
        origin: { location: { latLng: points[index] } },
        destination: { location: { latLng: points[index + 1] } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE'
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      throw new RouteDistanceError(
        'تعذر الحصول على مسافة الطريق من مزود الخرائط. حاول لاحقاً.',
        'ROUTING_PROVIDER_REQUEST_FAILED'
      );
    }
    const data = await response.json();
    const meters = Number(data?.routes?.[0]?.distanceMeters);
    if (!Number.isFinite(meters) || meters <= 0) {
      throw new RouteDistanceError(
        'لم يُرجع مزود الخرائط مسافة طريق صالحة لهذه الرحلة.',
        'ROUTE_NOT_FOUND'
      );
    }
    totalMeters += meters;
  }
  // Round upward to 0.1 km so a partial tenth is not charged as a shorter trip.
  return Math.ceil(totalMeters / 100) / 10;
}

module.exports = { getDrivingDistanceKm, RouteDistanceError };
