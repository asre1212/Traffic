// Commute PWA front end. No framework: one module, direct DOM.

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const DEVICE_KEY = 'commute.device';
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const state = {
  device: null,      // { deviceId, token }
  settings: null,
  routes: [],
  results: [],
  usage: null,       // traffic-API calls used today, against the free-tier budget
  editing: null,     // route draft while the editor is open
};

/* ---------------------------------------------------------------- API --- */

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && state.device) headers.Authorization = `Bearer ${state.device.token}`;

  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth) {
    localStorage.removeItem(DEVICE_KEY);
    state.device = null;
    throw new Error('This install lost its registration. Pull to refresh to start over.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function ensureDevice() {
  const saved = localStorage.getItem(DEVICE_KEY);
  if (saved) {
    state.device = JSON.parse(saved);
    return;
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const created = await api('/api/device', { method: 'POST', body: { tz }, auth: false });
  state.device = { deviceId: created.deviceId, token: created.token };
  localStorage.setItem(DEVICE_KEY, JSON.stringify(state.device));
}

/* ------------------------------------------------------------- status --- */

let statusTimer;
function status(message, kind = '') {
  const node = $('#status');
  node.className = `status ${kind}`;
  node.textContent = message;
  node.hidden = !message;
  clearTimeout(statusTimer);
  if (message && kind !== 'err') statusTimer = setTimeout(() => { node.hidden = true; }, 6000);
}

const isStandalone = () => window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;

/* --------------------------------------- master switch & holiday pause --- */

const DATE_FMT = { weekday: 'short', day: 'numeric', month: 'short' };

/** Local midnight `days` from now - "paused until Monday" means alerts resume that morning. */
function localMidnightIn(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date;
}

function renderMaster() {
  const s = state.settings;
  if (!s) return;
  const paused = Boolean(s.snoozeUntil) && new Date(s.snoozeUntil) > new Date();
  const on = s.enabled && !paused;

  $('#master-toggle').setAttribute('aria-checked', String(on));
  $('#master-card').classList.toggle('paused', paused);
  $('#resume').hidden = !paused;
  for (const button of document.querySelectorAll('.pauses button')) button.disabled = !s.enabled;

  $('#master-sub').textContent = !s.enabled
    ? 'Off. No alerts until you switch this back on.'
    : paused
      ? `Paused until ${new Date(s.snoozeUntil).toLocaleDateString([], DATE_FMT)} — nothing will be sent before then.`
      : `${s.days.map((d) => DAY_LABELS[d - 1]).join(' ')} · ${s.windowStart}–${s.windowEnd}`;
}

async function patchSettings(body, note) {
  try {
    const { settings } = await api('/api/settings', { method: 'PATCH', body });
    state.settings = settings;
    renderMaster();
    fillSettings(settings);
    renderAlertState(await pushState());
    if (note) status(note, 'good');
    // Nothing should be left on the lock screen once alerts are off or paused.
    if (!settings.enabled || settings.paused) {
      const registration = await navigator.serviceWorker?.getRegistration();
      registration?.active?.postMessage({ type: 'clear-notifications' });
    }
  } catch (err) {
    status(err.message, 'err');
  }
}

async function pauseFor(days) {
  const until = localMidnightIn(days);
  await patchSettings({ snoozeUntil: until.toISOString(), enabled: true },
    `Paused until ${until.toLocaleDateString([], DATE_FMT)}`);
}

/* --------------------------------------------------------- today view --- */

function severityClass(r) {
  if (!r.ok) return 'unknown';
  if (r.hasAccident || r.hasClosure) return 'bad';
  const threshold = state.settings?.delayThreshold || 5;
  if (r.delayMinutes >= threshold * 2) return 'bad';
  if (r.delayMinutes >= threshold) return 'slow';
  return 'ok';
}

function renderLive() {
  const host = $('#routes-live');
  host.textContent = '';
  $('#empty-live').hidden = state.routes.length > 0;

  for (const result of state.results) {
    const card = el('div', `route ${severityClass(result)}`);
    const top = el('div', 'top');
    if (result.ok) {
      const mins = el('div', 'mins', String(result.minutes));
      mins.append(el('small', null, 'min'));
      top.append(mins);
    } else {
      top.append(el('div', 'mins', 'n/a'));
    }
    top.append(el('div', 'name', result.name));
    card.append(top);

    if (result.ok) {
      const delta = result.delayMinutes > 0 ? `+${result.delayMinutes} vs usual ${result.baselineMinutes}`
        : result.delayMinutes < 0 ? `${result.delayMinutes} vs usual ${result.baselineMinutes}`
          : `on par with the usual ${result.baselineMinutes} min`;
      card.append(el('div', 'sub', `${delta} · ${result.distance.value} ${result.distance.unit}`));

      const flags = el('div', 'flags');
      if (!result.incidents.length) flags.append(el('span', 'flag off', 'No incidents on route'));
      for (const incident of result.incidents.slice(0, 4)) {
        const bits = [incident.type];
        if (incident.road || incident.where) bits.push(incident.road || incident.where);
        if (incident.delayMinutes) bits.push(`+${incident.delayMinutes} min`);
        flags.append(el('span', `flag ${incident.isAccident ? 'accident' : ''}`, bits.join(' · ')));
      }
      card.append(flags);
    } else {
      card.append(el('div', 'sub', result.error));
    }
    host.append(card);
  }
}

async function refreshLive({ quiet = false, force = false } = {}) {
  if (!state.routes.length) { state.results = []; renderLive(); return; }
  if (!quiet) status('Checking traffic…');
  try {
    const data = await api(`/api/check${force ? '?force=1' : ''}`);
    state.results = data.results;
    if (data.usage) state.usage = data.usage;
    renderLive();
    const at = new Date(data.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (!quiet) status(data.cached ? `As of ${at} (cached)` : `Updated ${at}`, 'good');
  } catch (err) {
    status(err.message, 'err');
  }
}

/* -------------------------------------------------------- routes view --- */

function renderRoutes() {
  const host = $('#route-list');
  host.textContent = '';
  for (const route of state.routes) {
    const card = el('button', 'route');
    card.type = 'button';
    card.append(el('div', 'name', route.name));
    card.append(el('div', 'sub', route.points.map((p) => p.label || `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`).join('  →  ')));
    const flags = el('div', 'flags');
    flags.append(el('span', `flag ${route.active ? '' : 'off'}`, route.active ? 'In morning alert' : 'Paused'));
    if (route.points.length > 2) flags.append(el('span', 'flag off', `${route.points.length - 2} waypoint(s)`));
    if (route.avoid) flags.append(el('span', 'flag off', `avoids ${route.avoid.replace(/([A-Z])/g, ' $1').toLowerCase()}`));
    card.append(flags);
    card.addEventListener('click', () => openEditor(route));
    host.append(card);
  }
  if (!state.routes.length) host.append(el('p', 'muted center', 'No routes yet.'));
}

/* ------------------------------------------------------- route editor --- */

const blankPoint = () => ({ lat: null, lon: null, label: '' });

function openEditor(route) {
  state.editing = route
    ? { ...route, points: route.points.map((p) => ({ ...p })), avoid: route.avoid || '' }
    : { id: null, name: '', points: [blankPoint(), blankPoint()], avoid: '', active: true };

  $('#editor-title').textContent = route ? 'Edit route' : 'New route';
  $('#route-name').value = state.editing.name;
  $('#route-active').checked = state.editing.active !== false;
  $('#delete-route').hidden = !route;
  $('#editor-msg').textContent = '';
  for (const box of document.querySelectorAll('.avoid input')) {
    box.checked = state.editing.avoid.split(',').includes(box.value);
  }
  renderPoints();
  $('#editor').showModal();
}

function renderPoints() {
  const host = $('#points');
  host.textContent = '';
  const points = state.editing.points;
  points.forEach((point, index) => {
    const row = el('div', 'point');
    const kind = index === 0 ? 'A' : index === points.length - 1 ? 'B' : String(index);
    row.append(el('div', 'pin', kind));

    const pick = el('button', `pick${point.lat == null ? ' empty' : ''}`,
      point.label || (point.lat == null
        ? (index === 0 ? 'Start' : index === points.length - 1 ? 'Destination' : 'Waypoint')
        : `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`));
    pick.type = 'button';
    pick.addEventListener('click', async () => {
      const place = await pickPlace(kind === 'A' ? 'Start' : kind === 'B' ? 'Destination' : 'Waypoint');
      if (!place) return;
      points[index] = place;
      renderPoints();
    });
    row.append(pick);

    if (points.length > 2 && index !== 0 && index !== points.length - 1) {
      const drop = el('button', 'ghost drop', '✕');
      drop.type = 'button';
      drop.setAttribute('aria-label', 'Remove waypoint');
      drop.addEventListener('click', () => { points.splice(index, 1); renderPoints(); });
      row.append(drop);
    }
    host.append(row);
  });
}

function editorPayload() {
  const points = state.editing.points.filter((p) => p.lat != null);
  return {
    name: $('#route-name').value.trim() || 'Commute',
    points,
    active: $('#route-active').checked,
    avoid: [...document.querySelectorAll('.avoid input:checked')].map((b) => b.value).join(','),
  };
}

async function saveRoute() {
  const payload = editorPayload();
  if (payload.points.length < 2) { $('#editor-msg').textContent = 'Pick a start and a destination first.'; return; }
  try {
    const path = state.editing.id ? `/api/routes/${state.editing.id}` : '/api/routes';
    await api(path, { method: state.editing.id ? 'PUT' : 'POST', body: payload });
    $('#editor').close();
    await loadState();
    await refreshLive({ quiet: true });
    status('Route saved', 'good');
  } catch (err) {
    $('#editor-msg').textContent = err.message;
  }
}

/* ------------------------------------------------------- place picker --- */

let pickerResolve = null;
let pickerTimer = null;

function pickPlace(title) {
  $('#picker-title').textContent = title;
  $('#picker-q').value = '';
  $('#picker-results').textContent = '';
  $('#picker-msg').textContent = 'Search an address, or paste "lat, lon".';
  $('#picker').showModal();
  $('#picker-q').focus();
  return new Promise((resolve) => { pickerResolve = resolve; });
}

function closePicker(value) {
  $('#picker').close();
  const resolve = pickerResolve;
  pickerResolve = null;
  if (resolve) resolve(value || null);
}

function showPlaces(places) {
  const list = $('#picker-results');
  list.textContent = '';
  for (const place of places) {
    const item = el('li');
    const button = el('button', 'ghost', place.label);
    button.type = 'button';
    button.addEventListener('click', () => closePicker(place));
    item.append(button);
    list.append(item);
  }
}

async function runSearch(query) {
  const coords = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(query);
  if (coords) {
    const [lat, lon] = [Number(coords[1]), Number(coords[2])];
    showPlaces([{ label: `${lat}, ${lon}`, lat, lon }]);
    $('#picker-msg').textContent = 'Tap to use these coordinates.';
    return;
  }
  if (query.trim().length < 3) { showPlaces([]); return; }
  $('#picker-msg').textContent = 'Searching…';
  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(query)}`);
    showPlaces(results);
    $('#picker-msg').textContent = results.length ? '' : 'Nothing found.';
  } catch (err) {
    $('#picker-msg').textContent = err.message;
  }
}

/* ----------------------------------------------------------- settings --- */

let daysSelected = [1, 2, 3, 4, 5];

function renderDays() {
  const host = $('#set-days');
  host.textContent = '';
  DAY_LABELS.forEach((label, i) => {
    const iso = i + 1;
    const button = el('button', daysSelected.includes(iso) ? 'on' : '', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      daysSelected = daysSelected.includes(iso)
        ? daysSelected.filter((d) => d !== iso)
        : [...daysSelected, iso].sort();
      renderDays();
    });
    host.append(button);
  });
}

function fillSettings(s) {
  $('#set-start').value = s.windowStart;
  $('#set-end').value = s.windowEnd;
  $('#set-refresh').value = String(s.refreshMin);
  $('#set-tz').value = s.tz;
  $('#set-threshold').value = String(s.delayThreshold);
  $('#set-quiet').checked = s.quietOk;
  $('#set-units').value = s.units;
  daysSelected = s.days;
  renderDays();
  renderDiagnostics();
}

async function renderDiagnostics() {
  const s = state.settings;
  const lines = [
    s.paused
      ? `Alerts paused until ${new Date(s.snoozeUntil).toLocaleDateString([], DATE_FMT)}`
      : `Alerts ${s.enabled ? 'on' : 'off'} · ${s.windowStart}–${s.windowEnd} ${s.tz}`,
    `Days: ${s.days.map((d) => DAY_LABELS[d - 1]).join(', ') || 'none'}`,
    `Push subscription: ${s.subscribed ? 'registered' : 'not registered'}`,
    `Installed to Home Screen: ${isStandalone() ? 'yes' : 'no'}`,
    s.lastStatus ? `Last run: ${s.lastStatus}` : 'Last run: not yet',
    state.usage
      ? `Traffic API today: ${state.usage.used} of ${state.usage.limit} calls (resets 00:00 UTC)`
      : 'Traffic API today: unknown',
  ];
  try {
    const health = await api('/api/health', { auth: false });
    lines.push(`Server: push ${health.push ? 'configured' : 'MISSING KEYS'}, traffic ${health.traffic ? 'configured' : 'MISSING KEY'}`);
  } catch { lines.push('Server: unreachable'); }
  $('#diag').textContent = lines.join('\n');
  $('#diag').style.whiteSpace = 'pre-line';
}

async function saveSettings() {
  try {
    const { settings } = await api('/api/settings', {
      method: 'PATCH',
      body: {
        windowStart: $('#set-start').value,
        windowEnd: $('#set-end').value,
        days: daysSelected,
        refreshMin: Number($('#set-refresh').value),
        tz: $('#set-tz').value.trim(),
        delayThreshold: Number($('#set-threshold').value),
        quietOk: $('#set-quiet').checked,
        units: $('#set-units').value,
      },
    });
    state.settings = settings;
    fillSettings(settings);
    renderMaster();
    status('Settings saved', 'good');
  } catch (err) {
    status(err.message, 'err');
  }
}

/* --------------------------------------------------------------- push --- */

function urlB64ToBytes(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function renderAlertState(message) {
  $('#alert-state').textContent = message;
}

async function pushState() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'This browser cannot deliver lock-screen alerts. On iPhone use Safari, and add the app to the Home Screen.';
  }
  if (!isStandalone()) return 'Add Commute to your Home Screen, then open it from the icon to enable alerts.';
  if (Notification.permission === 'denied') {
    return 'Notifications are blocked. Turn them back on in Settings → Notifications → Commute.';
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription && state.settings?.subscribed) {
    return `Ready. You will get one alert at ${state.settings.windowStart}, refreshed every ${state.settings.refreshMin} min until ${state.settings.windowEnd}.`;
  }
  return 'Alerts are not enabled yet on this iPhone.';
}

async function enablePush() {
  try {
    // requestPermission() must be the first thing after the tap on iOS.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      renderAlertState('Permission denied. Enable it in Settings → Notifications → Commute.');
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/vapid', { auth: false });
    if (!publicKey) throw new Error('Server has no VAPID public key configured.');

    let subscription = await registration.pushManager.getSubscription();
    if (subscription && subscription.options?.applicationServerKey) {
      const current = new Uint8Array(subscription.options.applicationServerKey);
      const wanted = urlB64ToBytes(publicKey);
      if (current.length !== wanted.length || current.some((b, i) => b !== wanted[i])) {
        await subscription.unsubscribe();       // server keys rotated
        subscription = null;
      }
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToBytes(publicKey),
      });
    }
    await api('/api/push/subscription', { method: 'PUT', body: subscription.toJSON() });
    state.settings.subscribed = true;
    renderAlertState(await pushState());
    status('Lock-screen alerts enabled', 'good');
    renderDiagnostics();
  } catch (err) {
    renderAlertState(`Could not enable alerts: ${err.message}`);
  }
}

async function sendTestPush() {
  status('Sending test alert…');
  try {
    const res = await api('/api/push/test', { method: 'POST' });
    status(res.sent ? 'Test alert sent — check your lock screen.' : `Push rejected (${res.status}). ${res.error || ''}`,
      res.sent ? 'good' : 'err');
    if (res.results?.length) { state.results = res.results; renderLive(); }
  } catch (err) {
    status(err.message, 'err');
  }
}

/* --------------------------------------------------------------- boot --- */

async function loadState() {
  const data = await api('/api/state');
  state.settings = data.settings;
  state.routes = data.routes;
  state.usage = data.usage || state.usage;
  fillSettings(data.settings);
  renderMaster();
  renderRoutes();
  renderAlertState(await pushState());
}

function showTab(name) {
  for (const tab of document.querySelectorAll('.tab')) tab.hidden = tab.id !== `tab-${name}`;
  for (const button of document.querySelectorAll('.tabbtn')) button.classList.toggle('on', button.dataset.tab === name);
  if (name === 'settings') renderDiagnostics();
}

function wireEvents() {
  for (const button of document.querySelectorAll('.tabbtn')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
  $('#refresh').addEventListener('click', () => refreshLive({ force: true }));

  $('#master-toggle').addEventListener('click', () => {
    const on = $('#master-toggle').getAttribute('aria-checked') === 'true';
    // Switching on also lifts any holiday pause.
    patchSettings({ enabled: !on, ...(on ? {} : { snoozeUntil: null }) },
      on ? 'Morning alerts off' : 'Morning alerts on');
  });
  $('#resume').addEventListener('click', () => patchSettings({ snoozeUntil: null, enabled: true }, 'Alerts resumed'));
  for (const button of document.querySelectorAll('.pauses button')) {
    button.addEventListener('click', () => {
      if (button.dataset.pause !== 'custom') { pauseFor(Number(button.dataset.pause)); return; }
      const picker = $('#pause-date');
      picker.hidden = false;
      picker.min = localMidnightIn(1).toISOString().slice(0, 10);
      picker.showPicker?.() ?? picker.focus();
    });
  }
  $('#pause-date').addEventListener('change', (event) => {
    if (!event.target.value) return;
    const until = new Date(`${event.target.value}T00:00:00`);   // local midnight
    $('#pause-date').hidden = true;
    patchSettings({ snoozeUntil: until.toISOString(), enabled: true },
      `Paused until ${until.toLocaleDateString([], DATE_FMT)}`);
  });
  $('#add-route').addEventListener('click', () => openEditor(null));
  $('#save-route').addEventListener('click', saveRoute);
  $('#add-waypoint').addEventListener('click', () => {
    state.editing.points.splice(state.editing.points.length - 1, 0, blankPoint());
    renderPoints();
  });
  $('#delete-route').addEventListener('click', async () => {
    if (!confirm('Delete this route?')) return;
    await api(`/api/routes/${state.editing.id}`, { method: 'DELETE' });
    $('#editor').close();
    await loadState();
    await refreshLive({ quiet: true });
  });
  $('#preview-route').addEventListener('click', async () => {
    const payload = editorPayload();
    if (payload.points.length < 2) { $('#editor-msg').textContent = 'Pick a start and a destination first.'; return; }
    $('#editor-msg').textContent = 'Checking…';
    try {
      const { result } = await api('/api/preview', { method: 'POST', body: payload });
      $('#editor-msg').textContent = result.ok
        ? `${result.minutes} min now (usual ${result.baselineMinutes}), ${result.distance.value} ${result.distance.unit}` +
          (result.incidents.length ? ` · ${result.incidents.length} incident(s), ${result.accidents.length} accident(s)` : ' · no incidents')
        : result.error;
    } catch (err) { $('#editor-msg').textContent = err.message; }
  });

  $('#picker-cancel').addEventListener('click', () => closePicker(null));
  $('#picker').addEventListener('cancel', (event) => { event.preventDefault(); closePicker(null); });
  $('#picker-q').addEventListener('input', (event) => {
    clearTimeout(pickerTimer);
    const value = event.target.value;
    pickerTimer = setTimeout(() => runSearch(value), 350);
  });
  $('#picker-here').addEventListener('click', () => {
    $('#picker-msg').textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(async (position) => {
      const { latitude: lat, longitude: lon } = position.coords;
      try {
        const { place } = await api(`/api/reverse?lat=${lat}&lon=${lon}`);
        closePicker(place);
      } catch {
        closePicker({ label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon });
      }
    }, (err) => { $('#picker-msg').textContent = `Location unavailable: ${err.message}`; }, { timeout: 10000 });
  });

  $('#save-settings').addEventListener('click', saveSettings);
  $('#enable-push').addEventListener('click', enablePush);
  $('#test-push').addEventListener('click', sendTestPush);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshLive({ quiet: true });
  });
  // The service worker forwards each delivered alert so the app opens on fresh data.
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'alert') refreshLive({ quiet: true });
  });
}

async function boot() {
  $('#install-hint').hidden = isStandalone();
  wireEvents();
  showTab('today');

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js', { scope: '/' }); }
    catch (err) { status(`Service worker failed: ${err.message}`, 'err'); }
  }
  try {
    await ensureDevice();
    await loadState();
    await refreshLive({ quiet: true });
  } catch (err) {
    status(err.message, 'err');
  }
}

boot();
