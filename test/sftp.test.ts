import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { SSHConnectionManager } from '../src/ssh-connection-manager';

const makeAttrs = (kind: 'file' | 'directory' = 'file') => ({
  size: 12,
  mode: 0o644,
  mtime: 1_700_000_000,
  isFile: () => kind === 'file',
  isDirectory: () => kind === 'directory',
  isSymbolicLink: () => false,
});

function managerWithSftp(sftp: Record<string, any>): SSHConnectionManager {
  const manager = new SSHConnectionManager({ host: 'example.test', port: 22, username: 'user' } as any);
  vi.spyOn(manager, 'ensureConnected').mockResolvedValue();
  vi.spyOn(manager, 'getConnection').mockReturnValue({
    sftp: (callback: (error: undefined, value: any) => void) => callback(undefined, { ...sftp, end: vi.fn() }),
  } as any);
  return manager;
}

describe('SFTP operations', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    vi.restoreAllMocks();
  });

  it('lists remote entries with their type and metadata', async () => {
    const manager = managerWithSftp({
      readdir: (_remote: string, callback: (error: undefined, entries: any[]) => void) => callback(undefined, [
        { filename: 'app.log', attrs: makeAttrs() },
      ]),
    });

    const result = await manager.listRemoteDirectory('/srv');

    expect(result.entries).toEqual([{
      name: 'app.log', type: 'file', size: 12, modifiedAt: '2023-11-14T22:13:20.000Z',
    }]);
  });

  it('creates and removes a remote directory through SFTP', async () => {
    const mkdir = vi.fn((_remote: string, callback: (error?: Error) => void) => callback());
    const rmdir = vi.fn((_remote: string, callback: (error?: Error) => void) => callback());
    const manager = managerWithSftp({
      stat: (_remote: string, callback: (error: any, attrs?: any) => void) => callback(Object.assign(new Error('missing'), { code: 2 })),
      mkdir,
      rmdir,
    });

    expect(await manager.createRemoteDirectory('/srv/new')).toEqual({ remotePath: '/srv/new', created: true });
    expect(await manager.removeRemoteDirectory('/srv/old')).toEqual({ remotePath: '/srv/old', removed: true });
    expect(mkdir).toHaveBeenCalledOnce();
    expect(rmdir).toHaveBeenCalledOnce();
  });

  it('downloads into a temporary file and does not overwrite an existing destination by default', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'termssh-sftp-'));
    const destination = path.join(tempDir, 'download.txt');
    await fs.writeFile(destination, 'keep me');
    const manager = managerWithSftp({
      stat: (_remote: string, callback: (error: undefined, attrs: any) => void) => callback(undefined, makeAttrs()),
      fastGet: (_remote: string, local: string, callback: (error?: Error) => void) => {
        void fs.writeFile(local, 'downloaded').then(() => callback());
      },
    });

    await expect(manager.downloadRemoteFile({ remotePath: '/srv/download.txt', localPath: destination }))
      .rejects.toThrow('Local path already exists');
    expect(await fs.readFile(destination, 'utf8')).toBe('keep me');
  });

  it('rejects remote directory entry names that could escape the local destination', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'termssh-sftp-'));
    const destination = path.join(tempDir, 'download');
    const manager = managerWithSftp({
      readdir: (_remote: string, callback: (error: undefined, entries: any[]) => void) => callback(undefined, [
        { filename: '..', attrs: makeAttrs() },
      ]),
    });

    await expect(manager.downloadRemoteDirectory({ remotePath: '/srv', localPath: destination }))
      .rejects.toThrow('Invalid remote directory entry name');
    expect(await fs.readdir(tempDir)).toEqual(['download']);
  });

  it('sets remote metadata only when requested', async () => {
    const chmod = vi.fn((_remote: string, _mode: number, callback: (error?: Error) => void) => callback());
    const utimes = vi.fn((_remote: string, _atime: number, _mtime: number, callback: (error?: Error) => void) => callback());
    const manager = managerWithSftp({ chmod, utimes });

    await manager.setRemoteFileMetadata({ remotePath: '/srv/file.txt', mode: '0600', modifiedAt: '2024-01-01T00:00:00.000Z' });

    expect(chmod).toHaveBeenCalledWith('/srv/file.txt', 0o600, expect.any(Function));
    expect(utimes).toHaveBeenCalledWith('/srv/file.txt', 1_704_067_200, 1_704_067_200, expect.any(Function));
  });
});
