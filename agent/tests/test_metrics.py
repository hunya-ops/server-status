import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("status_agent", pathlib.Path(__file__).parents[1] / "status_agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class MetricsTests(unittest.TestCase):
    def fixture(self, content):
        handle = tempfile.NamedTemporaryFile(mode="w", delete=False)
        handle.write(content)
        handle.close()
        self.addCleanup(pathlib.Path(handle.name).unlink)
        return handle.name

    def test_cpu_uses_deltas_without_double_counting_guest(self):
        path = self.fixture("cpu 100 10 40 800 20 5 5 20 50 5\n")
        self.assertEqual(agent.read_cpu(path), (1000, 820))
        self.assertEqual(agent.cpu_usage((1000, 820), (1200, 940)), 40)
        self.assertEqual(agent.cpu_usage((1000, 820), (900, 700)), 0)

    def test_memory_excludes_reclaimable_cache(self):
        path = self.fixture("MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 700 kB\nCached: 600 kB\n")
        result = agent.memory_metrics(path)
        self.assertEqual(result["usedBytes"], 300 * 1024)
        self.assertEqual(result["usagePercent"], 30)

    def test_mount_filter_keeps_data_disk_and_excludes_docker_duplicates(self):
        path = self.fixture("1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 8:1 /var /duplicate rw - ext4 /dev/sda1 rw\n3 1 8:2 / /data rw - xfs /dev/sdb rw\n4 1 0:1 / /proc rw - proc proc rw\n5 1 0:2 / /var/lib/docker/overlay2/a/merged rw - overlay overlay rw\n")
        value = SimpleNamespace(f_blocks=1000, f_bfree=400, f_bavail=350, f_frsize=4096)
        with patch.object(agent.os, "statvfs", return_value=value):
            result = agent.mounted_disks(path)
        self.assertEqual([disk["mount"] for disk in result], ["/", "/data"])
        self.assertEqual(result[0]["usagePercent"], 63.16)

    def test_mount_escape_sequences(self):
        self.assertEqual(agent.unescape_mount(r"/data\040space"), "/data space")


if __name__ == "__main__":
    unittest.main()
