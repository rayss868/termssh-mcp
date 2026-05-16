import { describe, it, expect } from 'vitest';
import {
  resolveSshConfigFromSources,
  type VaultFile,
} from '../src/vault';

describe('resolveSshConfigFromSources', () => {
  it('resolves the requested account from vault data', async () => {
    const vault: VaultFile = {
      activeAccount: 'prod',
      accounts: {
        prod: {
          host: '1.2.3.4',
          port: 22,
          user: 'root',
          password: 'secret',
          suPassword: 'su-secret',
          sudoPassword: 'sudo-secret',
        },
      },
    };

    const resolved = await resolveSshConfigFromSources({
      argvConfig: { account: 'prod' },
      defaultTimeout: 60000,
      loadVaultFile: async () => vault,
    });

    expect(resolved.source).toBe('vault');
    expect(resolved.accountName).toBe('prod');
    expect(resolved.sshConfig.host).toBe('1.2.3.4');
    expect(resolved.sshConfig.port).toBe(22);
    expect(resolved.sshConfig.username).toBe('root');
    expect(resolved.sshConfig.password).toBe('secret');
    expect(resolved.sshConfig.suPassword).toBe('su-secret');
    expect(resolved.sshConfig.sudoPassword).toBe('sudo-secret');
    expect(resolved.vaultPath).toBe('./vault.json');
  });

  it('uses the explicit --vault path when provided', async () => {
    const requestedPaths: string[] = [];

    await resolveSshConfigFromSources({
      argvConfig: { vault: './configs/prod-vault.json', account: 'prod' },
      defaultTimeout: 60000,
      loadVaultFile: async (path: string) => {
        requestedPaths.push(path);
        return {
          activeAccount: 'prod',
          accounts: {
            prod: {
              host: '1.2.3.4',
              port: 2222,
              user: 'ubuntu',
              password: 'secret',
            },
          },
        } satisfies VaultFile;
      },
    });

    expect(requestedPaths).toEqual(['./configs/prod-vault.json']);
  });

  it('falls back to legacy cli config when vault file is missing', async () => {
    const resolved = await resolveSshConfigFromSources({
      argvConfig: {
        host: '9.9.9.9',
        port: '2200',
        user: 'deployer',
        password: 'legacy-secret',
      },
      defaultTimeout: 12000,
      loadVaultFile: async () => {
        throw new Error('ENOENT: no such file or directory, open ./vault.json');
      },
    });

    expect(resolved.source).toBe('cli');
    expect(resolved.sshConfig.host).toBe('9.9.9.9');
    expect(resolved.sshConfig.port).toBe(2200);
    expect(resolved.sshConfig.username).toBe('deployer');
    expect(resolved.sshConfig.password).toBe('legacy-secret');
    expect(resolved.vaultPath).toBeUndefined();
  });

  it('fails when a requested account does not exist in the vault', async () => {
    await expect(() => resolveSshConfigFromSources({
      argvConfig: { account: 'missing' },
      defaultTimeout: 60000,
      loadVaultFile: async () => ({
        activeAccount: 'prod',
        accounts: {
          prod: {
            host: '1.2.3.4',
            port: 22,
            user: 'root',
            password: 'secret',
          },
        },
      }),
    })).rejects.toThrow('activeAccount "missing" was not found in vault accounts');
  });

  it('fails when neither vault nor legacy cli credentials are available', async () => {
    await expect(() => resolveSshConfigFromSources({
      argvConfig: {},
      defaultTimeout: 60000,
      loadVaultFile: async () => {
        throw new Error('ENOENT: no such file or directory, open ./vault.json');
      },
    })).rejects.toThrow('Missing required --host or --user, and no usable vault account was found');
  });

  it('resolves a named account override instead of activeAccount', async () => {
    const vault: VaultFile = {
      activeAccount: 'prod',
      accounts: {
        prod: {
          host: '1.2.3.4',
          port: 22,
          user: 'root',
          password: 'prod-secret',
        },
        staging: {
          host: '5.6.7.8',
          port: 2222,
          user: 'ubuntu',
          password: 'staging-secret',
        },
      },
    };

    const resolved = await resolveSshConfigFromSources({
      argvConfig: { account: 'staging' },
      defaultTimeout: 60000,
      loadVaultFile: async () => vault,
    });

    expect(resolved.source).toBe('vault');
    expect(resolved.accountName).toBe('staging');
    expect(resolved.sshConfig.host).toBe('5.6.7.8');
    expect(resolved.sshConfig.port).toBe(2222);
    expect(resolved.sshConfig.username).toBe('ubuntu');
    expect(resolved.sshConfig.password).toBe('staging-secret');
  });

  it('fails with a clear message when no account is provided', async () => {
    const vault: VaultFile = {
      activeAccount: 'prod',
      accounts: {
        prod: {
          host: '1.2.3.4',
          port: 22,
          user: 'root',
          password: 'prod-secret',
        },
        staging: {
          host: '5.6.7.8',
          port: 2222,
          user: 'ubuntu',
          password: 'staging-secret',
        },
      },
    };

    await expect(() => resolveSshConfigFromSources({
      argvConfig: {},
      defaultTimeout: 60000,
      loadVaultFile: async () => vault,
    })).rejects.toThrow('Vault account selection is required. Available accounts: prod, staging. Provide the account parameter. Use list-accounts to inspect available account names.');
  });
});
