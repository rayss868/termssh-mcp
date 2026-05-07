import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ClientChannel } from 'ssh2';

const DEFAULT_TERMINAL_BUFFER_CHARS = 200_000;
const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;

export type PlatformHint = 'auto' | 'linux' | 'windows';

export interface InteractiveSession {
  id: string;
  stream: ClientChannel | null;
  cols: number;
  rows: number;
  platformHint: PlatformHint;
  shell?: string;
  closed: boolean;
  exitCode?: number;
  sequence: number;
  droppedBeforeSequence: number;
  chunks: Array<{ sequence: number; text: string }>;
  bufferedChars: number;
  truncated: boolean;
  createdAt: number;
  lastActivityAt: number;
  managedSessionPrefix?: string;
  cwd?: string;
  user?: string;
  host?: string;
  remotePid?: string;
  remoteMetadataPath?: string;
}

export interface InteractiveSessionReadResult {
  sessionId: string;
  output: string;
  nextSequence: number;
  truncated: boolean;
  closed: boolean;
  exitCode?: number;
}

export interface ManagedSessionReuseOptions {
  managedSessionPrefix: string;
  cwd?: string;
  user?: string;
  host?: string;
  allowMultiple?: boolean;
}

function createManagedSessionId(prefix: string, counter: number): string {
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}`;
}

function normalizeReuseKeyPart(value?: string): string {
  return (value ?? '').trim();
}

export class InteractiveSessionStore {
  private sessions = new Map<string, InteractiveSession>();
  private counter = 0;
  private readonly maxBufferedChars: number;

  constructor(options?: { maxBufferedChars?: number }) {
    this.maxBufferedChars = options?.maxBufferedChars ?? DEFAULT_TERMINAL_BUFFER_CHARS;
  }

  createSession(options?: {
    cols?: number;
    rows?: number;
    platformHint?: PlatformHint;
    shell?: string;
    stream?: ClientChannel | null;
    managedSessionPrefix?: string;
    cwd?: string;
    user?: string;
    host?: string;
    remoteMetadataPath?: string;
  }): InteractiveSession {
    this.counter += 1;
    const now = Date.now();
    const session: InteractiveSession = {
      id: options?.managedSessionPrefix
        ? createManagedSessionId(options.managedSessionPrefix, this.counter)
        : `term_${now}_${this.counter}`,
      stream: options?.stream ?? null,
      cols: options?.cols ?? DEFAULT_TERMINAL_COLS,
      rows: options?.rows ?? DEFAULT_TERMINAL_ROWS,
      platformHint: options?.platformHint ?? 'auto',
      shell: options?.shell,
      closed: false,
      exitCode: undefined,
      sequence: 0,
      droppedBeforeSequence: 0,
      chunks: [],
      bufferedChars: 0,
      truncated: false,
      createdAt: now,
      lastActivityAt: now,
      managedSessionPrefix: options?.managedSessionPrefix,
      cwd: options?.cwd,
      user: options?.user,
      host: options?.host,
      remoteMetadataPath: options?.remoteMetadataPath,
    };

    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): InteractiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new McpError(ErrorCode.InvalidParams, `Interactive session ${sessionId} was not found`);
    }
    return session;
  }

  listSessions(): InteractiveSession[] {
    return [...this.sessions.values()];
  }

  findReusableSession(options: ManagedSessionReuseOptions): InteractiveSession | undefined {
    if (options.allowMultiple) {
      return undefined;
    }

    const cwd = normalizeReuseKeyPart(options.cwd);
    const user = normalizeReuseKeyPart(options.user);
    const host = normalizeReuseKeyPart(options.host);

    return this.listSessions().find((session) => (
      !session.closed
      && session.managedSessionPrefix === options.managedSessionPrefix
      && normalizeReuseKeyPart(session.cwd) === cwd
      && normalizeReuseKeyPart(session.user) === user
      && normalizeReuseKeyPart(session.host) === host
      && session.stream
    ));
  }

  attachStream(sessionId: string, stream: ClientChannel) {
    const session = this.getSession(sessionId);
    session.stream = stream;
    this.touchSessionActivity(sessionId);
  }

  touchSessionActivity(sessionId: string, timestamp = Date.now()) {
    const session = this.getSession(sessionId);
    session.lastActivityAt = timestamp;
  }

  appendOutput(sessionId: string, text: string): number {
    const session = this.getSession(sessionId);
    if (session.closed) {
      throw new McpError(ErrorCode.InvalidParams, `Interactive session ${sessionId} is already closed`);
    }
    if (!text) {
      return session.sequence;
    }

    session.sequence += 1;
    session.chunks.push({ sequence: session.sequence, text });
    session.bufferedChars += text.length;
    this.touchSessionActivity(sessionId);

    while (session.bufferedChars > this.maxBufferedChars && session.chunks.length > 0) {
      const first = session.chunks[0];
      if (!first) break;

      const overflow = session.bufferedChars - this.maxBufferedChars;
      if (first.text.length <= overflow) {
        session.chunks.shift();
        session.bufferedChars -= first.text.length;
        session.droppedBeforeSequence = first.sequence;
      } else {
        first.text = first.text.slice(overflow);
        session.bufferedChars -= overflow;
        session.droppedBeforeSequence = Math.max(session.droppedBeforeSequence, first.sequence - 1);
      }
      session.truncated = true;
    }

    return session.sequence;
  }

  read(sessionId: string, sinceSequence = 0, maxChars?: number): InteractiveSessionReadResult {
    const session = this.getSession(sessionId);
    const visibleChunks = session.chunks.filter((chunk) => chunk.sequence > sinceSequence);
    let output = visibleChunks.map((chunk) => chunk.text).join('');
    let truncated = session.truncated || sinceSequence < session.droppedBeforeSequence;

    if (typeof maxChars === 'number' && maxChars > 0 && output.length > maxChars) {
      output = output.slice(output.length - maxChars);
      truncated = true;
    }

    this.touchSessionActivity(sessionId);

    return {
      sessionId,
      output,
      nextSequence: session.sequence,
      truncated,
      closed: session.closed,
      exitCode: session.exitCode,
    };
  }

  resizeSession(sessionId: string, cols: number, rows: number) {
    const session = this.getSession(sessionId);
    session.cols = cols;
    session.rows = rows;
    this.touchSessionActivity(sessionId);
  }

  closeSession(sessionId: string, exitCode?: number) {
    const session = this.getSession(sessionId);
    session.closed = true;
    session.exitCode = exitCode;
    this.touchSessionActivity(sessionId);
  }

  removeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session?.stream) {
      try { session.stream.end(); } catch {}
      try { session.stream.close(); } catch {}
    }
    this.sessions.delete(sessionId);
  }

  closeAll() {
    for (const sessionId of [...this.sessions.keys()]) {
      this.removeSession(sessionId);
    }
  }
}

export function ensureNonEmptyPath(value: string, fieldName: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} cannot be empty`);
  }
  return trimmed;
}

export function normalizeOptionalMode(mode?: string): string | undefined {
  if (!mode) return undefined;
  const trimmed = mode.trim();
  if (!trimmed) return undefined;
  if (!/^[0-7]{3,4}$/.test(trimmed)) {
    throw new McpError(ErrorCode.InvalidParams, 'mode must be a POSIX octal string such as 644 or 0644');
  }
  return trimmed;
}

export function decodeUploadContent(content: string, encoding: 'utf8' | 'base64'): Buffer {
  if (encoding === 'utf8') {
    return Buffer.from(content, 'utf8');
  }
  if (encoding === 'base64') {
    return Buffer.from(content, 'base64');
  }
  throw new McpError(ErrorCode.InvalidParams, `Unsupported content encoding: ${encoding}`);
}

export function escapeSingleQuotedShellArg(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

export function splitRemotePath(remotePath: string): { root: string; segments: string[]; separator: '/' | '\\' } {
  const isWindows = /^[a-zA-Z]:[\\/]/.test(remotePath);
  const separator: '/' | '\\' = isWindows ? '\\' : '/';
  if (isWindows) {
    const root = remotePath.slice(0, 3);
    const remainder = remotePath.slice(3);
    const segments = remainder.split(/[\\/]+/).filter(Boolean);
    return { root, segments, separator };
  }

  const isAbsolute = remotePath.startsWith('/');
  const root = isAbsolute ? '/' : '';
  const segments = remotePath.split(/[\\/]+/).filter(Boolean);
  return { root, segments, separator };
}
