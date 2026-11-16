import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export function getGeminiHomeDir(): string {
  return path.join(os.homedir(), '.gemini');
}

export function getCharlierDir(): string {
  return path.join(getGeminiHomeDir(), 'charlier');
}

export function getProfilesDir(): string {
  return path.join(getCharlierDir(), 'profiles');
}

export function getCodexProfilesDir(): string {
  return path.join(getCharlierDir(), 'providers', 'codex', 'profiles');
}

export function getStateFilePath(): string {
  return path.join(getCharlierDir(), 'state.json');
}

export function getActiveGoogleAccountsPath(): string {
  return path.join(getGeminiHomeDir(), 'google_accounts.json');
}

export function getActiveOAuthCredsPath(): string {
  return path.join(getGeminiHomeDir(), 'oauth_creds.json');
}

export function getCodexHomeDir(): string {
  const envHome = process.env.CODEX_HOME?.trim();
  if (envHome) {
    try {
      if (fs.existsSync(envHome) && fs.statSync(envHome).isDirectory()) {
        return fs.realpathSync(envHome);
      }
    } catch {}
  }
  return path.join(os.homedir(), '.codex');
}

export function getActiveCodexAuthPath(): string {
  return path.join(getCodexHomeDir(), 'auth.json');
}

export function getActiveCodexConfigPath(): string {
  return path.join(getCodexHomeDir(), 'config.toml');
}

export function getDaemonSearchDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.gemini', 'antigravity-ide', 'daemon'),
    path.join(home, '.gemini', 'antigravity', 'daemon'),
    path.join(home, '.gemini', 'daemon')
  ];
}

export function getIdeGlobalStorageDirs(): string[] {
  const home = os.homedir();
  const baseDirs: string[] = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    baseDirs.push(appData);
  } else if (process.platform === 'darwin') {
    baseDirs.push(path.join(home, 'Library', 'Application Support'));
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    baseDirs.push(xdgConfig);
  }

  const ideFolders = [
    'Antigravity',
    'Antigravity IDE',
    'antigravity',
    'antigravity-ide',
    'Code',
    'Code - Insiders',
    'Cursor',
    'Windsurf'
  ];

  const results: string[] = [];
  for (const base of baseDirs) {
    for (const ide of ideFolders) {
      results.push(path.join(base, ide, 'User', 'globalStorage'));
    }
  }
  return results;
}

