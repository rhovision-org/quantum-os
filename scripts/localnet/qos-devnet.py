#!/usr/bin/env python3
"""QuantumOS + Rholo dev/operator harness (#601).

Linux workstation only. This script launches only process groups it owns.
The existing-node mode is read-only with respect to the Rholo node.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = Path(os.environ.get("QOS_RUN_DIR", str(Path(tempfile.gettempdir()) / f"qos-devnet-{os.getuid()}"))).expanduser()
STATE_FILE = STATE_DIR / "state.json"
NODE_PORT = 40403
SIGNAL_PORT = 4444
BROWSER_PORT = 5173


def fail(message: str) -> None:
    raise SystemExit(f"qos-devnet: {message}")


def atomic_json(path: Path, value: dict) -> None:
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    with tmp.open("x", encoding="utf-8") as handle:
        os.chmod(tmp, 0o600)
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    if STATE_FILE.is_symlink():
        fail("refusing symlinked state file")
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))


def proc_birth(pid: int) -> str | None:
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
        return raw[raw.rfind(") ") + 2:].split()[19]
    except (OSError, IndexError, ValueError):
        return None


def owned_alive(record: dict) -> bool:
    try:
        pid = int(record["pid"])
        if pid < 2 or os.getpgid(pid) != pid:
            return False
        if record.get("birth") is not None and proc_birth(pid) != record["birth"]:
            return False
        return os.stat(f"/proc/{pid}").st_uid == os.getuid()
    except (OSError, KeyError, ValueError):
        return False


def terminate_owned(record: dict) -> None:
    if not owned_alive(record):
        return
    pid = int(record["pid"])
    os.killpg(pid, signal.SIGTERM)
    for _ in range(35):
        time.sleep(0.1)
        if not owned_alive(record):
            return
    # Never escalate to SIGKILL automatically: node might be writing state.
    print(f"qos-devnet: PID {pid} still running; inspect manually (not force-killed)", file=sys.stderr)


def safe_base(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        fail("--existing-node must be an absolute http(s) URL")
    if parts.username or parts.password or parts.query or parts.fragment or parts.path not in {"", "/"}:
        fail("node URL must contain only scheme, host, and optional port")
    try:
        port = parts.port
    except ValueError:
        fail("invalid port in node URL")
    if port == 40405:
        fail("refusing node admin HTTP port 40405")
    if parts.scheme == "http" and parts.hostname not in {"127.0.0.1", "localhost", "::1"}:
        fail("insecure remote node HTTP rejected; use TLS or a loopback SSH tunnel")
    return url.rstrip("/")


def http_json(url: str, timeout: float = 3) -> dict:
    with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
        parsed = json.loads(response.read(200_000))
    if not isinstance(parsed, dict):
        raise RuntimeError("node returned non-object JSON")
    return parsed


def http_ok(url: str, timeout: float = 2) -> bool:
    try:
        with urlopen(url, timeout=timeout) as response:
            return response.status == 200
    except Exception:
        return False


def wait_http(url: str, record: dict, label: str, timeout: float = 35) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if http_ok(url):
            return
        if not owned_alive(record):
            fail(f"{label} exited before becoming ready; inspect private logs")
        time.sleep(0.5)
    fail(f"{label} did not become HTTP-ready; inspect private logs")


def run_build(command: list[str], label: str) -> None:
    log_dir = STATE_DIR / "logs"
    log_dir.mkdir(mode=0o700, exist_ok=True)
    path = log_dir / (label + ".log")
    with path.open("wb") as output:
        os.chmod(path, 0o600)
        result = subprocess.run(command, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, timeout=1200)
    if result.returncode:
        fail(f"{label} failed (exit {result.returncode}); log: {path}")


def start_service(label: str, argv: list[str], state: dict,
                  env: dict | None = None, secret_fd: int | None = None) -> dict:
    log_dir = STATE_DIR / "logs"
    log_dir.mkdir(mode=0o700, exist_ok=True)
    log = log_dir / (label + ".log")
    # Agent stdout can contain room metadata; never retain its log.
    output = subprocess.DEVNULL if label == "agent" else log.open("wb")
    if label != "agent":
        os.chmod(log, 0o600)
    try:
        proc = subprocess.Popen(argv, cwd=ROOT, env=env or os.environ.copy(),
                                stdout=output, stderr=subprocess.STDOUT, start_new_session=True,
                                close_fds=True, pass_fds=(() if secret_fd is None else (secret_fd,)))
    finally:
        if output is not subprocess.DEVNULL:
            output.close()
    record = {"pid": proc.pid, "birth": proc_birth(proc.pid), "started_by_harness": True}
    state["services"][label] = record
    atomic_json(STATE_FILE, state)
    return record


def create_room() -> str:
    process = subprocess.run(
        ["node", "--input-type=module", "-e",
         'import {generateCapability} from "./scripts/qos-cli/zfa.mjs"; process.stdout.write(generateCapability("room"));'],
        cwd=ROOT, text=True, capture_output=True, timeout=15, check=True)
    cap = process.stdout.strip()
    if not cap.startswith("cap:room:") or len(cap) < 20:
        fail("capability generation failed")
    return cap


def ensure_free_port(port: int, label: str) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        if sock.connect_ex(("127.0.0.1", port)) == 0:
            fail(f"{label} port {port} already occupied; refusing to adopt or replace foreign service")


def prerequisites(mode: str, ai: bool) -> None:
    if sys.platform != "linux" or not Path("/proc").exists():
        fail("Linux with /proc is required for safe process ownership checks")
    for name in ("node", "pnpm", "npm", "python3", "git", "openssl"):
        if not shutil.which(name):
            fail(f"missing executable: {name}")
    try:
        major = int(subprocess.check_output(
            ["node", "-p", "process.versions.node.split('.')[0]"],
            text=True, timeout=3).strip())
    except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        fail("cannot detect Node.js version")
    if major < 22:
        fail("Node.js 22+ required")
    if ai and not shutil.which("claude"):
        fail("--ai requires an installed, configured Claude CLI")
    if mode == "bundled":
        selected = Path(os.environ.get("RNODE", str(ROOT / "bin" / "rnode"))).expanduser()
        if not selected.is_absolute():
            fail("RNODE override must be an absolute path")
        if not os.access(selected, os.X_OK):
            fail(f"selected Rholo executable is missing or not executable: {selected}")
    if mode == "bundled" and shutil.which("bash") is None:
        fail("bash is required for bundled Rholo")


def cmd_up(args: argparse.Namespace) -> None:
    mode = "existing" if args.existing_node else "bundled"
    prerequisites(mode, args.ai)
    if STATE_DIR.is_symlink():
        fail("refusing symlinked state directory")
    if STATE_DIR.exists() and STATE_DIR.stat().st_uid != os.getuid():
        fail("refusing state directory owned by another user")
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    if load_state():
        fail("state exists: run status/down first; no unrelated processes will be replaced")
    ensure_free_port(SIGNAL_PORT, "signaling")
    ensure_free_port(BROWSER_PORT, "browser")
    if mode == "bundled":
        ensure_free_port(NODE_PORT, "bundled Rholo")
    node_url = safe_base(args.existing_node) if args.existing_node else "http://127.0.0.1:40403"
    state = {"schema": 1, "mode": mode, "node_url": node_url, "services": {},
             "quantum_os_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
             "created_utc": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()}
    atomic_json(STATE_FILE, state)
    try:
        wasm_pkg = ROOT / "packages" / "zfa-core-wasm" / "package.json"
        if not wasm_pkg.exists():
            if not shutil.which("wasm-pack"):
                fail("WASM package missing: install Rust + wasm-pack (see docs); no fake browser build")
            run_build(["pnpm", "build:wasm"], "wasm")
        run_build(["pnpm", "install", "--frozen-lockfile"], "install")
        run_build(["pnpm", "--filter", "@quantum-os/signaling", "build"], "signaling-build")
        run_build(["pnpm", "--filter", "@quantum-os/browser", "build"], "browser-build")
        run_build(["npm", "ci", "--prefix", "scripts/qos-cli", "--no-audit", "--no-fund", "--ignore-scripts"], "agent-install")
        if mode == "bundled":
            env = os.environ.copy()
            env["QOS_RNODE_DATA"] = str(STATE_DIR / "rnode-data")
            start_service("node", ["bash", str(ROOT / "scripts" / "localnet" / "run-node.sh")], state, env)
        # Existing-node is *never* a lifecycle target; only read its public API.
        try:
            node_status = http_json(node_url + "/api/status", 5)
        except Exception as exc:
            if mode == "bundled":
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline:
                    time.sleep(1)
                    try:
                        node_status = http_json(node_url + "/api/status", 3)
                        break
                    except Exception:
                        continue
                else:
                    fail("bundled node did not become ready (check node log)")
            else:
                fail(f"existing node status unavailable: {type(exc).__name__}")
        if not node_status.get("shardId"):
            fail("node reports no shardId, cannot validate /rholang target")
        env = os.environ.copy()
        env["PORT"] = str(SIGNAL_PORT)
        env["SIGNAL_HOST"] = "127.0.0.1"
        signal_rec = start_service("signaling", ["pnpm", "--filter", "@quantum-os/signaling", "start"], state, env)
        wait_http(f"http://127.0.0.1:{SIGNAL_PORT}/", signal_rec, "signaling")
        env = os.environ.copy()
        env["QOS_RNODE_PROXY_TARGET"] = node_url
        browser = start_service("browser", ["pnpm", "--filter", "@quantum-os/browser", "exec",
                            "vite", "--host", "127.0.0.1", "--port", str(BROWSER_PORT), "--strictPort"], state, env)
        # The Vite basic-ssl plugin serves local HTTPS; verify TLS without claiming certificate trust.
        deadline = time.monotonic() + 35
        import ssl
        context = ssl._create_unverified_context()  # local loopback readiness only
        while time.monotonic() < deadline:
            try:
                with urlopen(f"https://127.0.0.1:{BROWSER_PORT}/quantum-os/", timeout=2, context=context) as res:
                    if res.status == 200: break
            except Exception:
                if not owned_alive(browser):
                    fail("browser dev server exited; inspect private log")
            time.sleep(0.5)
        else:
            fail("browser did not become HTTPS-ready; inspect private log")
        cap = create_room()
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, cap.encode("ascii"))
        finally:
            os.close(write_fd)
        try:
            command = ["node", "scripts/qos-cli/agent.mjs", "--room-fd", str(read_fd),
                       "--role", "facilitator", "--signal", f"ws://127.0.0.1:{SIGNAL_PORT}",
                       "--state", str(STATE_DIR / "agent-state")]
            if args.ai:
                command += ["--ai", "--ai-backend", "claude-code"]
            start_service("agent", command, state, secret_fd=read_fd)
        finally:
            os.close(read_fd)
        time.sleep(1)
        if not owned_alive(state["services"]["agent"]):
            fail("facilitator agent exited; see agent requirements in docs")
        # Only user-facing stdout receives the transient bearer capability.
        print(f"Rholo: {node_status.get('version', {}).get('node') if isinstance(node_status.get('version'), dict) else node_status.get('version')}")
        print(f"Shard: {node_status['shardId']}")
        print(f"Browser: https://127.0.0.1:{BROWSER_PORT}/quantum-os/#room={cap}")
        print(f"Signaling: wss://127.0.0.1:{BROWSER_PORT}/signal (via Vite TLS proxy)")
        print(f"Rholang browser command: /rholang rnode https://127.0.0.1:{BROWSER_PORT}/rnode")
        print("Room capability printed ONCE; never stored in harness state or logs.")
        print("Browser uses a local self-signed dev TLS certificate; trust only this local instance.")
    except BaseException:
        for label in reversed(list(state["services"])):
            terminate_owned(state["services"][label])
        STATE_FILE.unlink(missing_ok=True)
        raise


def cmd_status(_: argparse.Namespace) -> None:
    state = load_state()
    if not state:
        print("STOPPED (no harness state)")
        return
    print(f"mode={state.get('mode')} QOS_SHA={state.get('quantum_os_revision')}")
    for label, record in state.get("services", {}).items():
        print(f"{label}: pid={record['pid']} alive={owned_alive(record)} owned_by_harness=true")
    url = state.get("node_url", "")
    try:
        node = http_json(url + "/api/status")
        print("node_status=" + json.dumps({"version": node.get("version"), "shardId": node.get("shardId"),
                                            "networkId": node.get("networkId")}, default=str)[:2000])
    except Exception as exc:
        print(f"node_status=UNAVAILABLE ({type(exc).__name__})")
    # On a fresh devnet, finality may be unavailable even when /api/status is live.
    try:
        last = http_json(url + "/api/last-finalized-block")
        print("last_finalized=" + json.dumps(last.get("blockInfo"), default=str)[:1000])
    except Exception as exc:
        print(f"last_finalized=UNAVAILABLE ({type(exc).__name__})")
    print(f"signaling_health={http_ok(f'http://127.0.0.1:{SIGNAL_PORT}/')}")
    print("Room capability deliberately not stored; use original terminal URL or generate a fresh room.")


def cmd_down(_: argparse.Namespace) -> None:
    state = load_state()
    if not state:
        print("STOPPED (no harness-owned processes)")
        return
    for label in ("agent", "browser", "signaling", "node"):
        record = state.get("services", {}).get(label)
        if record:
            terminate_owned(record)
            print(f"{label}: stop attempted on owned process group only")
    remaining = [k for k, record in state.get("services", {}).items() if owned_alive(record)]
    if remaining:
        fail("some process groups remain; retained state for safe manual cleanup: " + ", ".join(remaining))
    STATE_FILE.unlink(missing_ok=True)
    print("STOPPED: existing node untouched. Dev data/log directory retained for explicit operator cleanup:", STATE_DIR)


def main() -> None:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    up = sub.add_parser("up", help="build, launch bundled local node or reuse an existing node, QOS and facilitator")
    up.add_argument("--existing-node", metavar="URL", help="reuse a public HTTP API; never start/stop/restart this node")
    ai = up.add_mutually_exclusive_group()
    ai.add_argument("--no-ai", action="store_true", help="default: deterministic FAQ only")
    ai.add_argument("--ai", action="store_true", help="explicit Claude CLI opt-in")
    sub.add_parser("status", help="read process health and node public status")
    sub.add_parser("down", help="stop only verified harness-owned process groups")
    args = parser.parse_args()
    if args.cmd == "up":
        cmd_up(args)
    elif args.cmd == "status":
        cmd_status(args)
    else:
        cmd_down(args)


if __name__ == "__main__":
    main()
