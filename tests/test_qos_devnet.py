"""Contract tests for the #601 harness. No network, process launch, or devnet."""
import importlib.util
import os
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

    def test_no_foreign_process_adoption(self):
        self.assertFalse(HARNESS.owned_alive({"pid": 999999999}))
        self.assertFalse(HARNESS.owned_alive({"pid": 0}))
        self.assertFalse(HARNESS.owned_alive({}))

    def test_proc_start_marker(self):
        self.assertIsNotNone(HARNESS.proc_birth(os.getpid()))


if __name__ == "__main__":
    unittest.main()
