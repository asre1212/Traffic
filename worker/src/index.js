// Cloudflare Worker: JSON API for the PWA + the weekday cron that pushes the
// 6am commute alert to the lock screen.

import { buildAlert, buildSweep } from './alerts.js';
import { callsForRoutes, createBudget } from './budget.js';
import { sendPush } from './push.js';
import { epochMinute, localParts, parseHhMm, tickAction } from './schedule.js';
import { checkRoute, reverseGeocode, searchPlaces } from './traffic.js';
import * as store from './store.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const fail = (message, status = 400) => json({ error: message }, status);

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

/** Window end as an absolute instant, so the phone can auto-clear the notification. */
function windowEndInstant(device, now = new Date()) {
  const local = localParts(now, device.tz);
  const end = parseHhMm(device.window_end, 410);
  const minutesLeft = end - local.minutes;
  return new Date(now.getTime() + minutesLeft * 60000).toISOString();
}

/** How long a cached check is served before the provider is asked again. */
const CACHE_FRESH_MS = 3 * 60 * 1000;
const CACHE_FLOOR_MS = 45 * 1000;   // even a forced refresh honours this

async function runRoutes(env, device, routes, budget) {
  return Promise.all(routes.map((r) => checkRoute(r, env, { units: device.units, budget })));
}

/**
 * Route checks with the free-tier guard applied: refuses up front when the
 * day's allowance cannot cover the batch, and records what was spent.
 */
async function checkWithBudget(env, device, routes) {
  const budget = await createBudget(env).load();
  if (!budget.canAfford(callsForRoutes(routes.length))) {
    const message = `Daily traffic-API budget reached (${budget.limit} calls). It resets at 00:00 UTC.`;
    return {
      budget,
      exhausted: true,
      results: routes.map((r) => ({ routeId: r.id, name: r.name, ok: false, error: message })),
    };
  }
  try {
    return { budget, exhausted: false, results: await runRoutes(env, device, routes, budget) };
  } finally {
    await budget.flush();
  }
}

async function pushTo(env, device, payload, options) {
  const sub = store.subscriptionOf(device);
  if (!sub) return { ok: false, status: 0, error: 'no subscription' };
  const res = await sendPush(sub, payload, env, options);
  if (res.gone) await store.clearSubscription(env, device.id, 'push subscription expired - re-enable alerts in the app');
  return res;
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/api';
  const method = request.method;

  if (path === '/api/health') {
    return json({
      ok: true,
      time: new Date().toISOString(),
      push: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      traffic: Boolean(env.TOMTOM_API_KEY),
    });
  }

  if (path === '/api/vapid' && method === 'GET') {
    return json({ publicKey: env.VAPID_PUBLIC_KEY || null });
  }

  if (path === '/api/device' && method === 'POST') {
    const body = await readJson(request);
    const created = await store.createDevice(env, { tz: body.tz });
    const device = await env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(created.deviceId).first();
    return json({ ...created, settings: store.publicSettings(device), routes: [] }, 201);
  }

  // Everything below needs the device bearer token.
  const device = await store.authenticate(env, request);
  if (!device) return fail('unknown device - reinstall the app to re-register', 401);

  if (path === '/api/state' && method === 'GET') {
    const budget = await createBudget(env).load();
    return json({
      settings: store.publicSettings(device),
      routes: await store.listRoutes(env, device.id),
      usage: { used: budget.used, limit: budget.limit, remaining: budget.remaining, resetsAt: `${budget.day} 24:00 UTC` },
    });
  }

  if (path === '/api/settings' && (method === 'PATCH' || method === 'PUT')) {
    try {
      const updated = await store.updateSettings(env, device, await readJson(request));
      return json({ settings: store.publicSettings({ ...updated, id: device.id }) });
    } catch (err) { return fail(err.message); }
  }

  if (path === '/api/routes' && method === 'GET') {
    return json({ routes: await store.listRoutes(env, device.id) });
  }

  if (path === '/api/routes' && method === 'POST') {
    try { return json({ route: await store.saveRoute(env, device.id, await readJson(request)) }, 201); }
    catch (err) { return fail(err.message); }
  }

  const routeMatch = /^\/api\/routes\/([\w-]+)$/.exec(path);
  if (routeMatch) {
    const id = routeMatch[1];
    if (method === 'PUT' || method === 'PATCH') {
      try { return json({ route: await store.saveRoute(env, device.id, await readJson(request), id) }); }
      catch (err) { return fail(err.message, err.message === 'route not found' ? 404 : 400); }
    }
    if (method === 'DELETE') {
      return (await store.deleteRoute(env, device.id, id)) ? json({ deleted: id }) : fail('route not found', 404);
    }
  }

  if (path === '/api/push/subscription') {
    if (method === 'PUT' || method === 'POST') {
      try {
        await store.setSubscription(env, device.id, await readJson(request));
        return json({ subscribed: true });
      } catch (err) { return fail(err.message); }
    }
    if (method === 'DELETE') {
      await store.clearSubscription(env, device.id, 'alerts turned off in the app');
      return json({ subscribed: false });
    }
  }

  if (path === '/api/push/test' && method === 'POST') {
    const routes = await store.listRoutes(env, device.id, { activeOnly: true });
    const { results } = await checkWithBudget(env, device, routes);
    const built = routes.length
      ? buildAlert(results, { ...device, quiet_ok: 1 }, { windowEndsAt: windowEndInstant(device) })
      : { payload: { kind: 'alert', tag: 'commute', title: '🚗 Test alert', body: 'Add a route to see live drive times here.' } };
    const payload = built.payload || { kind: 'alert', tag: 'commute', title: '🚗 Test alert', body: built.skip };
    const res = await pushTo(env, device, { ...payload, kind: 'test' });
    return json({ sent: res.ok, status: res.status, error: res.error, preview: payload, results });
  }

  if (path === '/api/check' && method === 'GET') {
    const routeId = url.searchParams.get('routeId');
    const forced = url.searchParams.get('force') === '1';
    let routes = await store.listRoutes(env, device.id, { activeOnly: !routeId });
    if (routeId) routes = routes.filter((r) => r.id === routeId);

    // Reopening the app, or tapping refresh twice, must not spend the allowance.
    const cached = routeId ? null : store.cachedCheck(device);
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && age < (forced ? CACHE_FLOOR_MS : CACHE_FRESH_MS)) {
      return json({
        results: cached.results,
        checkedAt: new Date(cached.at).toISOString(),
        cached: true,
        ageSeconds: Math.round(age / 1000),
      });
    }

    const { results, budget, exhausted } = await checkWithBudget(env, device, routes);
    const at = Date.now();
    if (!routeId && !exhausted) await store.saveCheck(env, device.id, results, at);
    return json({
      results,
      checkedAt: new Date(at).toISOString(),
      cached: false,
      usage: { used: budget.used, limit: budget.limit, remaining: budget.remaining },
    });
  }

  if (path === '/api/preview' && method === 'POST') {
    // Live check for a route being edited, before it is saved.
    const body = await readJson(request);
    try {
      const points = store.parsePoints(body.points);
      const budget = await createBudget(env).load();
      if (!budget.canAfford(2)) return fail(`Daily traffic-API budget reached (${budget.limit} calls)`, 429);
      try {
        const result = await checkRoute({ id: 'preview', name: body.name || 'Preview', points, avoid: body.avoid },
          env, { units: device.units, budget });
        return json({ result });
      } finally { await budget.flush(); }
    } catch (err) { return fail(err.message); }
  }

  if (path === '/api/search' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 3) return json({ results: [] });
    if (!env.TOMTOM_API_KEY) return fail('TOMTOM_API_KEY is not configured', 503);
    const budget = await createBudget(env).load();
    if (!budget.canAfford(1)) return fail(`Daily traffic-API budget reached (${budget.limit} calls)`, 429);
    try {
      return json({
        results: await searchPlaces(q, env, {
          lat: Number(url.searchParams.get('lat')),
          lon: Number(url.searchParams.get('lon')),
          budget,
        }),
      });
    } catch (err) { return fail(err.message, 502); }
    finally { await budget.flush(); }
  }

  if (path === '/api/reverse' && method === 'GET') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return fail('lat and lon are required');
    if (!env.TOMTOM_API_KEY) return fail('TOMTOM_API_KEY is not configured', 503);
    const budget = await createBudget(env).load();
    if (!budget.canAfford(1)) return fail(`Daily traffic-API budget reached (${budget.limit} calls)`, 429);
    try { return json({ place: await reverseGeocode(lat, lon, env, budget) }); }
    catch (err) { return fail(err.message, 502); }
    finally { await budget.flush(); }
  }

  return fail('not found', 404);
}

/** One cron tick for one device. */
async function tickDevice(env, device, now) {
  const decision = tickAction(device, now);
  const minute = epochMinute(now);
  if (decision.action === 'idle') return { device: device.id, ...decision };

  // A retried or overlapping tick must not double-push.
  if (minute - Number(device.last_run_min || 0) < 5) {
    return { device: device.id, action: 'idle', reason: 'already handled this slot' };
  }

  if (decision.action === 'sweep') {
    const res = await pushTo(env, device, buildSweep(), { ttl: 300, urgency: 'low' });
    await store.markRun(env, device.id, minute, res.ok ? 'window closed' : `sweep failed: ${res.status}`);
    return { device: device.id, action: 'sweep', sent: res.ok };
  }

  const routes = await store.listRoutes(env, device.id, { activeOnly: true });
  if (!routes.length) {
    await store.markRun(env, device.id, minute, 'no active routes');
    return { device: device.id, action: 'idle', reason: 'no active routes' };
  }

  const { results, exhausted } = await checkWithBudget(env, device, routes);
  if (exhausted) {
    await store.markRun(env, device.id, minute, 'skipped: daily traffic-API budget reached');
    return { device: device.id, action: 'skip', reason: 'budget exhausted' };
  }
  await store.saveCheck(env, device.id, results, now.getTime());
  const built = buildAlert(results, device, { windowEndsAt: windowEndInstant(device, now) });
  if (built.skip) {
    await store.markRun(env, device.id, minute, `skipped: ${built.skip}`);
    return { device: device.id, action: 'skip', reason: built.skip };
  }

  const res = await pushTo(env, device, built.payload, { ttl: 900, urgency: 'high' });
  await store.markRun(env, device.id, minute,
    res.ok ? `sent ${built.payload.title}` : `push failed (${res.status}) ${res.error || ''}`);
  return { device: device.id, action: 'alert', sent: res.ok, title: built.payload.title };
}

async function runCron(env, now = new Date()) {
  const devices = await store.listActiveDevices(env);
  const out = [];
  // Small batches keep subrequest concurrency sane on the Workers free tier.
  for (let i = 0; i < devices.length; i += 5) {
    const batch = devices.slice(i, i + 5);
    const settled = await Promise.allSettled(batch.map((d) => tickDevice(env, d, now)));
    for (const [j, s] of settled.entries()) {
      out.push(s.status === 'fulfilled' ? s.value : { device: batch[j].id, action: 'error', reason: String(s.reason) });
    }
  }
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env);
      } catch (err) {
        console.error('api error', err?.stack || err);
        return fail(`server error: ${err.message || err}`, 500);
      }
    }
    // Static PWA shell; the assets binding serves index.html for bare paths.
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const summary = await runCron(env, new Date(event.scheduledTime || Date.now()));
      const acted = summary.filter((s) => s.action !== 'idle');
      if (acted.length) console.log('cron', JSON.stringify(acted));
    })());
  },
};

export { runCron, tickDevice };
