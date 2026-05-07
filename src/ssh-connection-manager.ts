import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { Client, ClientChannel } from 'ssh2';
import fs from 'fs/promises';
import {
  type SSHConfig,
  sanitizePassword,
} from './core.js';
import {
  InteractiveSessionStore,
  type InteractiveSession,
  type InteractiveSessionReadResult,
  type PlatformHint,
  decodeUploadContent,
  ensureNonEmptyPath,
  normalizeOptionalMode,
  escapeSingleQuotedShellArg,
  splitRemotePath,
} from './upload.js';

const DEFAULT_TIMEOUT = 60000;
const DEFAULT_TERMINAL_BUFFER_CHARS = 200_000;
const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const DEFAULT_TERMINAL_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MANAGED_SESSION_PREFIX = 'termssh-mcp';
const REMOTE_SESSION_MARKER_DIR = '/tmp/termssh-mcp';
const REMOTE_SESSION_METADATA_SENTINEL = '__TERMSSH_MCP_META__';

export class SSHConnectionManager {
  private conn: Client | null = null;
  private sshConfig: SSHConfig;
  private isConnecting = false;
  private connectionPromise: Promise<void> | null = null;
  private suShell: ClientChannel | null = null;
  private suPromise: Promise<void> | null = null;
  private isElevated = false;
  private interactiveStore = new InteractiveSessionStore({ maxBufferedChars: DEFAULT_TERMINAL_BUFFER_CHARS });
  private sessionIdleTimeoutMs = DEFAULT_TERMINAL_IDLE_TIMEOUT_MS;
  private idleSweepTimer: NodeJS.Timeout | null = null;

  constructor(config: SSHConfig) {
    this.sshConfig = config;
  }

  static async fromCliConfig(config: {
    host?: string | null;
    port: number;
    user?: string | null;
    password?: string | null;
    key?: string | null;
    suPassword?: string | null;
    sudoPassword?: string | null;
    timeout: number;
  }): Promise<SSHConnectionManager> {
    if (!config.host || !config.user) {
      throw new McpError(ErrorCode.InvalidParams, 'Missing required host or username');
    }

    const sshConfig: SSHConfig = {
      host: config.host,
      port: config.port,
      username: config.user,
      readyTimeout: config.timeout,
    };

    if (config.password) {
      sshConfig.password = config.password;
    } else if (config.key) {
      sshConfig.privateKey = await fs.readFile(config.key, 'utf8');
    }

    if (config.suPassword !== null && config.suPassword !== undefined) {
      sshConfig.suPassword = sanitizePassword(config.suPassword);
    }
    if (config.sudoPassword !== null && config.sudoPassword !== undefined) {
      sshConfig.sudoPassword = sanitizePassword(config.sudoPassword);
    }

    return new SSHConnectionManager(sshConfig);
  }

  async connect(): Promise<void> {
    if (this.conn && this.isConnected()) return;
    if (this.isConnecting && this.connectionPromise) return this.connectionPromise;

    this.isConnecting = true;
    this.connectionPromise = new Promise((resolve, reject) => {
      this.conn = new Client();

      const timeoutId = setTimeout(() => {
        this.conn?.end();
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        reject(new McpError(ErrorCode.InternalError, `SSH connection timeout after ${DEFAULT_TIMEOUT}ms`));
      }, DEFAULT_TIMEOUT);

      this.conn.on('ready', async () => {
        clearTimeout(timeoutId);
        this.isConnecting = false;
        this.startIdleSweep();

        if (this.sshConfig.suPassword && !process.env.TERMSSH_MCP_TEST) {
          try {
            await this.ensureElevated();
          } catch {
          }
        }

        resolve();
      });

      this.conn.on('error', (err: Error) => {
        clearTimeout(timeoutId);
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        reject(new McpError(ErrorCode.InternalError, `SSH connection error: ${err.message}`));
      });

      this.conn.on('end', () => {
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
      });

      this.conn.on('close', () => {
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
      });

      (this.conn as any).on('debug', (msg: string) => {
        console.error(`[SSH Debug] ${msg}`);
      });

      this.conn.connect({
        ...this.sshConfig,
        readyTimeout: this.sshConfig.readyTimeout || DEFAULT_TIMEOUT,
        keepaliveInterval: this.sshConfig.keepaliveInterval || 10000,
        keepaliveCountMax: this.sshConfig.keepaliveCountMax || 3,
      });
    });

    return this.connectionPromise;
  }

  async ensureConnected(): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }
  }

  isConnected(): boolean {
    return this.conn !== null && (this.conn as any)._sock && !(this.conn as any)._sock.destroyed;
  }

  getConnection(): Client {
    if (!this.conn || !this.isConnected()) {
      throw new McpError(ErrorCode.InternalError, 'SSH connection not established');
    }
    return this.conn;
  }

  getSudoPassword(): string | undefined {
    return this.sshConfig.sudoPassword;
  }

  getSuPassword(): string | undefined {
    return this.sshConfig.suPassword;
  }

  async setSuPassword(pwd?: string): Promise<void> {
    this.sshConfig.suPassword = pwd;
    if (pwd) {
      try {
        await this.ensureElevated();
      } catch (err) {
        console.error('setSuPassword: failed to elevate to su shell:', err);
      }
      return;
    }

    if (this.suShell) {
      try { this.suShell.end(); } catch {}
      this.suShell = null;
      this.isElevated = false;
    }
  }

  setSudoPassword(pwd?: string) {
    this.sshConfig.sudoPassword = pwd;
  }

  private startIdleSweep() {
    if (this.idleSweepTimer) return;
    this.idleSweepTimer = setInterval(() => {
      const now = Date.now();
      for (const session of this.interactiveStore.listSessions()) {
        if (!session.closed && now - session.lastActivityAt > this.sessionIdleTimeoutMs) {
          this.interactiveStore.closeSession(session.id);
          if (session.stream) {
            try { session.stream.end(); } catch {}
            try { session.stream.close(); } catch {}
          }
        }
      }
    }, 30_000);
    this.idleSweepTimer.unref?.();
  }

  private stopIdleSweep() {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = null;
    }
  }

  async ensureElevated(): Promise<void> {
    if (this.isElevated && this.suShell) return;
    if (!this.sshConfig.suPassword) return;
    if (this.suPromise) return this.suPromise;

    this.suPromise = new Promise((resolve, reject) => {
      const conn = this.getConnection();
      const timeoutId = setTimeout(() => {
        this.suPromise = null;
        reject(new McpError(ErrorCode.InternalError, `su elevation timed out after ${DEFAULT_TIMEOUT}ms`));
      }, DEFAULT_TIMEOUT);

      conn.shell({ term: 'xterm', cols: 80, rows: 24 }, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          clearTimeout(timeoutId);
          this.suPromise = null;
          reject(new McpError(ErrorCode.InternalError, `Failed to open su shell: ${err.message}`));
          return;
        }

        let buffer = '';
        let passwordSent = false;

        const cleanup = () => {
          try { stream.removeAllListeners('data'); } catch {}
        };

        const onData = (data: Buffer) => {
          buffer += data.toString();

          if (!passwordSent && /password/i.test(buffer)) {
            passwordSent = true;
            stream.write(this.sshConfig.suPassword + '\n');
          }

          if (/\n.*#\s*$/.test(buffer) || /root@.*[#>]\s*$/.test(buffer)) {
            clearTimeout(timeoutId);
            cleanup();
            this.suShell = stream;
            this.isElevated = true;
            this.suPromise = null;
            resolve();
          }
        };

        stream.on('data', onData);
        stream.on('close', () => {
          clearTimeout(timeoutId);
          this.isElevated = false;
          this.suShell = null;
          this.suPromise = null;
        });

        stream.write('su -\n');
      });
    });

    return this.suPromise;
  }

  private async withSftp<T>(handler: (sftp: any) => Promise<T>): Promise<T> {
    await this.ensureConnected();
    return new Promise<T>((resolve, reject) => {
      this.getConnection().sftp(async (err: Error | undefined, sftp: any) => {
        if (err) {
          reject(new McpError(ErrorCode.InternalError, `Failed to open SFTP session: ${err.message}`));
          return;
        }

        try {
          resolve(await handler(sftp));
        } catch (error) {
          reject(error);
        } finally {
          try { sftp.end?.(); } catch {}
        }
      });
    });
  }

  private async sftpStat(sftp: any, remotePath: string): Promise<any | null> {
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err: any, stats: any) => {
        if (!err) {
          resolve(stats);
          return;
        }
        const code = err?.code;
        if (code === 2 || code === 4 || /no such file/i.test(String(err?.message || ''))) {
          resolve(null);
          return;
        }
        reject(new McpError(ErrorCode.InternalError, `Failed to stat remote path ${remotePath}: ${err?.message || err}`));
      });
    });
  }

  private async sftpMkdir(sftp: any, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err: any) => {
        if (!err) {
          resolve();
          return;
        }
        if (err?.code === 4 || /failure/i.test(String(err?.message || ''))) {
          resolve();
          return;
        }
        reject(new McpError(ErrorCode.InternalError, `Failed to create remote directory ${remotePath}: ${err?.message || err}`));
      });
    });
  }

  private async ensureRemoteDirectoryExists(sftp: any, remoteDir: string): Promise<void> {
    const normalized = remoteDir.trim();
    if (!normalized || normalized === '.' || normalized === '/' || /^[a-zA-Z]:[\\/]?$/.test(normalized)) {
      return;
    }

    const { root, segments, separator } = splitRemotePath(normalized);
    let current = root;

    for (const segment of segments) {
      if (!current || current === '/') {
        current = current === '/' ? `${current}${segment}` : `${segment}`;
      } else if (current.endsWith('\\') || current.endsWith('/')) {
        current = `${current}${segment}`;
      } else {
        current = `${current}${separator}${segment}`;
      }

      const stat = await this.sftpStat(sftp, current);
      if (!stat) {
        await this.sftpMkdir(sftp, current);
      }
    }
  }

  private async writeRemoteBuffer(sftp: any, remotePath: string, content: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      sftp.open(remotePath, 'w', (openErr: any, handle: any) => {
        if (openErr) {
          reject(new McpError(ErrorCode.InternalError, `Failed to open remote file ${remotePath}: ${openErr?.message || openErr}`));
          return;
        }

        sftp.write(handle, content, 0, content.length, 0, (writeErr: any) => {
          if (writeErr) {
            sftp.close(handle, () => {
              reject(new McpError(ErrorCode.InternalError, `Failed to write remote file ${remotePath}: ${writeErr?.message || writeErr}`));
            });
            return;
          }

          sftp.close(handle, (closeErr: any) => {
            if (closeErr) {
              reject(new McpError(ErrorCode.InternalError, `Failed to close remote file ${remotePath}: ${closeErr?.message || closeErr}`));
              return;
            }
            resolve();
          });
        });
      });
    });
  }

  private async chmodRemote(sftp: any, remotePath: string, mode?: string): Promise<void> {
    if (!mode) return;
    const numericMode = parseInt(mode, 8);
    if (Number.isNaN(numericMode)) return;

    await new Promise<void>((resolve, reject) => {
      sftp.chmod(remotePath, numericMode, (err: any) => {
        if (err) {
          reject(new McpError(ErrorCode.InternalError, `Failed to chmod remote file ${remotePath}: ${err?.message || err}`));
          return;
        }
        resolve();
      });
    });
  }

  private toIsoString(timestamp: number): string {
    return new Date(timestamp).toISOString();
  }

  private getManagedSessionMetadataPath(sessionId: string): string {
    return `${REMOTE_SESSION_MARKER_DIR}/${sessionId}.json`;
  }

  private buildManagedSessionMetadata(session: InteractiveSession): string {
    return JSON.stringify({
      session_id: session.id,
      pid: session.remotePid ?? null,
      created_at: this.toIsoString(session.createdAt),
      last_activity_at: this.toIsoString(session.lastActivityAt),
      cwd: session.cwd ?? null,
      user: session.user ?? null,
      host: session.host ?? null,
    }, null, 2);
  }

  private async writeManagedSessionMetadata(session: InteractiveSession): Promise<void> {
    const metadataPath = session.remoteMetadataPath;
    if (!metadataPath) {
      return;
    }

    await this.withSftp(async (sftp) => {
      await this.ensureRemoteDirectoryExists(sftp, REMOTE_SESSION_MARKER_DIR);
      await this.writeRemoteBuffer(
        sftp,
        metadataPath,
        Buffer.from(this.buildManagedSessionMetadata(session), 'utf8')
      );
    });
  }

  private async refreshManagedSessionHeartbeat(sessionId: string): Promise<void> {
    const session = this.interactiveStore.getSession(sessionId);
    if (session.closed || !session.remoteMetadataPath) {
      return;
    }

    await this.writeManagedSessionMetadata(session);
  }

  async uploadLocalFile(options: {
    localPath: string;
    remotePath: string;
    overwrite?: boolean;
    createDirectories?: boolean;
    mode?: string;
  }): Promise<{ remotePath: string; bytesWritten: number; overwritten: boolean; modeApplied?: string }> {
    const localPath = ensureNonEmptyPath(options.localPath, 'localPath');
    const remotePath = ensureNonEmptyPath(options.remotePath, 'remotePath');
    const mode = normalizeOptionalMode(options.mode);

    const localStat = await fs.stat(localPath).catch((err) => {
      throw new McpError(ErrorCode.InvalidParams, `localPath is not readable: ${err?.message || err}`);
    });

    if (!localStat.isFile()) {
      throw new McpError(ErrorCode.InvalidParams, 'localPath must point to a file');
    }

    return this.withSftp(async (sftp) => {
      const existing = await this.sftpStat(sftp, remotePath);
      if (existing && !options.overwrite) {
        throw new McpError(ErrorCode.InvalidParams, `Remote path already exists: ${remotePath}`);
      }

      if (options.createDirectories) {
        const remoteDir = remotePath.replace(/[\\/][^\\/]+$/, '');
        if (remoteDir && remoteDir !== remotePath) {
          await this.ensureRemoteDirectoryExists(sftp, remoteDir);
        }
      }

      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (err: any) => {
          if (err) {
            reject(new McpError(ErrorCode.InternalError, `Failed to upload file to ${remotePath}: ${err?.message || err}`));
            return;
          }
          resolve();
        });
      });

      await this.chmodRemote(sftp, remotePath, mode);

      return {
        remotePath,
        bytesWritten: localStat.size,
        overwritten: Boolean(existing),
        modeApplied: mode,
      };
    });
  }

  async uploadContent(options: {
    content: string;
    encoding: 'utf8' | 'base64';
    remotePath: string;
    overwrite?: boolean;
    createDirectories?: boolean;
    mode?: string;
  }): Promise<{ remotePath: string; bytesWritten: number; overwritten: boolean; modeApplied?: string }> {
    const remotePath = ensureNonEmptyPath(options.remotePath, 'remotePath');
    const mode = normalizeOptionalMode(options.mode);
    const contentBuffer = decodeUploadContent(options.content, options.encoding);

    return this.withSftp(async (sftp) => {
      const existing = await this.sftpStat(sftp, remotePath);
      if (existing && !options.overwrite) {
        throw new McpError(ErrorCode.InvalidParams, `Remote path already exists: ${remotePath}`);
      }

      if (options.createDirectories) {
        const remoteDir = remotePath.replace(/[\\/][^\\/]+$/, '');
        if (remoteDir && remoteDir !== remotePath) {
          await this.ensureRemoteDirectoryExists(sftp, remoteDir);
        }
      }

      await this.writeRemoteBuffer(sftp, remotePath, contentBuffer);
      await this.chmodRemote(sftp, remotePath, mode);

      return {
        remotePath,
        bytesWritten: contentBuffer.length,
        overwritten: Boolean(existing),
        modeApplied: mode,
      };
    });
  }

  async startInteractiveSession(options?: {
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
    shell?: string;
    platformHint?: PlatformHint;
    elevated?: boolean;
    multiSession?: boolean;
  }): Promise<{ sessionId: string; initialOutput: string; nextSequence: number; reused?: boolean }> {
    await this.ensureConnected();

    const cols = options?.cols ?? DEFAULT_TERMINAL_COLS;
    const rows = options?.rows ?? DEFAULT_TERMINAL_ROWS;
    const platformHint = options?.platformHint ?? 'auto';
    const reusableSession = this.interactiveStore.findReusableSession({
      managedSessionPrefix: MANAGED_SESSION_PREFIX,
      cwd: options?.cwd,
      user: this.sshConfig.username,
      host: this.sshConfig.host,
      allowMultiple: options?.multiSession,
    });

    if (reusableSession) {
      const initial = this.interactiveStore.read(reusableSession.id);
      await this.refreshManagedSessionHeartbeat(reusableSession.id).catch(() => {});
      return {
        sessionId: reusableSession.id,
        initialOutput: initial.output,
        nextSequence: initial.nextSequence,
        reused: true,
      };
    }

    return new Promise((resolve, reject) => {
      this.getConnection().shell({ term: 'xterm', cols, rows }, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          reject(new McpError(ErrorCode.InternalError, `Failed to start interactive shell: ${err.message}`));
          return;
        }

        const session = this.interactiveStore.createSession({
          cols,
          rows,
          platformHint,
          shell: options?.shell,
          stream,
          managedSessionPrefix: MANAGED_SESSION_PREFIX,
          cwd: options?.cwd,
          user: this.sshConfig.username,
          host: this.sshConfig.host,
        });
        session.remoteMetadataPath = this.getManagedSessionMetadataPath(session.id);
        const metadataPath = session.remoteMetadataPath;
        this.interactiveStore.attachStream(session.id, stream);

        let bufferedLine = '';
        let metadataResolved = false;

        const handleOutput = (chunk: string) => {
          bufferedLine += chunk;
          while (bufferedLine.includes('\n')) {
            const newlineIndex = bufferedLine.indexOf('\n');
            const line = bufferedLine.slice(0, newlineIndex + 1);
            bufferedLine = bufferedLine.slice(newlineIndex + 1);

            if (line.startsWith(REMOTE_SESSION_METADATA_SENTINEL)) {
              const payload = line.slice(REMOTE_SESSION_METADATA_SENTINEL.length).trim();
              const [pid, cwd, user, host] = payload.split('\u001f');
              session.remotePid = pid;
              session.cwd = cwd || session.cwd;
              session.user = user || session.user;
              session.host = host || session.host;
              metadataResolved = true;
              void this.writeManagedSessionMetadata(session).catch(() => {});
              continue;
            }

            this.interactiveStore.appendOutput(session.id, line);
          }
        };

        stream.on('data', (data: Buffer) => {
          handleOutput(data.toString());
        });

        stream.stderr?.on?.('data', (data: Buffer) => {
          handleOutput(data.toString());
        });

        stream.on('close', (code?: number) => {
          if (bufferedLine) {
            if (!bufferedLine.startsWith(REMOTE_SESSION_METADATA_SENTINEL)) {
              try {
                this.interactiveStore.appendOutput(session.id, bufferedLine);
              } catch {}
            }
            bufferedLine = '';
          }
          try {
            this.interactiveStore.closeSession(session.id, typeof code === 'number' ? code : undefined);
          } catch {}
        });

        const bootstrapCommands: string[] = [];
        if (options?.shell) {
          bootstrapCommands.push(options.shell);
        }
        if (options?.cwd) {
          if (platformHint === 'windows') {
            bootstrapCommands.push(`cd /d "${options.cwd.replace(/"/g, '""')}"`);
          } else {
            bootstrapCommands.push(`cd '${escapeSingleQuotedShellArg(options.cwd)}'`);
          }
        }
        if (options?.env) {
          for (const [key, value] of Object.entries(options.env)) {
            if (platformHint === 'windows') {
              bootstrapCommands.push(`set ${key}=${value}`);
            } else {
              bootstrapCommands.push(`export ${key}='${escapeSingleQuotedShellArg(value)}'`);
            }
          }
        }
        if (options?.elevated && this.sshConfig.suPassword && platformHint !== 'windows') {
          bootstrapCommands.push('su -');
          bootstrapCommands.push(this.sshConfig.suPassword);
        }
        if (platformHint !== 'windows') {
          bootstrapCommands.push(`MCP_SESSION_PID=$$`);
          bootstrapCommands.push(`MCP_MARKER_DIR='${REMOTE_SESSION_MARKER_DIR}'`);
          bootstrapCommands.push(`MCP_MARKER_FILE='${escapeSingleQuotedShellArg(metadataPath)}'`);
          bootstrapCommands.push(`mkdir -p "$MCP_MARKER_DIR" >/dev/null 2>&1 || true`);
          bootstrapCommands.push(`touch "$MCP_MARKER_FILE" >/dev/null 2>&1 || true`);
          bootstrapCommands.push(`trap 'rm -f "$MCP_MARKER_FILE" >/dev/null 2>&1 || true' EXIT`);
          bootstrapCommands.push(`(while [ -f "$MCP_MARKER_FILE" ]; do last=$(stat -c %Y "$MCP_MARKER_FILE" 2>/dev/null || printf 0); now=$(date +%s); if [ $((now - last)) -ge 600 ]; then kill -TERM "$MCP_SESSION_PID" >/dev/null 2>&1 || true; rm -f "$MCP_MARKER_FILE" >/dev/null 2>&1 || true; exit 0; fi; sleep 30; done) >/dev/null 2>&1 &`);
          bootstrapCommands.push(`printf '${REMOTE_SESSION_METADATA_SENTINEL}%s\x1f%s\x1f%s\x1f%s\n' "$$" "$(pwd)" "$(id -un 2>/dev/null || whoami 2>/dev/null || printf unknown)" "$(hostname 2>/dev/null || uname -n 2>/dev/null || printf unknown)"`);
        }

        for (const command of bootstrapCommands) {
          stream.write(command + '\n');
        }

        setTimeout(async () => {
          try {
            if (!metadataResolved && platformHint !== 'windows') {
              await this.writeManagedSessionMetadata(session).catch(() => {});
            }
            const initial = this.interactiveStore.read(session.id);
            resolve({
              sessionId: session.id,
              initialOutput: initial.output,
              nextSequence: initial.nextSequence,
              reused: false,
            });
          } catch (readError) {
            reject(readError);
          }
        }, 200);
      });
    });
  }

  async writeInteractiveSession(sessionId: string, input: string, appendNewline = false): Promise<{ sessionId: string; bytesWritten: number; closed: boolean }> {
    const session = this.interactiveStore.getSession(sessionId);
    if (session.closed) {
      throw new McpError(ErrorCode.InvalidParams, `Interactive session ${sessionId} is already closed`);
    }
    if (!session.stream) {
      throw new McpError(ErrorCode.InternalError, `Interactive session ${sessionId} has no active stream`);
    }

    const payload = appendNewline ? `${input}\n` : input;
    session.stream.write(payload);
    this.interactiveStore.touchSessionActivity(sessionId);
    await this.refreshManagedSessionHeartbeat(sessionId).catch(() => {});

    return {
      sessionId,
      bytesWritten: Buffer.byteLength(payload, 'utf8'),
      closed: false,
    };
  }

  async readInteractiveSession(sessionId: string, options?: { sinceSequence?: number; maxChars?: number }): Promise<InteractiveSessionReadResult> {
    const result = this.interactiveStore.read(sessionId, options?.sinceSequence ?? 0, options?.maxChars);
    await this.refreshManagedSessionHeartbeat(sessionId).catch(() => {});
    return result;
  }

  resizeInteractiveSession(sessionId: string, cols: number, rows: number): { sessionId: string; cols: number; rows: number } {
    const session = this.interactiveStore.getSession(sessionId);
    if (session.closed) {
      throw new McpError(ErrorCode.InvalidParams, `Interactive session ${sessionId} is already closed`);
    }
    if (!session.stream) {
      throw new McpError(ErrorCode.InternalError, `Interactive session ${sessionId} has no active stream`);
    }

    (session.stream as any).setWindow?.(rows, cols, 0, 0);
    this.interactiveStore.resizeSession(sessionId, cols, rows);
    return { sessionId, cols, rows };
  }

  closeInteractiveSession(sessionId: string): { sessionId: string; closed: true; exitCode?: number } {
    const session = this.interactiveStore.getSession(sessionId);
    if (!session.closed) {
      this.interactiveStore.closeSession(sessionId, session.exitCode);
    }
    if (session.stream) {
      try { session.stream.end(); } catch {}
      try { session.stream.close(); } catch {}
    }
    session.stream = null;
    const read = this.interactiveStore.read(sessionId);
    return { sessionId, closed: true, exitCode: read.exitCode };
  }

  async execCommand(
    command: string,
    stdin?: string
  ): Promise<{ [x: string]: unknown; content: ({ [x: string]: unknown; type: 'text'; text: string; } | { [x: string]: unknown; type: 'image'; data: string; mimeType: string; } | { [x: string]: unknown; type: 'audio'; data: string; mimeType: string; } | { [x: string]: unknown; type: 'resource'; resource: any; })[] }> {
    return new Promise((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;
      let isResolved = false;

      const conn = this.getConnection();
      const shell = this.suShell;

      timeoutId = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          reject(new McpError(ErrorCode.InternalError, `Command execution timed out after ${DEFAULT_TIMEOUT}ms`));
        }
      }, DEFAULT_TIMEOUT);

      if (shell) {
        let buffer = '';
        const dataHandler = (data: Buffer) => {
          buffer += data.toString();
          if (/#/.test(buffer)) {
            if (!isResolved) {
              isResolved = true;
              clearTimeout(timeoutId);
              const lines = buffer.split('\n');
              const output = lines.slice(1, -1).join('\n');
              resolve({ content: [{ type: 'text', text: output + (output ? '\n' : '') }] });
            }
            shell.removeListener('data', dataHandler);
          }
        };

        shell.on('data', dataHandler);
        shell.write(command + '\n');
        return;
      }

      conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            reject(new McpError(ErrorCode.InternalError, `SSH exec error: ${err.message}`));
          }
          return;
        }

        let stdout = '';
        let stderr = '';

        if (stdin && stdin.length > 0) {
          try {
            stream.write(stdin);
          } catch (e) {
            console.error('Error writing to stdin:', e);
          }
        }
        try { stream.end(); } catch {}

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            if (stderr) {
              reject(new McpError(ErrorCode.InternalError, `Error (code ${code}):\n${stderr}`));
            } else {
              resolve({ content: [{ type: 'text', text: stdout }] });
            }
          }
        });
      });
    });
  }

  async execSudoCommand(
    commandWithDescription: string
  ): Promise<{ [x: string]: unknown; content: ({ [x: string]: unknown; type: 'text'; text: string; } | { [x: string]: unknown; type: 'image'; data: string; mimeType: string; } | { [x: string]: unknown; type: 'audio'; data: string; mimeType: string; } | { [x: string]: unknown; type: 'resource'; resource: any; })[] }> {
    const sudoPassword = this.getSudoPassword();
    const wrapped = !sudoPassword
      ? `sudo -n sh -c '${commandWithDescription.replace(/'/g, `'\\''`)}'`
      : `printf '%s\\n' '${sudoPassword.replace(/'/g, `'\\''`)}' | sudo -p "" -S sh -c '${commandWithDescription.replace(/'/g, `'\\''`)}'`;

    return this.execCommand(wrapped);
  }

  close(): void {
    this.stopIdleSweep();
    this.interactiveStore.closeAll();
    if (this.conn) {
      if (this.suShell) {
        try { this.suShell.end(); } catch {}
        this.suShell = null;
        this.isElevated = false;
      }
      this.conn.end();
      this.conn = null;
    }
  }
}
