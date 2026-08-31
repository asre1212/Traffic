import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRoute } from '../worker/src/traffic.js';

const env = { TOMTOM_API_KEY: 'test-key' };
const route = {
  id: 'r1',
  name: 'Home → Work',
  points: [{ lat: 40.7128, lon: -74.006 }, { lat: 40.7580, lon: -73.9855 }],
};
// A straight line of route geometry between the two endpoints.
const geometry = Array.from({ length: 40 }, (_, i) => ({
  latitude: 40.7128 + (0.0452 * i) / 39,
  longitude: -74.006 + (0.0205 * i) / 39,
}));

const routeResponse = (over = {}) => ({
  routes: [{
    summary: {
      lengthInMeters: 29000, travelTimeInSeconds: 2460, trafficDelayInSeconds: 540,
      noTrafficTravelTimeInSeconds: 1800, historicTrafficTravelTimeInSeconds: 1560,
      arrivalTime: '2026-09-01T06:41:00-04:00', ...over,
    },
    legs: [{ points: geometry }],
  }],
});

const incident = (lat, lon, over = {}) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: [[lon, lat], [lon + 0.001, lat + 0.001]] },
  properties: {
    iconCategory: 1, events: [{ description: 'Accident' }], from: 'Exit 12', to: 'Exit 14',
    delay: 540, length: 800, roadNumbers: ['I-95'], magnitudeOfDelay: 3, ...over,
  },
});

function stub({ routing = routeResponse(), incidents = { incidents: [] }, incidentStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/routing/')) return Response.json(routing);
    if (incidentStatus !== 200) return new Response('nope', { status: incidentStatus });
    return Response.json(incidents);
  };
  return calls;
}

test('live and typical travel times are normalized to minutes', async () => {
  stub();
  const r = await checkRoute(route, env);
  assert.equal(r.ok, true);
  assert.equal(r.minutes, 41);
  assert.equal(r.baselineMinutes, 26);   // historic, not free-flow
  assert.equal(r.delayMinutes, 15);
  assert.deepEqual(r.distance, { value: 18, unit: 'mi' });
  assert.equal(r.hasAccident, false);
});

test('metric units are supported', async () => {
  stub();
  const r = await checkRoute(route, env, { units: 'metric' });
  assert.deepEqual(r.distance, { value: 29, unit: 'km' });
});

test('an accident on the route is flagged and described', async () => {
  stub({ incidents: { incidents: [incident(40.735, -73.996)] } });
  const r = await checkRoute(route, env);
  assert.equal(r.hasAccident, true);
  assert.equal(r.accidents.length, 1);
  assert.deepEqual(
    { type: r.accidents[0].type, road: r.accidents[0].road, delay: r.accidents[0].delayMinutes },
    { type: 'Accident', road: 'I-95', delay: 9 },
  );
});

test('incidents inside the bounding box but off the route are dropped', async () => {
  // Same box, ~2 km east of the driven line.
  stub({ incidents: { incidents: [incident(40.7128, -73.99)] } });
  const r = await checkRoute(route, env);
  assert.deepEqual({ incidents: r.incidents.length, accident: r.hasAccident }, { incidents: 0, accident: false });
});

test('accidents sort ahead of jams', async () => {
  stub({
    incidents: {
      incidents: [
        incident(40.730, -73.998, { iconCategory: 6, events: [{ description: 'Slow traffic' }], delay: 120 }),
        incident(40.740, -73.994),
        incident(40.745, -73.992, { iconCategory: 8, events: [{ description: 'Closed' }], delay: 0 }),
      ],
    },
  });
  const r = await checkRoute(route, env);
  assert.deepEqual(r.incidents.map((i) => i.type), ['Accident', 'Road closed', 'Jam']);
  assert.equal(r.hasClosure, true);
});

test('identical duplicate incidents are collapsed', async () => {
  stub({ incidents: { incidents: [incident(40.730, -73.998), incident(40.732, -73.997)] } });
  const r = await checkRoute(route, env);
  assert.equal(r.incidents.length, 1);
});

test('a failing incident lookup still returns travel time', async () => {
  stub({ incidentStatus: 403 });
  const r = await checkRoute(route, env);
  assert.equal(r.ok, true);
  assert.equal(r.minutes, 41);
  assert.match(r.incidentError, /403/);
});

test('provider and configuration errors surface as ok:false, never as a throw', async () => {
  stub({ routing: { routes: [] } });
  assert.match((await checkRoute(route, env)).error, /no route found/);

  globalThis.fetch = async () => new Response('bad key', { status: 403 });
  assert.match((await checkRoute(route, env)).error, /Route lookup failed \(403\)/);

  assert.match((await checkRoute(route, {})).error, /TOMTOM_API_KEY/);
  assert.match((await checkRoute({ ...route, points: [route.points[0]] }, env)).error, /origin and a destination/);
});

test('waypoints and avoid options are passed through to the provider', async () => {
  const calls = stub();
  await checkRoute({
    ...route,
    avoid: 'tollRoads',
    points: [route.points[0], { lat: 40.73, lon: -73.99 }, route.points[1]],
  }, env);
  assert.match(calls[0], /calculateRoute\/40\.7128,-74\.006:40\.73,-73\.99:40\.758,-73\.9855\/json/);
  assert.match(calls[0], /avoid=tollRoads/);
  assert.match(calls[0], /traffic=true/);
});
