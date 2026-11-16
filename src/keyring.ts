import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';

const SERVICE_NAME = 'gemini';
const ACCOUNT_NAME = 'antigravity';
const TARGET_NAME = `${SERVICE_NAME}:${ACCOUNT_NAME}`;
const WIN_TARGET_NAME = `LegacyGeneric:target=${TARGET_NAME}`;

interface WinCredAddon {
  readCredential(targetName: string): string | null;
  writeCredential(targetName: string, userName: string, secretUtf8: string): boolean;
  deleteCredential(targetName: string): boolean;
}

function escapeDarwinQuotable(val: string): string {
  return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function hasLinuxDbusSession(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return Boolean(env.DBUS_SESSION_BUS_ADDRESS);
}

function resolveWinAddonPath(extensionPath?: string): string | null {
  const filename = `wincred-win32-${process.arch}.node`;
  const candidates = [
    extensionPath ? path.join(extensionPath, 'native', filename) : '',
    typeof __dirname === 'string' && __dirname
      ? path.resolve(__dirname, '..', 'native', filename)
      : '',
    typeof __dirname === 'string' && __dirname ? path.join(__dirname, 'native', filename) : '',
    path.resolve(process.cwd(), 'native', filename)
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export class KeyringManager {
  private readonly extensionPath?: string;
  private winAddon: WinCredAddon | false | null = null;

  constructor(extensionPath?: string) {
    this.extensionPath = extensionPath;
  }

  private getWinAddon(): WinCredAddon | null {
    if (this.winAddon === false) return null;
    if (this.winAddon) return this.winAddon;

    const addonPath = resolveWinAddonPath(this.extensionPath);
    if (!addonPath) {
      this.winAddon = false;
      return null;
    }

    try {
      const req = createRequire(addonPath);
      const loaded = req(addonPath) as Partial<WinCredAddon>;
      if (
        loaded &&
        typeof loaded.readCredential === 'function' &&
        typeof loaded.writeCredential === 'function' &&
        typeof loaded.deleteCredential === 'function'
      ) {
        this.winAddon = loaded as WinCredAddon;
        return this.winAddon;
      }
    } catch {}

    this.winAddon = false;
    return null;
  }

  private readWin(targetPrimary: string, targetSecondary: string): string | null {
    const addon = this.getWinAddon();
    if (!addon) return null;
    try {
      const primary = addon.readCredential(targetPrimary);
      if (primary && primary.trim()) return primary.trim();
      const secondary = addon.readCredential(targetSecondary);
      return secondary && secondary.trim() ? secondary.trim() : null;
    } catch {
      return null;
    }
  }

  private writeWin(target: string, user: string, secret: string): boolean {
    const addon = this.getWinAddon();
    if (!addon) return false;
    try {
      return Boolean(addon.writeCredential(target, user, secret));
    } catch {
      return false;
    }
  }

  private deleteWin(targetPrimary: string, targetSecondary: string): boolean | null {
    const addon = this.getWinAddon();
    if (!addon) return null;
    try {
      const a = addon.deleteCredential(targetPrimary);
      const b = addon.deleteCredential(targetSecondary);
      return Boolean(a || b);
    } catch {
      return false;
    }
  }

  public dispose(): void {
    // No persistent background child processes to tear down.
  }

  public read(): string | null {
    const platform = os.platform();

    if (platform === 'win32') {
      return this.readWin(WIN_TARGET_NAME, TARGET_NAME);
    }

    if (platform === 'darwin') {
      try {
        const out = execFileSync(
          '/usr/bin/security',
          ['find-generic-password', '-s', SERVICE_NAME, '-a', ACCOUNT_NAME, '-w'],
          { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        return out && out.trim() ? out.trim() : null;
      } catch {
        return null;
      }
    }

    if (platform === 'linux') {
      if (!hasLinuxDbusSession()) return null;
      try {
        // zalando/go-keyring on Linux indexes by 'username', while standard schemas use 'account'
        let out = '';
        try {
          out = execFileSync(
            'secret-tool',
            ['lookup', 'service', SERVICE_NAME, 'username', ACCOUNT_NAME],
            { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }
          );
        } catch {}

        if (!out || !out.trim()) {
          try {
            out = execFileSync(
              'secret-tool',
              ['lookup', 'service', SERVICE_NAME, 'account', ACCOUNT_NAME],
              { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }
            );
          } catch {}
        }

        return out && out.trim() ? out.trim() : null;
      } catch {
        return null;
      }
    }

    return null;
  }

  public async readAsync(): Promise<string | null> {
    const platform = os.platform();

    if (platform === 'win32') {
      return this.readWin(WIN_TARGET_NAME, TARGET_NAME);
    }

    if (platform === 'darwin') {
      return new Promise<string | null>((resolve) => {
        try {
          execFile(
            '/usr/bin/security',
            ['find-generic-password', '-s', SERVICE_NAME, '-a', ACCOUNT_NAME, '-w'],
            { encoding: 'utf8', timeout: 3000 },
            (error, stdout) => {
              if (error) {
                resolve(null);
              } else {
                const trimmed = (stdout || '').trim();
                resolve(trimmed ? trimmed : null);
              }
            }
          );
        } catch {
          resolve(null);
        }
      });
    }

    if (platform === 'linux') {
      if (!hasLinuxDbusSession()) return null;
      return new Promise<string | null>((resolve) => {
        try {
          execFile(
            'secret-tool',
            ['lookup', 'service', SERVICE_NAME, 'username', ACCOUNT_NAME],
            { encoding: 'utf8', timeout: 1500 },
            (_err1, stdout1) => {
              const trimmed1 = (stdout1 || '').trim();
              if (trimmed1) {
                resolve(trimmed1);
                return;
              }
              execFile(
                'secret-tool',
                ['lookup', 'service', SERVICE_NAME, 'account', ACCOUNT_NAME],
                { encoding: 'utf8', timeout: 1500 },
                (_err2, stdout2) => {
                  const trimmed2 = (stdout2 || '').trim();
                  resolve(trimmed2 ? trimmed2 : null);
                }
              );
            }
          );
        } catch {
          resolve(null);
        }
      });
    }

    return null;
  }

  public write(secret: string): boolean {
    const platform = os.platform();

    if (platform === 'win32') {
      return this.writeWin(WIN_TARGET_NAME, ACCOUNT_NAME, secret);
    }

    if (platform === 'darwin') {
      if (!/[\r\n]/.test(secret)) {
        try {
          const stdinCmd = `add-generic-password -U -s ${escapeDarwinQuotable(SERVICE_NAME)} -a ${escapeDarwinQuotable(ACCOUNT_NAME)} -w ${escapeDarwinQuotable(secret)}\n`;
          execFileSync('/usr/bin/security', ['-i'], {
            input: stdinCmd,
            timeout: 3000,
            stdio: ['pipe', 'ignore', 'ignore']
          });
          return true;
        } catch {}
      }
      try {
        execFileSync(
          '/usr/bin/security',
          ['add-generic-password', '-U', '-s', SERVICE_NAME, '-a', ACCOUNT_NAME, '-w', secret],
          { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] }
        );
        return true;
      } catch {
        return false;
      }
    }

    if (platform === 'linux') {
      if (!hasLinuxDbusSession()) return false;
      try {
        // Store with both username and account attributes for universal Secret Service compatibility
        execFileSync(
          'secret-tool',
          ['store', '--label=Antigravity', 'service', SERVICE_NAME, 'username', ACCOUNT_NAME, 'account', ACCOUNT_NAME],
          { input: secret, timeout: 1500, stdio: ['pipe', 'ignore', 'ignore'] }
        );
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  public async writeAsync(secret: string): Promise<boolean> {
    const platform = os.platform();

    if (platform === 'win32') {
      return this.writeWin(WIN_TARGET_NAME, ACCOUNT_NAME, secret);
    }

    if (platform === 'darwin') {
      return new Promise<boolean>((resolve) => {
        if (/[\r\n]/.test(secret)) {
          execFile(
            '/usr/bin/security',
            ['add-generic-password', '-U', '-s', SERVICE_NAME, '-a', ACCOUNT_NAME, '-w', secret],
            { timeout: 3000 },
            (err2) => resolve(!err2)
          );
          return;
        }
        try {
          const stdinCmd = `add-generic-password -U -s ${escapeDarwinQuotable(SERVICE_NAME)} -a ${escapeDarwinQuotable(ACCOUNT_NAME)} -w ${escapeDarwinQuotable(secret)}\n`;
          const child = execFile(
            '/usr/bin/security',
            ['-i'],
            { timeout: 3000 },
            (error) => {
              if (!error) {
                resolve(true);
                return;
              }
              execFile(
                '/usr/bin/security',
                ['add-generic-password', '-U', '-s', SERVICE_NAME, '-a', ACCOUNT_NAME, '-w', secret],
                { timeout: 3000 },
                (err2) => resolve(!err2)
              );
            }
          );
          if (child.stdin) {
            child.stdin.write(stdinCmd);
            child.stdin.end();
          }
        } catch {
          resolve(false);
        }
      });
    }

    if (platform === 'linux') {
      if (!hasLinuxDbusSession()) return false;
      return new Promise<boolean>((resolve) => {
        try {
          const child = execFile(
            'secret-tool',
            ['store', '--label=Antigravity', 'service', SERVICE_NAME, 'username', ACCOUNT_NAME, 'account', ACCOUNT_NAME],
            { timeout: 1500 },
            (error) => resolve(!error)
          );
          if (child.stdin) {
            child.stdin.write(secret);
            child.stdin.end();
          }
        } catch {
          resolve(false);
        }
      });
    }

    return false;
  }

  public async deleteAsync(): Promise<boolean> {
    const platform = os.platform();

    if (platform === 'win32') {
      const nativeRes = this.deleteWin(WIN_TARGET_NAME, TARGET_NAME);
      if (nativeRes !== null) {
        return nativeRes;
      }
      return new Promise<boolean>((resolve) => {
        execFile('cmdkey.exe', [`/delete:${WIN_TARGET_NAME}`], { windowsHide: true, timeout: 3000 }, (err1) => {
          execFile('cmdkey.exe', [`/delete:${TARGET_NAME}`], { windowsHide: true, timeout: 3000 }, (err2) => {
            resolve(!err1 || !err2);
          });
        });
      });
    }

    if (platform === 'darwin') {
      return new Promise<boolean>((resolve) => {
        execFile('/usr/bin/security', ['delete-generic-password', '-s', SERVICE_NAME, '-a', ACCOUNT_NAME], { timeout: 3000 }, (error) => resolve(!error));
      });
    }

    if (platform === 'linux') {
      if (!hasLinuxDbusSession()) return false;
      return new Promise<boolean>((resolve) => {
        execFile(
          'secret-tool',
          ['clear', 'service', SERVICE_NAME, 'username', ACCOUNT_NAME],
          { timeout: 1500 },
          (err1) => {
            execFile(
              'secret-tool',
              ['clear', 'service', SERVICE_NAME, 'account', ACCOUNT_NAME],
              { timeout: 1500 },
              (err2) => resolve(!err1 || !err2)
            );
          }
        );
      });
    }

    return false;
  }

  public delete(): boolean {
    const platform = os.platform();

    if (platform === 'win32') {
      const nativeRes = this.deleteWin(WIN_TARGET_NAME, TARGET_NAME);
      if (nativeRes !== null) {
        return nativeRes;
      }
      let deletedAny = false;
      for (const target of [WIN_TARGET_NAME, TARGET_NAME]) {
        try {
          // Fast Microsoft signed system command fallback
          execFileSync('cmdkey.exe', [`/delete:${target}`], {
            windowsHide: true,
            timeout: 3000,
            stdio: ['ignore', 'ignore', 'ignore']
          });
          deletedAny = true;
        } catch {}
      }
      return deletedAny;
    }

    if (platform === 'darwin') {
      try {
        execFileSync(
          '/usr/bin/security',
          ['delete-generic-password', '-s', SERVICE_NAME, '-a', ACCOUNT_NAME],
          { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] }
        );
        return true;
      } catch {
        return false;
      }
    }

    if (platform === 'linux') {
      if (!hasLinuxDbusSession()) return false;
      let cleared = false;
      try {
        execFileSync(
          'secret-tool',
          ['clear', 'service', SERVICE_NAME, 'username', ACCOUNT_NAME],
          { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] }
        );
        cleared = true;
      } catch {}
      try {
        execFileSync(
          'secret-tool',
          ['clear', 'service', SERVICE_NAME, 'account', ACCOUNT_NAME],
          { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] }
        );
        cleared = true;
      } catch {}
      return cleared;
    }

    return false;
  }
}
