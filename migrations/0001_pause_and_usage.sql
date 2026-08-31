-- Only needed if you ran `npm run db:init` before the holiday-pause and
-- free-tier budget were added. A database created from the current schema.sql
-- already has these; running this on one will fail with "duplicate column".

ALTER TABLE devices ADD COLUMN snooze_until  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN last_check_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN last_results  TEXT;

CREATE TABLE IF NOT EXISTS usage (
  day   TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);
