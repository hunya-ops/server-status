ALTER TABLE servers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE servers ADD COLUMN interval_seconds INTEGER NOT NULL DEFAULT 60;

CREATE TABLE administrator (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  session_version TEXT NOT NULL
);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  site_name TEXT NOT NULL DEFAULT 'Status',
  warning_percent INTEGER NOT NULL DEFAULT 90,
  retention_days INTEGER NOT NULL DEFAULT 7
);
INSERT INTO settings (id) VALUES (1);

CREATE TABLE enrollment_codes (
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  redeemed_token_hash TEXT,
  redeemed_at INTEGER
);

CREATE INDEX metrics_by_minute ON metrics (minute);
