-- D1 schema for the commute alert app.
-- Apply with: npm run db:init   (or db:init:local for `wrangler dev`)

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  tz            TEXT NOT NULL DEFAULT 'America/New_York',
  window_start  TEXT NOT NULL DEFAULT '06:00',
  window_end    TEXT NOT NULL DEFAULT '06:50',
  days          TEXT NOT NULL DEFAULT '1,2,3,4,5',   -- ISO weekdays, 1=Mon
  refresh_min   INTEGER NOT NULL DEFAULT 20,          -- refresh cadence inside the window
  enabled       INTEGER NOT NULL DEFAULT 1,
  quiet_ok      INTEGER NOT NULL DEFAULT 1,           -- 0 = only alert when traffic is bad
  units         TEXT NOT NULL DEFAULT 'imperial',
  delay_threshold INTEGER NOT NULL DEFAULT 5,         -- minutes over baseline that counts as "bad"
  sub_endpoint  TEXT,
  sub_p256dh    TEXT,
  sub_auth      TEXT,
  last_run_min  INTEGER NOT NULL DEFAULT 0,           -- epoch minute of last push, for idempotency
  last_status   TEXT
);

CREATE TABLE IF NOT EXISTS routes (
  id         TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  points     TEXT NOT NULL,      -- JSON [{lat,lon,label}] origin, waypoints..., destination
  avoid      TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS routes_by_device ON routes (device_id, position);
CREATE INDEX IF NOT EXISTS devices_enabled ON devices (enabled);
