import pathlib
import sqlite3
import unittest

ROOT = pathlib.Path(__file__).parents[2]


class MigrationTests(unittest.TestCase):
    def test_uptime_tracks_accepted_coverage_without_inventing_old_history(self):
        with sqlite3.connect(":memory:") as database:
            database.executescript((ROOT/"migrations/0001_servers.sql").read_text())
            database.execute("INSERT INTO servers VALUES ('existing','Private name',1,NULL)")
            database.execute("INSERT INTO snapshots VALUES ('existing',500,500,'{}')")
            for path in sorted((ROOT/"migrations").glob("*.sql")):
                if path.name != "0001_servers.sql":
                    database.executescript(path.read_text())
            self.assertEqual(database.execute("SELECT COUNT(*) FROM uptime_tracking").fetchone()[0], 0)
            def report(collected_at, received_at):
                # Use the actual ingest UPSERT: its conflict policy also applies
                # inside triggers, unlike a standalone UPDATE.
                database.execute("""INSERT INTO snapshots (server_id,collected_at,received_at,payload)
                    VALUES ('existing',?,?,'{}') ON CONFLICT (server_id) DO UPDATE SET
                    collected_at=excluded.collected_at, received_at=excluded.received_at
                    WHERE excluded.collected_at > snapshots.collected_at""", (collected_at, received_at))
            report(1000, 1000)
            report(1060, 1060)
            self.assertEqual(database.execute("SELECT started_at, ended_at FROM uptime_intervals").fetchall(), [(1000,1240)])
            # A stale/duplicate report or metadata update must not extend coverage.
            report(1060, 2000)
            report(1000, 2000)
            self.assertEqual(database.execute("SELECT ended_at FROM uptime_intervals").fetchone()[0], 1240)
            report(2000, 2000)
            self.assertEqual(database.execute("SELECT started_at, ended_at FROM uptime_intervals ORDER BY started_at").fetchall(), [(1000,1240),(2000,2180)])
            self.assertEqual(database.execute("SELECT started_at FROM uptime_tracking").fetchone()[0], 1000)
            database.execute("UPDATE servers SET interval_seconds=300")
            report(2100, 2100)
            self.assertEqual(database.execute("SELECT MAX(ended_at) FROM uptime_intervals").fetchone()[0], 3000)
            database.execute("INSERT INTO servers (id,name,sort_order) VALUES ('new','New',2)")
            database.execute("INSERT INTO snapshots (server_id,collected_at,received_at,payload) VALUES ('new',2500,2500,'{}')")
            self.assertEqual(database.execute("SELECT ended_at FROM uptime_intervals WHERE server_id='new'").fetchone()[0], 2680)

    def test_new_database_has_no_personal_or_example_servers(self):
        with sqlite3.connect(":memory:") as database:
            for path in sorted((ROOT/"migrations").glob("*.sql")):
                database.executescript(path.read_text())
            self.assertEqual(database.execute("SELECT COUNT(*) FROM servers").fetchone()[0], 0)
            self.assertEqual(database.execute("SELECT site_name, warning_percent, retention_days FROM settings").fetchone(), ("Status",90,7))

    def test_upgrade_preserves_existing_identity_credentials_and_history(self):
        with sqlite3.connect(":memory:") as database:
            database.executescript((ROOT/"migrations/0001_servers.sql").read_text())
            database.execute("INSERT INTO servers VALUES ('existing-server','Existing server',1,?)", ("a"*64,))
            database.execute("INSERT INTO snapshots VALUES ('existing-server',1000,1000,'{}')")
            database.execute("INSERT INTO metrics VALUES ('existing-server',960,20,30,40)")
            for path in sorted((ROOT/"migrations").glob("*.sql")):
                if path.name != "0001_servers.sql":
                    database.executescript(path.read_text())
            self.assertEqual(database.execute("SELECT id, token_hash, enabled, interval_seconds FROM servers").fetchone(), ("existing-server","a"*64,1,60))
            self.assertEqual(database.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0], 1)
            self.assertEqual(database.execute("SELECT payload, ip_address, country, city FROM snapshots").fetchone(), ("{}",None,None,None))
            self.assertEqual(database.execute("SELECT cpu FROM metrics").fetchone()[0], 20)
