#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sanitizeCommand as sanitizeCommandWithLimit } from './core.js';
import { SSHConnectionManager } from './ssh-connection-manager.js';
import { resolveSshConfigFromSources } from './vault.js';

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
  'upload_file',
  'Upload a single file from the local MCP host disk to the remote SSH server via SFTP. ' +
  'Use this when the source already exists on disk. For small in-memory payloads (text, ' +
  'JSON, or base64-encoded binary) use upload_content instead. ' +
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
  'or base64-encoded binary. The source is the `content` field, not a file on disk. ' +
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
  'terminal_start',
  'Open an interactive shell session on the remote SSH server and start buffering ' +
  'its output. After this call, use terminal_read to view output and send_command to ' +
  'send input. End the session with terminal_close. By default, an active session ' +
  'matching the same account/cwd/user/host is REUSED; set multiSession=true to force ' +
  'a new one. Sessions auto-close after 10 minutes idle. Automatic su-elevation ' +
  'requires suPassword in the config plus elevated=true (ignored on Windows). ' +
  'REQUIRED: pass `account` (vault account name) when the server runs with --vault; ' +
  'without it the request fails. Omit `account` only when the server runs with --host/--user.',
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
    return createTextResult(JSON.stringify(session, null, 2));
  }
);

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
  {
    account: z.string().optional().describe('(Often required) Vault account name. REQUIRED with --vault, omit only with --host/--user. Must match the account used when the session was created.'),
    sessionId: z.string().describe('Interactive session id returned by terminal_start.'),
    input: z.string().describe('Text to send to the session stdin. A newline is appended automatically unless appendNewline=false.'),
    appendNewline: z.boolean().optional().describe('(Optional, default true) Append a newline at the end. Set false ONLY when you need to send input without executing it (e.g. a password).'),
  },
  async ({ account, sessionId, input, appendNewline }) => {
    const manager = await getOrCreateConnectionManager(account);
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
  'Check the `closed` and `exitCode` fields to detect an exited shell. ' +
  'REQUIRED: pass `account` (vault account name) when the server runs with --vault; ' +
  'the `account` value MUST MATCH the one used in terminal_start. Without it the ' +
  'request fails. Omit `account` only when the server runs with --host/--user.',
  {
    account: z.string().optional().describe('(Often required) Vault account name. REQUIRED with --vault, omit only with --host/--user. Must match the account used when the session was created.'),
    sessionId: z.string().describe('Interactive session id.'),
    sinceSequence: z.number().int().min(0).optional().describe('(Optional, default 0) Return only output whose sequence is greater than this value. Use the nextSequence from a previous response.'),
    maxChars: z.number().int().positive().optional().describe('(Optional) Trim the returned output to the last maxChars characters. Useful for very long outputs.'),
    waitForMs: z.number().int().min(0).max(5000).optional().describe('(Optional, 0–5000) Delay the read by this many milliseconds. Useful for soft-realtime polling without busy-looping.'),
  },
  async ({ account, sessionId, sinceSequence, maxChars, waitForMs }) => {
    const manager = await getOrCreateConnectionManager(account);
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
  'to the remote PTY so full-screen apps (vim, htop, less) redraw correctly. Does ' +
  'NOT discard already-buffered output. ' +
  'REQUIRED: pass `account` (vault account name) when the server runs with --vault; ' +
  'without it the request fails. Omit `account` only when the server runs with --host/--user.',
  {
    account: z.string().optional().describe('(Often required) Vault account name. REQUIRED with --vault, omit only with --host/--user.'),
    sessionId: z.string().describe('Interactive session id.'),
    cols: z.number().int().positive().describe('New terminal width in columns (must be > 0).'),
    rows: z.number().int().positive().describe('New terminal height in rows (must be > 0).'),
  },
  async ({ account, sessionId, cols, rows }) => {
    const manager = await getOrCreateConnectionManager(account);
    const result = manager.resizeInteractiveSession(sessionId, cols, rows);
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

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
  {
    account: z.string().optional().describe('(Often required) Vault account name. REQUIRED with --vault, omit only with --host/--user. Must match the account used when the session was created.'),
    sessionId: z.string().describe('Interactive session id to close.'),
  },
  async ({ account, sessionId }) => {
    const manager = await getOrCreateConnectionManager(account);
    const result = manager.closeInteractiveSession(sessionId);
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
