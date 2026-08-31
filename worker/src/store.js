// D1 access + the tiny per-install auth scheme.
//
// Auth model: on first launch the PWA calls POST /api/device and gets back a
// device id and a random bearer token. Only the SHA-256 of the token is stored,
// and every route/setting is scoped to that device id. No accounts, no email.

import { parseDays, parseHhMm } from './schedule.js';

const MAX_POINTS = 12;

export async function sha256hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export async function createDevice(env, { tz = 'America/New_York' } = {}) {
  const id = crypto.randomUUID();
  const token = randomToken();
  await env.DB.prepare(
    'INSERT INTO devices (id, token_hash, created_at, tz) VALUES (?, ?, ?, ?)',
  ).bind(id, await sha256hex(token), Date.now(), tz).run();
  return { deviceId: id, token };
}

/** Bearer token -> device row, or null. */
export async function authenticate(env, request) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  return env.DB.prepare('SELECT * FROM devices WHERE token_hash = ?')
    .bind(await sha256hex(token)).first();
}

export function parsePoints(input) {
  if (!Array.isArray(input)) throw new Error('points must be an array');
  const points = input.map((p, i) => {
    const lat = Number(p?.lat);
    const lon = Number(p?.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error(`point ${i + 1}: bad latitude`);
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error(`point ${i + 1}: bad longitude`);
    return { lat, lon, label: String(p.label || '').slice(0, 120) };
  });
  if (points.length < 2) throw new Error('a route needs a start and an end');
  if (points.length > MAX_POINTS) throw new Error(`at most ${MAX_POINTS} points (waypoints included)`);
  return points;
}

const rowToRoute = (row) => ({
  id: row.id,
  name: row.name,
  points: JSON.parse(row.points),
  avoid: row.avoid || '',
  active: !!row.active,
  position: row.position,
});

export async function listRoutes(env, deviceId, { activeOnly = false } = {}) {
  const sql = 'SELECT * FROM routes WHERE device_id = ?' +
    (activeOnly ? ' AND active = 1' : '') + ' ORDER BY position, created_at';
  const { results } = await env.DB.prepare(sql).bind(deviceId).all();
  return (results || []).map(rowToRoute);
}

export async function saveRoute(env, deviceId, body, id = null) {
  const name = String(body?.name || '').trim().slice(0, 40) || 'Commute';
  const points = parsePoints(body?.points);
  const avoid = String(body?.avoid || '').split(',').map((s) => s.trim())
    .filter((s) => ['tollRoads', 'motorways', 'ferries', 'unpavedRoads', 'carpools'].includes(s)).join(',');
  const active = body?.active === false ? 0 : 1;
  const position = Number.isFinite(Number(body?.position)) ? Number(body.position) : 0;

  if (id) {
    const res = await env.DB.prepare(
      'UPDATE routes SET name = ?, points = ?, avoid = ?, active = ?, position = ? WHERE id = ? AND device_id = ?',
    ).bind(name, JSON.stringify(points), avoid, active, position, id, deviceId).run();
    if (!res.meta.changes) throw new Error('route not found');
    return { id, name, points, avoid, active: !!active, position };
  }

  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM routes WHERE device_id = ?').bind(deviceId).first();
  if (count.n >= 6) throw new Error('at most 6 saved routes');
  const newId = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO routes (id, device_id, name, points, avoid, active, position, created_at) VALUES (?,?,?,?,?,?,?,?)',
  ).bind(newId, deviceId, name, JSON.stringify(points), avoid, active, count.n, Date.now()).run();
  return { id: newId, name, points, avoid, active: !!active, position: count.n };
}

export async function deleteRoute(env, deviceId, id) {
  const res = await env.DB.prepare('DELETE FROM routes WHERE id = ? AND device_id = ?').bind(id, deviceId).run();
  return res.meta.changes > 0;
}

const VALID_TZ = (tz) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

export async function updateSettings(env, device, body) {
  const next = {
    tz: VALID_TZ(body?.tz) ? body.tz : device.tz,
    window_start: fmt(parseHhMm(body?.windowStart, parseHhMm(device.window_start, 360))),
    window_end: fmt(parseHhMm(body?.windowEnd, parseHhMm(device.window_end, 410))),
    days: parseDays(Array.isArray(body?.days) ? body.days.join(',') : body?.days ?? device.days).join(','),
    refresh_min: clamp(body?.refreshMin, 5, 60, device.refresh_min),
    enabled: bool(body?.enabled, device.enabled),
    quiet_ok: bool(body?.quietOk, device.quiet_ok),
    delay_threshold: clamp(body?.delayThreshold, 1, 60, device.delay_threshold),
    units: body?.units === 'metric' || body?.units === 'imperial' ? body.units : device.units,
  };
  if (parseHhMm(next.window_end, 0) <= parseHhMm(next.window_start, 0)) {
    throw new Error('the end of the window must be after the start');
  }
  await env.DB.prepare(
    `UPDATE devices SET tz=?, window_start=?, window_end=?, days=?, refresh_min=?, enabled=?,
     quiet_ok=?, delay_threshold=?, units=? WHERE id=?`,
  ).bind(next.tz, next.window_start, next.window_end, next.days, next.refresh_min, next.enabled,
    next.quiet_ok, next.delay_threshold, next.units, device.id).run();
  return { ...device, ...next };
}

const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};
const bool = (v, fallback) => (v === true || v === 1 ? 1 : v === false || v === 0 ? 0 : fallback);

export async function setSubscription(env, deviceId, sub) {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw new Error('invalid push subscription');
  await env.DB.prepare('UPDATE devices SET sub_endpoint=?, sub_p256dh=?, sub_auth=?, last_status=NULL WHERE id=?')
    .bind(endpoint, p256dh, auth, deviceId).run();
}

export async function clearSubscription(env, deviceId, note = 'subscription removed') {
  await env.DB.prepare('UPDATE devices SET sub_endpoint=NULL, sub_p256dh=NULL, sub_auth=NULL, last_status=? WHERE id=?')
    .bind(note, deviceId).run();
}

export const subscriptionOf = (device) => (device.sub_endpoint
  ? { endpoint: device.sub_endpoint, p256dh: device.sub_p256dh, auth: device.sub_auth }
  : null);

/** Devices the cron tick needs to consider. */
export async function listActiveDevices(env, limit = 500) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM devices WHERE enabled = 1 AND sub_endpoint IS NOT NULL LIMIT ?',
  ).bind(limit).all();
  return results || [];
}

export async function markRun(env, deviceId, minute, status) {
  await env.DB.prepare('UPDATE devices SET last_run_min=?, last_status=? WHERE id=?')
    .bind(minute, String(status).slice(0, 200), deviceId).run();
}

export const publicSettings = (d) => ({
  deviceId: d.id,
  tz: d.tz,
  windowStart: d.window_start,
  windowEnd: d.window_end,
  days: parseDays(d.days),
  refreshMin: d.refresh_min,
  enabled: !!d.enabled,
  quietOk: !!d.quiet_ok,
  delayThreshold: d.delay_threshold,
  units: d.units,
  subscribed: !!d.sub_endpoint,
  lastStatus: d.last_status,
});
