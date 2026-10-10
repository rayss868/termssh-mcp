#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sanitizeCommand as sanitizeCommandWithLimit } from './core.js';
import { SSHConnectionManager } from './ssh-connection-manager.js';
import { loadVaultFileFromSources, resolveSshConfigFromSources } from './vault.js';

const isTestMode = process.env.TERMSSH_MCP_TEST === '1';
const isCliEnabled = process.env.TERMSSH_MCP_DISABLE_MAIN !== '1';
const argvConfig = (isCliEnabled || isTestMode) ? parseArgv() : {} as Record<string, string>;

const DEFAULT_TIMEOUT = argvConfig.timeout ? parseInt(argvConfig.timeout) : 60000;
const MAX_CHARS_RAW = argvConfig.maxChars;

const MAX_CHARS = (() => {
  if (typeof MAX_CHARS_RAW === 'string') {
    const lowered = MAX_CHARS_RAW.toLowerCase();
    if (lowered === 'none') return Infinity;
    const parsed = parseInt(MAX_CHARS_RAW);
    if (isNaN(parsed)) return 1000;
    if (parsed <= 0) return Infinity;
    return parsed;
  }
  return 1000;
})();

function parseArgv() {
  const args = process.argv.slice(2);
  const config: Record<string, string | null> = {};

  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const equalIndex = arg.indexOf('=');
    if (equalIndex === -1) {
      config[arg.slice(2)] = null;
    } else {
      config[arg.slice(2, equalIndex)] = arg.slice(equalIndex + 1);
    }
  }

  return config;
}

function validateConfig(config: Record<string, string | null>) {
  const hasVault = Boolean(config.vault);
  const errors = [];
  if (!hasVault) {
    if (!config.host) errors.push('Missing required --host');
    if (!config.user) errors.push('Missing required --user');
  }
  if (config.port && isNaN(Number(config.port))) errors.push('Invalid --port');
  if (errors.length > 0) {
    throw new Error('Configuration error:\n' + errors.join('\n'));
  }
}

if (isCliEnabled) {
  validateConfig(argvConfig);
}

export function sanitizeCommand(command: string): string {
  return sanitizeCommandWithLimit(command, MAX_CHARS);
}

const connectionManagers = new Map<string, SSHConnectionManager>();
const sessionAccountBindings = new Map<string, string>();

function resolveAccountForSession(sessionId: string, account?: string): string | undefined {
  if (account) {
    sessionAccountBindings.set(sessionId, account);
    return account;
  }
  const cached = sessionAccountBindings.get(sessionId);
  if (cached !== undefined) return cached;
  return undefined;
}

function getConnectionManagerCacheKey(source: 'vault' | 'cli', accountName?: string): string {
  if (source === 'vault') {
    return `vault:${accountName ?? 'active'}`;
  }
  return 'cli:default';
}

async function getOrCreateConnectionManager(account?: string): Promise<SSHConnectionManager> {
  const resolved = await resolveSshConfigFromSources({
    argvConfig,
    defaultTimeout: DEFAULT_TIMEOUT,
    accountName: account,
  });

  const cacheKey = getConnectionManagerCacheKey(resolved.source, resolved.accountName);
  let connectionManager = connectionManagers.get(cacheKey) ?? null;

  if (!connectionManager) {
    connectionManager = new SSHConnectionManager(resolved.sshConfig);
    connectionManagers.set(cacheKey, connectionManager);
  }

  await connectionManager.ensureConnected();
  return connectionManager;
}

function createTextResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

const server = new McpServer({
  name: 'TermSSH MCP',
  version: '1.7.0',
  capabilities: {
    resources: {},
    tools: {},
  },
});

server.tool(
  'list_accounts',
  'List the vault accounts this MCP server can connect with, plus the currently active ' +
  'account. Each entry reports the account name, host, port, SSH user, auth method ' +
  '(password and/or key), and whether su/sudo elevation is configured — no secrets are ' +
  'returned. Call this tool FIRST whenever you are unsure which `account` name to pass to ' +
  'any other tool, or to detect which mode the server runs in. How to read the result: ' +
  'mode="vault" with a non-empty accounts list means the server runs with --vault and the ' +
  '`account` parameter is REQUIRED on every other tool (upload_file, upload_content, ' +
  'terminal_start, send_command, terminal_read, terminal_resize, terminal_close); ' +
  'mode="cli" with an empty accounts list means no vault file was found (server runs with ' +
  '--host/--user) and `account` may be omitted everywhere; mode="vault-error" means the ' +
  'vault file exists but is invalid — see the note field. Account names are CASE-SENSITIVE ' +
  'and must match the vault JSON keys exactly. Pass vaultPath only to inspect a specific ' +
  'vault file instead of the one the server was started with.',
  {
    vaultPath: z.string().optional().describe('(Optional) Path to a vault JSON file to inspect instead of the server-configured vault path.'),
  },
  async ({ vaultPath }) => {
    const effectiveArgvConfig = vaultPath
      ? { ...argvConfig, vault: vaultPath }
      : argvConfig;
    try {
      const { vault, vaultPath: resolvedVaultPath } = await loadVaultFileFromSources({
        argvConfig: effectiveArgvConfig,
      });
      const accounts = Object.entries(vault.accounts).map(([name, acc]) => ({
        name,
        active: name === vault.activeAccount,
        host: acc.host,
        port: acc.port ?? 22,
        user: acc.user,
        auth: [acc.password ? 'password' : null, acc.key ? 'key' : null]
          .filter(Boolean)
          .join('+') || 'none',
        elevation: Boolean(acc.suPassword || acc.sudoPassword),
      }));
      return createTextResult(JSON.stringify({
        mode: 'vault',
        vaultPath: resolvedVaultPath,
        activeAccount: vault.activeAccount,
        accounts,
      }, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createTextResult(JSON.stringify({
        mode: /ENOENT/i.test(message) ? 'cli' : 'vault-error',
        vaultPath: vaultPath ?? argvConfig.vault ?? './vault.json',
        accounts: [],
        note: message,
      }, null, 2));
    }
  }
);

server.tool(
  'upload_file',
  'Upload a single file from the local MCP host disk to the remote SSH server via SFTP. ' +
  'Use this when the source file already exists on disk and only needs to be moved. For ' +
  'small in-memory payloads (text, JSON, base64-encoded binary) use upload_content instead. ' +
  'Behavior notes: localPath is read from the MCP HOST filesystem, not the remote server; ' +
  'remotePath must be an absolute path on the remote server; if the remote file already ' +
  'exists and overwrite is not true, the request FAILS — set overwrite=true to replace it; ' +
  'createDirectories=true creates missing parent directories recursively; mode is a POSIX ' +
  'OCTAL string such as 0644 or 0755 (not decimal). ' +
  'Common errors: "Vault account selection is required" → pass `account` (or call ' +
  'list_accounts to discover names); "already exists" → retry with overwrite=true; local ' +
  'path not readable → fix localPath on the MCP host, not on the remote. ' +
  'REQUIRED: pass `account` (vault account name) when the server runs with --vault; ' +
  'without it the request fails with "Vault account selection is required". ' +
  'Omit `account` only when the server runs with --host/--user.',
  {
    account: z.string().optional().describe('(Often required) Vault account name to target. REQUIRED when the server runs with --vault. May be omitted only when the server runs with --host/--user. Case-sensitive; must match a key in the vault JSON file.'),
    localPath: z.string().describe('Local file path on the MCP host machine — absolute or relative to the server working directory.'),
    remotePath: z.string().describe('Absolute destination path on the remote server (e.g. /etc/app/config.yaml). Use forward slashes for Linux/macOS, or drive-letter + backslash for Windows.'),
    createDirectories: z.boolean().optional().describe('(Optional, default false) Recursively create parent directories on the remote server if they do not exist.'),
    overwrite: z.boolean().optional().describe('(Optional, default false) Overwrite the remote file if it already exists. Without this flag, an existing file causes the request to fail.'),
    mode: z.string().optional().describe('(Optional) POSIX octal mode (3–4 digits) applied after upload, e.g. 0644 or 0755. Skip if you are unsure.'),
  },
  async ({ account, localPath, remotePath, createDirectories, overwrite, mode }) => {
    const manager = await getOrCreateConnectionManager(account);
    const result = await manager.uploadLocalFile({ localPath, remotePath, createDirectories, overwrite, mode });
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

server.tool(
  'upload_content',
  'Upload content directly (in-memory) to the remote SSH server via SFTP, without ' +
  'touching the local disk. Ideal for small payloads: config snippets, code, JSON, ' +
  'one-liner scripts, or base64-encoded binary. The source is the `content` field — ' +
  'there is no localPath and nothing is read from the MCP host disk. ' +
  'Behavior notes: use encoding="utf8" for plain text; for binary data (images, PDFs, ' +
  'executables, archives) base64-encode the payload and pass encoding="base64" — never ' +
  'send raw binary; remotePath must be absolute on the remote server; if the remote file ' +
  'already exists and overwrite is not true, the request FAILS — set overwrite=true to ' +
  'replace it; createDirectories=true creates missing parent directories recursively; ' +
  'mode is a POSIX OCTAL string such as 0644 (not decimal). ' +
  'Common errors: "Vault account selection is required" → pass `account` (or call ' +
  'list_accounts to discover names); "already exists" → retry with overwrite=true. ' +
  'REQUIRED: pass `account` (vault account name) when the server runs with --vault; ' +
  'without it the request fails. Omit `account` only when the server runs with --host/--user.',
  {
    account: z.string().optional().describe('(Often required) Vault account name. REQUIRED with --vault, omit only with --host/--user.'),
    content: z.string().describe('Payload to upload. Plain text for `utf8`, base64 for binary data.'),
    encoding: z.enum(['utf8', 'base64']).describe('Encoding of the content field: utf8 for plain text, base64 for binary data (images, PDFs, executables, etc.).'),
    remotePath: z.string().describe('Absolute destination path on the remote server.'),
    createDirectories: z.boolean().optional().describe('(Optional, default false) Recursively create parent directories if they do not exist.'),
    overwrite: z.boolean().optional().describe('(Optional, default false) Overwrite the remote file if it already exists.'),
    mode: z.string().optional().describe('(Optional) POSIX octal mode (3–4 digits) applied after write.'),
  },
  async ({ account, content, encoding, remotePath, createDirectories, overwrite, mode }) => {
    const manager = await getOrCreateConnectionManager(account);
    const result = await manager.uploadContent({ content, encoding, remotePath, createDirectories, overwrite, mode });
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

server.tool(
  'download_file',
  'Download a single file from the remote SSH server to the local MCP host using SFTP. ' +
  'Use this when the remote file should be saved to local disk. localPath refers to the MCP ' +
  'host, not the remote server. Existing local files are preserved unless overwrite=true. ' +
  'Parent directories are created automatically. Pass account when using --vault.',
  {
    account: z.string().optional().describe('(Optional) Vault account name. Required with --vault.'),
    remotePath: z.string().describe('Absolute path to a remote file.'),
    localPath: z.string().describe('Destination path on the MCP host. Parent directories are created if needed.'),
    overwrite: z.boolean().optional().describe('(Optional, default false) Replace the local file if it already exists.'),
  },
  async ({ account, remotePath, localPath, overwrite }) => {
    const manager = await getOrCreateConnectionManager(account);
    const result = await manager.downloadRemoteFile({ remotePath, localPath, overwrite });
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

server.tool(
  'list_remote_directory',
  'List entries in a remote directory over SFTP. Returns each entry name, type, size, ' +
  'and modification time. Use this to inspect remote files before downloading or uploading. ' +
  'Pass account when using --vault.',
  {
    account: z.string().optional().describe('(Optional) Vault account name. Required with --vault.'),
    remotePath: z.string().describe('Absolute path to the remote directory.'),
  },
  async ({ account, remotePath }) => {
    const manager = await getOrCreateConnectionManager(account);
    const result = await manager.listRemoteDirectory(remotePath);
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

server.tool(
  'get_remote_file_info',
  'Get metadata for a remote file or directory using SFTP, including type, size, ' +
  'permissions mode, and modification time. Pass account when using --vault.',
  {
    account: z.string().optional().describe('(Optional) Vault account name. Required with --vault.'),
    remotePath: z.string().describe('Absolute path to the remote file or directory.'),
  },
  async ({ account, remotePath }) => {
    const manager = await getOrCreateConnectionManager(account);
    const result = await manager.getRemoteFileInfo(remotePath);
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

server.tool('create_remote_directory', 'Create a remote directory. Set recursive=true to create missing parents.', {
  account: z.string().optional(), remotePath: z.string(), recursive: z.boolean().optional(),
}, async ({ account, remotePath, recursive }) => createTextResult(JSON.stringify(await (await getOrCreateConnectionManager(account)).createRemoteDirectory(remotePath, recursive), null, 2)));

server.tool('remove_remote_directory', 'Remove an empty remote directory. This operation is destructive.', {
  account: z.string().optional(), remotePath: z.string(),
}, async ({ account, remotePath }) => createTextResult(JSON.stringify(await (await getOrCreateConnectionManager(account)).removeRemoteDirectory(remotePath), null, 2)));

server.tool('delete_remote_file', 'Permanently delete a remote file. Does not remove directories.', {
  account: z.string().optional(), remotePath: z.string(),
}, async ({ account, remotePath }) => createTextResult(JSON.stringify(await (await getOrCreateConnectionManager(account)).deleteRemoteFile(remotePath), null, 2)));

server.tool('rename_remote_path', 'Rename or move a remote file or directory. Existing destination requires overwrite=true.', {
  account: z.string().optional(), remotePath: z.string(), newRemotePath: z.string(), overwrite: z.boolean().optional(),
}, async ({ account, remotePath, newRemotePath, overwrite }) => createTextResult(JSON.stringify(await (await getOrCreateConnectionManager(account)).renameRemotePath({ remotePath, newRemotePath, overwrite }), null, 2)));

server.tool('set_remote_file_metadata', 'Set remote file permissions and/or modification time.', {
  account: z.string().optional(), remotePath: z.string(), mode: z.string().optional(), modifiedAt: z.string().optional(),
}, async ({ account, remotePath, mode, modifiedAt }) => createTextResult(JSON.stringify(await (await getOrCreateConnectionManager(account)).setRemoteFileMetadata({ remotePath, mode, modifiedAt }), null, 2)));

server.tool('upload_directory', 'Recursively upload regular files from a local directory to a remote directory. Symlinks are skipped.', {
  account: z.string().optional(), localPath: z.string(), remotePath: z.string(), overwrite: z.boolean().optional(), mode: z.string().optional(), maxFiles: z.number().int().positive().optional(),
}, async ({ account, localPath, remotePath, overwrite, mode, maxFiles }) => createTextResult(JSON.stringify(await (await getOrCreateConnectionManager(account)).uploadRemoteDirectory({ localPath, remotePath, overwrite, mode, maxFiles }), null, 2)));

server.tool('download_directory', 'Recursively download regular files from a remote directory to the MCP host. Symlinks are skipped.', {
  account: z.string().optional(), remotePath: z.string(), localPath: z.string(), overwrite: z.boolean().optional(), maxFiles: z.number().int().positive().optional(),
}, async ({ account, remotePath, localPath, overwrite, maxFiles }) => createTextResult(JSON.stringify(await (await getOrCreateConnectionManager(account)).downloadRemoteDirectory({ remotePath, localPath, overwrite, maxFiles }), null, 2)));

server.tool(
  'terminal_start',
  'Open an interactive shell session on the remote SSH server and start buffering ' +
  'its output. Standard workflow: 1) terminal_start → 2) send_command to send input → ' +
  '3) terminal_read (with sinceSequence/waitForMs) to fetch output → 4) repeat 2-3 as ' +
  'needed → 5) terminal_close when done. The response includes a sessionId — pass it to ' +
  'send_command, terminal_read, terminal_resize and terminal_close. ' +
  'Behavior notes: by default an active session matching the same account/cwd/user/host ' +
  'is REUSED; set multiSession=true to force a new one; cwd, shell and env are applied ' +
  'as bootstrap AFTER the shell starts, so a bootstrap failure does not mean the shell ' +
  'itself failed; sessions auto-close after 10 minutes idle (each send_command refreshes ' +
  'the idle timer); automatic su elevation requires suPassword in the vault account plus ' +
  'elevated=true (ignored on Windows); platformHint controls newline handling and ' +
  'bootstrap target — "windows" targets cmd.exe. ' +
  'REQUIRED: pass `account` (vault account name) when the server runs with --vault; ' +
  'without it the request fails. Omit `account` only when the server runs with ' +
  '--host/--user. The session is auto-bound to this account, so later calls for the same ' +
  'sessionId usually do not need `account`.',
  {
    account: z.string().optional().describe('(Often required) Vault account name. REQUIRED with --vault, omit only with --host/--user.'),
    cwd: z.string().optional().describe('(Optional) Working directory to `cd` into after the shell starts.'),
    shell: z.string().optional().describe("(Optional) Path to a shell executable, e.g. '/bin/bash' or 'C:\\\\Windows\\\\System32\\\\cmd.exe'."),
    platformHint: z.enum(['auto', 'linux', 'windows']).optional().describe("(Optional, default 'auto') Platform hint: 'linux', 'windows', or 'auto' (auto-detect). Controls newline handling and bootstrap behavior."),
    elevated: z.boolean().optional().describe('(Optional, default false) Try to elevate to `su -` when suPassword is configured. Ignored on Windows.'),
    cols: z.number().int().positive().optional().describe('(Optional, default 80) Initial terminal width in columns.'),
    rows: z.number().int().positive().optional().describe('(Optional, default 24) Initial terminal height in rows.'),
    env: z.record(z.string()).optional().describe('(Optional) Extra environment variables to export after the shell starts (object key→value).'),
    multiSession: z.boolean().optional().describe('(Optional, default false) Set true to force a new session. Default reuses an active matching session.'),
  },
  async ({ account, cwd, shell, platformHint, elevated, cols, rows, env, multiSession }) => {
    const manager = await getOrCreateConnectionManager(account);
    const session = await manager.startInteractiveSession({ cwd, shell, platformHint, elevated, cols, rows, env, multiSession });
    if (session && session.sessionId) {
      sessionAccountBindings.set(session.sessionId, account ?? 'cli:default');
    }
    return createTextResult(JSON.stringify(session, null, 2));
  }
);

server.tool(
  'send_command',
  'Send input to an existing interactive terminal session (created via terminal_start). ' +
  'This is for interactive sessions only — there is no one-shot exec tool; to run a single ' +
  'command: terminal_start, then send_command here, then terminal_read. ' +
  'appendNewline defaults to true so the shell executes the command immediately. ' +
  'Set appendNewline=false ONLY for special cases (e.g. typing a password at a prompt). ' +
  'This tool does NOT wait for output — call terminal_read (with sinceSequence / ' +
  'waitForMs) afterwards to fetch results. Each call refreshes the session idle timer, ' +
  'postponing the 10-minute auto-close. ' +
  'AUTO-BINDING: once the session is opened with terminal_start, you usually do NOT ' +
  'need to pass `account` here — the MCP reuses the account that opened the session. ' +
  'Pass `account` explicitly only to override the binding when working with multiple ' +
  'vault accounts in parallel. terminal_start itself still requires `account` in ' +
  '--vault mode.',
  {
    account: z.string().optional().describe('(Optional) Vault account name. If omitted, the account bound to this sessionId at terminal_start time is reused automatically. Pass explicitly to override the binding when working with multiple vault accounts.'),
    sessionId: z.string().describe('Interactive session id returned by terminal_start.'),
    input: z.string().describe('Text to send to the session stdin. A newline is appended automatically unless appendNewline=false.'),
    appendNewline: z.boolean().optional().describe('(Optional, default true) Append a newline at the end. Set false ONLY when you need to send input without executing it (e.g. a password).'),
  },
  async ({ account, sessionId, input, appendNewline }) => {
    const resolvedAccount = resolveAccountForSession(sessionId, account);
    const manager = await getOrCreateConnectionManager(resolvedAccount);
    const result = await manager.writeInteractiveSession(sessionId, input, appendNewline ?? true);
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

server.tool(
  'terminal_read',
  'Read buffered output from an interactive terminal session. Each output line has a ' +
  'monotonic sequence number; pass sinceSequence to fetch only new lines and avoid ' +
  'duplicates between calls. waitForMs (0–5000ms) is useful for waiting on the next ' +
  'prompt without busy-looping. maxChars truncates to the last N characters. Maximum ' +
  'per-session buffer is 200,000 chars; on overflow the response sets truncated=true. ' +
  'Check the `closed` and `exitCode` fields to detect an exited shell. Typical polling ' +
  'loop: send_command → terminal_read with waitForMs=500-2000 and sinceSequence=<the ' +
  'nextSequence from the previous response> → repeat until the shell prompt reappears ' +
  'or closed=true. ' +
  'AUTO-BINDING: once the session is opened with terminal_start, you usually do NOT ' +
  'need to pass `account` here — the MCP reuses the account that opened the session. ' +
  'Pass `account` explicitly only to override the binding when working with multiple ' +
  'vault accounts in parallel.',
  {
    account: z.string().optional().describe('(Optional) Vault account name. If omitted, the account bound to this sessionId at terminal_start time is reused automatically. Pass explicitly to override the binding when working with multiple vault accounts.'),
    sessionId: z.string().describe('Interactive session id.'),
    sinceSequence: z.number().int().min(0).optional().describe('(Optional, default 0) Return only output whose sequence is greater than this value. Use the nextSequence from a previous response.'),
    maxChars: z.number().int().positive().optional().describe('(Optional) Trim the returned output to the last maxChars characters. Useful for very long outputs.'),
    waitForMs: z.number().int().min(0).max(5000).optional().describe('(Optional, 0–5000) Delay the read by this many milliseconds. Useful for soft-realtime polling without busy-looping.'),
  },
  async ({ account, sessionId, sinceSequence, maxChars, waitForMs }) => {
    const resolvedAccount = resolveAccountForSession(sessionId, account);
    const manager = await getOrCreateConnectionManager(resolvedAccount);
    if (waitForMs && waitForMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitForMs));
    }
    const result = await manager.readInteractiveSession(sessionId, { sinceSequence, maxChars });
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

server.tool(
  'terminal_resize',
  'Resize an in-progress interactive terminal session (cols × rows). Sends TIOCSWINSZ ' +
  'to the remote PTY so full-screen apps (vim, htop, less) redraw correctly. Call this ' +
  'after terminal_start and before running full-screen applications. Does NOT discard ' +
  'already-buffered output and only affects the session PTY, not your local window. ' +
  'AUTO-BINDING: once the session is opened with terminal_start, you usually do NOT ' +
  'need to pass `account` here — the MCP reuses the account that opened the session. ' +
  'Pass `account` explicitly only to override the binding when working with multiple ' +
  'vault accounts in parallel.',
  {
    account: z.string().optional().describe('(Optional) Vault account name. If omitted, the account bound to this sessionId at terminal_start time is reused automatically. Pass explicitly to override the binding when working with multiple vault accounts.'),
    sessionId: z.string().describe('Interactive session id.'),
    cols: z.number().int().positive().describe('New terminal width in columns (must be > 0).'),
    rows: z.number().int().positive().describe('New terminal height in rows (must be > 0).'),
  },
  async ({ account, sessionId, cols, rows }) => {
    const resolvedAccount = resolveAccountForSession(sessionId, account);
    const manager = await getOrCreateConnectionManager(resolvedAccount);
    const result = manager.resizeInteractiveSession(sessionId, cols, rows);
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

server.tool(
  'terminal_close',
  'Close an interactive terminal session on the MCP (client) side. The SSH stream ' +
  'is ended and the session is removed from memory, along with its account binding. ' +
  'Always call this when finished to avoid leaking sessions and idle timers. The marker ' +
  'file at /tmp/termssh-mcp/<id>.json on the remote is LEFT IN PLACE — a server-side ' +
  'watcher cleans it up and sends SIGTERM within ~10 minutes. This tool is idempotent: ' +
  'calling it twice does not error. ' +
  'AUTO-BINDING: once the session is opened with terminal_start, you usually do NOT ' +
  'need to pass `account` here — the MCP reuses the account that opened the session. ' +
  'Pass `account` explicitly only to override the binding when working with multiple ' +
  'vault accounts in parallel.',
  {
    account: z.string().optional().describe('(Optional) Vault account name. If omitted, the account bound to this sessionId at terminal_start time is reused automatically. Pass explicitly to override the binding when working with multiple vault accounts.'),
    sessionId: z.string().describe('Interactive session id to close.'),
  },
  async ({ account, sessionId }) => {
    const resolvedAccount = resolveAccountForSession(sessionId, account);
    const manager = await getOrCreateConnectionManager(resolvedAccount);
    const result = manager.closeInteractiveSession(sessionId);
    sessionAccountBindings.delete(sessionId);
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

function closeAllConnectionManagers() {
  for (const manager of connectionManagers.values()) {
    manager.close();
  }
  connectionManagers.clear();
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('TermSSH MCP running on stdio');

  const cleanup = () => {
    console.error('Shutting down TermSSH MCP...');
    closeAllConnectionManagers();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => {
    closeAllConnectionManagers();
  });
}

if (isTestMode) {
  const transport = new StdioServerTransport();
  server.connect(transport).catch((error) => {
    console.error('Fatal error connecting server:', error);
    process.exit(1);
  });
} else if (isCliEnabled) {
  main().catch((error) => {
    console.error('Fatal error in main():', error);
    closeAllConnectionManagers();
    process.exit(1);
  });
}

export { parseArgv, validateConfig, SSHConnectionManager };
