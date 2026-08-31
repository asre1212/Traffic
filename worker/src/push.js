// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) implemented directly on
// WebCrypto so the Worker has no npm dependencies.

export function b64urlToBytes(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '==='.slice((pad.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

const utf8 = (s) => new TextEncoder().encode(s);

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

// Single-block HKDF (every output we need is <= 32 bytes).
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

// Rebuild a signing key from the raw 32-byte P-256 scalar + raw public point.
async function importVapidPrivateKey(privB64, pubB64) {
  const pub = b64urlToBytes(pubB64);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point');
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: bytesToB64url(b64urlToBytes(privB64)),
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function vapidHeader(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(utf8(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  })));
  const signingInput = `${header}.${payload}`;
  const key = await importVapidPrivateKey(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, utf8(signingInput),
  ));
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function encrypt(payload, p256dhB64, authB64) {
  const clientPub = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);

  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const localPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const clientKey = await crypto.subtle.importKey('raw', clientPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, local.privateKey, 256));

  // RFC 8291 §3.4: the auth secret salts the ECDH output, and the info string
  // binds the derived key to both public keys.
  const ikm = await hkdf(authSecret, shared, concat(utf8('WebPush: info\0'), clientPub, localPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concat(utf8(payload), new Uint8Array([0x02])); // 0x02 = last record
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, record));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([localPub.length]), localPub, ciphertext);
}

/**
 * Send one push message.
 * @returns {Promise<{ok: boolean, status: number, gone: boolean, error?: string}>}
 *   `gone` means the subscription is dead and should be dropped.
 */
export async function sendPush(subscription, data, env, { ttl = 1800, urgency = 'high' } = {}) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  if (payload.length > 3800) throw new Error('push payload too large');

  const body = await encrypt(payload, subscription.p256dh, subscription.auth);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
      TTL: String(ttl),
      Urgency: urgency,
      Authorization: await vapidHeader(subscription.endpoint, env),
    },
    body,
  });

  if (res.ok) return { ok: true, status: res.status, gone: false };
  const error = (await res.text().catch(() => '')).slice(0, 300);
  return { ok: false, status: res.status, gone: res.status === 404 || res.status === 410, error };
}
