import pathlib
import sqlite3
import unittest

ROOT = pathlib.Path(__file__).parents[2]


class MigrationTests(unittest.TestCase):
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
