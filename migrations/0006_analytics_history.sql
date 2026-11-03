-- One migration record per dataset; no old tables, indexes or data are changed.
CREATE TABLE history_migration (
  dataset TEXT PRIMARY KEY,
  cutover_at INTEGER NOT NULL,
  verified_at INTEGER,
  verified_points INTEGER
);
