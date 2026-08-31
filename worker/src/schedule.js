// Everything about "is this device inside its 06:00-06:50 weekday window right now",
// evaluated in the device's own IANA timezone (the Worker itself runs in UTC).

/** Local wall-clock fields for `date` in `tz`. */
export function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});

  const isoDay = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  const hour = Number(parts.hour) % 24; // some locales render midnight as "24"
  return {
    isoDay,
    hour,
    minute: Number(parts.minute),
    minutes: hour * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
    label: `${String(hour).padStart(2, '0')}:${parts.minute}`,
  };
}

export function parseHhMm(s, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return fallback;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins <= 24 * 60 ? mins : fallback;
}

export function parseDays(s) {
  const days = String(s || '')
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => d >= 1 && d <= 7);
  return days.length ? [...new Set(days)] : [1, 2, 3, 4, 5];
}

/**
 * Decide what the cron tick should do for one device.
 * Returns an action:
 *   'alert' - inside the window, and this tick lines up with the refresh cadence
 *   'sweep' - the window just ended; tell the phone to clear the notification
 *   'idle'  - nothing to do
 */
export function tickAction(device, now = new Date(), toleranceMin = 5) {
  const tz = device.tz || 'UTC';
  let local;
  try {
    local = localParts(now, tz);
  } catch {
    local = localParts(now, 'UTC');
  }

  const start = parseHhMm(device.window_start, 6 * 60);
  const end = parseHhMm(device.window_end, 6 * 60 + 50);
  const days = parseDays(device.days);
  const every = Math.max(5, Number(device.refresh_min) || 20);
  const base = { local, start, end, reason: '' };

  if (!device.enabled) return { ...base, action: 'idle', reason: 'disabled' };
  if (Number(device.snooze_until) > now.getTime()) return { ...base, action: 'idle', reason: 'paused' };
  if (!device.sub_endpoint) return { ...base, action: 'idle', reason: 'no subscription' };
  if (!days.includes(local.isoDay)) return { ...base, action: 'idle', reason: 'not an alert day' };

  // The window just closed: one sweep push so the notification does not linger
  // on the lock screen for the rest of the day.
  if (local.minutes >= end && local.minutes < end + toleranceMin) {
    return { ...base, action: 'sweep', reason: 'window ended' };
  }
  if (local.minutes < start || local.minutes >= end) {
    return { ...base, action: 'idle', reason: 'outside window' };
  }

  // Inside the window: fire at the start and then every `refresh_min` minutes.
  const since = local.minutes - start;
  const sinceLastSlot = since % every;
  if (sinceLastSlot >= toleranceMin) return { ...base, action: 'idle', reason: 'between refreshes' };

  return { ...base, action: 'alert', reason: since === 0 ? 'window opened' : 'refresh', slot: since - sinceLastSlot };
}

/** Epoch minute, used to make cron delivery idempotent if a tick is retried. */
export function epochMinute(now = new Date()) {
  return Math.floor(now.getTime() / 60000);
}
