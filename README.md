# Commute — weekday 6am traffic alerts on the iPhone lock screen

A small progressive web app you add to the iPhone Home Screen. Every weekday
morning it checks your saved route(s), and pushes the live drive time to the
lock screen — with an explicit flag when there is an **accident on your route**.
The alert appears at 06:00, refreshes while the window is open, and is cleared
again at 06:50. Nothing is sent on weekends, or outside the window. One switch
turns it off, and a pause button covers a holiday and then resumes by itself.
Everything runs on free tiers, with a guard that keeps it there.

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
  tick asks, per device, "is it a weekday inside your local window, and are
  alerts switched on?"; only then does it call the traffic API and send a push.
  Your API key never leaves the Worker.
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

## Everything here runs on free tiers

Nothing in this project requires a paid plan or a card on file, and the app is
built to stay inside the allowances rather than trusting itself not to drift
over them.

| Service | Free allowance | What this app uses |
| --- | --- | --- |
| TomTom Freemium | 2,500 non-tile requests/day, 5 req/s | **~6/day** for one route (2 calls × 3 refreshes) |
| Workers | 100,000 requests/day, 10 ms CPU each | 144 cron ticks/day + your own app opens |
| D1 | 5 GB, 5M row reads/day, 100k row writes/day | a handful of rows per morning |
| Web Push (Apple) | free, unlimited | one push per refresh |

The daily numbers to watch are TomTom's. One route checked at 06:00, 06:20 and
06:40 costs **6 of the 2,500** calls — about 0.25% of the allowance. Even five
routes refreshed every 10 minutes is 60/day. The realistic risk isn't the
morning alert; it's address searches while building routes, or leaning on the
refresh button.

**How the guard works** (`worker/src/budget.js`):

* Every provider call is claimed from a **daily budget** counted in D1 against
  the same UTC day TomTom resets on. The default cap is **2,000**, deliberately
  below the 2,500 allowance; set `DAILY_API_BUDGET` in `wrangler.toml` to change
  it. Past the cap the app stops calling out and says so, instead of collecting
  `403 - Over the limit`.
* Calls are **paced at 4/second** — under TomTom's 5 req/s ceiling — even when
  several routes are checked at once.
* Check results are **cached for 3 minutes** on the device row. Reopening the
  app, switching tabs, or tapping refresh twice costs nothing; a forced refresh
  still won't call out more than once every 45 seconds.
* A morning alert is **one batch of calls shared by all your routes**, and the
  cron does no work at all outside your window — 138 of the day's 144 ticks read
  one D1 row and stop.

Settings → Status shows the day's usage (`Traffic API today: 6 of 2000 calls`).

If you do outgrow the free tier, TomTom bills routing per 1,000 requests, but
you'd have to be checking dozens of routes every few minutes to get there.

## Setup

Requires a free Cloudflare account and a free TomTom developer key. Neither
needs a credit card. About 20 minutes end to end, most of it waiting on signups.

**0. Get the code running locally.**

```bash
git clone <this repo> && cd Traffic
npm install
npm test                              # 48 tests should pass
```

**1. Cloudflare account + CLI login.** Sign up at
<https://dash.cloudflare.com/sign-up> (Free plan), then:

```bash
npx wrangler login                    # opens a browser to authorise the CLI
npx wrangler whoami                   # confirms which account you are on
```

**2. Traffic data.** Register at <https://developer.tomtom.com>, create an app,
and copy its API key. The Freemium plan is 2,500 requests/day with no card.

```bash
npx wrangler secret put TOMTOM_API_KEY     # paste the key when prompted
```

**3. Push keys.**

```bash
npm run keys                          # prints a VAPID keypair
```

Paste the printed public key into `wrangler.toml` under `[vars]` as
`VAPID_PUBLIC_KEY`, change `VAPID_SUBJECT` to your own `mailto:` address, then
store the private key as a secret:

```bash
npx wrangler secret put VAPID_PRIVATE_KEY
```

**4. Database.**

```bash
npx wrangler d1 create commute        # prints a database_id
```

Copy that id into `wrangler.toml` under `[[d1_databases]]`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`, then create the tables:

```bash
npm run db:init
```

**5. Deploy.**

```bash
npm run deploy                        # prints https://commute.<subdomain>.workers.dev
```

Open `https://.../api/health` in a browser. It must report
`"push": true, "traffic": true` — if either is false, that key didn't land.

**6. Install on the iPhone.** Open the deployed URL in **Safari** (Chrome on iOS
cannot install a PWA), tap **Share → Add to Home Screen**, then open Commute
from the new icon — push only works from the installed app, not the tab.

**7. Set it up in the app.** On *Routes* tap **New route**, pick a start and a
destination (add waypoints if the router would otherwise pick a different way
than you drive), and **Check now** to confirm it returns a sensible drive time.
Then on *Today* tap **Enable alerts**, accept the iOS prompt, and tap
**Send test** — a notification should reach your lock screen within a few
seconds.

**8. Confirm the first real one.** The next weekday at 06:00 you should get the
alert unprompted. If it doesn't arrive, check *Settings → Status* and run
`npx wrangler tail` to see what the cron decided.

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

## Turning it off — holidays, sick days, a week away

The *Today* tab leads with a master switch and three pause buttons:

* **The switch** turns morning alerts off entirely and back on again. Off means
  the cron skips you completely — no traffic calls, no push.
* **Pause 1 wk / 2 wks / Until…** silences alerts through a date you pick, then
  **resumes on its own** on the morning after. Handy for a holiday: set it once
  and you don't have to remember to switch it back.
* Turning alerts off or pausing them also clears anything currently on the lock
  screen, so a pause taken at 06:10 takes that morning's alert with it.

The pause is stored server-side, so it holds even if the phone is off, and it
survives reinstalling the app on the same device.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Window | 06:00 – 06:50 | Local to the device's time zone, DST included |
| Days | Mon–Fri | Any subset, including weekends |
| Refresh | every 20 min | The window's cadence; the cron itself runs every 10 min |
| Flag delays over | 5 min | Above this the alert reads "slow"; double it reads "bad" |
| Alert every morning | on | Turn off to be notified only when there's an accident or a real delay |
| Units | miles | or kilometres |
| Master switch / pause | on | On the *Today* tab, not here |

## Development

```bash
npm test                     # 48 tests: push crypto, scheduling, pausing, budget guard,
                             # incident matching, notification text, SW behaviour
npm run db:init:local
npm run dev                  # http://127.0.0.1:8787
```

Put `TOMTOM_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and
`VAPID_SUBJECT` in a `.dev.vars` file for local runs. If you created your
database before the pause and budget features existed, apply
`migrations/0001_pause_and_usage.sql` once. Scheduled Workers don't
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
| `worker/src/budget.js` | Free-tier guard: daily call budget and rate pacing |
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
| "Daily traffic-API budget reached" | The guard stopped before TomTom would have. Check Settings → Status; it resets at 00:00 UTC, or raise `DAILY_API_BUDGET` (the free ceiling is 2,500). |
| No alerts and you don't know why | Check the master switch on *Today* — a holiday pause may still be running. |
| Notification lingers past 06:50 | The sweep push needs the phone to be reachable; it clears on the next push or when you open the app. |

## Privacy

An install is identified by a random device id and bearer token generated on
first launch and kept in the phone's local storage; only a hash of the token is
stored server-side. Route coordinates and settings are stored in your own D1
database, and route coordinates are sent to TomTom to get drive times. There are
no accounts, no analytics, and no third-party scripts.

---

Free-tier figures checked August 2026 against
[TomTom pricing](https://docs.tomtom.com/pricing),
[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). Providers
change their terms; re-check before relying on the numbers.
