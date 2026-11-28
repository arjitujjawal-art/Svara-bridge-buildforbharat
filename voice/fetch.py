"""Provision the pinned model atomically. Only public weights leave the network client."""
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.request import urlopen

manifest = json.loads(Path(__file__).with_name("model.json").read_text())
root = Path(sys.argv[1])
for name, digest in manifest["sha256"].items():
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file():
        with target.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() == digest:
                continue
    url = f"https://huggingface.co/{manifest['repo']}/resolve/{manifest['revision']}/{name}?download=true"
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as download:
        temporary = Path(download.name)
    try:
        print(f"Downloading {name}", flush=True)
        with urlopen(url, timeout=90) as response, temporary.open("wb") as destination:
            shutil.copyfileobj(response, destination, 1024 * 1024)
        with temporary.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != digest:
                raise ValueError(f"Checksum mismatch for {name}")
        temporary.chmod(0o644)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
