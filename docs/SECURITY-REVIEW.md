# Terminion security review

**Date:** 2026-11-07  
**Scope:** Terminion 0.1.0 source tree, Tauri configuration, release build, IPC surface,
SSH/SFTP/FTP and port-forwarding code, frontend rendering, npm dependencies.  
**Method:** source review plus targeted tests. This is not a full external penetration
test, network fuzzing exercise, or Windows kernel/DPAPI review.

## Executive summary

The application has a reasonable security posture for a local-first desktop SSH client:

- machine-local storage, no account, telemetry or update service;
- passwords, private keys and key passphrases sealed with Windows DPAPI;
- SSH host keys checked with SHA-256 fingerprints (trust on first use);
- parameterized SQLite queries;
- minimal Tauri capabilities (no shell/fs plugin, no remote web content);
- React escapes remote file names and terminal output is rendered by xterm.js as text;
- native file-drop is used only for uploading into the currently open remote folder.

One **high-severity path-traversal/arbitrary-write issue** was found in the local download
path handling and has been fixed. Several medium hardening issues were also fixed:
production CSP contained development origins, `open_folder` could open files with their
default handler, forwarding host keys were persisted before authentication succeeded,
and non-Windows builds silently stored secrets as recoverable base64.

Remaining risks are mainly protocol/design choices: first-use host-key auto-trust,
plain FTP, a SOCKS5 proxy without authentication if bound to a non-loopback address,
and an unsigned installer.

## Findings

| ID | Severity | Status | Finding |
| --- | --- | --- | --- |
| T-01 | High | Fixed | Server-controlled download names could escape the download folder (Windows backslash, drive prefix, UNC, NTFS ADS) and overwrite local files. |
| T-02 | Medium | Fixed | Forwarding connections saved a new host key before authentication succeeded, allowing known-host poisoning by an unauthenticated endpoint. |
| T-03 | Medium | Fixed | Production CSP allowed `localhost:1420` / `ws://localhost:1420`; now separated into `devCsp`. |
| T-04 | Medium | Fixed | `open_folder` accepted file paths; Explorer could launch an executable if called with one. It now requires a directory. |
| T-05 | Medium | Fixed | Non-Windows `secret` fallback stored credentials as `plain:<base64>`; it now fails closed. |
| T-06 | Medium | Open | First connection to an unknown SSH host key is accepted automatically (TOFU) without an explicit fingerprint confirmation. |
| T-07 | Medium | Open | Plain FTP sends credentials and data unencrypted; FTPS is not implemented. |
| T-08 | Medium | Open | Dynamic SOCKS5 has no authentication. It binds to `127.0.0.1` by default, but the bind address is editable; `0.0.0.0` creates an open LAN proxy. |
| T-09 | Medium | Open | NSIS installer and executable are not Authenticode-signed; no signed update channel exists. |
| T-10 | Low | Open | DPAPI protects against other Windows users, not against malware running as the same user. Secrets are ordinary Rust `String`s without zeroization. |
| T-11 | Low | Open | Host names, usernames, snippets, startup commands and known-host metadata are stored unencrypted in SQLite. SSH private keys/passwords/passphrases are sealed. |
| T-12 | Low | Open | FTP passive mode trusts the address advertised by the server; a malicious FTP server can direct the data connection to another host/port (SSRF/port-scan style behaviour). |
| T-13 | Low | Open | Rust dependency advisory scan could not be completed in this environment (`index.crates.io` DNS unavailable). `npm audit` reported zero vulnerabilities. |
| T-14 | Info | Open | The main window webview can invoke custom Tauri commands; an XSS in the frontend would be high impact (remote commands, stored credentials, local file writes). No XSS sink was found in the reviewed code. |

### T-01 — Download path traversal / arbitrary write (High, fixed)

**Old behaviour:** `sanitize_rel` only split on `/`. On Windows, a server-supplied name
such as `..\..\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\evil.lnk`
is a single component containing backslashes. `Path::join` then interprets those as
separators, writing outside the selected download folder. Drive prefixes (`C:\...`),
UNC paths (`\\server\share\...`) and NTFS alternate data streams (`file.txt:payload`)
had similar problems. Existing files were also overwritten with `File::create`.

**Impact:** a malicious or compromised SFTP/FTP server could write attacker-controlled
content to locations writable by the user, including the Windows Startup folder. This
requires the user to download a file/folder, but the remote side chooses the names and
content.

**Fix:**

- `sanitize_rel` now splits on both `/` and `\`;
- rejects `.`/`..`, drive/ADS colons, control characters, empty components;
- trims Windows trailing dots/spaces and neutralises reserved device names (`CON`,
  `NUL`, `COM1`, …);
- `safe_local_path` canonicalises/validates that the result remains under the chosen
  download directory;
- `unique_download_path` never overwrites an existing file and treats broken symlinks as
  existing;
- both SFTP and FTP downloads use these helpers.

References: `src-tauri/src/ssh/xfer.rs`, `src-tauri/src/ssh/sftp.rs`,
`src-tauri/src/ssh/ftp.rs`.

Regression tests: `cargo test --lib ssh::xfer` — three tests pass, covering traversal,
drive/UNC prefixes, ADS/control bytes and Windows device names.

### T-02 — Host-key persistence before authentication (Medium, fixed)

`ForwardManager` committed a new host key before `authenticate()` succeeded. A server
that cannot authenticate the user could still cause the client to save its key as
trusted, which makes later legitimate-connection key changes look like an attack.
Terminal and SFTP paths already committed after authentication. The forwarding paths
were moved after successful authentication as well.

Reference: `src-tauri/src/ssh/forward.rs`.

### T-03 — Production CSP trusted development origins (Medium, fixed)

The release CSP included `http://localhost:1420` and `ws://localhost:1420` in
`connect-src`. `script-src 'self'` prevented loading scripts from that origin, but an
XSS in the app could still exfiltrate data to a local listener. The release CSP now
contains only the Tauri IPC origins; the Vite origins live in `devCsp`. The policy also
adds `object-src 'none'`, `base-uri 'none'`, `frame-src 'none'`, `frame-ancestors 'none'`
and `form-action 'none'`. `devtools` is explicitly disabled for the release window.

Reference: `src-tauri/tauri.conf.json`.

### T-04 — `open_folder` could open files (Medium, fixed)

The command accepted any existing path and asked Explorer to open it. A `.exe`, `.lnk`
or script path could therefore be launched by the default handler if the command was
invoked with one (for example via a future XSS). It now rejects anything that is not a
directory. `reveal_path` still accepts files, but only asks Explorer to select them.
The Explorer executable is now resolved from `%SystemRoot%` rather than left to
PATH/current-directory search, reducing binary-planting risk.

Reference: `src-tauri/src/commands.rs`.

### T-05 — Non-Windows plaintext secret fallback (Medium, fixed)

Non-Windows builds stored secrets as `plain:<base64>`. The product is Windows-first, but
a Linux/macOS build would have silently exposed every password and private key. Those
builds now fail closed with a clear error instead of writing recoverable secrets. A
future cross-platform build should use the OS keychain or a vetted encrypted store.

Reference: `src-tauri/src/secret.rs`.

### T-06 — Trust on first use has no confirmation (Medium, open)

The first key seen for an endpoint is accepted and saved automatically after a successful
login. This is standard TOFU and blocks later key changes, but a MITM on the very first
connection is trusted. Recommended hardening: show the SHA-256 fingerprint and require an
explicit “Trust this key” action before saving the entry, or import an existing
`~/.ssh/known_hosts` file. Users should verify fingerprints out of band.

### T-07 — Plain FTP (Medium, open)

FTP is unencrypted by design (RFC 959). The UI marks FTP hosts `UNENCRYPTED` and the
README warns about it, but credentials and file contents still cross the network in
clear text. Use SFTP for anything reachable over an untrusted network. If legacy FTP is
required, add FTPS (explicit/implicit TLS) or require a per-session confirmation.

### T-08 — SOCKS5 has no authentication (Medium, open)

`ForwardManager` implements the CONNECT command only, with the “no authentication”
method. The default bind is `127.0.0.1`, which is safe on a single-user machine, but the
listen host is a free-form field. Binding to `0.0.0.0` or a LAN interface creates an open
proxy. Recommended: force dynamic forwards to loopback, or add username/password auth,
and show a warning whenever a local/dynamic rule binds to a non-loopback address.

### T-09 — Unsigned release artifacts (Medium, open)

The NSIS installer and `terminion.exe` are not Authenticode-signed and there is no signed
auto-update channel. Users cannot verify publisher identity through Windows beyond the
file hash you distribute. Recommended: sign the executable/installer with an EV or
standard code-signing certificate, publish SHA-256 checksums, and sign updates if one is
added later.

### T-10 — Same-user malware and memory lifetime (Low, open)

DPAPI current-user scope protects against other Windows accounts and offline database
theft. It does not protect against malware running as the same user, which can call
`CryptUnprotectData` or read process memory. DPAPI calls now set
`CRYPTPROTECT_UI_FORBIDDEN`, but passwords/private keys are still held in Rust
`String`s and copies during authentication; they are not zeroized. For a higher threat
model, use `secrecy`/`zeroize`, avoid unnecessary clones, and disable crash dumps/WER
collection for the process.

### T-11 — Plaintext metadata and snippets (Low, open)

Only credential material is sealed. Server names, usernames, tags, snippets, startup
commands and known-host fingerprints are plaintext in `%APPDATA%\com.terminion.app`.
If snippets or startup commands contain tokens, those values are not protected at rest.
Document this, or encrypt selected fields with DPAPI and expand them only when needed.

### T-12 — FTP passive-mode address trust (Low, open)

The async FTP client follows the address in the server’s PASV response. A malicious FTP
server can point the data connection at an internal host/port. The impact is limited
(server-controlled data connection, no shell), but forcing the data connection to the
control connection’s host is a sensible hardening.

### T-13 — Dependency audit status (Low, open)

- `npm audit` (including dev dependencies): **0 vulnerabilities** at review time.
- `cargo audit` was not available locally and the RustSec index could not be downloaded
  because `index.crates.io` did not resolve in this environment. Do not treat the Rust
  dependency tree as audited until `cargo audit`/`cargo deny` runs in CI.
- Current direct pins observed: Tauri `2.12.5`, Wry `0.57.1`, russh `0.65.1`,
  russh-sftp `3`, suppaftp `12.2.1`, ring `0.17.14`, rustls `0.23.46`,
  rusqlite `0.41.1` / libsqlite3-sys `0.39.1`.

## Positive controls verified

- Win32 DPAPI (`CryptProtectData`/`CryptUnprotectData`) protects passwords, private keys
  and passphrases; the frontend receives only `hasPassword`/public key metadata.
- SQL statements are parameterized; no user-controlled SQL string interpolation was found.
- Known-host mismatch returns a hard error with saved/presented fingerprints and does not
  fall back to password auth.
- Tauri capabilities include only window/dialog permissions; no shell, filesystem, HTTP
  or updater plugin is exposed.
- No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, `document.write`,
  `window.open` or external link handler was found in `src/`.
- Terminal output is written through xterm.js, not inserted as HTML. File previews use a
  React `<pre>` element. Host labels, file names and transfer paths are React text nodes.
- Native file drops are uploaded only into the current SFTP/FTP directory; local symlinks
  are skipped during recursive upload.
- Download paths are now checked against the chosen local directory and duplicate
  downloads receive a numbered name instead of overwriting existing files. Local
  symlinks are skipped during recursive uploads.
- The release build uses LTO, stripping and abort-on-panic; no application logging of
  credentials or terminal output was found.

## Verification performed

- `cargo test --lib ssh::xfer` — 3/3 tests passed (Windows traversal, drive/UNC
  prefixes, NTFS streams/control bytes, reserved device names).
- `cargo check` — clean after the security changes.
- `npm audit` — 0 vulnerabilities, including development dependencies at review time.
- Release build completed and the hardened CSP was loaded successfully; the app opened
  its workspace and host list normally.
- The private-key/credential files used during manual testing were removed from the
  project and test data was reset.
- Not performed: `cargo audit` (RustSec index unavailable), fuzzing, external penetration
  testing, malicious-server integration testing, or a Windows code-signing review.

## Recommended next steps

1. Add explicit host-key confirmation for first use, and optionally import
   `~/.ssh/known_hosts`.
2. Decide the policy for FTP and dynamic SOCKS5: FTPS, per-connection warning, loopback
   enforcement, or authentication.
3. Sign the installer/executable and publish checksums.
4. Run `cargo audit` / `cargo deny` and `npm audit` in CI on every release.
5. Add `zeroize`/`secrecy` for credential buffers and consider encrypting snippets or
   startup commands that may contain tokens.
6. Add a fuzz target for the SOCKS5 handshake and FTP/SFTP list parsers; consider limits on
   directory entry counts and recursive tree sizes.
7. If the app is ever ported away from Windows, replace the DPAPI backend with a
   platform keychain and keep the fail-closed behaviour until it exists.
