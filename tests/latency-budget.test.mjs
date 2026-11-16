import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const nodeRequire = createRequire(import.meta.url);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function createLatencyHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-latency-e2e-'));
  const home = path.join(root, 'home');
  const appData = path.join(root, 'appdata');
  const localAppData = path.join(root, 'localappdata');
  const geminiDir = path.join(home, '.gemini');
  const codexDir = path.join(home, '.codex');
  const agyIdeDir = path.join(geminiDir, 'antigravity-ide');
  const agyUserGlobalStorage = path.join(appData, 'Antigravity', 'User', 'globalStorage');

  fs.mkdirSync(geminiDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(agyIdeDir, { recursive: true });
  fs.mkdirSync(agyUserGlobalStorage, { recursive: true });

  const oauthPath = path.join(geminiDir, 'oauth_creds.json');
  const stateDbPath = path.join(agyUserGlobalStorage, 'state.vscdb');
  fs.writeFileSync(
    oauthPath,
    JSON.stringify({ access_token: 'tok-old', refresh_token: 'ref-old', expiry_date: Date.now() + 3600_000 })
  );
  fs.writeFileSync(stateDbPath, 'placeholder');

  const prevEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CODEX_HOME = codexDir;
  process.env.APPDATA = appData;
  process.env.LOCALAPPDATA = localAppData;
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');

  let mockDaemonEmail = 'old@example.test';
  let slowQuotaDelayMs = 2500;
  let hangCommands = true;
  const shownToasts = [];
  const webviewMessages = [];

  const vscode = {
    StatusBarAlignment: { Right: 2 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class {
      value = '';
      appendMarkdown(v) { this.value += v; }
    },
    Uri: { parse: (u) => u },
    env: { appName: 'Antigravity', openExternal: async () => true },
    extensions: { getExtension: () => undefined },
    commands: {
      executeCommand: async () => {
        if (hangCommands) return new Promise(() => {});
        return undefined;
      }
    },
    workspace: { getConfiguration: () => ({ get: (_k, fallback) => fallback }) },
    window: {
      createStatusBarItem: () => ({
        text: '',
        color: undefined,
        backgroundColor: undefined,
        accessibilityInformation: undefined,
        tooltip: undefined,
        show() {},
        hide() {},
        dispose() {}
      }),
      showInputBox: async ({ value }) => value || 'Saved Profile',
      showWarningMessage: async (_msg, _opts, confirmBtn) => confirmBtn,
      showInformationMessage: async (msg, ...buttons) => {
        shownToasts.push({ at: Date.now(), msg, buttons });
        return undefined;
      },
      showErrorMessage: async () => undefined,
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
  const builtVault = await esbuild.build({
    entryPoints: ['src/vault.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
    logLevel: 'silent'
  });
  const builtQuota = await esbuild.build({
    entryPoints: ['src/quota.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
    logLevel: 'silent'
  });
  const builtWatcher = await esbuild.build({
    entryPoints: ['src/watcher.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
    logLevel: 'silent'
  });

  const osProxy = { ...os, homedir: () => home };
  const load = (code) => {
    const m = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', code)(
      (name) => (name === 'vscode' ? vscode : name === 'os' ? osProxy : nodeRequire(name)),
      m,
      m.exports,
      path.resolve('dist')
    );
    return m.exports;
  };

  const { UIController } = load(builtUi.outputFiles[0].text);
  const { Vault } = load(builtVault.outputFiles[0].text);
  const { QuotaService } = load(builtQuota.outputFiles[0].text);
  const { CredentialWatcher } = load(builtWatcher.outputFiles[0].text);

  const vault = new Vault({ read: () => null, readAsync: async () => null });
  // Wire deterministic live session backed by mockDaemonEmail + oauth_creds on disk
  let diskAgyEmail = 'old@example.test';
  vault.getLiveSessionInfoAsync = async () => ({
    email: fs.existsSync(oauthPath) ? diskAgyEmail : null,
    hasOAuthCreds: fs.existsSync(oauthPath),
    tokenExpiryDate: Date.now() + 3600_000,
    isExpired: false
  });
  vault.prepareNewLoginAsync = async () => {
    diskAgyEmail = null;
    try { fs.unlinkSync(oauthPath); } catch {}
    return { backedUpProfile: null, wasExisting: false };
  };

  const quotaService = new QuotaService();
  let cachedSummary = null;
  quotaService.getCachedSummary = () => cachedSummary;
  quotaService.invalidate = () => { cachedSummary = null; };
  quotaService.peekDaemonIdentityAsync = async () => {
    if (!mockDaemonEmail) return null;
    if ((quotaService).isLoggingOutPending?.()) {
      const lower = mockDaemonEmail.toLowerCase();
      if ((quotaService).loggingOutEmail === lower) {
        const fresh = fs.existsSync(oauthPath) && fs.statSync(oauthPath).mtimeMs >= (quotaService).loggingOutStartedAt;
        if (!fresh) return null;
      }
      (quotaService).clearLoggingOut?.();
    }
    return { email: mockDaemonEmail };
  };
  quotaService.getQuotaSummary = async () => {
    await wait(slowQuotaDelayMs);
    if (!mockDaemonEmail) return null;
    cachedSummary = { email: mockDaemonEmail, groups: [{ modelLabel: 'Gemini', remainingFraction: 0.9, remainingPercent: '90%' }], fetchedAt: Date.now() };
    return cachedSummary;
  };
  quotaService.buildAccountsHoverTooltip = () => 'agy-hover';

  let codexLive = { email: 'c1@example.test', accountId: 'acc-1', hasOAuthCreds: true, authMode: 'chatgpt' };
  const codexVault = {
    listProfiles: () => [{
      id: 'c1',
      provider: 'codex',
      name: 'C1',
      email: 'c1@example.test',
      accountId: 'acc-1',
      updatedAt: Date.now(),
      cachedQuota: { plan: 'PLUS', codex5h: '90%', codex7d: '80%', updatedAt: Date.now() }
    }],
    getLiveSessionInfo: () => codexLive,
    findMatchingProfile: (l) => (l?.email === 'c1@example.test' ? codexVault.listProfiles()[0] : null),
    saveCurrentAsProfile: (name) => ({ id: 'c-saved', provider: 'codex', name, email: codexLive.email, accountId: codexLive.accountId, updatedAt: Date.now() }),
    deleteProfile: () => true,
    updateProfileCachedQuota: () => {},
    invalidateLiveSessionCache: () => {}
  };
  const codexQuotaService = {
    getCachedMetric: () => ({ plan: 'PLUS', codex5h: '90%', codex7d: '80%', updatedAt: Date.now() }),
    getCachedSummary: () => null,
    invalidateCache: () => {},
    refreshAllProfiles: async () => 0,
    refreshProfileQuota: async () => { await wait(slowQuotaDelayMs); return null; },
    buildCodexHoverTooltip: () => 'codex-hover'
  };

  const controller = new UIController(vault, quotaService, codexVault, codexQuotaService);
  controller.attachSidebar({
    render: async (state) => {
      webviewMessages.push({ at: Date.now(), selectedProvider: state.selectedProvider, agyLive: state.antigravity.liveSession.email });
    }
  });

  const watcher = new CredentialWatcher(
    () => controller.scheduleUpdate(30, true),
    { shouldWatchIdeStorage: () => controller.isAwaitingNewLogin('antigravity') }
  );
  watcher.start();
  controller.attachWatcherMuter((ms) => watcher.muteFor(ms));
  controller.attachWatcherShortener((ms) => watcher.shortenMute(ms));

  return {
    root,
    oauthPath,
    stateDbPath,
    shownToasts,
    webviewMessages,
    controller,
    vault,
    quotaService,
    watcher,
    setMockSession: ({ daemonEmail, diskEmail }) => {
      mockDaemonEmail = daemonEmail;
      diskAgyEmail = diskEmail;
    },
    setSlowQuotaDelay: (ms) => { slowQuotaDelayMs = ms; },
    dispose: () => {
      watcher.dispose();
      controller.dispose();
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test('latency budget: handleAddAccount Antigravity settles fast under hung commands and detects new account in <600ms', async () => {
  const env = await createLatencyHarness();
  try {
    await env.controller.update(true);

    const addStart = Date.now();
    await env.controller.handleAddAccount('antigravity');
    const addElapsed = Date.now() - addStart;
    assert.ok(addElapsed < 650, `handleAddAccount took ${addElapsed}ms (expected <650ms even with hung logout command)`);

    // Simulate user finishing Google OAuth 150ms later while full daemon quota RPC is still slow (2500ms)
    await wait(150);
    const landedAt = Date.now();
    env.setMockSession({ daemonEmail: 'fresh-agy@example.test', diskEmail: 'fresh-agy@example.test' });
    fs.writeFileSync(
      env.oauthPath,
      JSON.stringify({ access_token: 'tok-new', refresh_token: 'ref-new', expiry_date: Date.now() + 3600_000 })
    );
    fs.appendFileSync(env.stateDbPath, '-wal');

    // Poll until New Antigravity account toast fires
    const deadline = landedAt + 900;
    while (Date.now() < deadline) {
      if (env.shownToasts.some((t) => t.msg.includes('fresh-agy@example.test'))) break;
      await wait(20);
    }

    const toast = env.shownToasts.find((t) => t.msg.includes('fresh-agy@example.test'));
    assert.ok(toast, 'expected New Antigravity account online toast to fire');
    const detectElapsed = toast.at - landedAt;
    assert.ok(detectElapsed < 600, `new account toast took ${detectElapsed}ms after creds landed (budget <600ms)`);
  } finally {
    env.dispose();
  }
});

test('same-email re-auth guard does not falsely trigger on stale daemon cache while disk creds are empty', async () => {
  const env = await createLatencyHarness();
  try {
    await env.controller.update(true);
    env.setMockSession({ daemonEmail: 'old@example.test', diskEmail: 'old@example.test' });
    await env.controller.handleAddAccount('antigravity');
    env.shownToasts.length = 0;

    // Simulate daemon still holding stale 'old@example.test' while disk creds remain absent (`diskEmail = null`)
    env.setMockSession({ daemonEmail: 'old@example.test', diskEmail: null });
    await wait(450);
    assert.equal(
      env.shownToasts.some((t) => t.msg.includes('old@example.test')),
      false,
      'must not fire new-account toast on pre-logout daemon cache while disk creds are cleared'
    );

    // Now write fresh creds for same email
    const landedAt = Date.now();
    env.setMockSession({ daemonEmail: 'old@example.test', diskEmail: 'old@example.test' });
    fs.writeFileSync(
      env.oauthPath,
      JSON.stringify({ access_token: 'tok-reauth', refresh_token: 'ref-reauth', expiry_date: Date.now() + 3600_000 })
    );

    const deadline = landedAt + 900;
    while (Date.now() < deadline) {
      if (env.shownToasts.some((t) => t.msg.includes('old@example.test'))) break;
      await wait(20);
    }
    assert.ok(
      env.shownToasts.some((t) => t.msg.includes('old@example.test')),
      'same-email fresh disk creds should detect cleanly once written'
    );
  } finally {
    env.dispose();
  }
});

test('latency budget: switchProvider (<25ms) and handleSaveCurrent / handleDelete (<50ms) never block behind slow daemon', async () => {
  const env = await createLatencyHarness();
  try {
    env.setSlowQuotaDelay(3000);
    await env.controller.update(true);

    const tSwitch = Date.now();
    await env.controller.switchProvider('codex');
    assert.ok(Date.now() - tSwitch < 25, 'switchProvider exceeded 25ms');

    const tSaveCodex = Date.now();
    await env.controller.handleSaveCurrent('codex');
    assert.ok(Date.now() - tSaveCodex < 50, 'Codex handleSaveCurrent blocked on background quota refresh');

    const tSaveAgy = Date.now();
    await env.controller.handleSaveCurrent('antigravity');
    assert.ok(Date.now() - tSaveAgy < 50, 'Antigravity handleSaveCurrent blocked on slow daemon');

    const profiles = env.vault.listProfiles();
    assert.ok(profiles.length >= 1);
    // Make the saved profile inactive (switch live session off it) before standby delete benchmark
    env.setMockSession({ daemonEmail: 'other@example.test', diskEmail: 'other@example.test' });
    env.vault.invalidateLiveSessionCache();
    env.vault.saveState({ activeProfileId: null });
    const tDel = Date.now();
    await env.controller.handleDelete(profiles[0].id, 'antigravity');
    assert.ok(Date.now() - tDel < 50, 'handleDelete blocked on slow daemon');
  } finally {
    env.dispose();
  }
});

test('CredentialWatcher shortenMute unmutes early and ignores selectedProviderByHost-only state writes', async () => {
  const builtWatcher = await esbuild.build({
    entryPoints: ['src/watcher.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
    logLevel: 'silent'
  });
  const mod = { exports: {} };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-watcher-e2e-'));
  const home = path.join(root, 'home');
  const gemini = path.join(home, '.gemini');
  const charlier = path.join(gemini, 'charlier');
  fs.mkdirSync(charlier, { recursive: true });
  fs.writeFileSync(
    path.join(charlier, 'state.json'),
    JSON.stringify({ selectedProvider: 'antigravity', activeProfileId: 'p1', activeCodexProfileId: 'c1', profiles: [] })
  );
  const osProxy = { ...os, homedir: () => home };
  new Function('require', 'module', 'exports', '__dirname', builtWatcher.outputFiles[0].text)(
    (name) => (name === 'vscode' ? {} : name === 'os' ? osProxy : nodeRequire(name)),
    mod,
    mod.exports,
    path.resolve('dist')
  );
  let extEvents = 0;
  const watcher = new mod.exports.CredentialWatcher(() => { extEvents++; });
  watcher.start();
  try {
    await wait(120);
    // Changing ONLY selectedProvider / selectedProviderByHost must NOT wake CredentialWatcher
    fs.writeFileSync(
      path.join(charlier, 'state.json'),
      JSON.stringify({
        selectedProvider: 'codex',
        selectedProviderByHost: { vscode: 'codex' },
        activeProfileId: 'p1',
        activeCodexProfileId: 'c1',
        profiles: []
      })
    );
    await wait(350);
    assert.equal(extEvents, 0, 'provider-flip state writes must not wake external change watcher');

    // Mute for 8000ms, shorten to 150ms, write oauth_creds -> must deliver quickly (<600ms)
    watcher.muteFor(8000);
    watcher.shortenMute(150);
    fs.writeFileSync(path.join(gemini, 'oauth_creds.json'), JSON.stringify({ access_token: 'fresh' }));
    await wait(550);
    assert.ok(extEvents >= 1, 'shortenMute(150) should allow credential event within <550ms');
  } finally {
    watcher.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
