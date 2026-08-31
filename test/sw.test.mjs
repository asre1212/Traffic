// Loads public/sw.js into a fake ServiceWorkerGlobalScope and drives real push
// events through it, so the lock-screen behaviour is covered without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function loadWorker() {
  const shown = [];
  const listeners = {};
  const posted = [];

  const notification = (title, options) => ({
    title, ...options, closed: false, close() { this.closed = true; },
  });

  const self = {
    location: { origin: 'https://commute.example' },
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => [{ url: 'https://commute.example/', focus: async () => {}, postMessage: (m) => posted.push(m) }],
      openWindow: async () => {},
    },
    registration: {
      async showNotification(title, options) {
        shown.push(notification(title, options));
      },
      async getNotifications({ tag }) {
        return shown.filter((n) => n.tag === tag && !n.closed);
      },
    },
  };

  const caches = { open: async () => ({ addAll: async () => {}, put: async () => {} }), keys: async () => [], delete: async () => {}, match: async () => undefined };
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'fetch', 'Response', SOURCE)(self, caches, globalThis.fetch, Response);

  const dispatch = async (type, event) => {
    const pending = [];
    const wrapped = { ...event, waitUntil: (p) => pending.push(p) };
    for (const fn of listeners[type] || []) fn(wrapped);
    await Promise.all(pending);
  };

  const pushEvent = (payload) => dispatch('push', { data: { json: () => payload, text: () => JSON.stringify(payload) } });
  return { shown, posted, dispatch, pushEvent, visible: () => shown.filter((n) => !n.closed) };
}

const alert = (over = {}) => ({
  kind: 'alert', tag: 'commute', title: '⚠️ 41 min · Home → Work', body: 'Accident on I-95 N +9 min',
  expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), checkedAt: new Date().toISOString(), ...over,
});

test('a push renders one lock-screen notification and wakes the open app', async () => {
  const sw = loadWorker();
  await sw.pushEvent(alert());
  assert.equal(sw.visible().length, 1);
  assert.match(sw.visible()[0].title, /41 min/);
  assert.equal(sw.visible()[0].tag, 'commute');
  assert.equal(sw.posted[0].type, 'alert');
});

test('refreshes replace the previous alert instead of stacking', async () => {
  const sw = loadWorker();
  await sw.pushEvent(alert({ title: 'first' }));
  await sw.pushEvent(alert({ title: 'second' }));
  // Same tag, and the still-valid earlier one is left for the platform to replace.
  assert.deepEqual(sw.shown.map((n) => n.tag), ['commute', 'commute']);
  assert.equal(sw.visible().at(-1).title, 'second');
});

test('an alert left over from a past window is closed on the next push', async () => {
  const sw = loadWorker();
  await sw.pushEvent(alert({ title: 'yesterday', expiresAt: new Date(Date.now() - 60000).toISOString() }));
  await sw.pushEvent(alert({ title: 'today' }));
  assert.equal(sw.shown[0].closed, true);
  assert.deepEqual(sw.visible().map((n) => n.title), ['today']);
});

test('the end-of-window sweep leaves nothing on the lock screen', async () => {
  const sw = loadWorker();
  await sw.pushEvent(alert());
  await sw.pushEvent({ kind: 'sweep', tag: 'commute', title: 'Commute window closed' });
  assert.equal(sw.visible().length, 0);
  // iOS requires every push to show something, so the sweep still posts one
  // (silent) notification before taking everything down.
  assert.equal(sw.shown.at(-1).silent, true);
  assert.equal(sw.shown.every((n) => n.closed), true);
});

test('tapping the notification dismisses it and focuses the app', async () => {
  const sw = loadWorker();
  await sw.pushEvent(alert());
  const note = sw.visible()[0];
  await sw.dispatch('notificationclick', { notification: note });
  assert.equal(note.closed, true);
});

test('a malformed payload still produces a notification rather than throwing', async () => {
  const sw = loadWorker();
  await sw.dispatch('push', { data: { json: () => { throw new Error('not json'); }, text: () => 'raw text' } });
  assert.equal(sw.visible()[0].title, 'raw text');
});
