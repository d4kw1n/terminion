"""Local SSH + SFTP test server for Terminion development.

Run:  python tools/mock_ssh_server.py
Listens on 127.0.0.1:2222 (user demo / password demo), SFTP rooted at
tools/mock/sftp-root, plus an HTTP service on 127.0.0.1:8080 for tunnel tests.
"""
from __future__ import annotations

import asyncio
import random
import string
import sys
from pathlib import Path

import asyncssh

BASE = Path(__file__).resolve().parent / "mock"
ROOT = BASE / "sftp-root"
HOST_KEY = BASE / "host_key"
AUTHORIZED_KEYS = BASE / "authorized_keys"
SSH_PORT = 2222
HTTP_PORT = 8080

RESET = "\x1b[0m"
BOLD = "\x1b[1m"
DIM = "\x1b[2m"
PURPLE = "\x1b[38;2;124;92;255m"
MINT = "\x1b[38;2;34;211;166m"
BLUE = "\x1b[1;34m"
GREEN = "\x1b[32m"
YELLOW = "\x1b[33m"
RED = "\x1b[31m"
CYAN = "\x1b[36m"
MAGENTA = "\x1b[35m"

PROMPT = f"{BOLD}{GREEN}demo@terminion{RESET}:{BLUE}~{RESET}$ "


def ensure_tree() -> None:
    (BASE / "uploads").mkdir(parents=True, exist_ok=True)
    ROOT.mkdir(parents=True, exist_ok=True)
    for folder in ("scripts", "logs", "images", "incoming"):
        (ROOT / folder).mkdir(exist_ok=True)

    (ROOT / "README.md").write_text(
        "# Terminion test server\n\n"
        "This SFTP tree is served by the local asyncssh test server.\n\n"
        "- Upload a file and it lands here.\n"
        "- Rename it, chmod it, delete it — the UI should keep up.\n",
        encoding="utf-8",
    )
    (ROOT / "notes.txt").write_text(
        "Deploy checklist\n"
        "================\n"
        "1. Run the test suite\n"
        "2. Build the release binary\n"
        "3. Tag the release\n",
        encoding="utf-8",
    )
    (ROOT / "scripts" / "deploy.sh").write_text(
        "#!/usr/bin/env bash\nset -euo pipefail\necho 'deploying...'\n",
        encoding="utf-8",
    )
    (ROOT / "scripts" / "healthcheck.sh").write_text(
        "#!/usr/bin/env bash\ncurl -fsS http://127.0.0.1:8080/ >/dev/null && echo ok\n",
        encoding="utf-8",
    )
    log = "\n".join(
        f"2026-11-06T12:{i // 60:02d}:{i % 60:02d}Z INFO worker={i % 8} "
        f"request handled in {i % 97}ms"
        for i in range(2400)
    )
    (ROOT / "logs" / "app.log").write_text(log + "\n", encoding="utf-8")
    big = ROOT / "bigfile.bin"
    if not big.exists() or big.stat().st_size != 8 * 1024 * 1024:
        random.seed(7)
        big.write_bytes(random.randbytes(8 * 1024 * 1024))
    image = ROOT / "images" / "diagram.png"
    if not image.exists():
        image.write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 64)
    upload_src = BASE / "upload-source.txt"
    upload_src.write_text(
        "This file was uploaded from the local machine through Terminion.\n"
        + "".join(random.choice(string.ascii_letters + "\n") for _ in range(4000)),
        encoding="utf-8",
    )


def ensure_host_key() -> None:
    if not HOST_KEY.exists():
        key = asyncssh.generate_private_key("ssh-ed25519")
        HOST_KEY.write_bytes(key.export_private_key())


def authorized_keys() -> list[str]:
    if not AUTHORIZED_KEYS.exists():
        return []
    return [
        line.strip()
        for line in AUTHORIZED_KEYS.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]


class Server(asyncssh.SSHServer):
    def begin_auth(self, username: str) -> bool:
        return True

    def password_auth_supported(self) -> bool:
        return True

    def validate_password(self, username: str, password: str) -> bool:
        return username == "demo" and password == "demo"

    def public_key_auth_supported(self) -> bool:
        return True

    def validate_public_key(self, username: str, key: asyncssh.SSHKey) -> bool:
        exported = key.export_public_key().decode().strip()
        blob = exported.split()[1] if len(exported.split()) >= 2 else ""
        return username == "demo" and any(
            len(allowed.split()) >= 2 and allowed.split()[1] == blob
            for allowed in authorized_keys()
        )

    def connection_requested(self, dest_host, dest_port, orig_host, orig_port) -> bool:
        return True

    def server_requested(self, listen_host, listen_port) -> bool:
        return True


def out(proc, text: str) -> None:
    try:
        proc.stdout.write(text.encode("utf-8", "replace"))
    except Exception:
        pass


def run_command(proc, line: str) -> None:
    cmd = line.strip()
    if not cmd:
        return
    name, _, rest = cmd.partition(" ")
    if name == "pwd":
        out(proc, "/home/demo\r\n")
    elif name == "whoami":
        out(proc, "demo\r\n")
    elif name == "ls":
        entries = sorted(ROOT.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        for entry in entries:
            if entry.is_dir():
                out(proc, f"{BLUE}{entry.name}/{RESET}  ")
            else:
                out(proc, f"{entry.name}  ")
        out(proc, "\r\n")
    elif name == "echo":
        out(proc, rest + "\r\n")
    elif name == "uname":
        out(proc, "Linux terminion 6.11.0-test #1 SMP x86_64 GNU/Linux\r\n")
    elif name == "clear":
        out(proc, "\x1b[2J\x1b[H")
    elif name == "cat":
        target = ROOT / rest.strip().lstrip("/")
        try:
            data = target.read_text(encoding="utf-8", errors="replace")
            out(proc, data.replace("\n", "\r\n") + "\r\n")
        except Exception as exc:
            out(proc, f"cat: {rest}: {exc}\r\n")
    elif name in ("neofetch", "tty-test"):
        banner = (
            f"{PURPLE} ▄▄▄▄▄ {RESET}  {BOLD}demo@terminion{RESET}\r\n"
            f"{PURPLE}█  >_  █{RESET}  ---------------\r\n"
            f"{PURPLE} ▀▀▀▀▀ {RESET}  OS: Terminion test image\r\n"
            "             Shell: mock-bash 1.0\r\n"
            "             Terminal: xterm-256color\r\n"
            f"{GREEN}✓ green{RESET} {YELLOW}● yellow{RESET} "
            f"{RED}✗ red{RESET} {CYAN}◆ cyan{RESET} "
            f"{MAGENTA}■ magenta{RESET}\r\n"
        )
        out(proc, banner)
    elif name in ("big", "yes"):
        for i in range(1, 8001):
            out(
                proc,
                f"{i:5d}  {PURPLE}●{RESET} line {i} — the quick brown fox "
                f"jumps over the lazy dog\r\n",
            )
    elif name in ("help", "?"):
        out(proc, "commands: ls, pwd, whoami, uname, echo, cat, tty-test, big, clear, exit\r\n")
    elif name in ("exit", "logout"):
        return
    else:
        out(proc, f"bash: {name}: command not found\r\n")


async def handle_process(proc) -> None:
    command_line = getattr(proc, "command", None)
    if command_line:
        run_command(proc, command_line)
        proc.exit(0)
        return

    out(
        proc,
        f"{PURPLE}Terminion test shell{RESET} — type {BOLD}help{RESET} for commands\r\n"
        f"{DIM}Resize the window, run `big` for a flood, or open SFTP from the toolbar.{RESET}\r\n\r\n",
    )
    out(proc, PROMPT)
    buf = ""
    skip = 0
    while True:
        try:
            chunk = await proc.stdin.read(1)
        except asyncssh.misc.TerminalSizeChanged:
            # Resizing the terminal is not an error; keep the shell alive.
            continue
        except (ConnectionError, OSError, asyncssh.Error):
            break
        if not chunk:
            break
        if isinstance(chunk, str):
            chunk = chunk.encode()
        c = chunk[0]
        if skip:
            skip -= 1
            continue
        if c == 27:
            skip = 2
            continue
        if c in (13, 10):
            out(proc, "\r\n")
            line = buf
            buf = ""
            if line.strip() in ("exit", "logout"):
                break
            run_command(proc, line)
            out(proc, PROMPT)
        elif c in (8, 127):
            if buf:
                buf = buf[:-1]
                out(proc, "\b \b")
        elif c == 3:
            out(proc, "^C\r\n")
            buf = ""
            out(proc, PROMPT)
        elif c == 4:
            if not buf:
                break
        elif 32 <= c < 127:
            buf += chr(c)
            out(proc, chr(c))
    out(proc, "\r\nlogout\r\n")
    proc.exit(0)


async def handle_http(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        await reader.readuntil(b"\r\n\r\n")
    except Exception:
        pass
    body = b"Hello from the Terminion tunnel!\n"
    writer.write(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\nConnection: close\r\n\r\n"
        + body
    )
    await writer.drain()
    writer.close()
    try:
        await writer.wait_closed()
    except Exception:
        pass


async def main() -> None:
    ensure_tree()
    ensure_host_key()
    sftp_root = str(ROOT).encode()

    await asyncio.start_server(handle_http, "127.0.0.1", HTTP_PORT)

    await asyncssh.create_server(
        Server,
        "127.0.0.1",
        SSH_PORT,
        server_host_keys=[str(HOST_KEY)],
        process_factory=handle_process,
        sftp_factory=lambda chan: asyncssh.SFTPServer(chan, chroot=sftp_root),
        encoding=None,
    )
    print(
        f"READY ssh://demo@127.0.0.1:{SSH_PORT} (password: demo) "
        f"http://127.0.0.1:{HTTP_PORT}",
        flush=True,
    )
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
