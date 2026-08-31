import test from 'node:test';
import assert from 'node:assert/strict';
import { localParts, parseDays, parseHhMm, tickAction } from '../worker/src/schedule.js';

const device = (over = {}) => ({
  enabled: 1, sub_endpoint: 'https://push/x', tz: 'America/New_York',
  window_start: '06:00', window_end: '06:50', days: '1,2,3,4,5', refresh_min: 20, ...over,
});
// 2026-09-01 is a Tuesday. EDT is UTC-4, so 10:00Z == 06:00 local.
const at = (utc) => new Date(`2026-09-01T${utc}:00Z`);

test('local time is resolved in the device timezone, not UTC', () => {
  const p = localParts(at('10:05'), 'America/New_York');
  assert.deepEqual({ isoDay: p.isoDay, label: p.label, minutes: p.minutes }, { isoDay: 2, label: '06:05', minutes: 365 });
  assert.equal(localParts(at('10:05'), 'Europe/London').label, '11:05');
});

test('midnight is 00:00, not 24:00', () => {
  assert.equal(localParts(new Date('2026-09-01T04:00:00Z'), 'America/New_York').label, '00:00');
  assert.equal(localParts(new Date('2026-09-01T04:00:00Z'), 'America/New_York').minutes, 0);
});

test('fires at the top of the window and on the refresh cadence', () => {
  assert.equal(tickAction(device(), at('10:00')).action, 'alert');   // 06:00
  assert.equal(tickAction(device(), at('10:20')).action, 'alert');   // 06:20
  assert.equal(tickAction(device(), at('10:40')).action, 'alert');   // 06:40
  assert.equal(tickAction(device(), at('10:10')).action, 'idle');    // between refreshes
  assert.equal(tickAction(device(), at('10:30')).action, 'idle');
});

test('sweeps once when the window ends, then goes quiet', () => {
  assert.equal(tickAction(device(), at('10:50')).action, 'sweep');   // 06:50
  assert.equal(tickAction(device(), at('11:00')).action, 'idle');    // 07:00
  assert.equal(tickAction(device(), at('13:00')).action, 'idle');
});

test('nothing fires before the window or on non-alert days', () => {
  assert.equal(tickAction(device(), at('09:40')).action, 'idle');            // 05:40 Tue
  const saturday = new Date('2026-09-05T10:00:00Z');                          // Sat 06:00 local
  assert.equal(tickAction(device(), saturday).reason, 'not an alert day');
  assert.equal(tickAction(device({ days: '6,7' }), saturday).action, 'alert'); // weekend-only user
});

test('disabled or unsubscribed devices never fire', () => {
  assert.equal(tickAction(device({ enabled: 0 }), at('10:00')).reason, 'disabled');
  assert.equal(tickAction(device({ sub_endpoint: null }), at('10:00')).reason, 'no subscription');
});

test('a holiday pause silences the window until it expires', () => {
  const nextWeek = device({ snooze_until: Date.parse('2026-09-08T04:00:00Z') });
  assert.equal(tickAction(nextWeek, at('10:00')).reason, 'paused');   // 1 Sep, inside the pause
  assert.equal(tickAction(nextWeek, at('10:50')).reason, 'paused');   // not even the sweep
  // The morning the pause lapses, alerts resume on their own.
  assert.equal(tickAction(nextWeek, new Date('2026-09-08T10:00:00Z')).action, 'alert');
});

test('a pause in the past is ignored', () => {
  assert.equal(tickAction(device({ snooze_until: Date.parse('2026-08-01T00:00:00Z') }), at('10:00')).action, 'alert');
  assert.equal(tickAction(device({ snooze_until: 0 }), at('10:00')).action, 'alert');
});

test('the window survives a DST shift', () => {
  // 2026-11-01 02:00 local: EDT -> EST, so 06:00 local is now 11:00Z.
  const afterFallBack = new Date('2026-11-02T11:00:00Z'); // Monday
  assert.equal(localParts(afterFallBack, 'America/New_York').label, '06:00');
  assert.equal(tickAction(device(), afterFallBack).action, 'alert');
  assert.equal(tickAction(device(), new Date('2026-11-02T10:00:00Z')).action, 'idle'); // 05:00 local
});

test('window and day parsing falls back safely on junk input', () => {
  assert.equal(parseHhMm('6:00', 0), 360);
  assert.equal(parseHhMm('nonsense', 360), 360);
  assert.equal(parseHhMm('99:99', 360), 360);
  assert.deepEqual(parseDays('1,2,x,9'), [1, 2]);
  assert.deepEqual(parseDays(''), [1, 2, 3, 4, 5]);
});

test('a custom window and cadence are honoured', () => {
  const d = device({ window_start: '05:30', window_end: '06:15', refresh_min: 15 });
  assert.equal(tickAction(d, at('09:30')).action, 'alert');  // 05:30
  assert.equal(tickAction(d, at('09:45')).action, 'alert');  // 05:45
  assert.equal(tickAction(d, at('10:15')).action, 'sweep');  // 06:15
});

test('a pause is bounded and clearable', async () => {
  const { parseSnooze } = await import('../worker/src/store.js');
  const week = Date.now() + 7 * 86400000;
  assert.equal(parseSnooze(new Date(week).toISOString()), week);
  assert.equal(parseSnooze(null, week), 0);                       // explicit resume
  assert.equal(parseSnooze(undefined, week), week);               // field omitted: unchanged
  assert.equal(parseSnooze('2020-01-01T00:00:00Z'), 0);           // already elapsed
  assert.equal(parseSnooze('nonsense', 0), 0);
  assert.ok(parseSnooze(Date.now() + 10 * 365 * 86400000) <= Date.now() + 366 * 86400000);
});
