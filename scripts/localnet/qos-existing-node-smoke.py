#!/usr/bin/env python3
"""CI-only lifecycle witness for a separately launched disposable rnode."""
import hashlib
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
BASE = "http://127.0.0.1:40403"
HARNESS = ["bash", "scripts/localnet/qos-devnet.sh"]


def status(url, context=None):
    with urlopen(url + "/api/status", timeout=5, context=context) as response:
        return json.load(response)


def identity(proc):
    assert proc.poll() is None, "independent node exited"
    raw = Path(f"/proc/{proc.pid}/stat").read_text()
    with open(f"/proc/{proc.pid}/exe", "rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    st = status(BASE)
    assert st["shardId"]
    return {"pid": proc.pid, "birth": raw[raw.rfind(") ") + 2:].split()[19],
            "binary_sha256": digest, "shardId": st["shardId"],
            "version": st.get("version"), "networkId": st.get("networkId")}


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("runner-only disposable witness")
    temp = Path(os.environ["RUNNER_TEMP"])
    run_dir = temp / "qos601-existing"
    data_dir = temp / "qos601-external-node-data"
    assert not run_dir.exists() and not data_dir.exists()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 40403))
    env = dict(os.environ, QOS_RUN_DIR=str(run_dir), QOS_RNODE_DATA=str(data_dir),
               RNODE=str(ROOT / "bin/rnode"), DEPLOYER_KEY="")
    with (temp / "qos601-external-node.log").open("wb") as log:
        node = subprocess.Popen(["bash", "scripts/localnet/run-node.sh"], cwd=ROOT,
                                env=env, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True)
        try:
            deadline = time.monotonic() + 60
            while True:
                assert node.poll() is None, "independent node exited before readiness"
                try:
                    before = identity(node)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(1)
            subprocess.run(HARNESS + ["up", "--existing-node", BASE, "--no-ai"],
                           cwd=ROOT, env=env, stdout=subprocess.DEVNULL,
                           check=True, timeout=1200)
            state = json.loads((run_dir / "state.json").read_text())
            assert state["mode"] == "existing"
            assert set(state["services"]) == {"agent", "browser", "signaling"}
            assert node.pid not in {r["pid"] for r in state["services"].values()}
            proxy = status("https://127.0.0.1:5173/rnode", ssl._create_unverified_context())
            assert proxy["shardId"] == before["shardId"]
            during = identity(node)
            assert during == before
            subprocess.run(HARNESS + ["status"], cwd=ROOT, env=env,
                           stdout=subprocess.DEVNULL, check=True, timeout=30)
            subprocess.run(HARNESS + ["down"], cwd=ROOT, env=env, check=True, timeout=30)
            assert not (run_dir / "state.json").exists()
            after = identity(node)
            assert after == before, "independent node identity changed"
            (ROOT / "qos601-existing-node.json").write_text(json.dumps({
                "scope": "disposable CI loopback; lifecycle identity and HTTP routing only",
                "before": before, "during": during, "after": after,
                "harness_owned_services": sorted(state["services"]),
                "proxy_shard_matches": True, "state_removed": True,
            }, indent=2) + "\n")
        finally:
            if (run_dir / "state.json").exists():
                subprocess.run(HARNESS + ["down"], cwd=ROOT, env=env,
                               check=False, timeout=30)
            if node.poll() is None:
                node.terminate()
            node.wait(timeout=30)


if __name__ == "__main__":
    main()
