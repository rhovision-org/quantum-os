#!/usr/bin/env python3
"""Build a reproducible, identity-free source release ZIP."""
from hashlib import sha256
from pathlib import Path
import sys
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
INCLUDED = ("README.md", "LICENSE", "package.json", ".gitignore",
            "src", "scripts", "tests", "examples", "docs", "dist")
OUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT.parent / "RhoGov-Pilot-Kit-v1.0.0.zip"
files = []
for name in INCLUDED:
    path = ROOT / name
    if path.is_file():
        files.append(path)
    elif path.is_dir():
        files.extend(p for p in path.rglob("*") if p.is_file())
files.sort(key=lambda p: p.relative_to(ROOT).as_posix())
manifest = []
for path in files:
    relative = path.relative_to(ROOT).as_posix()
    manifest.append(sha256(path.read_bytes()).hexdigest() + "  " + relative)
OUT.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(OUT, "w", ZIP_DEFLATED, compresslevel=9) as archive:
    for path in files:
        archive.write(path, "rhogov-pilot-kit/" + path.relative_to(ROOT).as_posix())
    archive.writestr("rhogov-pilot-kit/MANIFEST.sha256", "\n".join(manifest) + "\n")
print("Created " + str(OUT) + " with " + str(len(files)) + " files and a SHA-256 manifest.")
