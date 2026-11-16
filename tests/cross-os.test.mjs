import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const nodeRequire = createRequire(import.meta.url);

const builtCli = await esbuild.build({
  entryPoints: ['src/cli-isolation.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  write: false,
  logLevel: 'silent'
});
const cliMod = { exports: {} };
new Function('require', 'module', 'exports', '__dirname', builtCli.outputFiles[0].text)(
  (name) => (name === 'vscode' ? {} : nodeRequire(name)),
  cliMod,
  cliMod.exports,
  path.resolve('dist')
);

const {
  resolveCliBinary,
  prepareAntigravityCliHome
} = cliMod.exports;

test('resolveCliBinary discovers newest extension bundle, ~/.gemini/bin/agy, nvm descending semver, config override, and blocks directories / non-exec POSIX files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-crossos-cli-'));
  try {
    // 1. Windows extension-bundled codex.exe (picks newest semver when multiple versions exist)
    const winHome = path.join(root, 'win-home');
    const oldWinExt = path.join(winHome, '.vscode', 'extensions', 'openai.chatgpt-26.0.1-win32-x64', 'bin', 'windows-x86_64');
    const newWinExt = path.join(winHome, '.vscode', 'extensions', 'openai.chatgpt-26.1111.21308-win32-x64', 'bin', 'windows-x86_64');
    const agyWinDir = path.join(winHome, '.gemini', 'bin');
    fs.mkdirSync(oldWinExt, { recursive: true });
    fs.mkdirSync(newWinExt, { recursive: true });
    fs.mkdirSync(agyWinDir, { recursive: true });
    fs.writeFileSync(path.join(oldWinExt, 'codex.exe'), 'old');
    const newWinCodex = path.join(newWinExt, 'codex.exe');
    fs.writeFileSync(newWinCodex, 'new');
    const winAgy = path.join(agyWinDir, 'agy.exe');
    fs.writeFileSync(winAgy, 'agy');

    const resWinCodex = resolveCliBinary('codex', {
      platform: 'win32',
      arch: 'x64',
      realHomeDir: winHome,
      env: { Path: 'C:\\Windows\\System32' }
    });
    assert.ok(resWinCodex);
    assert.equal(resWinCodex.executablePath, newWinCodex);
    assert.equal(resWinCodex.source, 'extension');
    assert.ok(resWinCodex.pathOverride.Path.startsWith(newWinExt + ';'), 'must preserve Path key casing on Windows');

    const resWinAgy = resolveCliBinary('agy', {
      platform: 'win32',
      arch: 'x64',
      realHomeDir: winHome,
      env: { PATH: '' }
    });
    assert.ok(resWinAgy);
    assert.equal(resWinAgy.executablePath, winAgy);
    assert.equal(resWinAgy.source, 'standard');

    // 2. macOS arm64 bundle + explicit config override
    const macHome = path.join(root, 'mac-home');
    const macExtDir = path.join(macHome, '.vscode', 'extensions', 'openai.chatgpt-26.5.0-darwin-arm64');
    const macBinDir = path.join(macExtDir, 'bin', 'aarch64-apple-darwin');
    const macCustomBin = path.join(root, 'custom-codex');
    fs.mkdirSync(macBinDir, { recursive: true });
    fs.writeFileSync(path.join(macBinDir, 'codex'), 'mac-bin', { mode: 0o755 });
    fs.writeFileSync(macCustomBin, 'custom', { mode: 0o755 });

    const resMacExt = resolveCliBinary('codex', {
      platform: 'darwin',
      arch: 'arm64',
      realHomeDir: macHome,
      env: { PATH: '/usr/bin:/bin' },
      extensionPaths: [macExtDir]
    });
    assert.ok(resMacExt);
    assert.equal(resMacExt.executablePath, path.join(macBinDir, 'codex'));
    assert.equal(resMacExt.source, 'extension');

    const resConfig = resolveCliBinary('codex', {
      platform: 'darwin',
      arch: 'arm64',
      realHomeDir: macHome,
      env: { PATH: '/usr/bin:/bin' },
      configuredExecutable: macCustomBin
    });
    assert.equal(resConfig?.executablePath, macCustomBin);
    assert.equal(resConfig?.source, 'config');

    // 3. Linux: ignores a directory named `codex` (& skips non-exec 0o644 on POSIX hosts); picks highest NVM version
    const linHome = path.join(root, 'lin-home');
    const dirCollision = path.join(root, 'lin-path-dir');
    const nonExecDir = path.join(root, 'lin-nonexec-dir');
    const nvm20 = path.join(linHome, '.nvm', 'versions', 'node', 'v20.18.0', 'bin');
    const nvm22 = path.join(linHome, '.nvm', 'versions', 'node', 'v22.12.0', 'bin');
    fs.mkdirSync(path.join(dirCollision, 'codex'), { recursive: true });
    fs.mkdirSync(nonExecDir, { recursive: true });
    fs.mkdirSync(nvm20, { recursive: true });
    fs.mkdirSync(nvm22, { recursive: true });
    if (process.platform !== 'win32') {
      fs.writeFileSync(path.join(nonExecDir, 'codex'), 'no-x', { mode: 0o644 });
    }
    fs.writeFileSync(path.join(nvm20, 'codex'), 'v20', { mode: 0o755 });
    const v22Codex = path.join(nvm22, 'codex');
    fs.writeFileSync(v22Codex, 'v22', { mode: 0o755 });

    const resLin = resolveCliBinary('codex', {
      platform: 'linux',
      arch: 'x64',
      realHomeDir: linHome,
      env: { PATH: `${dirCollision}:${nonExecDir}` }
    });
    assert.ok(resLin);
    assert.equal(resLin.executablePath, v22Codex);
    assert.equal(resLin.source, 'standard');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepareAntigravityCliHome refreshes stale copied dotfiles and replaces dangling symlinks atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-dotfile-sync-'));
  try {
    const realHome = path.join(root, 'real-home');
    const realGemini = path.join(realHome, '.gemini');
    const charlierDir = path.join(realGemini, 'charlier');
    const profilesDir = path.join(charlierDir, 'profiles');
    const profDir = path.join(profilesDir, 'a1');
    fs.mkdirSync(profDir, { recursive: true });
    fs.writeFileSync(
      path.join(profDir, 'oauth_creds.json'),
      JSON.stringify({ access_token: 'tok', refresh_token: 'ref' })
    );
    const realProjects = path.join(realGemini, 'projects.json');
    fs.writeFileSync(realProjects, JSON.stringify({ projects: { one: 1 } }));

    const roots = { realHomeDir: realHome, realGeminiHomeDir: realGemini, charlierDir, profilesDir };
    const first = prepareAntigravityCliHome('a1', roots);
    const isoGemini = path.join(first.homeDir, '.gemini');
    const isoProjects = path.join(isoGemini, 'projects.json');
    assert.match(fs.readFileSync(isoProjects, 'utf8'), /"one"/);

    // Modify source projects.json with a newer mtime and different content -> next prepare must refresh copy
    const older = new Date(Date.now() - 10_000);
    try { fs.utimesSync(isoProjects, older, older); } catch {}
    fs.writeFileSync(realProjects, JSON.stringify({ projects: { one: 1, two: 2 } }));
    const nowPlus = new Date(Date.now() + 2000);
    fs.utimesSync(realProjects, nowPlus, nowPlus);

    prepareAntigravityCliHome('a1', roots);
    assert.match(fs.readFileSync(isoProjects, 'utf8'), /"two"/, 'stale copied dotfile should refresh when source mtime/size changes');

    // Replace target oauth_creds.json with a dangling symlink if supported -> writeFileAtomic must unlink safely without throwing
    const isoCreds = path.join(isoGemini, 'oauth_creds.json');
    try {
      fs.unlinkSync(isoCreds);
      fs.symlinkSync(path.join(root, 'nonexistent-target'), isoCreds);
    } catch {}
    prepareAntigravityCliHome('a1', roots);
    assert.ok(fs.existsSync(isoCreds));
    assert.equal(fs.lstatSync(isoCreds).isSymbolicLink(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('UIController.handleSwitch cliOnly shows actionable error modal, skips createTerminal, and stays retryable when codex/agy CLI is missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-missing-cli-'));
  const fakeHome = path.join(root, 'empty-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const prevEnv = { ...process.env };
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.CODEX_HOME = path.join(fakeHome, '.codex');
  process.env.APPDATA = path.join(root, 'empty-appdata');
  process.env.LOCALAPPDATA = path.join(root, 'empty-localappdata');
  process.env[pathKey] = root;
  delete process.env.NVM_SYMLINK;

  const createdTerminals = [];
  const errorsShown = [];
  const vscode = {
    StatusBarAlignment: { Right: 2 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { value = ''; appendMarkdown(v) { this.value += v; } },
    Uri: { parse: (u) => u },
    env: { appName: 'Antigravity', openExternal: async () => true },
    extensions: { getExtension: () => undefined },
    commands: { executeCommand: async () => undefined },
    workspace: { getConfiguration: () => ({ get: (_k, fallback) => fallback }) },
    window: {
      terminals: createdTerminals,
      createStatusBarItem: () => ({
        text: '', color: undefined, backgroundColor: undefined,
        accessibilityInformation: undefined, tooltip: undefined,
        show() {}, hide() {}, dispose() {}
      }),
      createTerminal: (opts) => {
        const t = { opts, show() {}, sendText() {} };
        createdTerminals.push(t);
        return t;
      },
      showErrorMessage: async (msg, opts, ...actions) => {
        errorsShown.push({ msg, opts, actions });
        return undefined;
      },
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      setStatusBarMessage: () => ({ dispose() {} })
    }
  };

  const builtUi = await esbuild.build({
    entryPoints: ['src/ui.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
    logLevel: 'silent'
  });
  const mod = { exports: {} };
  const osProxy = { ...os, homedir: () => fakeHome };
  new Function('require', 'module', 'exports', '__dirname', builtUi.outputFiles[0].text)(
    (name) => (name === 'vscode' ? vscode : name === 'os' ? osProxy : nodeRequire(name)),
    mod,
    mod.exports,
    path.resolve('dist')
  );

  // Only inspect missing-binary behavior when no global system binary exists outside mocked dirs
  const codexProbe = resolveCliBinary('codex', { realHomeDir: fakeHome, env: { [pathKey]: root } });
  const agyProbe = resolveCliBinary('agy', { realHomeDir: fakeHome, env: { [pathKey]: root } });

  const controller = new mod.exports.UIController(
    {
      getState: () => ({ selectedProvider: 'codex', activeProfileId: 'a1', activeCodexProfileId: 'c1' }),
      setActiveCodexProfileId: () => {},
      saveState: () => {},
      listProfiles: () => [{ id: 'a2', name: 'Agy CLI', email: 'a2@example.test', cachedQuota: { updatedAt: Date.now() } }],
      getLiveSessionInfoAsync: async () => ({ email: 'a1@example.test', hasOAuthCreds: true, isExpired: false }),
      autoSaveUnsavedActiveSessionAsync: async () => null
    },
    { getCachedSummary: () => null, refreshInactiveProfile: async () => null, invalidate: () => {}, buildAccountsHoverTooltip: () => '' },
    {
      listProfiles: () => [{ id: 'c2', name: 'Codex CLI', email: 'c2@example.test', cachedQuota: { updatedAt: Date.now() } }],
      getLiveSessionInfo: () => ({ email: 'c1@example.test', hasOAuthCreds: true }),
      findMatchingProfile: () => null,
      autoSaveUnsavedActiveSession: () => null
    },
    { getCachedMetric: () => null, invalidateCache: () => {}, refreshProfileQuota: async () => null, buildCodexHoverTooltip: () => '' }
  );
  controller.update = async () => {};

  try {
    if (!codexProbe) {
      await controller.handleSwitch('c2', 'codex', true);
      assert.equal(createdTerminals.length, 0, 'missing codex CLI must NOT spawn an empty broken terminal');
      assert.equal(controller.getClaimedProfileIds('codex').size, 0, 'missing codex CLI must NOT leave a phantom claim');
      assert.equal(errorsShown.length, 1);
      assert.equal(errorsShown[0].opts?.modal, true);
      assert.ok(errorsShown[0].actions.includes('Install Codex CLI'));
    }

    if (!agyProbe) {
      await controller.handleSwitch('a2', 'antigravity', true);
      assert.equal(createdTerminals.length, 0, 'missing agy CLI must NOT spawn an empty broken terminal');
      assert.equal(controller.getClaimedProfileIds('antigravity').size, 0);
      assert.ok(errorsShown.some((e) => e.actions.includes('Install agy CLI')));
    }

    // Now place valid executables inside root (on PATH) and retry -> must succeed immediately!
    for (const binName of process.platform === 'win32' ? ['codex.exe', 'agy.exe'] : ['codex', 'agy']) {
      fs.writeFileSync(path.join(root, binName), 'echo ok\n', { mode: 0o755 });
    }
    await controller.handleSwitch('c2', 'codex', true);
    await controller.handleSwitch('a2', 'antigravity', true);
    assert.equal(controller.getClaimedProfileIds('codex').has('c2'), true);
    assert.equal(controller.getClaimedProfileIds('antigravity').has('a2'), true);

    // Leading ~/ in chatgpt.cliExecutable must expand cleanly against home dir
    const binDir = path.join(fakeHome, 'custom-bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binFile = path.join(binDir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    fs.writeFileSync(binFile, 'echo ok\n', { mode: 0o755 });
    const tildeRes = resolveCliBinary('codex', {
      realHomeDir: fakeHome,
      configuredExecutable: `~/custom-bin/${path.basename(binFile)}`,
      env: { [pathKey]: '' }
    });
    assert.ok(tildeRes);
    assert.equal(tildeRes.source, 'config');
    assert.equal(tildeRes.executablePath, binFile);
  } finally {
    controller.dispose();
    for (const k of Object.keys(process.env)) {
      if (!(k in prevEnv)) delete process.env[k];
    }
    Object.assign(process.env, prevEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
