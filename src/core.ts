import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { Client, ClientChannel } from 'ssh2';

export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  suPassword?: string;
  sudoPassword?: string;
  readyTimeout?: number;
  keepaliveInterval?: number;
  keepaliveCountMax?: number;
}

export const sanitizeCommand = (command: string, maxChars: number): string => {
  if (typeof command !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'Command must be a string');
  }

  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    throw new McpError(ErrorCode.InvalidParams, 'Command cannot be empty');
  }

  if (Number.isFinite(maxChars) && trimmedCommand.length > maxChars) {
    throw new McpError(ErrorCode.InvalidParams, `Command is too long (max ${maxChars} characters)`);
  }

  return trimmedCommand;
};

export const sanitizePassword = (password: string | undefined): string | undefined => {
  if (typeof password !== 'string') return undefined;
  if (password.length === 0) return undefined;
  return password;
};

export const escapeCommandForShell = (command: string): string => command.replace(/'/g, `'"'"'`);

export const execSshCommand = async (
  sshConfig: any,
  command: string,
  defaultTimeout: number,
  stdin?: string
): Promise<{ [x: string]: unknown; content: ({ [x: string]: unknown; type: 'text'; text: string; } | { [x: string]: unknown; type: 'image'; data: string; mimeType: string; } | { [x: string]: unknown; type: 'audio'; data: string; mimeType: string; } | { [x: string]: unknown; type: 'resource'; resource: any; })[] }> => {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let timeoutId: NodeJS.Timeout;
    let isResolved = false;

    timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        const abortTimeout = setTimeout(() => {
          conn.end();
        }, 5000);

        conn.exec(`timeout 3s pkill -f '${escapeCommandForShell(command)}' 2>/dev/null || true`, (_err: Error | undefined, abortStream: ClientChannel | undefined) => {
          if (abortStream) {
            abortStream.on('close', () => {
              clearTimeout(abortTimeout);
              conn.end();
            });
          } else {
            clearTimeout(abortTimeout);
            conn.end();
          }
        });

        reject(new McpError(ErrorCode.InternalError, `Command execution timed out after ${defaultTimeout}ms`));
      }
    }, defaultTimeout);

    conn.on('ready', () => {
      conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            reject(new McpError(ErrorCode.InternalError, `SSH exec error: ${err.message}`));
          }
          conn.end();
          return;
        }

        if (stdin && stdin.length > 0) {
          try {
            stream.write(stdin);
          } catch {}
        }
        try { stream.end(); } catch {}

        let stdout = '';
        let stderr = '';
        stream.on('close', (code: number) => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            conn.end();
            if (stderr) {
              reject(new McpError(ErrorCode.InternalError, `Error (code ${code}):\n${stderr}`));
            } else {
              resolve({ content: [{ type: 'text', text: stdout }] });
            }
          }
        });
        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });

    conn.on('error', (err: Error) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        reject(new McpError(ErrorCode.InternalError, `SSH connection error: ${err.message}`));
      }
    });

    conn.connect(sshConfig);
  });
};
