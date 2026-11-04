import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';

const SERVICE_NAME = 'gemini';
const ACCOUNT_NAME = 'antigravity';
const TARGET_NAME = `${SERVICE_NAME}:${ACCOUNT_NAME}`;

export class KeyringManager {
  private helperPath: string;

  constructor(extensionPath: string) {
    this.helperPath = path.join(extensionPath, 'bin', 'charlier-cred.exe');
  }

  public read(): string | null {
    const platform = os.platform();

    if (platform === 'win32') {
      if (fs.existsSync(this.helperPath)) {
        try {
          const out = execFileSync(this.helperPath, ['read', TARGET_NAME], {
            encoding: 'utf8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore']
          });
          return out && out.trim() ? out.trim() : null;
        } catch {
          return null;
        }
      }
      return null;
    }

    if (platform === 'darwin') {
      try {
        const out = execFileSync(
          '/usr/bin/security',
          ['find-generic-password', '-s', SERVICE_NAME, '-a', ACCOUNT_NAME, '-w'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
        return out && out.trim() ? out.trim() : null;
      } catch {
        return null;
      }
    }

    if (platform === 'linux') {
      try {
        const out = execFileSync(
          'secret-tool',
          ['lookup', 'service', SERVICE_NAME, 'account', ACCOUNT_NAME],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
        return out && out.trim() ? out.trim() : null;
      } catch {
        return null;
      }
    }

    return null;
  }

  public write(secret: string): boolean {
    const platform = os.platform();

    if (platform === 'win32') {
      if (fs.existsSync(this.helperPath)) {
        try {
          execFileSync(this.helperPath, ['write', TARGET_NAME, ACCOUNT_NAME], {
            input: secret,
            windowsHide: true,
            stdio: ['pipe', 'ignore', 'ignore']
          });
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }

    if (platform === 'darwin') {
      try {
        // -U updates if existing
        execFileSync(
          '/usr/bin/security',
          ['add-generic-password', '-s', SERVICE_NAME, '-a', ACCOUNT_NAME, '-w', secret, '-U'],
          { stdio: ['ignore', 'ignore', 'ignore'] }
        );
        return true;
      } catch {
        return false;
      }
    }

    if (platform === 'linux') {
      try {
        execFileSync(
          'secret-tool',
          ['store', '--label=Antigravity', 'service', SERVICE_NAME, 'account', ACCOUNT_NAME],
          { input: secret, stdio: ['pipe', 'ignore', 'ignore'] }
        );
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  public delete(): boolean {
    const platform = os.platform();

    if (platform === 'win32') {
      if (fs.existsSync(this.helperPath)) {
        try {
          execFileSync(this.helperPath, ['delete', TARGET_NAME], {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore']
          });
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }

    if (platform === 'darwin') {
      try {
        execFileSync(
          '/usr/bin/security',
          ['delete-generic-password', '-s', SERVICE_NAME, '-a', ACCOUNT_NAME],
          { stdio: ['ignore', 'ignore', 'ignore'] }
        );
        return true;
      } catch {
        return false;
      }
    }

    if (platform === 'linux') {
      try {
        execFileSync(
          'secret-tool',
          ['clear', 'service', SERVICE_NAME, 'account', ACCOUNT_NAME],
          { stdio: ['ignore', 'ignore', 'ignore'] }
        );
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }
}

