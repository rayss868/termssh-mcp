#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sanitizeCommand as sanitizeCommandWithLimit } from './core.js';
import { SSHConnectionManager } from './ssh-connection-manager.js';

const isTestMode = process.env.TERMSSH_MCP_TEST === '1';
const isCliEnabled = process.env.TERMSSH_MCP_DISABLE_MAIN !== '1';
const argvConfig = (isCliEnabled || isTestMode) ? parseArgv() : {} as Record<string, string>;

const HOST = argvConfig.host;
const PORT = argvConfig.port ? parseInt(argvConfig.port) : 22;
const USER = argvConfig.user;
const PASSWORD = argvConfig.password;
const SUPASSWORD = argvConfig.suPassword;
const SUDOPASSWORD = argvConfig.sudoPassword;
const KEY = argvConfig.key;
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
  const errors = [];
  if (!config.host) errors.push('Missing required --host');
  if (!config.user) errors.push('Missing required --user');
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

let connectionManager: SSHConnectionManager | null = null;

async function getOrCreateConnectionManager(): Promise<SSHConnectionManager> {
  if (!connectionManager) {
    connectionManager = await SSHConnectionManager.fromCliConfig({
      host: HOST,
      port: PORT,
      user: USER,
      password: PASSWORD,
      key: KEY,
      suPassword: SUPASSWORD,
      sudoPassword: SUDOPASSWORD,
      timeout: DEFAULT_TIMEOUT,
    });
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
  'upload-file',
  'Upload a local file to the remote SSH server using SFTP.',
  {
    localPath: z.string().describe('Local file path on the MCP host machine'),
    remotePath: z.string().describe('Destination file path on the remote SSH server'),
    createDirectories: z.boolean().optional().describe('Create missing parent directories on the remote server if needed'),
    overwrite: z.boolean().optional().describe('Overwrite the remote file if it already exists'),
    mode: z.string().optional().describe('Optional POSIX mode to apply after upload, such as 0644'),
  },
  async ({ localPath, remotePath, createDirectories, overwrite, mode }) => {
    const manager = await getOrCreateConnectionManager();
    const result = await manager.uploadLocalFile({ localPath, remotePath, createDirectories, overwrite, mode });
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

server.tool(
  'upload-content',
  'Upload direct text or base64 content to the remote SSH server using SFTP.',
  {
    content: z.string().describe('Raw content to upload'),
    encoding: z.enum(['utf8', 'base64']).describe('Encoding used for the content field'),
    remotePath: z.string().describe('Destination file path on the remote SSH server'),
    createDirectories: z.boolean().optional().describe('Create missing parent directories on the remote server if needed'),
    overwrite: z.boolean().optional().describe('Overwrite the remote file if it already exists'),
    mode: z.string().optional().describe('Optional POSIX mode to apply after upload, such as 0644'),
  },
  async ({ content, encoding, remotePath, createDirectories, overwrite, mode }) => {
    const manager = await getOrCreateConnectionManager();
    const result = await manager.uploadContent({ content, encoding, remotePath, createDirectories, overwrite, mode });
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

server.tool(
  'terminal-start',
  'Start an interactive terminal session on the remote SSH server. Reuses a managed session by default unless multiSession is true.',
  {
    cwd: z.string().optional().describe('Optional working directory to change into after the shell starts'),
    shell: z.string().optional().describe('Optional shell executable to start inside the terminal session'),
    platformHint: z.enum(['auto', 'linux', 'windows']).optional().describe('Hint for newline and bootstrap behavior'),
    elevated: z.boolean().optional().describe('Attempt to elevate to su when a su password is configured'),
    cols: z.number().int().positive().optional().describe('Initial terminal width in columns'),
    rows: z.number().int().positive().optional().describe('Initial terminal height in rows'),
    env: z.record(z.string()).optional().describe('Optional environment variables to set after shell start'),
    multiSession: z.boolean().optional().describe('Set true to explicitly create a new managed terminal instead of reusing an existing active session'),
  },
  async ({ cwd, shell, platformHint, elevated, cols, rows, env, multiSession }) => {
    const manager = await getOrCreateConnectionManager();
    const session = await manager.startInteractiveSession({ cwd, shell, platformHint, elevated, cols, rows, env, multiSession });
    return createTextResult(JSON.stringify(session, null, 2));
  }
);

server.tool(
  'terminal-write',
  'Write input into an existing interactive terminal session. Use this for ordinary commands and sudo-interactive flows instead of exec tools.',
  {
    sessionId: z.string().describe('Interactive terminal session id'),
    input: z.string().describe('Input text to send to the session'),
    appendNewline: z.boolean().optional().describe('Append a newline after the input before sending it'),
  },
  async ({ sessionId, input, appendNewline }) => {
    const manager = await getOrCreateConnectionManager();
    const result = await manager.writeInteractiveSession(sessionId, input, appendNewline);
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

server.tool(
  'terminal-read',
  'Read buffered output from an interactive terminal session.',
  {
    sessionId: z.string().describe('Interactive terminal session id'),
    sinceSequence: z.number().int().min(0).optional().describe('Return only output newer than this sequence number'),
    maxChars: z.number().int().positive().optional().describe('Trim returned output to the latest maxChars characters'),
    waitForMs: z.number().int().min(0).max(5000).optional().describe('Optional short wait before reading, useful for pseudo-realtime polling'),
  },
  async ({ sessionId, sinceSequence, maxChars, waitForMs }) => {
    const manager = await getOrCreateConnectionManager();
    if (waitForMs && waitForMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitForMs));
    }
    const result = await manager.readInteractiveSession(sessionId, { sinceSequence, maxChars });
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

server.tool(
  'terminal-resize',
  'Resize an existing interactive terminal session.',
  {
    sessionId: z.string().describe('Interactive terminal session id'),
    cols: z.number().int().positive().describe('New terminal width in columns'),
    rows: z.number().int().positive().describe('New terminal height in rows'),
  },
  async ({ sessionId, cols, rows }) => {
    const manager = await getOrCreateConnectionManager();
    const result = manager.resizeInteractiveSession(sessionId, cols, rows);
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

server.tool(
  'terminal-close',
  'Close an interactive terminal session locally. The remote marker file is left for the server-side watcher to clean up if it is still present.',
  {
    sessionId: z.string().describe('Interactive terminal session id'),
  },
  async ({ sessionId }) => {
    const manager = await getOrCreateConnectionManager();
    const result = manager.closeInteractiveSession(sessionId);
    return createTextResult(JSON.stringify(result, null, 2));
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('TermSSH MCP running on stdio');

  const cleanup = () => {
    console.error('Shutting down TermSSH MCP...');
    if (connectionManager) {
      connectionManager.close();
      connectionManager = null;
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => {
    if (connectionManager) {
      connectionManager.close();
    }
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
    if (connectionManager) {
      connectionManager.close();
    }
    process.exit(1);
  });
}

export { parseArgv, validateConfig, SSHConnectionManager };
