#!/usr/bin/env python3
"""CI-only actual browser + signaling; no Rholo service is started."""
import hashlib
import os
from pathlib import Path
import socket
import sys
import ssl
import subprocess
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]

def main():
    kind=sys.argv[1] if len(sys.argv)==2 else "vfs" if len(sys.argv)==1 else ""
    if kind not in ("vfs","shell","device","init","observe"):
        raise SystemExit("expected vfs, shell, device, init or observe")
    issue={"vfs":280,"shell":281,"device":283,"init":284,"observe":285}[kind]
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("CI-only")
    for port in (4444, 5173):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", port))
    temp = Path(os.environ["RUNNER_TEMP"])
    services = []
    try:
        with (temp/"qos-vfs-signal.log").open("wb") as signal_log, (temp/"qos-vfs-browser.log").open("wb") as browser_log:
            services.append(subprocess.Popen(["node","packages/signaling/dist/index.js"],cwd=ROOT,
                env=dict(os.environ,PORT="4444"),stdout=signal_log,stderr=subprocess.STDOUT))
            services.append(subprocess.Popen(["node","node_modules/vite/bin/vite.js","--host","127.0.0.1","--strictPort"],
                cwd=ROOT/"packages/browser",stdout=browser_log,stderr=subprocess.STDOUT))
            until = time.monotonic()+90
            while True:
                if any(p.poll() is not None for p in services):
                    raise RuntimeError("owned browser or signaling service exited")
                try:
                    with urlopen("http://127.0.0.1:4444/",timeout=2) as a, urlopen(
                        "https://127.0.0.1:5173/quantum-os/",timeout=3,context=ssl._create_unverified_context()) as b:
                        if a.status==b.status==200:
                            break
                except OSError:
                    pass
                if time.monotonic()>until:
                    raise RuntimeError("disposable app readiness timed out")
                time.sleep(1)
            subprocess.run(["node",f"packages/browser/test/qos-{kind}-opfs-ci.mjs"],cwd=ROOT,check=True,timeout=240)
            evidence=ROOT/f"qos{issue}-opfs-evidence.json"
            (ROOT/f"qos{issue}-opfs-evidence.SHA256SUMS").write_text(
                hashlib.sha256(evidence.read_bytes()).hexdigest()+"  "+evidence.name+"\n")
    finally:
        for p in reversed(services):
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait(timeout=10)

if __name__=="__main__":
    main()
