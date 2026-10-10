import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bootstrap", pathlib.Path(__file__).parents[1] / "bootstrap.py")
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def test_accepts_default_and_custom_https_origins(self):
        self.assertEqual(bootstrap.origin("https://status.example.com/"), "https://status.example.com")
        self.assertEqual(bootstrap.origin("https://status-monitor.example-account.workers.dev/"), "https://status-monitor.example-account.workers.dev")
        for value in ("http://status.example.com", "http://status-monitor.example-account.workers.dev", "https://user:pass@status.example.com", "https://status.example.com/path", "https://status.example.com?token=secret"):
            with self.assertRaises(ValueError):
                bootstrap.origin(value)

    def test_lost_response_retries_the_same_credential_and_writes_private_config(self):
        with tempfile.TemporaryDirectory() as directory:
            pending, output = pathlib.Path(directory)/"pending.json", pathlib.Path(directory)/"config.json"
            with patch.object(bootstrap.urllib.request.OpenerDirector, "open", side_effect=urllib.error.URLError("lost response")):
                with self.assertRaises(urllib.error.URLError):
                    bootstrap.enroll("https://status-monitor.example-account.workers.dev", "test-server", "a"*64, pending, output)
            token = json.loads(pending.read_text())["token"]
            self.assertFalse(output.exists())
            response = io.BytesIO(json.dumps({"ok":True, "serverId":"test-server", "interval":60}).encode())
            with patch.object(bootstrap.urllib.request.OpenerDirector, "open", return_value=response) as opened:
                bootstrap.enroll("https://status-monitor.example-account.workers.dev", "test-server", "a"*64, pending, output)
            self.assertEqual(json.loads(output.read_text())["token"], token)
            self.assertEqual(json.loads(opened.call_args.args[0].data)["token"], token)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("enrollmentHash", json.loads(output.read_text()))

    def test_refuses_to_forward_credentials_on_redirect(self):
        handler = bootstrap.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, "redirect", {}, "https://other.example.com"))
