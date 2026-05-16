import fs from 'fs/promises';
import { type SSHConfig } from './core.js';

export interface VaultAccount {
  host: string;
  port?: number;
  user: string;
  password?: string;
  key?: string;
  suPassword?: string;
  sudoPassword?: string;
}

export interface VaultFile {
  activeAccount: string;
  accounts: Record<string, VaultAccount>;
}

export interface ResolvedSshConfigSource {
  source: 'vault' | 'cli';
  sshConfig: SSHConfig;
  vaultPath?: string;
  accountName?: string;
}

const DEFAULT_VAULT_PATH = './vault.json';

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && /ENOENT/i.test(error.message);
}

function normalizePort(rawPort: string | null | undefined, fallback = 22): number {
  if (typeof rawPort !== 'string' || rawPort.trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(rawPort, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function validateVaultFile(vault: VaultFile): void {
  if (!vault || typeof vault !== 'object') {
    throw new Error('Vault file must be a JSON object');
  }

  if (!vault.activeAccount || typeof vault.activeAccount !== 'string') {
    throw new Error('Vault file must contain a non-empty activeAccount');
  }

  if (!vault.accounts || typeof vault.accounts !== 'object') {
    throw new Error('Vault file must contain an accounts object');
  }
}

function getVaultAccountNames(vault: VaultFile): string[] {
  return Object.keys(vault.accounts);
}

function resolveSelectedAccountName(vault: VaultFile, requestedAccountName?: string | null): string {
  const accountNames = getVaultAccountNames(vault);
  if (accountNames.length === 0) {
    throw new Error('Vault file does not contain any accounts');
  }

  if (requestedAccountName && requestedAccountName.trim() !== '') {
    return requestedAccountName;
  }

  throw new Error(
    `Vault account selection is required. Available accounts: ${accountNames.join(', ')}. Provide the account parameter. Use list-accounts to inspect available account names.`
  );
}

function validateVaultAccount(accountName: string, account: VaultAccount | undefined): asserts account is VaultAccount {
  if (!account) {
    throw new Error(`activeAccount "${accountName}" was not found in vault accounts`);
  }

  if (!account.host || !account.user) {
    throw new Error(`Vault account "${accountName}" must include host and user`);
  }

  if (!account.password && !account.key) {
    throw new Error(`Vault account "${accountName}" must include password or key`);
  }
}

async function defaultLoadVaultFile(vaultPath: string): Promise<VaultFile> {
  const content = await fs.readFile(vaultPath, 'utf8');
  return JSON.parse(content) as VaultFile;
}

async function toSshConfigFromVault(account: VaultAccount, defaultTimeout: number): Promise<SSHConfig> {
  return {
    host: account.host,
    port: account.port ?? 22,
    username: account.user,
    password: account.password,
    privateKey: account.key ? await fs.readFile(account.key, 'utf8') : undefined,
    suPassword: account.suPassword,
    sudoPassword: account.sudoPassword,
    readyTimeout: defaultTimeout,
  };
}

function toSshConfigFromCli(argvConfig: Record<string, string | null>, defaultTimeout: number): SSHConfig | null {
  if (!argvConfig.host || !argvConfig.user) {
    return null;
  }

  return {
    host: argvConfig.host,
    port: normalizePort(argvConfig.port, 22),
    username: argvConfig.user,
    password: argvConfig.password ?? undefined,
    privateKey: argvConfig.key ?? undefined,
    suPassword: argvConfig.suPassword ?? undefined,
    sudoPassword: argvConfig.sudoPassword ?? undefined,
    readyTimeout: defaultTimeout,
  };
}

export async function loadVaultFileFromSources(options: {
  argvConfig: Record<string, string | null>;
  loadVaultFile?: (vaultPath: string) => Promise<VaultFile>;
}): Promise<{ vault: VaultFile; vaultPath: string }> {
  const vaultPath = options.argvConfig.vault ?? DEFAULT_VAULT_PATH;
  const loadVaultFile = options.loadVaultFile ?? defaultLoadVaultFile;
  const vault = await loadVaultFile(vaultPath);
  validateVaultFile(vault);
  return { vault, vaultPath };
}

export async function resolveSshConfigFromSources(options: {
  argvConfig: Record<string, string | null>;
  defaultTimeout: number;
  accountName?: string;
  loadVaultFile?: (vaultPath: string) => Promise<VaultFile>;
}): Promise<ResolvedSshConfigSource> {
  const vaultPath = options.argvConfig.vault ?? DEFAULT_VAULT_PATH;

  try {
    const { vault } = await loadVaultFileFromSources(options);

    const selectedAccountName = resolveSelectedAccountName(vault, options.accountName ?? options.argvConfig.account);
    const selectedAccount = vault.accounts[selectedAccountName];
    validateVaultAccount(selectedAccountName, selectedAccount);

    return {
      source: 'vault',
      sshConfig: await toSshConfigFromVault(selectedAccount, options.defaultTimeout),
      vaultPath,
      accountName: selectedAccountName,
    };
  } catch (error) {
    const cliConfig = toSshConfigFromCli(options.argvConfig, options.defaultTimeout);
    if (cliConfig && isMissingFileError(error)) {
      return {
        source: 'cli',
        sshConfig: cliConfig,
      };
    }

    if (cliConfig && options.argvConfig.vault == null && isMissingFileError(error)) {
      return {
        source: 'cli',
        sshConfig: cliConfig,
      };
    }

    if (cliConfig && options.argvConfig.vault == null && error instanceof Error && /ENOENT/i.test(error.message)) {
      return {
        source: 'cli',
        sshConfig: cliConfig,
      };
    }

    if (cliConfig == null && isMissingFileError(error)) {
      throw new Error('Missing required --host or --user, and no usable vault account was found');
    }

    throw error;
  }
}
