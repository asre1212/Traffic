// Traffic provider: TomTom Routing (live travel time) + Traffic Incidents
// (accidents, closures, jams) filtered down to the incidents actually on the route.
//
// Everything provider-specific lives in this file; swap it for HERE/Google/Mapbox
// by keeping `checkRoute`, `searchPlaces` and `reverseGeocode` signatures intact.

const ROUTING = 'https://api.tomtom.com/routing/1/calculateRoute';
const INCIDENTS = 'https://api.tomtom.com/traffic/services/5/incidentDetails';
const SEARCH = 'https://api.tomtom.com/search/2';

// TomTom iconCategory -> human label. 1 is the one we alarm on.
const CATEGORIES = {
  0: 'Incident', 1: 'Accident', 2: 'Fog', 3: 'Dangerous conditions', 4: 'Rain',
  5: 'Ice', 6: 'Jam', 7: 'Lane closed', 8: 'Road closed', 9: 'Road works',
  10: 'Wind', 11: 'Flooding', 14: 'Broken down vehicle',
};
const ACCIDENT_CATEGORIES = new Set([1, 14]); // accident, broken-down vehicle

const INCIDENT_FIELDS =
  '{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,' +
  'events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers}}}';

class ProviderError extends Error {}

async function getJson(url, label) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new ProviderError(`${label} failed (${res.status}): ${detail}`);
  }
  return res.json();
}

const round = (n) => Math.round(n);
const toMinutes = (seconds) => Math.max(0, Math.round(seconds / 60));

/**
 * Spatial hash of the route so incident geometry can be matched in one pass
 * instead of a full O(route x incident) distance sweep.
 */
function routeIndex(points, cellDeg = 0.0025) {
  const cells = new Set();
  for (const p of points) {
    cells.add(`${Math.floor(p.lat / cellDeg)}:${Math.floor(p.lon / cellDeg)}`);
  }
  return {
    hit(lat, lon) {
      const cy = Math.floor(lat / cellDeg);
      const cx = Math.floor(lon / cellDeg);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (cells.has(`${cy + dy}:${cx + dx}`)) return true;
        }
      }
      return false;
    },
  };
}

function boundingBox(points, padDeg = 0.01) {
  let minLat = 90, minLon = 180, maxLat = -90, maxLon = -180;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  }
  return [minLon - padDeg, minLat - padDeg, maxLon + padDeg, maxLat + padDeg];
}

/** Flatten Point / LineString / MultiLineString GeoJSON coordinates to [lon,lat] pairs. */
function flattenCoords(geometry, out = []) {
  const c = geometry?.coordinates;
  if (!Array.isArray(c)) return out;
  const walk = (node) => {
    if (typeof node[0] === 'number') out.push(node);
    else for (const child of node) walk(child);
  };
  walk(c);
  return out;
}

function describeIncident(feature) {
  const p = feature.properties || {};
  const category = Number(p.iconCategory ?? 0);
  const events = (p.events || []).map((e) => e.description).filter(Boolean);
  const road = (p.roadNumbers || []).join('/') || null;
  const where = p.from && p.to ? `${p.from} → ${p.to}` : p.from || p.to || null;
  return {
    category,
    type: CATEGORIES[category] || 'Incident',
    isAccident: ACCIDENT_CATEGORIES.has(category),
    description: events[0] || CATEGORIES[category] || 'Traffic incident',
    road,
    where,
    delayMinutes: p.delay ? toMinutes(p.delay) : 0,
    lengthMeters: p.length ? round(p.length) : 0,
    magnitude: Number(p.magnitudeOfDelay ?? 0), // 0 unknown … 4 indefinite
  };
}

async function fetchIncidents(points, env) {
  const bbox = boundingBox(points).join(',');
  const url = `${INCIDENTS}?key=${env.TOMTOM_API_KEY}&bbox=${bbox}` +
    `&fields=${encodeURIComponent(INCIDENT_FIELDS)}&language=en-GB&timeValidityFilter=present`;
  const data = await getJson(url, 'Incident lookup');

  const index = routeIndex(points);
  const seen = new Set();
  const onRoute = [];
  for (const feature of data.incidents || []) {
    const coords = flattenCoords(feature.geometry);
    if (!coords.some(([lon, lat]) => index.hit(lat, lon))) continue; // bbox hit but not on our roads
    const incident = describeIncident(feature);
    const key = `${incident.type}|${incident.description}|${incident.where}`;
    if (seen.has(key)) continue;
    seen.add(key);
    onRoute.push(incident);
  }
  // Worst first: accidents, then closures, then whatever costs the most time.
  const rank = (i) => (i.isAccident ? 3 : i.category === 8 ? 2 : 1);
  onRoute.sort((a, b) => (rank(b) - rank(a)) || (b.delayMinutes - a.delayMinutes) || (b.magnitude - a.magnitude));
  return onRoute;
}

/**
 * Live check for one saved route.
 * @param {{id:string,name:string,points:Array<{lat:number,lon:number,label?:string}>,avoid?:string}} route
 * @returns normalized summary; `error` is set instead of throwing so one bad
 *          route never takes down the whole morning alert.
 */
export async function checkRoute(route, env, { departAt = 'now', units = 'imperial' } = {}) {
  const base = { routeId: route.id, name: route.name, checkedAt: new Date().toISOString() };
  try {
    if (!env.TOMTOM_API_KEY) throw new ProviderError('TOMTOM_API_KEY is not configured');
    const pts = route.points || [];
    if (pts.length < 2) throw new ProviderError('route needs at least an origin and a destination');

    const locations = pts.map((p) => `${p.lat},${p.lon}`).join(':');
    const params = new URLSearchParams({
      key: env.TOMTOM_API_KEY,
      traffic: 'true',
      travelMode: 'car',
      routeType: 'fastest',
      computeTravelTimeFor: 'all',
      sectionType: 'traffic',
      routeRepresentation: 'polyline',
      departAt,
    });
    if (route.avoid) params.set('avoid', route.avoid); // e.g. tollRoads,motorways

    const data = await getJson(`${ROUTING}/${locations}/json?${params}`, 'Route lookup');
    const best = data.routes?.[0];
    if (!best) throw new ProviderError('no route found between those points');

    const s = best.summary;
    const live = s.travelTimeInSeconds;
    // Prefer the typical-for-this-time-of-day baseline; fall back to free flow.
    const baseline = s.historicTrafficTravelTimeInSeconds || s.noTrafficTravelTimeInSeconds || live;
    const points = (best.legs || []).flatMap((leg) =>
      (leg.points || []).map((p) => ({ lat: p.latitude, lon: p.longitude })));

    let incidents = [];
    let incidentError = null;
    try {
      incidents = await fetchIncidents(points.length ? points : pts, env);
    } catch (err) {
      incidentError = err.message; // travel time is still useful without incident data
    }

    const minutes = toMinutes(live);
    const baselineMinutes = toMinutes(baseline);
    const delayMinutes = minutes - baselineMinutes;
    const accidents = incidents.filter((i) => i.isAccident);
    const closures = incidents.filter((i) => i.category === 8);
    const meters = s.lengthInMeters;

    return {
      ...base,
      ok: true,
      minutes,
      baselineMinutes,
      delayMinutes,
      trafficDelayMinutes: toMinutes(s.trafficDelayInSeconds || 0),
      distance: units === 'metric'
        ? { value: Math.round(meters / 100) / 10, unit: 'km' }
        : { value: Math.round(meters / 160.934) / 10, unit: 'mi' },
      arrival: s.arrivalTime || null,
      incidents,
      accidents,
      hasAccident: accidents.length > 0,
      hasClosure: closures.length > 0,
      incidentError,
    };
  } catch (err) {
    return { ...base, ok: false, error: String(err.message || err) };
  }
}

/** Typeahead for the route editor. Keeps the API key server-side. */
export async function searchPlaces(query, env, { lat, lon, limit = 6 } = {}) {
  const params = new URLSearchParams({ key: env.TOMTOM_API_KEY, limit: String(limit), typeahead: 'true' });
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    params.set('lat', String(lat));
    params.set('lon', String(lon));
    params.set('radius', '150000');
  }
  const data = await getJson(`${SEARCH}/search/${encodeURIComponent(query)}.json?${params}`, 'Place search');
  return (data.results || []).map((r) => ({
    label: r.poi?.name ? `${r.poi.name}, ${r.address?.freeformAddress || ''}`.replace(/,\s*$/, '') : r.address?.freeformAddress || 'Unnamed',
    lat: r.position.lat,
    lon: r.position.lon,
  }));
}

/** "Use my current location" -> a human label. */
export async function reverseGeocode(lat, lon, env) {
  const params = new URLSearchParams({ key: env.TOMTOM_API_KEY });
  const data = await getJson(`${SEARCH}/reverseGeocode/${lat},${lon}.json?${params}`, 'Reverse geocode');
  const a = data.addresses?.[0]?.address;
  return { label: a?.freeformAddress || `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon };
}
