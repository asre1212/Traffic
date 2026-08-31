// Round-trips a real push message: encrypt with sendPush(), then decrypt with an
// independent RFC 8291 receiver implementation. Run with `node --test test/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import { sendPush, bytesToB64url } from '../worker/src/push.js';

globalThis.crypto ??= crypto;
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary');
globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64');

const utf8 = (s) => new TextEncoder().encode(s);
const cat = (...a) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) { out.set(x, o); o += x.length; }
  return out;
};
async function hmac(k, d) {
  const key = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, d));
}
async function hkdf(salt, ikm, info, len) {
  return (await hmac(await hmac(salt, ikm), cat(info, new Uint8Array([1])))).slice(0, len);
}

test('aes128gcm payload decrypts back to the original JSON', async () => {
  // The "browser" side: subscription keys.
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  // The server's VAPID keypair.
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', vapid.privateKey);
  const vapidPub = new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey));

  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response('', { status: 201 });
  };

  const message = { title: 'Home → Work', minutes: 31, accident: true };
  const res = await sendPush(
    { endpoint: 'https://web.push.apple.com/abc123', p256dh: bytesToB64url(uaPub), auth: bytesToB64url(authSecret) },
    message,
    { VAPID_PUBLIC_KEY: bytesToB64url(vapidPub), VAPID_PRIVATE_KEY: jwk.d, VAPID_SUBJECT: 'mailto:a@b.c' },
  );
  assert.equal(res.ok, true);
  assert.equal(captured.init.headers['Content-Encoding'], 'aes128gcm');
  assert.match(captured.init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);

  // Receiver side, per RFC 8291 §3.4 / RFC 8188 §2.1.
  const body = new Uint8Array(captured.init.body);
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16), 4096);
  assert.equal(idlen, 65);

  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, cat(utf8('WebPush: info\0'), uaPub, asPub), 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));

  assert.equal(plain[plain.length - 1], 0x02);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain.slice(0, -1))), message);
});

test('410 from the push service is reported as gone', async () => {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', vapid.privateKey);
  const vapidPub = new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey));
  globalThis.fetch = async () => new Response('gone', { status: 410 });

  const res = await sendPush(
    { endpoint: 'https://web.push.apple.com/x', p256dh: bytesToB64url(uaPub), auth: bytesToB64url(crypto.getRandomValues(new Uint8Array(16))) },
    { a: 1 },
    { VAPID_PUBLIC_KEY: bytesToB64url(vapidPub), VAPID_PRIVATE_KEY: jwk.d },
  );
  assert.deepEqual({ ok: res.ok, gone: res.gone }, { ok: false, gone: true });
});
