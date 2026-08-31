#!/usr/bin/env node
// Generates the VAPID keypair the Worker signs push requests with.
//   npm run keys
import { webcrypto as crypto } from 'node:crypto';

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;

console.log(`
VAPID keypair generated. Keep the private key secret.

1. Put the public key in wrangler.toml under [vars]:

   VAPID_PUBLIC_KEY = "${publicKey}"

2. Store the private key as a Worker secret:

   echo "${privateKey}" | npx wrangler secret put VAPID_PRIVATE_KEY

Rotating these invalidates existing push subscriptions; the app re-subscribes
automatically the next time it is opened.
`);
