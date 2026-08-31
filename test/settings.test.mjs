// Settings updates are partial patches: whatever the phone leaves out must keep
// its stored value rather than being written as undefined.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSettings, updateSettings } from '../worker/src/store.js';

const stored = (over = {}) => ({
  id: 'dev-1', tz: 'America/New_York', window_start: '06:00', window_end: '06:50',
  days: '1,2,3,4,5', refresh_min: 20, enabled: 1, quiet_ok: 1, delay_threshold: 5,
  units: 'imperial', snooze_until: 0, last_check_ms: 0, sub_endpoint: 'https://push/x', ...over,
});

function fakeDb() {
  const bound = [];
  return {
    bound,
    prepare: () => ({ bind: (...v) => (bound.push(v), { run: async () => ({ meta: { changes: 1 } }) }) }),
  };
}

test('a one-field patch leaves every other column intact', async () => {
  const DB = fakeDb();
  const next = await updateSettings({ DB }, stored(), { enabled: false });
  assert.equal(next.enabled, 0);
  assert.deepEqual(
    { tz: next.tz, start: next.window_start, days: next.days, units: next.units },
    { tz: 'America/New_York', start: '06:00', days: '1,2,3,4,5', units: 'imperial' },
  );
  assert.equal(DB.bound[0].some((v) => v === undefined), false, 'no undefined may reach D1');
});

test('an omitted or bogus time zone keeps the stored one', async () => {
  const DB = fakeDb();
  assert.equal((await updateSettings({ DB }, stored(), {})).tz, 'America/New_York');
  assert.equal((await updateSettings({ DB }, stored(), { tz: '' })).tz, 'America/New_York');
  assert.equal((await updateSettings({ DB }, stored(), { tz: 'Mars/Olympus' })).tz, 'America/New_York');
  assert.equal((await updateSettings({ DB }, stored(), { tz: 'Europe/Berlin' })).tz, 'Europe/Berlin');
  for (const call of DB.bound) assert.equal(call.some((v) => v === undefined), false);
});

test('pausing and resuming round-trip through the public shape', async () => {
  const DB = fakeDb();
  const until = Date.now() + 7 * 86400000;
  const paused = await updateSettings({ DB }, stored(), { snoozeUntil: new Date(until).toISOString() });
  assert.equal(publicSettings({ ...paused, id: 'dev-1' }).paused, true);

  const resumed = await updateSettings({ DB }, stored({ snooze_until: until }), { snoozeUntil: null });
  const shape = publicSettings({ ...resumed, id: 'dev-1' });
  assert.deepEqual({ paused: shape.paused, until: shape.snoozeUntil }, { paused: false, until: null });
});

test('an invalid window is rejected rather than half-written', async () => {
  const DB = fakeDb();
  await assert.rejects(() => updateSettings({ DB }, stored(), { windowStart: '07:00', windowEnd: '06:00' }),
    /end of the window must be after the start/);
  assert.equal(DB.bound.length, 0);
});
