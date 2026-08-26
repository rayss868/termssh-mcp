# Copy-Paste Tool Descriptions into `src/index.ts`

> The snippets below are **ready to paste** to replace the existing `server.tool(...)`
> calls. Only the **name** (argument 1) and **description** (argument 2) change;
> the schema and handler stay untouched.

---

## Account selection rules (REQUIRED)

Each tool description below includes this reminder explicitly:

> **REQUIRED:** Pass the `account` parameter (vault account name) when the server is
> started with `--vault`. Without it, the request fails with
> `"Vault account selection is required"`. If the server is started with `--host` /
> `--user`, `account` may be omitted.

**Quick reference for the AI:**
- `--vault <path>` mode → `account` is **REQUIRED** (vault account name from JSON).
- `--host` + `--user` mode → `account` is optional and may be omitted.
- Account names are **case-sensitive** and must match the keys in the vault JSON.
- The same account **reuses** its SSH connection across calls.
- When in doubt, call `list-accounts` first (see
  `tool-descriptions-recommendation.md`).

---

## 1) `upload-file` → `upload_file`

```ts
server.tool(
  'upload_file',
  'Upload a single file from the local MCP host disk to the remote SSH server via SFTP. ' +
  'Use this when the source already exists on disk. For small in-memory payloads (text, ' +
  'JSON, or base64-encoded binary) use upload_content instead. ' +
  'REQUIRED: pass `account` (vault account name) when the server runs with --vault; ' +
  'without it the request fails with "Vault account selection is required". ' +
  'Omit `account` only when the server runs with --host/--user.',
  { ... }, // schema UNCHANGED
  async (...) => { ... } // handler UNCHANGED
);
```

---

## 2) `upload-content` → `upload_content`

```ts
server.tool(
  'upload_content',
  'Upload content directly (in-memory) to the remote SSH server via SFTP, without ' +
  'touching the local disk. Ideal for small payloads: config snippets, code, JSON, ' +
  'or base64-encoded binary. The source is the `content` field, not a file on disk. ' +
  'REQUIRED: pass `account` (vault account name) when the server runs with --vault; ' +
  'without it the request fails. Omit `account` only when the server runs with --host/--user.',
  { ... },
  async (...) => { ... }
);
```

---

## 3) `terminal-start` → `terminal_start`

```ts
server.tool(
  'terminal_start',
  'Open an interactive shell session on the remote SSH server and start buffering ' +
  'its output. After this call, use terminal_read to view output and send_command to ' +
  'send input. End the session with terminal_close. By default, an active session ' +
  'matching the same account/cwd/user/host is REUSED; set multiSession=true to force ' +
  'a new one. Sessions auto-close after 10 minutes idle. Automatic su-elevation ' +
  'requires suPassword in the config plus elevated=true (ignored on Windows). ' +
  'REQUIRED: pass `account` (vault account name) when the server runs with --vault; ' +
  'without it the request fails. Omit `account` only when the server runs with --host/--user.',
  { ... },
  async (...) => { ... }
);
```

---

## 4) `send-command` → `send_command`

```ts
server.tool(
  'send_command',
  'Send input to an existing interactive terminal session (created via terminal_start). ' +
  'appendNewline defaults to true so the shell executes the command immediately. ' +
  'Set appendNewline=false ONLY for special cases (e.g. typing a password at a prompt). ' +
  'This tool does NOT wait for output — call terminal_read (with sinceSequence / ' +
  'waitForMs) afterwards to fetch results. ' +
  'REQUIRED: pass `account` (vault account name) when the server runs with --vault; ' +
  'the `account` value MUST MATCH the one used in terminal_start. Without it the ' +
  'request fails. Omit `account` only when the server runs with --host/--user.',
  { ... },
  async (...) => { ... }
);
```

---

## 5) `terminal-read` → `terminal_read`

```ts
server.tool(
  'terminal_read',
  'Read buffered output from an interactive terminal session. Each output line has a ' +
  'monotonic sequence number; pass sinceSequence to fetch only new lines and avoid ' +
  'duplicates between calls. waitForMs (0–5000ms) is useful for waiting on the next ' +
  'prompt without busy-looping. maxChars truncates to the last N characters. Maximum ' +
  'per-session buffer is 200,000 chars; on overflow the response sets truncated=true. ' +
  'Check the `closed` and `exitCode` fields to detect an exited shell. ' +
  'REQUIRED: pass `account` (vault account name) when the server runs with --vault; ' +
  'the `account` value MUST MATCH the one used in terminal_start. Without it the ' +
  'request fails. Omit `account` only when the server runs with --host/--user.',
  { ... },
  async (...) => { ... }
);
```

---

## 6) `terminal-resize` → `terminal_resize`

```ts
server.tool(
  'terminal_resize',
  'Resize an in-progress interactive terminal session (cols × rows). Sends TIOCSWINSZ ' +
  'to the remote PTY so full-screen apps (vim, htop, less) redraw correctly. Does ' +
  'NOT discard already-buffered output. ' +
  'REQUIRED: pass `account` (vault account name) when the server runs with --vault; ' +
  'without it the request fails. Omit `account` only when the server runs with --host/--user.',
  { ... },
  async (...) => { ... }
);
```

---

## 7) `terminal-close` → `terminal_close`

```ts
server.tool(
  'terminal_close',
  'Close an interactive terminal session on the MCP (client) side. The SSH stream ' +
  'is ended and the session is removed from memory. The marker file at ' +
  '/tmp/termssh-mcp/<id>.json on the remote is LEFT IN PLACE — a server-side watcher ' +
  'cleans it up and sends SIGTERM within ~10 minutes. This tool is idempotent: ' +
  'calling it twice does not error. ' +
  'REQUIRED: pass `account` (vault account name) when the server runs with --vault; ' +
  'the `account` value MUST MATCH the one used in terminal_start. Without it the ' +
  'request fails. Omit `account` only when the server runs with --host/--user.',
  { ... },
  async (...) => { ... }
);
```

---

## Summary of `name` changes (argument 1)

| Before | After |
|---|---|
| `upload-file` | `upload_file` |
| `upload-content` | `upload_content` |
| `terminal-start` | `terminal_start` |
| `send-command` | `send_command` |
| `terminal-read` | `terminal_read` |
| `terminal-resize` | `terminal_resize` |
| `terminal-close` | `terminal_close` |

> Rationale: the MCP naming convention is not strict, but `snake_case` is more common
> and many clients display the tool name verbatim in their UI.

---

## Bonus: register a `list_accounts` tool (strongly recommended)

Without this tool, the AI has no way to **discover** valid vault account names.
Pseudocode:

```ts
server.tool(
  'list_accounts',
  'Return the list of vault account names that are available, plus the currently ' +
  'active account. Call this FIRST whenever you are unsure whether the server runs ' +
  'in vault mode or CLI mode, or when you do not know which account name to pass to ' +
  'other tools. If this tool is registered, the server runs in vault mode and the ' +
  '`account` parameter is REQUIRED on every other SSH tool. If this tool is NOT ' +
  'registered, the server runs in CLI mode and `account` may be omitted.',
  { vaultPath: z.string().optional() },
  async ({ vaultPath }) => { /* read vault JSON, return list of names + active */ }
);
```
