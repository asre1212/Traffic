import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAlert, severityOf } from '../worker/src/alerts.js';

const result = (over = {}) => ({
  ok: true, routeId: 'r1', name: 'Home → Work', minutes: 28, baselineMinutes: 26, delayMinutes: 2,
  distance: { value: 18.4, unit: 'mi' }, incidents: [], accidents: [], hasAccident: false, hasClosure: false, ...over,
});
const accident = {
  category: 1, type: 'Accident', isAccident: true, description: 'Accident',
  road: 'I-95 N', where: 'Exit 12 → Exit 14', delayMinutes: 9, lengthMeters: 800, magnitude: 3,
};
const device = (over = {}) => ({ delay_threshold: 5, quiet_ok: 1, ...over });

test('a clear morning still gets the daily alert', () => {
  const { payload } = buildAlert([result()], device());
  assert.match(payload.title, /^🚗 28 min · Home → Work$/);
  assert.match(payload.body, /No accidents reported/);
  assert.equal(payload.severity, 'ok');
});

test('an accident is flagged in the title and named in the body', () => {
  const { payload } = buildAlert(
    [result({ minutes: 41, delayMinutes: 15, incidents: [accident], accidents: [accident], hasAccident: true })],
    device(),
  );
  assert.match(payload.title, /^⚠️ 41 min/);
  assert.match(payload.body, /Accident on I-95 N \+9 min/);
  assert.equal(payload.severity, 'bad');
  assert.equal(payload.renotify, true);
  assert.equal(payload.routes[0].hasAccident, true);
});

test('the accident route leads even when it is not first', () => {
  const clean = result({ routeId: 'a', name: 'Back road' });
  const crash = result({ routeId: 'b', name: 'Highway', minutes: 44, incidents: [accident], accidents: [accident], hasAccident: true });
  const { payload } = buildAlert([clean, crash], device());
  assert.match(payload.title, /Highway/);
  assert.match(payload.body, /Back road: 28 min/);
});

test('a slow-but-clear run is flagged without an accident', () => {
  const { payload } = buildAlert([result({ minutes: 34, delayMinutes: 8 })], device());
  assert.equal(payload.severity, 'slow');
  assert.match(payload.title, /^🐢/);
  assert.match(payload.body, /8 min slower than usual/);
});

test('quiet mode suppresses the push when roads are normal but not when they are not', () => {
  assert.match(buildAlert([result()], device({ quiet_ok: 0 })).skip, /clear roads/);
  assert.ok(buildAlert([result({ minutes: 40, delayMinutes: 14 })], device({ quiet_ok: 0 })).payload);
});

test('failed lookups are reported as a skip rather than a broken notification', () => {
  const { skip } = buildAlert([{ ok: false, name: 'Home → Work', error: 'Route lookup failed (403)' }], device());
  assert.match(skip, /403/);
});

test('the body stays within the three lines iOS will render', () => {
  const many = [result({ routeId: 'a', name: 'A' }), result({ routeId: 'b', name: 'B' }),
    result({ routeId: 'c', name: 'C' }), result({ routeId: 'd', name: 'D' })];
  assert.ok(buildAlert(many, device()).payload.body.split('\n').length <= 3);
});

test('severity honours the per-device threshold', () => {
  assert.equal(severityOf(result({ delayMinutes: 4 }), 5), 'ok');
  assert.equal(severityOf(result({ delayMinutes: 6 }), 5), 'slow');
  assert.equal(severityOf(result({ delayMinutes: 12 }), 5), 'bad');
  assert.equal(severityOf(result({ delayMinutes: 12 }), 15), 'ok');
});
