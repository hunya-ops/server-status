-- Heartbeat coverage is independent of private metric retention. A new
-- instance starts recording on its first accepted report; no history is inferred.
CREATE TABLE uptime_tracking (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL
);

CREATE TABLE uptime_intervals (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, started_at)
) WITHOUT ROWID;

CREATE INDEX uptime_by_end ON uptime_intervals (ended_at);

CREATE TRIGGER uptime_first_report AFTER INSERT ON snapshots
BEGIN
  INSERT INTO uptime_tracking VALUES (NEW.server_id, NEW.received_at)
    ON CONFLICT (server_id) DO NOTHING;
  INSERT INTO uptime_intervals (server_id, started_at, ended_at)
  VALUES (NEW.server_id, NEW.received_at,
    NEW.received_at + (SELECT MAX(180, interval_seconds * 3) FROM servers WHERE id = NEW.server_id));
END;

CREATE TRIGGER uptime_accepted_report AFTER UPDATE ON snapshots
WHEN NEW.collected_at > OLD.collected_at
BEGIN
  INSERT INTO uptime_tracking VALUES (NEW.server_id, NEW.received_at)
    ON CONFLICT (server_id) DO NOTHING;
  INSERT INTO uptime_intervals (server_id, started_at, ended_at)
  VALUES (NEW.server_id,
    COALESCE((SELECT MAX(started_at) FROM uptime_intervals
      WHERE server_id = NEW.server_id AND ended_at >= NEW.received_at), NEW.received_at),
    NEW.received_at + (SELECT MAX(180, interval_seconds * 3) FROM servers WHERE id = NEW.server_id))
  ON CONFLICT (server_id, started_at) DO UPDATE SET ended_at = MAX(ended_at, excluded.ended_at);
END;
