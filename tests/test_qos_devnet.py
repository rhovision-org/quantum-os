"""Contract tests for the #601 harness. No network, process launch, or devnet."""
import importlib.util
from contextlib import redirect_stdout
import io
from unittest.mock import patch
import os
import tempfile
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("qos_devnet_601", ROOT / "scripts/localnet/qos-devnet.py")
HARNESS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HARNESS)


class OperatorContract(unittest.TestCase):
    def test_reuse_local_loopback(self):
        self.assertEqual(HARNESS.safe_base("http://127.0.0.1:40403/"),
                         "http://127.0.0.1:40403")

    def test_reuse_https_remote(self):
        self.assertEqual(HARNESS.safe_base("https://node.example:443"),
                         "https://node.example:443")

    def test_reject_public_plaintext_and_admin(self):
        for url in ("http://203.0.113.10:40403", "http://127.0.0.1:40405",
                    "https://node.example:40405"):
            with self.subTest(url=url), self.assertRaises(SystemExit):
                HARNESS.safe_base(url)

    def test_reject_embedded_credentials_and_paths(self):
        for url in ("https://user:secret@node.example",
                    "https://node.example/api/status",
                    "https://node.example/#room=private",
                    "https://node.example:invalid",
                    "file:///tmp/foo"):
            with self.subTest(url=url), self.assertRaises(SystemExit):
                HARNESS.safe_base(url)

    def test_reject_foreign_owned_state_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "foreign-owned"
            state_dir.mkdir()
            real_stat = Path.stat
            foreign_stat = type("ForeignStat", (), {"st_uid": os.getuid() + 1})()

            def stat_with_foreign_owner(path, *args, **kwargs):
                if path == state_dir:
                    return foreign_stat
                return real_stat(path, *args, **kwargs)

            args = type("Args", (), {"existing_node": None, "ai": False})()
            state_file = state_dir / "state.json"
            with patch.object(HARNESS, "STATE_DIR", state_dir), patch.object(
                HARNESS, "STATE_FILE", state_file
            ), patch.object(HARNESS, "prerequisites"), patch.object(
                Path, "stat", new=stat_with_foreign_owner
            ):
                with self.assertRaisesRegex(SystemExit, "owned by another user"):
                    HARNESS.cmd_up(args)
            self.assertFalse(state_file.exists())

    def test_no_foreign_process_adoption(self):
        self.assertFalse(HARNESS.owned_alive({"pid": 999999999}))
        self.assertFalse(HARNESS.owned_alive({"pid": 0}))
        self.assertFalse(HARNESS.owned_alive({}))

    def test_proc_start_marker(self):
        self.assertIsNotNone(HARNESS.proc_birth(os.getpid()))

    def test_status_keeps_node_info_when_finality_is_unavailable(self):
        def endpoint(url):
            if url.endswith("/api/status"):
                return {"version": {"node": "rholo node test"}, "shardId": "/testnet"}
            raise OSError("finality not available")
        out = io.StringIO()
        fake = {"mode": "existing", "node_url": "http://127.0.0.1:40403",
                "services": {}, "quantum_os_revision": "ci-test"}
        with patch.object(HARNESS, "load_state", return_value=fake), patch.object(
            HARNESS, "http_json", side_effect=endpoint), patch.object(
            HARNESS, "http_ok", return_value=True), redirect_stdout(out):
            HARNESS.cmd_status(None)
        self.assertIn('"shardId": "/testnet"', out.getvalue())
        self.assertIn("last_finalized=UNAVAILABLE (OSError)", out.getvalue())


if __name__ == "__main__":
    unittest.main()
