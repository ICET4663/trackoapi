const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed (${response.status}): ${text}`);
  }
  return payload;
}

async function main() {
  console.log(`Tracko maps smoke: ${API_BASE_URL}`);

  const status = await request('/v1/integrations/status');
  if (!status.maps?.endpoints?.includes('GET /v1/maps/places?query=...')) {
    console.log('WARN maps endpoints are not listed in integration status. Testing endpoint paths directly.');
    console.log('WARN If the next request returns 404, redeploy the backend maps commit to Vercel.');
  } else {
    console.log('OK maps status', status.maps.provider, status.maps.mode);
  }

  const places = await request('/v1/maps/places?query=Lagos');
  if (!Array.isArray(places.results) || !places.results.length) {
    throw new Error('Places search did not return results.');
  }
  console.log('OK places', places.provider, places.results[0].address);

  const geocode = await request('/v1/maps/geocode?address=Wuse');
  if (!geocode.result?.latitude || !geocode.result?.longitude) {
    throw new Error('Geocode did not return coordinates.');
  }
  console.log('OK geocode', geocode.provider, geocode.result.address);

  const route = await request('/v1/maps/route-estimate', {
    method: 'POST',
    body: {
      originLatitude: 6.5244,
      originLongitude: 3.3792,
      destinationLatitude: 9.0765,
      destinationLongitude: 7.3986,
      truckType: 'Flatbed truck',
    },
  });
  if (!route.distanceKm || !route.durationMinutes || !route.quotedPriceKobo) {
    throw new Error('Route estimate did not return distance, duration, and quote.');
  }
  console.log('OK route estimate', `${route.distanceKm}km`, `${route.durationMinutes}mins`);

  console.log('DONE Tracko maps smoke passed');
}

main().catch((error) => {
  console.error('FAILED Tracko maps smoke');
  console.error(error.message || error);
  process.exitCode = 1;
});
