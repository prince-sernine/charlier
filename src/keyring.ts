import * as os from 'os';
import { execFileSync } from 'child_process';

const SERVICE_NAME = 'gemini';
const ACCOUNT_NAME = 'antigravity';
const TARGET_NAME = `${SERVICE_NAME}:${ACCOUNT_NAME}`;
const WIN_TARGET_NAME = `LegacyGeneric:target=${TARGET_NAME}`;

const PS_NATIVE_DEF = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public class NativeCred {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredReadW(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredWriteW(ref CREDENTIAL credential, int flags);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredDeleteW(string target, int type, int flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr buffer);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static string Read(string target) {
        IntPtr ptr;
        if (!CredReadW(target, 1, 0, out ptr)) return "";
        try {
            var cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            if (cred.CredentialBlobSize <= 0 || cred.CredentialBlob == IntPtr.Zero) return "";
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
            return Encoding.UTF8.GetString(bytes);
        } finally {
            CredFree(ptr);
        }
    }

    public static bool Write(string target, string user, string secret) {
        byte[] bytes = Encoding.UTF8.GetBytes(secret);
        IntPtr blobPtr = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, blobPtr, bytes.Length);
            var cred = new CREDENTIAL();
            cred.Type = 1;
            cred.TargetName = target;
            cred.UserName = user;
            cred.CredentialBlob = blobPtr;
            cred.CredentialBlobSize = bytes.Length;
            cred.Persist = 2;
            return CredWriteW(ref cred, 0);
        } finally {
            Marshal.FreeHGlobal(blobPtr);
        }
    }
}
`;

export class KeyringManager {
  constructor(_extensionPath?: string) {
    // Zero dependencies on external binaries - all OS native
  }

  public read(): string | null {
    const platform = os.platform();

    if (platform === 'win32') {
      try {
        const script = `
$typeDef = @'
${PS_NATIVE_DEF}
'@
Add-Type -TypeDefinition $typeDef -ErrorAction SilentlyContinue
$val = [NativeCred]::Read('${WIN_TARGET_NAME}')
if ($val) { Write-Output $val }
`;
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 4000,
          stdio: ['ignore', 'pipe', 'ignore']
        });
        return out && out.trim() ? out.trim() : null;
      } catch {
        return null;
      }
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
      try {
        // zalando/go-keyring on Linux indexes by 'username', while standard schemas use 'account'
        let out = '';
        try {
          out = execFileSync(
            'secret-tool',
            ['lookup', 'service', SERVICE_NAME, 'username', ACCOUNT_NAME],
            { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
          );
        } catch {}

        if (!out || !out.trim()) {
          try {
            out = execFileSync(
              'secret-tool',
              ['lookup', 'service', SERVICE_NAME, 'account', ACCOUNT_NAME],
              { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
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

  public write(secret: string): boolean {
    const platform = os.platform();

    if (platform === 'win32') {
      try {
        const b64 = Buffer.from(secret, 'utf8').toString('base64');
        const script = `
$typeDef = @'
${PS_NATIVE_DEF}
'@
Add-Type -TypeDefinition $typeDef -ErrorAction SilentlyContinue
$secret = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))
$res = [NativeCred]::Write('${WIN_TARGET_NAME}', '${ACCOUNT_NAME}', $secret)
if ($res) { Write-Output "OK" }
`;
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore']
        });
        return out.trim() === 'OK';
      } catch {
        return false;
      }
    }

    if (platform === 'darwin') {
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
      try {
        // Store with both username and account attributes for universal Secret Service compatibility
        execFileSync(
          'secret-tool',
          ['store', '--label=Antigravity', 'service', SERVICE_NAME, 'username', ACCOUNT_NAME, 'account', ACCOUNT_NAME],
          { input: secret, timeout: 3000, stdio: ['pipe', 'ignore', 'ignore'] }
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
      try {
        // Fast Microsoft signed system command
        execFileSync('cmdkey.exe', [`/delete:${WIN_TARGET_NAME}`], {
          windowsHide: true,
          timeout: 3000,
          stdio: ['ignore', 'ignore', 'ignore']
        });
        return true;
      } catch {
        return false;
      }
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
      try {
        try {
          execFileSync(
            'secret-tool',
            ['clear', 'service', SERVICE_NAME, 'username', ACCOUNT_NAME],
            { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] }
          );
        } catch {}
        try {
          execFileSync(
            'secret-tool',
            ['clear', 'service', SERVICE_NAME, 'account', ACCOUNT_NAME],
            { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] }
          );
        } catch {}
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }
}
