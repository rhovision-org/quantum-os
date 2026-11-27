#!/usr/bin/env python3
"""Fresh GitHub runner only: start the owned bundled node and run two independent JS witnesses."""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import sys
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
BASE = "http://127.0.0.1:40403"

def main():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("CI-only disposable witness")
    kind = sys.argv[1] if len(sys.argv) == 2 else "memory" if len(sys.argv) == 1 else ""
    if kind not in ("memory", "vfs", "device"):
        raise SystemExit("expected memory, vfs or device")
    issue = {"memory":279,"vfs":280,"device":283}[kind]
    temp = Path(os.environ["RUNNER_TEMP"])
    witness = Path(tempfile.mkdtemp(prefix=f"qos{issue}-", dir=temp))
    for port in (40401, 40402, 40403, 40405):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", port))
    binary = ROOT / "bin/rnode"
    with binary.open("rb") as f:
        expected = hashlib.file_digest(f, "sha256").hexdigest()
    env = dict(os.environ, QOS_RNODE_DATA=str(witness / "node-data"),
               RNODE=str(binary), DEPLOYER_KEY="", QOS_MEMORY_WITNESS_DIR=str(witness))
    with (witness / "node.log").open("wb") as log:
        node = subprocess.Popen(["bash", "scripts/localnet/run-node.sh"], cwd=ROOT,
                                env=env, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True)
        try:
            deadline = time.monotonic() + 120
            while True:
                if node.poll() is not None:
                    raise RuntimeError("owned node exited before readiness")
                try:
                    with urlopen(BASE + "/api/status", timeout=5) as response:
                        status = json.load(response)
                    if status.get("shardId") and status.get("networkId"):
                        break
                except (OSError, ValueError):
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError("node readiness deadline")
                time.sleep(1)
            with Path(f"/proc/{node.pid}/exe").open("rb") as f:
                actual = hashlib.file_digest(f,"sha256").hexdigest()
            if actual != expected:
                raise RuntimeError("node executable mismatch")
            raw = Path(f"/proc/{node.pid}/stat").read_text()
            birth = raw[raw.rfind(") ")+2:].split()[19]
            for mode in ("publish","recover"):
                subprocess.run(["node",f"packages/browser/test/qos-{kind}-rholo-ci.mjs",mode], cwd=ROOT,
                               env=env,check=True,timeout=240)
                if node.poll() is not None:
                    raise RuntimeError("owned node exited during witness")
            again = Path(f"/proc/{node.pid}/stat").read_text()
            if again[again.rfind(") ")+2:].split()[19] != birth:
                raise RuntimeError("node identity changed")
            evidence=json.loads((witness/"evidence.json").read_text())
            evidence["bundled_rnode_sha256"]=actual
            evidence["same_owned_node"]=True
            evidence["publisher_and_reader_separate_processes"]=True
            evidence["source_commit"]=subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()
            out=ROOT/f"qos{issue}-rholo-evidence.json"
            out.write_text(json.dumps(evidence,indent=2)+"\n")
            (ROOT/f"qos{issue}-rholo-evidence.SHA256SUMS").write_text(hashlib.sha256(out.read_bytes()).hexdigest()+"  "+out.name+"\n")
        finally:
            if node.poll() is None:
                node.terminate()
                try:
                    node.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    node.kill()
                    node.wait(timeout=10)
        print(f"PASS: real Rholo {kind} witness; owned node stopped")

if __name__=="__main__":
    main()
