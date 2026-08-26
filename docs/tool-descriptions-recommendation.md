# Recommended MCP Tool Descriptions — TermSSH MCP

> **Note:** This file contains text recommendations only (not executable code).
> Goal: help the AI (language model) understand *when* and *how* to use each tool.
> Copy-paste into `src/index.ts` if you agree.

---

## Account selection rules (MUST be read by the AI)

Almost every tool in this MCP exposes a string parameter `account` that selects the
**vault account** to use. The rules are:

1. **You MUST pass `account` whenever the server is started with `--vault <path>`.**
   If you omit it, the server throws:
   `Vault account selection is required. Available accounts: <list>. Provide the account parameter.`
   Call the `list-accounts` tool (see below) to discover valid account names.
2. **You MAY omit `account` whenever the server is started with `--host` / `--user` (CLI mode).**
   In this mode there is exactly one SSH connection (default `cli:default`).
3. **The same account reuses its SSH connection** — subsequent calls to any tool with
   the same `account` will reuse the existing connection, not open a new one.
4. **Account names are case-sensitive** and must match the keys in the vault JSON file.

> TL;DR for the AI: if you are not sure which mode the server runs in, call
> `list-accounts` first. If the tool exists and returns a list, you **must** include
> `account` in every tool call. If the tool does not exist, the server is in CLI mode
> and `account` may be omitted.

---

## 0) `list-accounts` (helper tool — optional but strongly recommended)

> **Note:** This tool is not yet registered in `src/index.ts`. Recommendation: add this
> small tool so the AI can introspect vault accounts. Pseudocode:

```ts
server.tool(
  'list_accounts',
  'Return the list of vault account names that are available, plus the currently ' +
  'active account. Call this FIRST whenever you are unsure whether the server runs in ' +
  'vault mode or CLI mode, or when you do not know which account name to pass to other ' +
  'tools. If this tool is registered, the server runs in vault mode and the `account` ' +
  'parameter is REQUIRED on every other SSH tool. If this tool is NOT registered, the ' +
  'server runs in CLI mode and `account` may be omitted.',
  { vaultPath: z.string().optional() },
  async ({ vaultPath }) => { /* read vault.json, return { accounts: string[], activeAccount: string } */ }
);
```

---

## 1) `upload-file`

**Title (name):** `upload_file`

**Description (for the tool):**
> Upload a single file from the **MCP host machine (local disk)** to the remote SSH
> server using the **SFTP** protocol. Use this when the source file already exists
> on disk and you only need to move it. To upload a small text / in-memory payload,
> use `upload_content` instead.
>
> **REQUIRED:** Pass the `account` parameter (vault account name) whenever the server
> is started with `--vault`. Without it, the request fails with
> `"Vault account selection is required"`. If the server is started with `--host` /
> `--user`, `account` may be omitted.
>
> **Things to keep in mind:**
> - `localPath` is read from the **MCP host's** filesystem (NOT the remote server).
> - `remotePath` must be an **absolute** path on the remote server
>   (e.g. `/etc/app/config.yaml`).
> - If `overwrite=false` (default) and the remote file already exists, the request
>   **fails**.
> - `createDirectories=true` creates missing parent folders recursively.
> - `mode` is a **POSIX octal** string (3–4 digits, e.g. `0644`). Not decimal.

**Parameter descriptions:**
- `account`: "**(Often required)** Vault account name to target. REQUIRED when the server runs with --vault. May be omitted only when the server runs with --host/--user. Case-sensitive; must match a key in the vault JSON file."
- `localPath`: "Local file path on the MCP host machine — absolute or relative to the server's working directory."
- `remotePath`: "Absolute destination path on the remote server (e.g. /etc/app/config.yaml). Use forward slashes for Linux/macOS, or drive-letter + backslash for Windows."
- `createDirectories`: "(Optional, default false) Recursively create parent directories on the remote server if they do not exist."
- `overwrite`: "(Optional, default false) Overwrite the remote file if it already exists. Without this flag, an existing file causes the request to fail."
- `mode`: "(Optional) POSIX octal mode (3–4 digits) applied after upload (e.g. 0644, 0755). Skip this if you are unsure."

---

## 2) `upload-content`

**Title (name):** `upload_content`

**Description (for the tool):**
> Upload content **directly (in-memory)** to the remote SSH server via SFTP, without
> touching the local disk. Ideal for small payloads: configuration snippets, JSON,
> one-liner scripts, etc. Supports `utf8` encoding (plain text) or `base64` (binary
> data).
>
> **REQUIRED:** Pass the `account` parameter (vault account name) whenever the server
> is started with `--vault`. Without it, the request fails with
> `"Vault account selection is required"`. If the server is started with `--host` /
> `--user`, `account` may be omitted.
>
> **Things to keep in mind:**
> - For binary files, **base64-encode** them and send `encoding="base64"`. Do NOT
>   send raw binary.
> - Same as `upload_file`: `remotePath` is on the remote server, and `overwrite=false`
>   is the default.
> - There is no `localPath` — the server only writes the bytes you provide.

**Parameter descriptions:**
- `account`: "**(Often required)** Vault account name. REQUIRED with --vault, omit only with --host/--user."
- `content`: "Payload to upload. Plain text for `utf8`, base64 for binary data."
- `encoding`: "Encoding of the content field: 'utf8' for plain text, 'base64' for binary data (images, PDFs, executables, etc.)."
- `remotePath`: "Absolute destination path on the remote server."
- `createDirectories`: "(Optional, default false) Recursively create parent directories if they do not exist."
- `overwrite`: "(Optional, default false) Overwrite the remote file if it already exists."
- `mode`: "(Optional) POSIX octal mode (3–4 digits) applied after write."

---

## 3) `terminal-start`

**Title (name):** `terminal_start`

**Description (for the tool):**
> Open an **interactive terminal session** (shell) on the remote server and start
> buffering its output. After this call, use `terminal_read` to view output and
> `send_command` to send input. End the session with `terminal_close`.
>
> **REQUIRED:** Pass the `account` parameter (vault account name) whenever the server
> is started with `--vault`. Without it, the request fails with
> `"Vault account selection is required"`. If the server is started with `--host` /
> `--user`, `account` may be omitted.
>
> **Things to keep in mind:**
> - By default, this tool **reuses an active session** that matches the same
>   account/cwd/user/host. Set `multiSession=true` to force a new session.
> - `cwd`, `shell`, and `env` are applied as bootstrap **after** the shell starts.
> - Automatic `su` elevation requires `suPassword` in the config **and**
>   `elevated=true`.
> - On Windows, newline handling and bootstrap target `cmd.exe`.
> - Sessions are auto-closed after **10 minutes of idle time**.

**Parameter descriptions:**
- `account`: "**(Often required)** Vault account name. REQUIRED with --vault, omit only with --host/--user."
- `cwd`: "(Optional) Working directory to `cd` into after the shell starts."
- `shell`: "(Optional) Path to a shell executable, e.g. '/bin/bash' or 'C:\\\\Windows\\\\System32\\\\cmd.exe'."
- `platformHint`: "(Optional, default 'auto') Platform hint: 'linux', 'windows', or 'auto' (auto-detect). Controls newline handling and bootstrap behavior."
- `elevated`: "(Optional, default false) Try to elevate to `su -` when `suPassword` is configured. Ignored on Windows."
- `cols`: "(Optional, default 80) Initial terminal width in columns."
- `rows`: "(Optional, default 24) Initial terminal height in rows."
- `env`: "(Optional) Extra environment variables to export after the shell starts (object: key→value)."
- `multiSession`: "(Optional, default false) Set true to force a new session. Default reuses an active matching session."

---

## 4) `send-command`

**Title (name):** `send_command`

**Description (for the tool):**
> Send **input** to an existing interactive terminal session (created via
> `terminal_start`). Do NOT use this for one-shot command execution — use
> `terminal_start` + `terminal_read` for that.
>
> **REQUIRED:** Pass the `account` parameter (vault account name) whenever the server
> is started with `--vault`. Without it, the request fails with
> `"Vault account selection is required"`. If the server is started with `--host` /
> `--user`, `account` may be omitted. The `account` value MUST match the one used in
> `terminal_start` for the session.
>
> **Things to keep in mind:**
> - `appendNewline=true` (default) appends `\n` so the shell **executes** the command.
> - Set `appendNewline=false` **only** for special cases (e.g. typing a password at a
>   `Password:` prompt).
> - This tool does **not** wait for output. Call `terminal_read` (with `sinceSequence`
>   / `waitForMs`) afterwards to fetch results.
> - Each call refreshes the session's heartbeat (idle timer resets).

**Parameter descriptions:**
- `account`: "**(Often required)** Vault account name. REQUIRED with --vault, omit only with --host/--user. Must match the account used when the session was created."
- `sessionId`: "Interactive session id returned by `terminal_start`."
- `command`: "Text to send to the session's stdin. A newline is appended automatically unless `appendNewline=false`."
- `appendNewline`: "(Optional, default true) Append a newline at the end. Set false ONLY when you need to send input without executing it (e.g. a password)."

---

## 5) `terminal-read`

**Title (name):** `terminal_read`

**Description (for the tool):**
> Read the **buffered output** of an interactive terminal session. Already-read
> output can be re-fetched by passing `sinceSequence`. Useful for polling
> long-running commands.
>
> **REQUIRED:** Pass the `account` parameter (vault account name) whenever the server
> is started with `--vault`. Without it, the request fails with
> `"Vault account selection is required"`. If the server is started with `--host` /
> `--user`, `account` may be omitted. The `account` value MUST match the one used in
> `terminal_start` for the session.
>
> **Things to keep in mind:**
> - Each line of output has a **monotonic sequence number**. Use `sinceSequence` to
>   fetch only new lines and **avoid duplicates** between calls.
> - `waitForMs` delays the read by 0–5000 ms — useful for waiting for the next prompt
>   without busy-looping on the AI side.
> - `maxChars` truncates the output to the last N characters. Maximum per-session
>   buffer is 200,000 characters; on overflow the response sets `truncated=true`.
> - The response includes `closed` and `exitCode` — check them to detect an exited
>   shell.

**Parameter descriptions:**
- `account`: "**(Often required)** Vault account name. REQUIRED with --vault, omit only with --host/--user. Must match the account used when the session was created."
- `sessionId`: "Interactive session id."
- `sinceSequence`: "(Optional, default 0) Return only output whose sequence is greater than this value. Use the `nextSequence` from a previous response."
- `maxChars`: "(Optional) Trim the returned output to the last `maxChars` characters. Useful for very long outputs."
- `waitForMs`: "(Optional, 0–5000) Delay the read by this many milliseconds. Useful for soft-realtime polling without busy-looping."

---

## 6) `terminal-resize`

**Title (name):** `terminal_resize`

**Description (for the tool):**
> Resize an in-progress interactive terminal session (cols × rows). This sends a
> `TIOCSWINSZ` signal to the remote PTY so that full-screen applications
> (vim, htop, less, etc.) redraw correctly.
>
> **REQUIRED:** Pass the `account` parameter (vault account name) whenever the server
> is started with `--vault`. Without it, the request fails with
> `"Vault account selection is required"`. If the server is started with `--host` /
> `--user`, `account` may be omitted.
>
> **Things to keep in mind:**
> - Only affects the **session's** buffer dimensions, not your AI/IDE window.
> - Does NOT discard already-buffered output.

**Parameter descriptions:**
- `account`: "**(Often required)** Vault account name. REQUIRED with --vault, omit only with --host/--user."
- `sessionId`: "Interactive session id."
- `cols`: "New terminal width in columns (must be > 0)."
- `rows`: "New terminal height in rows (must be > 0)."

---

## 7) `terminal-close`

**Title (name):** `terminal_close`

**Description (for the tool):**
> Close an interactive terminal session on the **client** (MCP) side. The SSH stream
> is ended and the session is removed from memory. The marker file at
> `/tmp/termssh-mcp/<id>.json` on the server is **left in place** — a server-side
> watcher will clean it up.
>
> **REQUIRED:** Pass the `account` parameter (vault account name) whenever the server
> is started with `--vault`. Without it, the request fails with
> `"Vault account selection is required"`. If the server is started with `--host` /
> `--user`, `account` may be omitted. The `account` value MUST match the one used in
> `terminal_start` for the session.
>
> **Things to keep in mind:**
> - Always call this when finished to avoid resource leaks.
> - The remote shell process receives SIGTERM (via the marker watcher) within
>   ≤ 10 minutes.
> - This tool is idempotent — calling it twice does not error.

**Parameter descriptions:**
- `account`: "**(Often required)** Vault account name. REQUIRED with --vault, omit only with --host/--user. Must match the account used when the session was created."
- `sessionId`: "Interactive session id to close."

---

## General notes for the AI (optional, can be embedded in each tool)

- **Vault account:** almost every tool accepts an `account` (string) parameter.
  **Required** when the server runs with `--vault`; optional when it runs with
  `--host` / `--user`.
- **Connection state:** the tool automatically opens (or reuses) the SSH connection
  per account. There is no manual "connect" step.
- **Common errors:**
  - `Vault account selection is required` → add `account="<name>"`, or call
    `list-accounts` to discover names.
  - `Remote path already exists` → set `overwrite=true`.
  - `localPath is not readable` → check the path on the MCP host, not the remote.
  - `Interactive session X is already closed` → the session has ended; open a new one.
