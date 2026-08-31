# Commute — weekday 6am traffic alerts on the iPhone lock screen

A small progressive web app you add to the iPhone Home Screen. Every weekday
morning it checks your saved route(s), and pushes the live drive time to the
lock screen — with an explicit flag when there is an **accident on your route**.
The alert appears at 06:00, refreshes while the window is open, and is cleared
again at 06:50. Nothing is sent on weekends, or outside the window.

```
 06:00 ─────────────────── 06:50            rest of the day
 ┌───────────────────────────┐
 │ ⚠️ 41 min · Home → Work   │              (nothing)
 │ Accident on I-95 N +9 min │
 │ Usually 26 min · 18.4 mi  │
 └───────────────────────────┘
   pushed, then refreshed          swept off the lock screen
   every 20 min                    when the window closes
```

## What actually runs where

```
iPhone (installed PWA)              Cloudflare (one Worker)          TomTom
┌──────────────────────┐            ┌───────────────────────┐     ┌──────────┐
│ index.html / app.js  │  /api/*    │  worker/src/index.js  │────▶│ Routing  │
│ routes, settings, UI │◀──────────▶│  routes + settings    │     │ Incidents│
│                      │            │  ┌─────────────────┐  │     │ Search   │
│ sw.js  ── push ─────────◀─────────── │ cron */10 min   │  │     └──────────┘
│ draws + clears the   │  Web Push  │  │ in window? →push│  │
│ lock-screen alert    │            │  └─────────────────┘  │
└──────────────────────┘            │  D1: devices, routes  │
                                    └───────────────────────┘
```

* **Cloudflare Worker** — JSON API, plus a cron trigger every 10 minutes. Each
  tick asks, per device, "is it a weekday inside your local window?"; only then
  does it call the traffic API and send a push. Your API key never leaves the
  Worker.
* **D1** — routes and per-device settings. One row per install; no accounts.
* **Service worker on the phone** — receives the push, draws the notification,
  and clears it at the end of the window.

### About "lock screen" on iOS, honestly

iOS does not let a web app put a widget or a Live Activity on the lock screen —
those are native-app-only APIs. What a web app *can* do, since iOS 16.4, is
Web Push: a notification that appears on the lock screen exactly like any other
app's. That is what this app uses, and it satisfies the goal (see the drive time
and the accident flag on the lock screen at 6am without unlocking) with these
consequences:

* The app **must be added to the Home Screen** and launched from that icon once.
  Push does not work in the Safari tab.
* Alerts are **pushed on a schedule from the server**, not polled by the phone;
  a web app cannot wake itself in the background.
* Refreshes reuse one notification tag, so the morning shows **one** alert that
  updates, not a stack.
* At 06:50 the server sends a sweep message and the service worker closes the
  notification. iOS requires every push to display *something*, so the sweep
  briefly posts a silent placeholder and takes it straight back down.

## Setup

Requires a free Cloudflare account and a free TomTom developer key.

```bash
npm install
```

**1. Traffic data.** Create a key at <https://developer.tomtom.com> (free tier
covers 2,500 requests/day; this app uses roughly 2 per route per refresh, so a
single route on a 20-minute cadence costs about 6 requests each morning).

```bash
npx wrangler secret put TOMTOM_API_KEY
```

**2. Push keys.**

```bash
npm run keys          # prints a VAPID keypair
```

Paste the public key into `wrangler.toml` under `[vars]`, set `VAPID_SUBJECT`
to your own `mailto:`, and store the private key as a secret:

```bash
npx wrangler secret put VAPID_PRIVATE_KEY
```

**3. Database.**

```bash
npx wrangler d1 create commute      # copy the database_id into wrangler.toml
npm run db:init
```

**4. Deploy.**

```bash
npm run deploy
```

**5. Install on the iPhone.** Open the deployed URL in **Safari** (not Chrome),
tap **Share → Add to Home Screen**, then open Commute from the new icon. On the
*Routes* tab add a route; on *Today* tap **Enable alerts** and accept the
notification prompt; tap **Send test** to confirm one lands on the lock screen.

A custom domain is worth adding (`workers.dev` subdomains work, but the push
subscription is bound to the origin — if you move the app later you re-enable
alerts once).

## Routes

A route is an ordered list of points: start, any number of waypoints, then the
destination (up to 12 points, 6 saved routes). Waypoints are how you pin the
route to the roads you actually drive — add one on the highway you take, and the
drive time and the accident scan follow that path instead of whatever the router
would otherwise pick. Pick points by searching an address, by pasting
`latitude, longitude`, or with **Use GPS**. Per route you can also avoid tolls,
highways or ferries, and pause a route so it stays available in the app but is
left out of the morning alert.

Every active route is checked each morning. The alert leads with the route that
has an accident on it, or with the first route otherwise.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Window | 06:00 – 06:50 | Local to the device's time zone, DST included |
| Days | Mon–Fri | Any subset, including weekends |
| Refresh | every 20 min | The window's cadence; the cron itself runs every 10 min |
| Flag delays over | 5 min | Above this the alert reads "slow"; double it reads "bad" |
| Alert every morning | on | Turn off to be notified only when there's an accident or a real delay |
| Units | miles | or kilometres |
| Morning alerts | on | Master switch |

## Development

```bash
npm test                     # 34 tests: push crypto, scheduling, incident matching, SW behaviour
npm run db:init:local
npm run dev                  # http://127.0.0.1:8787
```

Put `TOMTOM_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and
`VAPID_SUBJECT` in a `.dev.vars` file for local runs. Scheduled Workers don't
fire automatically in `wrangler dev`; trigger a tick by hand:

```bash
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*"
npx wrangler tail            # watch what the deployed cron decided
```

### Layout

| Path | Purpose |
| --- | --- |
| `worker/src/index.js` | API routes and the cron handler |
| `worker/src/schedule.js` | Time-zone-aware "should this device be alerted now" |
| `worker/src/traffic.js` | TomTom routing + incident matching (the only provider-specific file) |
| `worker/src/alerts.js` | Turns route results into the notification text |
| `worker/src/push.js` | VAPID + aes128gcm Web Push, on WebCrypto, no dependencies |
| `worker/src/store.js` | D1 queries and the per-install bearer token |
| `public/` | The PWA: shell, service worker, manifest, icons |

Incidents are matched to the route by hashing the returned route geometry into
~250 m cells and keeping only incidents whose geometry falls in one — a bounding
box alone would flag a crash on a parallel road you never touch.

### Using a different traffic provider

`worker/src/traffic.js` is the only file that knows about TomTom. Keep
`checkRoute`, `searchPlaces` and `reverseGeocode` returning the same shapes
(`test/traffic.test.mjs` pins them) and HERE, Google Routes or Mapbox drop in.
TomTom is the default because its free tier includes the incident feed that the
accident flag depends on.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Enable alerts" says to add to the Home Screen | Safari tab, not the installed app. iOS only allows push from the installed app. |
| Test alert works, 6am alert doesn't | Check *Settings → Status*, and `npx wrangler tail`. The window, days and time zone are all per-device. |
| Alert stops arriving after a while | iOS drops push subscriptions for apps left unused for weeks. Open the app and tap **Enable alerts** again. |
| Drive times show `n/a` | `TOMTOM_API_KEY` missing, out of quota, or the route has an unreachable point. The error text is on the card. |
| Notification lingers past 06:50 | The sweep push needs the phone to be reachable; it clears on the next push or when you open the app. |

## Privacy

An install is identified by a random device id and bearer token generated on
first launch and kept in the phone's local storage; only a hash of the token is
stored server-side. Route coordinates and settings are stored in your own D1
database, and route coordinates are sent to TomTom to get drive times. There are
no accounts, no analytics, and no third-party scripts.
