import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCharlierDir, getCodexProfilesDir, getProfilesDir } from './constants';

export type IsolatedProviderId = 'codex' | 'antigravity';

export interface CliIsolationRoots {
  charlierDir?: string;
  profilesDir?: string;
  codexProfilesDir?: string;
  realHomeDir?: string;
  realCodexHomeDir?: string;
  realGeminiHomeDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  configuredExecutable?: string;
  extensionPaths?: string[];
}

export interface CliBinaryResolution {
  executablePath: string;
  pathOverride: Record<string, string>;
  source: 'config' | 'path' | 'extension' | 'standard';
}

export interface PreparedCliEnvironment {
  homeDir: string;
  env: Record<string, string | null>;
}

const SHARED_CODEX_SUBDIRS = [
  'skills',
  'plugins',
  'vendor_imports',
  'packages',
  'rules'
] as const;

const SHARED_CODEX_FILES = ['AGENTS.md', 'instructions.md'] as const;

const SHARED_GEMINI_SUBDIRS = [
  'config',
  'skills',
  'extensions',
  'marketplaces',
  'hooks',
  'prompts',
  'policies'
] as const;

const SHARED_GEMINI_FILES = ['settings.json', 'GEMINI.md', 'projects.json'] as const;

const SHARED_HOME_DOTDIRS = [
  '.ssh',
  '.gnupg',
  '.config',
  '.kube',
  '.aws',
  '.azure',
  '.docker',
  '.cargo',
  '.rustup',
  '.npm',
  '.pnpm-store',
  '.bun',
  '.local',
  '.pyenv',
  '.nvm',
  '.fnm',
  '.vscode'
] as const;

const SHARED_HOME_DOTFILES = [
  '.gitconfig',
  '.git-credentials',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.netrc',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.profile'
] as const;

const RETRYABLE_RENAME_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

export function resolveSafeProfileSubdir(baseDir: string, profileId: string): string {
  const id = typeof profileId === 'string' ? profileId.trim() : '';
  if (!id || id === '.' || id === '..' || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new Error(`Invalid profile id for isolated CLI home: "${profileId}"`);
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, id);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Profile path escaped base directory: "${profileId}"`);
  }
  return resolvedTarget;
}

export function getCliHomesDir(
  provider: IsolatedProviderId,
  roots?: CliIsolationRoots
): string {
  const charlierDir = roots?.charlierDir || getCharlierDir();
  return path.join(charlierDir, 'cli-homes', provider);
}

export function getProfileCliHomeDir(
  provider: IsolatedProviderId,
  profileId: string,
  roots?: CliIsolationRoots
): string {
  return resolveSafeProfileSubdir(getCliHomesDir(provider, roots), profileId);
}

function getRealHomeDir(roots?: CliIsolationRoots): string {
  return roots?.realHomeDir || os.homedir();
}

function getRealCodexHomeDir(roots?: CliIsolationRoots): string {
  if (roots?.realCodexHomeDir) return roots.realCodexHomeDir;
  return path.join(getRealHomeDir(roots), '.codex');
}

function getRealGeminiHomeDir(roots?: CliIsolationRoots): string {
  if (roots?.realGeminiHomeDir) return roots.realGeminiHomeDir;
  return path.join(getRealHomeDir(roots), '.gemini');
}

function ensureRealDirectory(dirPath: string, mode = 0o700): void {
  try {
    const stat = fs.lstatSync(dirPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch {}
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode });
  }
}

function writeFileAtomic(filePath: string, data: string | Buffer, mode = 0o600): void {
  const dir = path.dirname(filePath);
  ensureRealDirectory(dir, 0o700);
  try {
    const existing = fs.lstatSync(filePath);
    if (existing.isSymbolicLink()) {
      fs.unlinkSync(filePath);
    }
  } catch {}

  const unique = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const tmpPath = `${filePath}.${unique}.tmp`;
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  fs.writeFileSync(tmpPath, buf, { mode });

  try {
    let renamed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        fs.renameSync(tmpPath, filePath);
        renamed = true;
        break;
      } catch (err: any) {
        if (!RETRYABLE_RENAME_CODES.has(err?.code) || attempt === 3) {
          if (!RETRYABLE_RENAME_CODES.has(err?.code)) {
            throw err;
          }
          break;
        }
      }
    }
    if (!renamed) {
      try {
        if (fs.lstatSync(filePath).isSymbolicLink()) {
          fs.unlinkSync(filePath);
        }
      } catch {}
      fs.copyFileSync(tmpPath, filePath);
    }
    try {
      fs.chmodSync(filePath, mode);
    } catch {}
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {}
  }
}

function mirrorReadMostlyEntry(
  srcPath: string,
  destPath: string,
  isDirectory: boolean,
  platform: NodeJS.Platform
): void {
  let srcStat: fs.Stats;
  try {
    srcStat = fs.statSync(srcPath);
  } catch {
    return;
  }
  if (isDirectory && !srcStat.isDirectory()) return;
  if (!isDirectory && !srcStat.isFile()) return;

  let destLstat: fs.Stats | null = null;
  try {
    destLstat = fs.lstatSync(destPath);
  } catch {
    destLstat = null;
  }

  if (destLstat) {
    if (destLstat.isSymbolicLink()) {
      try {
        const currentTarget = fs.readlinkSync(destPath);
        if (path.resolve(path.dirname(destPath), currentTarget) === path.resolve(srcPath)) {
          return;
        }
      } catch {}
      try {
        fs.rmSync(destPath, { recursive: true, force: true });
      } catch {}
    } else if (isDirectory) {
      // Preserve existing real directory inside isolated home
      return;
    } else {
      // Refresh real file copy if source moved ahead (e.g. .gitconfig/.zshrc edits after hardlink fallback)
      try {
        if (srcStat.ino === destLstat.ino && srcStat.dev === destLstat.dev) {
          return;
        }
        if (srcStat.mtimeMs <= destLstat.mtimeMs && srcStat.size === destLstat.size) {
          return;
        }
        fs.copyFileSync(srcPath, destPath);
      } catch {}
      return;
    }
  }

  ensureRealDirectory(path.dirname(destPath), 0o700);
  if (isDirectory) {
    try {
      fs.symlinkSync(srcPath, destPath, platform === 'win32' ? 'junction' : 'dir');
    } catch {}
    return;
  }

  try {
    fs.linkSync(srcPath, destPath);
    return;
  } catch {}
  try {
    fs.symlinkSync(srcPath, destPath, 'file');
    return;
  } catch {}
  try {
    fs.copyFileSync(srcPath, destPath);
  } catch {}
}

/**
 * Normalizes a Codex `config.toml` for isolated CLI homes:
 * strips any top-level `cli_auth_credentials_store` declaration before the first `[table]`
 * header and prepends `cli_auth_credentials_store = "file"` at root scope so trailing
 * `[projects.*]` sections cannot swallow it.
 */
export function buildIsolatedCodexConfigToml(rawConfig?: string | null): string {
  const eol = rawConfig && rawConfig.includes('\r\n') ? '\r\n' : '\n';
  if (!rawConfig || !rawConfig.trim()) {
    return `cli_auth_credentials_store = "file"${eol}`;
  }

  const lines = rawConfig.split(/\r?\n/);
  const filteredLines: string[] = [];
  let inTableSection = false;

  for (const line of lines) {
    if (!inTableSection && /^\s*\[/.test(line)) {
      inTableSection = true;
    }
    if (!inTableSection && /^\s*cli_auth_credentials_store\s*=/.test(line)) {
      continue;
    }
    filteredLines.push(line);
  }

  while (filteredLines.length > 0 && filteredLines[0].trim() === '') {
    filteredLines.shift();
  }

  const body = filteredLines.join(eol);
  return body
    ? `cli_auth_credentials_store = "file"${eol}${body}`
    : `cli_auth_credentials_store = "file"${eol}`;
}

function decodeJwtClaims(token?: string | null): Record<string, any> | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const padded = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

interface ParsedCodexAuthMeta {
  rawText: string;
  accessToken: string | null;
  refreshToken: string | null;
  freshnessMs: number;
}

function readCodexAuthMeta(filePath: string): ParsedCodexAuthMeta | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const rawText = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(rawText);
    const tokens = parsed?.tokens;
    const accessToken =
      typeof tokens?.access_token === 'string' && tokens.access_token.trim()
        ? tokens.access_token.trim()
        : null;
    const refreshToken =
      typeof tokens?.refresh_token === 'string' && tokens.refresh_token.trim()
        ? tokens.refresh_token.trim()
        : null;
    if (!accessToken && !refreshToken && !parsed?.OPENAI_API_KEY) {
      return null;
    }

    let freshnessMs = 0;
    if (typeof parsed?.last_refresh === 'string') {
      const lr = Date.parse(parsed.last_refresh);
      if (Number.isFinite(lr)) freshnessMs = lr;
    } else if (typeof parsed?.last_refresh === 'number' && Number.isFinite(parsed.last_refresh)) {
      freshnessMs = parsed.last_refresh;
    }
    if (!freshnessMs && accessToken) {
      const claims = decodeJwtClaims(accessToken);
      if (typeof claims?.iat === 'number') {
        freshnessMs = claims.iat * 1000;
      } else if (typeof claims?.exp === 'number') {
        freshnessMs = claims.exp * 1000;
      }
    }
    if (!freshnessMs) {
      freshnessMs = stat.mtimeMs || 0;
    }

    return { rawText, accessToken, refreshToken, freshnessMs };
  } catch {
    return null;
  }
}

function isExecutableFile(candidatePath: string, platform: NodeJS.Platform): boolean {
  try {
    const st = fs.statSync(candidatePath);
    if (!st.isFile()) return false;
    if (platform !== 'win32') {
      fs.accessSync(candidatePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function getBinNames(binaryBase: 'codex' | 'agy', platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? [`${binaryBase}.exe`, `${binaryBase}.cmd`, `${binaryBase}.bat`, `${binaryBase}.ps1`, binaryBase]
    : [binaryBase];
}

function findBinInDir(dir: string, binNames: string[], platform: NodeJS.Platform): string | null {
  for (const name of binNames) {
    const full = path.join(dir, name);
    if (isExecutableFile(full, platform)) {
      return full;
    }
  }
  return null;
}

function compareSemverDesc(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

function collectCodexExtensionBinDirs(
  home: string,
  platform: NodeJS.Platform,
  arch: string,
  explicitExtPaths?: string[],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const targetTriples: string[] = [];
  if (platform === 'win32') {
    if (arch === 'arm64') {
      targetTriples.push('windows-aarch64', 'aarch64-pc-windows-msvc');
    } else {
      targetTriples.push('windows-x86_64', 'x86_64-pc-windows-msvc');
    }
  } else if (platform === 'darwin') {
    if (arch === 'arm64') {
      targetTriples.push('macos-aarch64', 'aarch64-apple-darwin');
    } else {
      targetTriples.push('macos-x86_64', 'macos-x64', 'x86_64-apple-darwin');
    }
  } else {
    if (arch === 'arm64') {
      targetTriples.push('linux-aarch64', 'aarch64-unknown-linux-gnu', 'aarch64-unknown-linux-musl');
    } else {
      targetTriples.push('linux-x86_64', 'x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-musl');
    }
  }

  const extRoots: string[] = [];
  if (Array.isArray(explicitExtPaths)) {
    for (const p of explicitExtPaths) {
      if (p) extRoots.push(p);
    }
  }

  const vscodeExtEnv = env.VSCODE_EXTENSIONS || process.env.VSCODE_EXTENSIONS;
  const ideExtParents = [
    ...(vscodeExtEnv ? [vscodeExtEnv] : []),
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.vscode-server', 'extensions'),
    path.join(home, '.vscode-server-insiders', 'extensions'),
    path.join(home, '.antigravity-ide', 'extensions'),
    path.join(home, '.antigravity', 'extensions'),
    path.join(home, '.antigravity-server', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.windsurf', 'extensions')
  ];
  const matchedDirs: Array<{ version: string; dir: string }> = [];
  for (const parent of ideExtParents) {
    try {
      if (!fs.existsSync(parent)) continue;
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const lower = entry.name.toLowerCase();
        if (!lower.startsWith('openai.chatgpt-')) continue;
        const verMatch = entry.name.match(/^openai\.chatgpt-([0-9.]+)/i);
        matchedDirs.push({
          version: verMatch ? verMatch[1] : '0',
          dir: path.join(parent, entry.name)
        });
      }
    } catch {}
  }
  matchedDirs.sort((a, b) => compareSemverDesc(a.version, b.version));
  for (const m of matchedDirs) extRoots.push(m.dir);

  const binDirs: string[] = [];
  for (const rootDir of extRoots) {
    for (const triple of targetTriples) {
      binDirs.push(path.join(rootDir, 'bin', triple));
    }
  }
  return binDirs;
}

function collectNvmNodeBinDirs(home: string, baseEnv: NodeJS.ProcessEnv): string[] {
  const nvmDir = (baseEnv.NVM_DIR || '').trim() || path.join(home, '.nvm');
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  try {
    if (!fs.existsSync(versionsDir)) return [];
    return fs
      .readdirSync(versionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => compareSemverDesc(a.replace(/^v/i, ''), b.replace(/^v/i, '')))
      .map((name) => path.join(versionsDir, name, 'bin'));
  } catch {
    return [];
  }
}

export function resolveCliBinary(
  binaryBase: 'codex' | 'agy',
  options?: {
    platform?: NodeJS.Platform;
    arch?: string;
    env?: NodeJS.ProcessEnv;
    realHomeDir?: string;
    configuredExecutable?: string;
    extensionPaths?: string[];
  }
): CliBinaryResolution | null {
  const platform = options?.platform || process.platform;
  const arch = options?.arch || process.arch;
  const env = options?.env || process.env;
  const sep = platform === 'win32' ? ';' : ':';
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const currentPath = env[pathKey] || '';
  const segments = currentPath
    .split(sep)
    .map((s) => s.trim().replace(/^"+|"+$/g, ''))
    .filter(Boolean);
  const binNames = getBinNames(binaryBase, platform);

  const prependDirOverride = (dir: string): Record<string, string> => {
    const norm = (s: string) => (platform === 'win32' ? s.toLowerCase() : s);
    if (segments.some((s) => norm(s) === norm(dir))) {
      return {};
    }
    return {
      [pathKey]: currentPath ? `${dir}${sep}${currentPath}` : dir
    };
  };

  const home = options?.realHomeDir || env.HOME || env.USERPROFILE || os.homedir();

  // 1. Explicit IDE setting override (e.g. `chatgpt.cliExecutable`, expanding leading ~/ or ~\)
  const rawConfigured = (options?.configuredExecutable || '').trim();
  const configured =
    rawConfigured === '~'
      ? home
      : rawConfigured.startsWith('~/') || rawConfigured.startsWith('~\\')
        ? path.join(home, rawConfigured.slice(2))
        : rawConfigured;
  if (configured && isExecutableFile(configured, platform)) {
    return {
      executablePath: configured,
      pathOverride: prependDirOverride(path.dirname(configured)),
      source: 'config'
    };
  }

  // 2. Active PATH entries (must be a real executable file, not a bare folder)
  for (const seg of segments) {
    const found = findBinInDir(seg, binNames, platform);
    if (found) {
      return {
        executablePath: found,
        pathOverride: {},
        source: 'path'
      };
    }
  }

  // 3. Extension-bundled binaries (e.g. `openai.chatgpt/bin/<os>-<arch>/codex`)
  if (binaryBase === 'codex') {
    for (const extBinDir of collectCodexExtensionBinDirs(home, platform, arch, options?.extensionPaths, env)) {
      const found = findBinInDir(extBinDir, binNames, platform);
      if (found) {
        return {
          executablePath: found,
          pathOverride: prependDirOverride(extBinDir),
          source: 'extension'
        };
      }
    }
  }

  // 4. Cross-OS standard install & package-manager paths
  const pnpmHome = (env.PNPM_HOME || '').trim();
  const nvmBin = (env.NVM_BIN || '').trim();
  const voltaHome = (env.VOLTA_HOME || '').trim();
  const bunInstall = (env.BUN_INSTALL || '').trim();
  const cargoHome = (env.CARGO_HOME || '').trim();
  const candidates: string[] = [];
  if (binaryBase === 'agy') {
    candidates.push(
      path.join(home, '.gemini', 'bin'),
      path.join(home, '.gemini', 'antigravity', 'bin'),
      path.join(home, '.gemini', 'antigravity-ide', 'bin')
    );
    if (platform === 'win32') {
      const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      const programFiles = env.ProgramFiles || 'C:\\Program Files';
      candidates.push(
        path.join(localAppData, 'agy', 'bin'),
        path.join(localAppData, 'Programs', 'Antigravity', 'bin'),
        path.join(localAppData, 'Programs', 'Antigravity IDE', 'bin'),
        path.join(programFiles, 'Antigravity', 'bin')
      );
    } else if (platform === 'darwin') {
      candidates.push(
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        path.join(home, '.local', 'bin'),
        '/Applications/Antigravity.app/Contents/Resources/app/bin',
        '/Applications/Antigravity IDE.app/Contents/Resources/app/bin',
        path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin')
      );
    } else {
      candidates.push(
        '/usr/local/bin',
        '/usr/bin',
        path.join(home, '.local', 'bin'),
        '/snap/bin',
        '/usr/share/antigravity/bin',
        '/opt/Antigravity/bin'
      );
    }
  } else if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(
      path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'),
      ...(pnpmHome ? [pnpmHome] : []),
      ...(nvmBin ? [nvmBin] : []),
      ...(voltaHome ? [path.join(voltaHome, 'bin')] : []),
      ...(bunInstall ? [path.join(bunInstall, 'bin')] : []),
      ...(cargoHome ? [path.join(cargoHome, 'bin')] : []),
      path.join(appData, 'npm'),
      path.join(localAppData, 'pnpm'),
      path.join(localAppData, 'Volta', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, 'scoop', 'shims'),
      path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
      ...(env.NVM_SYMLINK ? [env.NVM_SYMLINK] : []),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.local', 'bin')
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      ...(nvmBin ? [nvmBin] : []),
      ...collectNvmNodeBinDirs(home, env),
      ...(pnpmHome ? [pnpmHome] : []),
      ...(voltaHome ? [path.join(voltaHome, 'bin')] : []),
      ...(bunInstall ? [path.join(bunInstall, 'bin')] : []),
      ...(cargoHome ? [path.join(cargoHome, 'bin')] : []),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.fnm', 'aliases', 'default', 'bin'),
      path.join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
      path.join(home, 'Library', 'pnpm'),
      path.join(home, '.local', 'share', 'mise', 'shims'),
      path.join(home, '.asdf', 'shims'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.local', 'bin'),
      '/Applications/Codex.app/Contents/Resources'
    );
  } else {
    candidates.push(
      '/usr/local/bin',
      '/usr/bin',
      ...(nvmBin ? [nvmBin] : []),
      ...collectNvmNodeBinDirs(home, env),
      ...(pnpmHome ? [pnpmHome] : []),
      ...(voltaHome ? [path.join(voltaHome, 'bin')] : []),
      ...(bunInstall ? [path.join(bunInstall, 'bin')] : []),
      ...(cargoHome ? [path.join(cargoHome, 'bin')] : []),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.fnm', 'aliases', 'default', 'bin'),
      path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
      path.join(home, '.local', 'share', 'pnpm'),
      path.join(home, '.local', 'share', 'mise', 'shims'),
      path.join(home, '.asdf', 'shims'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.local', 'bin'),
      '/snap/bin',
      '/home/linuxbrew/.linuxbrew/bin'
    );
  }

  for (const dir of candidates) {
    const found = findBinInDir(dir, binNames, platform);
    if (found) {
      return {
        executablePath: found,
        pathOverride: prependDirOverride(dir),
        source: 'standard'
      };
    }
  }

  return null;
}

export function resolveBinaryPathOverride(
  binaryBase: 'codex' | 'agy',
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  options?: {
    arch?: string;
    realHomeDir?: string;
    configuredExecutable?: string;
    extensionPaths?: string[];
  }
): Record<string, string> {
  return (
    resolveCliBinary(binaryBase, {
      platform,
      arch: options?.arch,
      env,
      realHomeDir: options?.realHomeDir,
      configuredExecutable: options?.configuredExecutable,
      extensionPaths: options?.extensionPaths
    })?.pathOverride ?? {}
  );
}

/**
 * Syncs rotated single-use RTR Codex tokens from an isolated CLI home back to the vault profile
 * when the CLI home holds a strictly newer token than the vault.
 */
function healProfileAuthHealthAfterCliSync(profileDir: string): void {
  const metaPath = path.join(profileDir, 'metadata.json');
  if (!fs.existsSync(metaPath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (raw && (raw.authStatus === 'revoked' || raw.authStatus === 'expired')) {
      raw.authStatus = 'ok';
      delete raw.authErrorCode;
      delete raw.authErrorMessage;
      raw.authCheckedAt = Date.now();
      writeFileAtomic(metaPath, JSON.stringify(raw, null, 2), 0o600);
    }
  } catch {}
}

/**
 * Reads the isolated CLI home's Codex `auth.json` strictly read-only (no vault or CLI writes)
 * so live telemetry refreshes can use a CLI-rotated `access_token` while a `CLI CLAIMED`
 * terminal is actively running without risking single-use RTR collisions.
 */
export function readCodexCliHomeAuthReadOnly(
  profileId: string,
  roots?: CliIsolationRoots
): { rawAuthJson: any; freshnessMs: number } | null {
  try {
    const cliHome = getProfileCliHomeDir('codex', profileId, roots);
    const cliAuthPath = path.join(cliHome, 'auth.json');
    for (let attempt = 0; attempt < 3; attempt++) {
      const meta = readCodexAuthMeta(cliAuthPath);
      if (meta) {
        try {
          const parsed = JSON.parse(meta.rawText);
          return { rawAuthJson: parsed, freshnessMs: meta.freshnessMs };
        } catch {
          // Transient partial read while CLI writes; retry immediately
        }
      } else if (!fs.existsSync(cliAuthPath)) {
        return null;
      }
    }
  } catch {}
  return null;
}

/**
 * Reads an isolated Antigravity CLI home's OAuth token strictly read-only so live quota
 * refreshes can reuse a fresh CLI-minted `access_token` without mutating active CLI files.
 */
export function readAntigravityCliHomeTokenReadOnly(
  profileId: string,
  roots?: CliIsolationRoots
): { accessToken: string | null; refreshToken: string | null; expiryMs: number } | null {
  try {
    const cliHome = getProfileCliHomeDir('antigravity', profileId, roots);
    const cliTokenPath = path.join(cliHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    for (let attempt = 0; attempt < 3; attempt++) {
      const meta = readAntigravityKeyringTokenMeta(cliTokenPath);
      if (meta) {
        return {
          accessToken: meta.accessToken,
          refreshToken: meta.refreshToken,
          expiryMs: meta.expiryMs
        };
      }
      if (!fs.existsSync(cliTokenPath)) {
        return null;
      }
    }
  } catch {}
  return null;
}

export function syncCodexCliHomeToVault(
  profileId: string,
  roots?: CliIsolationRoots
): boolean {
  const codexProfilesDir = roots?.codexProfilesDir || getCodexProfilesDir();
  const profileDir = resolveSafeProfileSubdir(codexProfilesDir, profileId);
  if (!fs.existsSync(profileDir)) return false;

  const cliHome = getProfileCliHomeDir('codex', profileId, roots);
  const cliAuthPath = path.join(cliHome, 'auth.json');
  const vaultAuthPath = path.join(profileDir, 'auth.json');

  const cliMeta = readCodexAuthMeta(cliAuthPath);
  if (!cliMeta) return false;

  const vaultMeta = readCodexAuthMeta(vaultAuthPath);
  if (
    vaultMeta &&
    vaultMeta.accessToken === cliMeta.accessToken &&
    vaultMeta.refreshToken === cliMeta.refreshToken
  ) {
    return false;
  }
  if (vaultMeta && cliMeta.freshnessMs <= vaultMeta.freshnessMs) {
    return false;
  }

  writeFileAtomic(vaultAuthPath, cliMeta.rawText, 0o600);
  healProfileAuthHealthAfterCliSync(profileDir);
  return true;
}

/**
 * Prepares an isolated per-profile `CODEX_HOME` directory and returns terminal env vars.
 * Never mutates global `~/.codex/auth.json`.
 */
export function prepareCodexCliHome(
  profileId: string,
  roots?: CliIsolationRoots
): PreparedCliEnvironment {
  const platform = roots?.platform || process.platform;
  const baseEnv = roots?.env || process.env;
  const cliHome = getProfileCliHomeDir('codex', profileId, roots);
  const codexProfilesDir = roots?.codexProfilesDir || getCodexProfilesDir();
  const profileDir = resolveSafeProfileSubdir(codexProfilesDir, profileId);
  const vaultAuthPath = path.join(profileDir, 'auth.json');

  // Skip filesystem materialization if vault directory doesn't exist (e.g. mocked unit tests
  // without real profile storage on disk) so tests do not touch real user home.
  if (fs.existsSync(vaultAuthPath)) {
    ensureRealDirectory(cliHome, 0o700);

    // Preserve fresher tokens rotated inside an active/previous isolated CLI process
    const syncedToVault = syncCodexCliHomeToVault(profileId, roots);
    const cliAuthPath = path.join(cliHome, 'auth.json');
    if (!syncedToVault || !fs.existsSync(cliAuthPath)) {
      const vaultRaw = fs.readFileSync(vaultAuthPath, 'utf8');
      const existingCliRaw = fs.existsSync(cliAuthPath)
        ? (() => {
            try {
              const st = fs.lstatSync(cliAuthPath);
              if (st.isSymbolicLink() || !st.isFile()) return null;
              return fs.readFileSync(cliAuthPath, 'utf8');
            } catch {
              return null;
            }
          })()
        : null;
      if (existingCliRaw !== vaultRaw) {
        writeFileAtomic(cliAuthPath, vaultRaw, 0o600);
      }
    }

    const realCodexHome = getRealCodexHomeDir(roots);
    const realConfigPath = path.join(realCodexHome, 'config.toml');
    const rawConfig = fs.existsSync(realConfigPath)
      ? fs.readFileSync(realConfigPath, 'utf8')
      : '';
    const isolatedConfig = buildIsolatedCodexConfigToml(rawConfig);
    writeFileAtomic(path.join(cliHome, 'config.toml'), isolatedConfig, 0o600);

    for (const dirName of SHARED_CODEX_SUBDIRS) {
      mirrorReadMostlyEntry(
        path.join(realCodexHome, dirName),
        path.join(cliHome, dirName),
        true,
        platform
      );
    }
    for (const fileName of SHARED_CODEX_FILES) {
      mirrorReadMostlyEntry(
        path.join(realCodexHome, fileName),
        path.join(cliHome, fileName),
        false,
        platform
      );
    }
  }

  const pathOverride = resolveBinaryPathOverride('codex', platform, baseEnv, {
    arch: roots?.arch,
    realHomeDir: getRealHomeDir(roots),
    configuredExecutable: roots?.configuredExecutable,
    extensionPaths: roots?.extensionPaths
  });
  return {
    homeDir: cliHome,
    env: {
      ...pathOverride,
      CODEX_HOME: cliHome
    }
  };
}

interface ParsedAntigravityTokenMeta {
  rawText: string;
  accessToken: string | null;
  refreshToken: string | null;
  email: string | null;
  expiryMs: number;
}

function readAntigravityKeyringTokenMeta(filePath: string): ParsedAntigravityTokenMeta | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const rawText = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(rawText);
    const tok = parsed?.token;
    if (!tok || typeof tok !== 'object') return null;

    const accessToken =
      typeof tok.access_token === 'string' && tok.access_token.trim()
        ? tok.access_token.trim()
        : null;
    const refreshToken =
      typeof tok.refresh_token === 'string' && tok.refresh_token.trim()
        ? tok.refresh_token.trim()
        : null;
    if (!accessToken && !refreshToken) return null;

    let expiryMs = 0;
    if (typeof tok.expiry === 'string') {
      const ms = Date.parse(tok.expiry);
      if (Number.isFinite(ms)) expiryMs = ms;
    } else if (typeof tok.expiry === 'number' && Number.isFinite(tok.expiry)) {
      expiryMs = tok.expiry;
    }

    const email =
      typeof parsed?.id_token_email === 'string' && parsed.id_token_email.trim()
        ? parsed.id_token_email.trim()
        : null;

    return { rawText, accessToken, refreshToken, email, expiryMs };
  } catch {
    return null;
  }
}

export function buildAntigravityCliTokenFromOAuth(
  oauthCredsRaw: any,
  email?: string | null
): string | null {
  if (!oauthCredsRaw || typeof oauthCredsRaw !== 'object') return null;
  const accessToken =
    typeof oauthCredsRaw.access_token === 'string' && oauthCredsRaw.access_token.trim()
      ? oauthCredsRaw.access_token.trim()
      : '';
  const refreshToken =
    typeof oauthCredsRaw.refresh_token === 'string' && oauthCredsRaw.refresh_token.trim()
      ? oauthCredsRaw.refresh_token.trim()
      : '';
  if (!accessToken && !refreshToken) return null;

  const expiryDateMs =
    typeof oauthCredsRaw.expiry_date === 'number' && Number.isFinite(oauthCredsRaw.expiry_date)
      ? oauthCredsRaw.expiry_date
      : Date.now() + 3600 * 1000;

  const payload = {
    token: {
      access_token: accessToken,
      token_type: oauthCredsRaw.token_type || 'Bearer',
      refresh_token: refreshToken,
      expiry: new Date(expiryDateMs).toISOString(),
      expires_in: Math.max(0, Math.floor((expiryDateMs - Date.now()) / 1000))
    },
    auth_method: 'consumer',
    ...(email ? { id_token_email: email } : {}),
    writer_id: 'charlier'
  };
  return JSON.stringify(payload);
}

/**
 * Syncs refreshed/re-authenticated Antigravity CLI file-store tokens back into the vault profile
 * when the isolated CLI home holds a newer credential than the vault.
 */
export function syncAntigravityCliHomeToVault(
  profileId: string,
  roots?: CliIsolationRoots
): boolean {
  const profilesDir = roots?.profilesDir || getProfilesDir();
  const profileDir = resolveSafeProfileSubdir(profilesDir, profileId);
  if (!fs.existsSync(profileDir)) return false;

  const cliHome = getProfileCliHomeDir('antigravity', profileId, roots);
  const cliTokenPath = path.join(cliHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  const vaultKeyringPath = path.join(profileDir, 'keyring_credential.json');
  const vaultOAuthPath = path.join(profileDir, 'oauth_creds.json');
  const vaultAccountsPath = path.join(profileDir, 'google_accounts.json');

  const cliMeta = readAntigravityKeyringTokenMeta(cliTokenPath);
  if (!cliMeta) return false;

  const vaultMeta = readAntigravityKeyringTokenMeta(vaultKeyringPath);
  if (
    vaultMeta &&
    vaultMeta.accessToken === cliMeta.accessToken &&
    vaultMeta.refreshToken === cliMeta.refreshToken
  ) {
    return false;
  }

  let cliMtime = 0;
  let vaultMtime = 0;
  try {
    cliMtime = fs.statSync(cliTokenPath).mtimeMs;
  } catch {}
  try {
    vaultMtime = fs.statSync(vaultKeyringPath).mtimeMs;
  } catch {}

  if (vaultMeta && cliMeta.expiryMs < vaultMeta.expiryMs) {
    return false;
  }
  if (vaultMeta && cliMeta.expiryMs === vaultMeta.expiryMs && cliMtime <= vaultMtime) {
    return false;
  }

  writeFileAtomic(vaultKeyringPath, cliMeta.rawText, 0o600);

  if (cliMeta.email) {
    writeFileAtomic(
      vaultAccountsPath,
      JSON.stringify({ active: cliMeta.email, old: [] }, null, 2),
      0o600
    );
  }
  const synthesizedOAuth = {
    ...(cliMeta.accessToken ? { access_token: cliMeta.accessToken } : {}),
    ...(cliMeta.refreshToken ? { refresh_token: cliMeta.refreshToken } : {}),
    token_type: 'Bearer',
    ...(cliMeta.expiryMs > 0 ? { expiry_date: cliMeta.expiryMs } : {})
  };
  writeFileAtomic(vaultOAuthPath, JSON.stringify(synthesizedOAuth, null, 2), 0o600);
  healProfileAuthHealthAfterCliSync(profileDir);
  return true;
}

/**
 * Prepares an isolated home directory for Antigravity CLI (`agy`) so file-based token storage
 * (`<home>/.gemini/antigravity-cli/antigravity-oauth-token`) isolates each terminal per profile
 * without touching OS keyring or global `~/.gemini` accounts.
 */
export function prepareAntigravityCliHome(
  profileId: string,
  roots?: CliIsolationRoots
): PreparedCliEnvironment {
  const platform = roots?.platform || process.platform;
  const baseEnv = roots?.env || process.env;
  const cliHome = getProfileCliHomeDir('antigravity', profileId, roots);
  const profilesDir = roots?.profilesDir || getProfilesDir();
  const profileDir = resolveSafeProfileSubdir(profilesDir, profileId);

  const hasProfileDiskData =
    fs.existsSync(profileDir) &&
    (fs.existsSync(path.join(profileDir, 'keyring_credential.json')) ||
      fs.existsSync(path.join(profileDir, 'oauth_creds.json')));

  if (hasProfileDiskData) {
    ensureRealDirectory(cliHome, 0o700);
    const cliGeminiDir = path.join(cliHome, '.gemini');
    const cliAgyDir = path.join(cliGeminiDir, 'antigravity-cli');
    ensureRealDirectory(cliGeminiDir, 0o700);
    ensureRealDirectory(cliAgyDir, 0o700);

    const syncedToVault = syncAntigravityCliHomeToVault(profileId, roots);

    const vaultAccountsPath = path.join(profileDir, 'google_accounts.json');
    const vaultOAuthPath = path.join(profileDir, 'oauth_creds.json');
    const vaultKeyringPath = path.join(profileDir, 'keyring_credential.json');

    let profileEmail: string | null = null;
    if (fs.existsSync(vaultAccountsPath)) {
      try {
        const accountsRaw = fs.readFileSync(vaultAccountsPath, 'utf8');
        writeFileAtomic(path.join(cliGeminiDir, 'google_accounts.json'), accountsRaw, 0o600);
        const parsed = JSON.parse(accountsRaw);
        if (typeof parsed?.active === 'string' && parsed.active.trim()) {
          profileEmail = parsed.active.trim();
        }
      } catch {}
    }

    if (fs.existsSync(vaultOAuthPath)) {
      try {
        const oauthRaw = fs.readFileSync(vaultOAuthPath, 'utf8');
        writeFileAtomic(path.join(cliGeminiDir, 'oauth_creds.json'), oauthRaw, 0o600);
      } catch {}
    }

    const cliTokenPath = path.join(cliAgyDir, 'antigravity-oauth-token');
    if (!syncedToVault || !fs.existsSync(cliTokenPath)) {
      let tokenPayload: string | null = null;
      if (fs.existsSync(vaultKeyringPath)) {
        try {
          tokenPayload = fs.readFileSync(vaultKeyringPath, 'utf8');
        } catch {}
      }
      if (!tokenPayload && fs.existsSync(vaultOAuthPath)) {
        try {
          const parsedOAuth = JSON.parse(fs.readFileSync(vaultOAuthPath, 'utf8'));
          tokenPayload = buildAntigravityCliTokenFromOAuth(parsedOAuth, profileEmail);
        } catch {}
      }
      if (tokenPayload) {
        const existingCli = fs.existsSync(cliTokenPath)
          ? (() => {
              try {
                const st = fs.lstatSync(cliTokenPath);
                if (st.isSymbolicLink() || !st.isFile()) return null;
                return fs.readFileSync(cliTokenPath, 'utf8');
              } catch {
                return null;
              }
            })()
          : null;
        if (existingCli !== tokenPayload) {
          writeFileAtomic(cliTokenPath, tokenPayload, 0o600);
        }
      }
    }

    const realHome = getRealHomeDir(roots);
    const realGemini = getRealGeminiHomeDir(roots);

    for (const dirName of SHARED_GEMINI_SUBDIRS) {
      mirrorReadMostlyEntry(
        path.join(realGemini, dirName),
        path.join(cliGeminiDir, dirName),
        true,
        platform
      );
    }
    for (const fileName of SHARED_GEMINI_FILES) {
      mirrorReadMostlyEntry(
        path.join(realGemini, fileName),
        path.join(cliGeminiDir, fileName),
        false,
        platform
      );
    }

    for (const dotDir of SHARED_HOME_DOTDIRS) {
      if (platform !== 'win32' && platform !== 'darwin' && (dotDir === '.config' || dotDir === '.local')) {
        continue;
      }
      mirrorReadMostlyEntry(
        path.join(realHome, dotDir),
        path.join(cliHome, dotDir),
        true,
        platform
      );
    }
    for (const dotFile of SHARED_HOME_DOTFILES) {
      mirrorReadMostlyEntry(
        path.join(realHome, dotFile),
        path.join(cliHome, dotFile),
        false,
        platform
      );
    }
    if (platform !== 'win32' && platform !== 'darwin') {
      const xdgBase = path.join(cliHome, '.xdg');
      ensureRealDirectory(path.join(xdgBase, 'config'), 0o700);
      ensureRealDirectory(path.join(xdgBase, 'data'), 0o700);
      ensureRealDirectory(path.join(xdgBase, 'state'), 0o700);
    }
  }

  const pathOverride = resolveBinaryPathOverride('agy', platform, baseEnv, {
    arch: roots?.arch,
    realHomeDir: getRealHomeDir(roots),
    configuredExecutable: roots?.configuredExecutable,
    extensionPaths: roots?.extensionPaths
  });
  const env: Record<string, string | null> = {
    ...pathOverride,
    HOME: cliHome
  };

  if (platform === 'win32') {
    env.USERPROFILE = cliHome;
    env.WSL_DISTRO_NAME = 'Charlier';
  } else if (platform === 'darwin') {
    env.WSL_DISTRO_NAME = 'Charlier';
  } else {
    const xdgBase = path.join(cliHome, '.xdg');
    env.XDG_CONFIG_HOME = path.join(xdgBase, 'config');
    env.XDG_DATA_HOME = path.join(xdgBase, 'data');
    env.XDG_STATE_HOME = path.join(xdgBase, 'state');
    env.DBUS_SESSION_BUS_ADDRESS = null;
    env.GNOME_KEYRING_CONTROL = null;
  }

  return {
    homeDir: cliHome,
    env
  };
}

export function cleanupProfileCliHome(
  provider: IsolatedProviderId,
  profileId: string,
  roots?: CliIsolationRoots
): void {
  try {
    const cliHome = getProfileCliHomeDir(provider, profileId, roots);
    if (fs.existsSync(cliHome)) {
      fs.rmSync(cliHome, { recursive: true, force: true });
    }
  } catch {}
}
