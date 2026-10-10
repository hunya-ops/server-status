CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  token_hash TEXT
);

CREATE TABLE snapshots (
  server_id TEXT PRIMARY KEY REFERENCES servers(id),
  collected_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE metrics (
  server_id TEXT NOT NULL REFERENCES servers(id),
  minute INTEGER NOT NULL,
  cpu REAL NOT NULL,
  memory REAL NOT NULL,
  disk REAL NOT NULL,
  PRIMARY KEY (server_id, minute)
) WITHOUT ROWID;

CREATE TABLE login_attempts (
  address_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
