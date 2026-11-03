-- Additive migration. Keep snapshots, metrics and their triggers for rollback.
CREATE TABLE monitor_presence (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  online INTEGER NOT NULL CHECK (online IN (0, 1)),
  since REAL NOT NULL,
  changed_at REAL NOT NULL
);
CREATE TABLE monitor_events (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  online INTEGER NOT NULL CHECK (online IN (0, 1)),
  occurred_at REAL NOT NULL,
  PRIMARY KEY (server_id, occurred_at, online)
) WITHOUT ROWID;
-- Existing installations keep their configured HTTP cadence until upgraded.
-- New nodes use five seconds in application code.
