"""Local plain-FTP test server for Terminion development.

Run: python tools/mock_ftp_server.py
Listens on 127.0.0.1:2121 with user demo / password demo, rooted at
tools/mock/ftp-root.
"""
from __future__ import annotations

import os
from pathlib import Path

from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer

BASE = Path(__file__).resolve().parent / "mock"
ROOT = BASE / "ftp-root"


def ensure_tree() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / "releases").mkdir(exist_ok=True)
    (ROOT / "incoming").mkdir(exist_ok=True)
    (ROOT / "README.txt").write_text(
        "Plain FTP test root. FTP is unencrypted; prefer SFTP where possible.\n",
        encoding="utf-8",
    )
    (ROOT / "releases" / "app-1.0.0.txt").write_text("release notes\n", encoding="utf-8")
    (ROOT / "releases" / "checksums.txt").write_text(
        "a1b2c3  app-1.0.0.txt\n", encoding="utf-8"
    )
    (ROOT / "firmware.bin").write_bytes(bytes(range(256)) * 4096)


def main() -> None:
    ensure_tree()
    authorizer = DummyAuthorizer()
    authorizer.add_user("demo", "demo", str(ROOT), perm="elradfmwMT")

    handler = FTPHandler
    handler.authorizer = authorizer
    handler.banner = "Terminion FTP test server ready."
    handler.passive_ports = range(60000, 60050)

    server = FTPServer(("127.0.0.1", 2121), handler)
    print("READY ftp://demo@127.0.0.1:2121 (password: demo)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
