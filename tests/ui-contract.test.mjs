import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as esbuild from 'esbuild';

const nodeRequire = createRequire(import.meta.url);
const createdStatusItems = [];
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
  commands: { executeCommand: async () => undefined },
  window: {
    createStatusBarItem: (_align, priority) => {
      const item = {
        priority,
        text: '',
        color: undefined,
        backgroundColor: undefined,
        accessibilityInformation: undefined,
        tooltip: undefined,
        showCalls: 0,
        hideCalls: 0,
        show() { this.showCalls++; },
        hide() { this.hideCalls++; },
        dispose() {}
      };
      createdStatusItems.push(item);
      return item;
    },
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined
  },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) }
};
const built = await esbuild.build({
  entryPoints: ['src/ui.ts'], bundle: true, platform: 'node', format: 'cjs',
  external: ['vscode'], write: false, logLevel: 'silent'
});
const module = { exports: {} };
new Function('require', 'module', 'exports', '__dirname', built.outputFiles[0].text)(
  name => name === 'vscode' ? vscode : nodeRequire(name), module, module.exports, path.resolve('dist')
);
const { UIController } = module.exports;
const live = { email: 'active@example.test', hasOAuthCreds: true, isExpired: false };
const profile = { id: 'active', name: 'Active', email: live.email, cachedQuota: { plan: 'PRO', gemini: '42%', updatedAt: Date.now() } };

test('active Antigravity refresh uses daemon and inactive refresh stays account-local', async () => {
  const calls = [];
  const vault = {
    getState: () => ({ selectedProvider: 'antigravity' }),
    getProfile: id => ({ id, email: id === 'active' ? live.email : 'other@example.test' }),
    getLiveSessionInfoAsync: async () => live
  };
  const quota = {
    getQuotaSummary: async force => calls.push(['daemon', force]),
    refreshInactiveProfile: async (p, _vault, force) => calls.push(['inactive', p.id, force])
  };
  const controller = new UIController(vault, quota, {}, {});
  controller.update = async () => {};
  const actions = controller.getSidebarCallbacks();
  await actions.onRefreshSingle('antigravity', 'active');
  await actions.onRefreshSingle('antigravity', 'other');
  assert.deepEqual(calls, [['daemon', true], ['inactive', 'other', true]]);
  vault.getLiveSessionInfoAsync = async () => ({ email: null, hasOAuthCreds: true });
  vault.getState = () => ({ selectedProvider: 'antigravity', activeProfileId: 'active' });
  await actions.onRefreshSingle('antigravity', 'active');
  assert.deepEqual(calls.at(-1), ['daemon', true]);
});

test('unified Antigravity status bar pill colors by tier-aware average and surfaces RE-AUTH or depletion cleanly', () => {
  const controller = new UIController({ getState: () => ({ selectedProvider: 'antigravity' }) }, {
    buildAccountsHoverTooltip: () => 'hover'
  }, {}, {});
  const summary = { planTier: 'FREE', email: 'active@example.test', groups: [{ displayName: 'Claude', buckets: [{ remainingFraction: 1 }] }] };
  controller.updateAntigravityStatusBar([profile], profile, live, true, summary, false, true);
  assert.equal(controller.statusBarItem.text, '$(charlier-antigravity-star) Active');
  assert.equal(controller.statusBarItem.color.id, 'charlier.antigravityAccent');
  assert.equal(controller.statusBarItem.backgroundColor, undefined);
  assert.doesNotMatch(controller.statusBarItem.text, /100%/);

  summary.groups = [{ displayName: 'Gemini', buckets: [{ remainingFraction: 0 }] }];
  controller.updateAntigravityStatusBar([profile], profile, live, true, summary, false, true);
  assert.equal(controller.statusBarItem.text, '$(charlier-antigravity-star) Active · G 0%');
  assert.equal(controller.statusBarItem.backgroundColor.id, 'statusBarItem.errorBackground');
  assert.equal(controller.statusBarItem.color, undefined);
  assert.match(controller.statusBarItem.accessibilityInformation.label, /depleted/);

  const proProf = { ...profile, cachedQuota: { plan: 'PRO', gemini: '75%', claudeGpt: '50%', argon: '6%', updatedAt: Date.now() } };
  controller.updateAntigravityStatusBar([proProf], proProf, live, true, null, false, true);
  assert.equal(controller.statusBarItem.text, '$(charlier-antigravity-star) Active · G 75% · C 50% · A 6%');
  assert.equal(controller.statusBarItem.color.id, 'charlier.quotaWarn');

  const critProf = { ...profile, cachedQuota: { plan: 'PRO', gemini: '12%', claudeGpt: '10%', argon: '8%', updatedAt: Date.now() } };
  controller.updateAntigravityStatusBar([critProf], critProf, live, true, null, false, true);
  assert.equal(controller.statusBarItem.color.id, 'charlier.quotaCritical');
});

test('mismatched Antigravity quota cannot reach the hero or profile cache', async () => {
  let cached = false;
  let rendered;
  const vault = {
    getState: () => ({ selectedProvider: 'antigravity', activeProfileId: profile.id }),
    listProfiles: () => [profile], getLiveSessionInfoAsync: async () => ({ ...live }),
    updateProfileCachedQuota: () => { cached = true; }
  };
  const quota = {
    getQuotaSummary: async () => ({ email: 'different@example.test', planTier: 'PRO', groups: [{ displayName: 'Gemini', buckets: [{ remainingFraction: 1 }] }] }),
    parseMetrics: () => { throw new Error('must not parse another account quota'); },
    buildAccountsHoverTooltip: () => 'hover'
  };
  const codexVault = {
    listProfiles: () => [], getLiveSessionInfo: () => ({ email: null, hasOAuthCreds: false }), findMatchingProfile: () => null
  };
  const controller = new UIController(vault, quota, codexVault, {});
  controller.attachSidebar({ render: state => { rendered = state; } });
  await controller.update();
  assert.equal(cached, false);
  assert.equal(rendered.antigravity.liveMetrics, null);
  assert.doesNotMatch(controller.statusBarItem.text, /100%/);
});

test('failed stale Antigravity refresh does not create a render loop', async () => {
  let attempts = 0;
  const stale = { ...profile, id: 'other', email: 'other@example.test', cachedQuota: undefined };
  const vault = {
    getState: () => ({ selectedProvider: 'antigravity', activeProfileId: profile.id }),
    listProfiles: () => [profile, stale], getLiveSessionInfoAsync: async () => ({ ...live })
  };
  const quota = {
    getQuotaSummary: async () => null,
    refreshAllInactiveProfiles: async () => { attempts++; },
    buildAccountsHoverTooltip: () => 'hover'
  };
  const codexVault = {
    listProfiles: () => [], getLiveSessionInfo: () => ({ email: null, hasOAuthCreds: false }), findMatchingProfile: () => null
  };
  const controller = new UIController(vault, quota, codexVault, {});
  await controller.update();
  await new Promise(resolve => setImmediate(resolve));
  await controller.update();
  assert.equal(attempts, 1);
});

test('provider flip repaints the cached frame instantly without waiting on the daemon', async () => {
  const renders = [];
  const vault = {
    getState: () => ({ selectedProvider: 'antigravity', activeProfileId: profile.id }),
    listProfiles: () => [profile], getLiveSessionInfoAsync: async () => ({ ...live }),
    updateProfileCachedQuota: () => {}, setSelectedProvider: () => {}, saveState: () => {}
  };
  const quota = {
    getQuotaSummary: async () => null, getCachedSummary: () => null,
    buildAccountsHoverTooltip: () => 'hover', refreshAllInactiveProfiles: async () => {}
  };
  const codexVault = {
    listProfiles: () => [], getLiveSessionInfo: () => ({ email: null, hasOAuthCreds: false }), findMatchingProfile: () => null
  };
  const codexQuota = { buildCodexHoverTooltip: () => 'codex-hover' };
  const controller = new UIController(vault, quota, codexVault, codexQuota);
  controller.attachSidebar({ render: state => renders.push(state.selectedProvider) });
  await controller.update();
  quota.getQuotaSummary = () => new Promise(() => {});
  const started = Date.now();
  await controller.switchProvider('codex');
  assert.ok(Date.now() - started < 100);
  assert.equal(renders.at(-1), 'codex');
});

test('scheduleUpdate coalesces bursts into one render', async () => {
  let renders = 0;
  const vault = {
    getState: () => ({ selectedProvider: 'antigravity', activeProfileId: profile.id }),
    listProfiles: () => [profile], getLiveSessionInfoAsync: async () => ({ ...live }),
    updateProfileCachedQuota: () => {}
  };
  const quota = { getQuotaSummary: async () => null, getCachedSummary: () => null, buildAccountsHoverTooltip: () => 'hover', refreshAllInactiveProfiles: async () => {} };
  const codexVault = { listProfiles: () => [], getLiveSessionInfo: () => ({ email: null, hasOAuthCreds: false }), findMatchingProfile: () => null };
  const controller = new UIController(vault, quota, codexVault, {});
  controller.attachSidebar({ render: () => { renders++; } });
  for (let i = 0; i < 6; i++) controller.scheduleUpdate(30);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(renders, 1);
});

test('a full update scheduled together with a fast one is never downgraded', async () => {
  const modes = [];
  const controller = new UIController({ getState: () => ({ selectedProvider: 'antigravity' }) }, {}, {}, {});
  controller.update = async fast => { modes.push(fast); };
  controller.scheduleUpdate(20, false);
  controller.scheduleUpdate(20, true);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(modes, [false]);
  controller.scheduleUpdate(20, true);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(modes, [false, true]);
});

test('CLI Only staging keeps the IDE profile pinned in the hero', async () => {
  const ide = { ...profile, id: 'ide', email: 'ide@example.test', name: 'Ide' };
  const staged = { ...profile, id: 'staged', email: 'staged@example.test', name: 'Staged' };
  let rendered;
  const vault = {
    getState: () => ({ selectedProvider: 'antigravity', activeProfileId: 'ide' }),
    listProfiles: () => [ide, staged],
    getLiveSessionInfoAsync: async () => ({ email: 'staged@example.test', hasOAuthCreds: true, isExpired: false }),
    updateProfileCachedQuota: () => {}, saveState: () => { throw new Error('pin must not be overwritten'); }
  };
  const quota = { getQuotaSummary: async () => null, getCachedSummary: () => null, buildAccountsHoverTooltip: () => 'hover', refreshAllInactiveProfiles: async () => {} };
  const codexVault = { listProfiles: () => [], getLiveSessionInfo: () => ({ email: null, hasOAuthCreds: false }), findMatchingProfile: () => null };
  const controller = new UIController(vault, quota, codexVault, {});
  controller.cliAntigravityProfileId = 'staged';
  controller.attachSidebar({ render: state => { rendered = state; } });
  await controller.update(true);
  assert.equal(rendered.antigravity.activeProfileId, 'ide');
  assert.equal(rendered.antigravity.cliProfileId, 'staged');
});

test('unified status bar pill colors Codex meters by threshold, highlights RE-AUTH, and skips duplicate writes', () => {
  const controller = new UIController(
    { getState: () => ({ selectedProvider: 'codex' }) },
    { buildAccountsHoverTooltip: () => 'agy-hover' },
    {},
    { buildCodexHoverTooltip: () => 'codex-hover' }
  );
  const baseProf = {
    id: 'c1',
    name: 'Codex Main',
    email: 'codex@example.test',
    authStatus: 'ok'
  };
  const metric = (p5h, p7d) => ({
    plan: 'PLUS',
    gemini: '--',
    claudeGpt: '--',
    argon: '--',
    codex5h: p5h,
    codex7d: p7d,
    updatedAt: Date.now()
  });

  controller.updateCodexStatusBar([baseProf], baseProf, live, true, false, metric('80%', '90%'), true);
  assert.equal(controller.statusBarItem.text, '$(charlier-codex-prompt) Codex Main · 5h 80% · 7d 90%');
  assert.equal(controller.statusBarItem.color.id, 'charlier.codexAccent');
  assert.equal(controller.statusBarItem.backgroundColor, undefined);

  let textWrites = 0;
  let currentText = controller.statusBarItem.text;
  Object.defineProperty(controller.statusBarItem, 'text', {
    get: () => currentText,
    set: (v) => { textWrites++; currentText = v; },
    configurable: true
  });
  controller.updateCodexStatusBar([baseProf], baseProf, live, true, false, metric('80%', '90%'), true);
  assert.equal(textWrites, 0);

  controller.updateCodexStatusBar([baseProf], baseProf, live, true, false, metric('35%', '90%'), true);
  assert.equal(controller.statusBarItem.color.id, 'charlier.quotaWarn');
  controller.updateCodexStatusBar([baseProf], baseProf, live, true, false, metric('12%', '90%'), true);
  assert.equal(controller.statusBarItem.color.id, 'charlier.quotaCritical');
  controller.updateCodexStatusBar([baseProf], baseProf, live, true, false, metric('0%', '90%'), true);
  assert.equal(controller.statusBarItem.backgroundColor.id, 'statusBarItem.errorBackground');
  assert.equal(controller.statusBarItem.color, undefined);

  const revokedProf = { ...baseProf, authStatus: 'revoked', authErrorCode: 'token_revoked' };
  controller.updateCodexStatusBar([revokedProf], revokedProf, live, true, false, null, false);
  assert.equal(controller.statusBarItem.text, '$(charlier-codex-prompt) Codex Main · $(warning) RE-AUTH (stale)');
  assert.equal(controller.statusBarItem.backgroundColor.id, 'statusBarItem.errorBackground');
  assert.equal(controller.statusBarItem.color, undefined);
});

test('handleFocusSignal respects manual pins, autoSwitchProvider setting, and installed extensions', async () => {
  const prevGetExtension = vscode.extensions.getExtension;
  const prevGetConfig = vscode.workspace.getConfiguration;
  let autoMode = 'auto';
  let codexInstalled = true;
  vscode.workspace.getConfiguration = () => ({
    get: (key, fallback) => (key === 'autoSwitchProvider' ? autoMode : fallback)
  });
  vscode.extensions.getExtension = (id) =>
    codexInstalled && id === 'openai.chatgpt' ? { id } : undefined;
  try {
    const controller = new UIController(
      { getState: () => ({ selectedProvider: 'antigravity', activeProfileId: profile.id }), listProfiles: () => [profile], getLiveSessionInfoAsync: async () => ({ ...live }), updateProfileCachedQuota: () => {}, setSelectedProvider: () => {}, saveState: () => {} },
      { getQuotaSummary: async () => null, getCachedSummary: () => null, buildAccountsHoverTooltip: () => 'hover', refreshAllInactiveProfiles: async () => {} },
      { listProfiles: () => [], getLiveSessionInfo: () => ({ email: null, hasOAuthCreds: false }), findMatchingProfile: () => null },
      { buildCodexHoverTooltip: () => 'codex-hover' }
    );
    await controller.update(true);

    controller.handleFocusSignal('codex', 'editor');
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(controller.getSelectedProvider(), 'codex');

    await controller.switchProvider('antigravity', { manual: true });
    controller.handleFocusSignal('codex', 'editor');
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(controller.getSelectedProvider(), 'antigravity');

    controller.manualProviderPinUntil = 0;
    autoMode = 'off';
    controller.handleFocusSignal('codex', 'editor');
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(controller.getSelectedProvider(), 'antigravity');

    autoMode = 'auto';
    codexInstalled = false;
    controller.handleFocusSignal('codex', 'editor');
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(controller.getSelectedProvider(), 'antigravity');

    controller.handleFocusSignal('codex', 'terminal');
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(controller.getSelectedProvider(), 'codex');
    controller.dispose();
  } finally {
    vscode.extensions.getExtension = prevGetExtension;
    vscode.workspace.getConfiguration = prevGetConfig;
  }
});

test('pre-switch RE-AUTH guard prompts on normal switch and confirms CLI Only on revoked profile', async () => {
  const prevWarn = vscode.window.showWarningMessage;
  const prevMsg = vscode.window.setStatusBarMessage;
  const prevInfo = vscode.window.showInformationMessage;
  const prevErr = vscode.window.showErrorMessage;
  const prevCreateTerm = vscode.window.createTerminal;
  const prevTerminals = vscode.window.terminals;
  const prevCommands = vscode.commands;
  let errorSeen = null;
  const createdTerms = [];
  vscode.window.terminals = createdTerms;
  vscode.window.createTerminal = (opts) => {
    const t = { name: opts?.name || String(opts), show() {}, sendText() {} };
    createdTerms.push(t);
    return t;
  };
  vscode.window.setStatusBarMessage = () => ({ dispose() {} });
  vscode.window.showInformationMessage = async () => undefined;
  vscode.window.showErrorMessage = async (msg) => { errorSeen = msg; };
  vscode.commands = { executeCommand: async () => undefined };
  let warnCalls = 0;
  let warnAnswer = 'Switch & Start Re-Login';
  vscode.window.showWarningMessage = async () => { warnCalls++; return warnAnswer; };

  try {
    let switchCount = 0;
    let prepareCalls = 0;
    const hotSwapModes = [];
    const revokedProfile = {
      id: 'bad',
      name: 'Revoked',
      email: 'bad@example.test',
      authStatus: 'revoked',
      authErrorCode: 'token_revoked'
    };
    const codexVault = {
      listProfiles: () => [revokedProfile],
      getLiveSessionInfo: () => ({ email: null, hasOAuthCreds: false }),
      findMatchingProfile: () => null,
      autoSaveUnsavedActiveSession: () => null,
      prepareNewLoginAsync: async () => { prepareCalls++; },
      switchProfile: async () => { switchCount++; return revokedProfile; }
    };
    const controller = new UIController(
      {
        getState: () => ({ selectedProvider: 'codex' }),
        listProfiles: () => [],
        getLiveSessionInfoAsync: async () => ({ email: null, hasOAuthCreds: false }),
        setActiveCodexProfileId: () => {},
        saveState: () => {}
      },
      { buildAccountsHoverTooltip: () => 'hover' },
      codexVault,
      {
        buildCodexHoverTooltip: () => 'codex-hover',
        primeActiveAccountKey: () => {},
        invalidateCache: () => {},
        markLoggingOut: () => {},
        getCachedMetric: () => null,
        refreshProfileQuota: async () => null,
        hotSwapCodexAppServer: async (mode) => { hotSwapModes.push(mode); return 'swapped'; }
      }
    );
    controller.update = async () => {};

    await controller.handleSwitch('bad', 'codex', false);
    assert.equal(errorSeen, null);
    assert.equal(warnCalls, 1);
    assert.equal(prepareCalls, 1);
    assert.deepEqual(hotSwapModes, [null]);
    assert.equal(switchCount, 0);
    assert.equal(controller.pendingReauthTarget?.profileId, 'bad');

    // Dismissing the CLI Only RE-AUTH confirmation cancels without spawning a terminal
    warnAnswer = undefined;
    await controller.handleSwitch('bad', 'codex', true);
    assert.equal(errorSeen, null);
    assert.equal(warnCalls, 2);
    assert.equal(createdTerms.length, 0);
    assert.equal(switchCount, 0);

    // Confirming 'Launch CLI Anyway' spawns isolated terminal without touching global IDE profile
    warnAnswer = 'Launch CLI Anyway';
    await controller.handleSwitch('bad', 'codex', true);
    assert.equal(errorSeen, null);
    assert.equal(warnCalls, 3);
    assert.equal(createdTerms.length, 1);
    assert.equal(switchCount, 0);

    // Release CLI claim so normal IDE switch reaches the RE-AUTH modal
    controller.handleTerminalClosed(createdTerms[0]);

    warnAnswer = 'Switch Only (Manual Login)';
    await controller.handleSwitch('bad', 'codex', false);
    assert.equal(errorSeen, null);
    assert.equal(warnCalls, 4);
    assert.equal(switchCount, 1);
    assert.equal(controller.pendingReauthTarget?.profileId, 'bad');
    controller.dispose();
  } finally {
    vscode.window.showWarningMessage = prevWarn;
    vscode.window.setStatusBarMessage = prevMsg;
    vscode.window.showInformationMessage = prevInfo;
    vscode.window.showErrorMessage = prevErr;
    vscode.window.createTerminal = prevCreateTerm;
    vscode.window.terminals = prevTerminals;
    vscode.commands = prevCommands;
  }
});

test('Codex updates do not wait on a hung Antigravity daemon', async () => {
  const controller = new UIController(
    { getState: () => ({ selectedProvider: 'codex' }), listProfiles: () => [], getLiveSessionInfoAsync: async () => ({ email: null, hasOAuthCreds: false }) },
    {
      getQuotaSummary: () => new Promise(() => {}),
      buildAccountsHoverTooltip: () => 'agy-hover'
    },
    { listProfiles: () => [], getLiveSessionInfo: () => ({ email: null, hasOAuthCreds: false }), findMatchingProfile: () => null },
    { buildCodexHoverTooltip: () => 'codex-hover' }
  );
  const started = Date.now();
  await controller.update(false);
  assert.ok(Date.now() - started < 100);
  controller.dispose();
});

test('RE-AUTH recovery clears authStatus on live daemon success and forces live Codex probe even with fresh timestamp', async () => {
  const healthUpdates = [];
  let syncedId = null;
  let forceFlagSeen = null;
  const revokedAgy = { ...profile, id: 'agy-1', email: 'active@example.test', authStatus: 'revoked', authErrorCode: 'invalid_grant' };
  const revokedCodex = {
    id: 'codex-1',
    name: 'Codex Revoked',
    email: 'codex@example.test',
    authStatus: 'revoked',
    authErrorCode: 'token_revoked',
    cachedQuota: { plan: 'PRO', gemini: '--', claudeGpt: '--', argon: '--', codex5h: '90%', codex7d: '80%', updatedAt: Date.now() }
  };
  const agySummary = {
    email: 'active@example.test',
    tier: 'Pro Plan',
    planTier: 'PRO',
    hasArgonGroup: false,
    fetchedAt: Date.now(),
    groups: [{ displayName: 'Gemini', buckets: [{ bucketId: 'g', displayName: 'Gemini', window: '5h', remainingFraction: 0.9 }] }]
  };
  const controller = new UIController(
    {
      getState: () => ({ selectedProvider: 'antigravity', activeProfileId: 'agy-1' }),
      listProfiles: () => [revokedAgy],
      getLiveSessionInfoAsync: async () => ({ ...live }),
      updateProfileCachedQuota: () => {},
      updateProfileAuthHealth: (id, h) => healthUpdates.push([id, h.authStatus]),
      syncActiveCredentialsToProfileAsync: async (id) => { syncedId = id; return true; },
      setActiveCodexProfileId: () => {},
      saveState: () => {}
    },
    {
      getQuotaSummary: async () => agySummary,
      parseMetrics: () => ({ plan: 'PRO', gemini: '90%', claudeGpt: '100%', argon: '100%', updatedAt: Date.now() }),
      buildAccountsHoverTooltip: () => 'agy-hover',
      refreshAllInactiveProfiles: async () => {}
    },
    {
      listProfiles: () => [revokedCodex],
      getLiveSessionInfo: () => ({ email: 'codex@example.test', accountId: 'acc-1', hasOAuthCreds: true }),
      findMatchingProfile: () => revokedCodex
    },
    {
      getActiveQuotaSummary: async (_vault, force) => {
        forceFlagSeen = force;
        return { metric: { plan: 'PRO', gemini: '--', claudeGpt: '--', argon: '--', codex5h: '95%', codex7d: '90%', updatedAt: Date.now() } };
      },
      buildCodexHoverTooltip: () => 'codex-hover'
    }
  );
  controller.notifiedReauthKeys.add('antigravity:agy-1');
  await controller.update(false);
  await new Promise((r) => setTimeout(r, 30));

  assert.deepEqual(healthUpdates, [['agy-1', 'ok']]);
  assert.equal(syncedId, 'agy-1');
  assert.equal(controller.notifiedReauthKeys.has('antigravity:agy-1'), false);
  assert.equal(forceFlagSeen, true);
  controller.dispose();
});

test('auto-saves unsaved active session with liveMetric before IDE Switch while CLI Only leaves IDE session untouched', async () => {
  const prevMsg = vscode.window.setStatusBarMessage;
  const prevInfo = vscode.window.showInformationMessage;
  const prevErr = vscode.window.showErrorMessage;
  const prevCreateTerm = vscode.window.createTerminal;
  const prevTerminals = vscode.window.terminals;
  let errorSeen = null;
  vscode.window.terminals = [];
  vscode.window.setStatusBarMessage = () => ({ dispose() {} });
  vscode.window.showInformationMessage = async () => undefined;
  vscode.window.showErrorMessage = async (msg) => { errorSeen = msg; };
  vscode.window.createTerminal = (opts) => {
    const t = { name: opts?.name || String(opts), show() {}, sendText() {} };
    vscode.window.terminals.push(t);
    return t;
  };

  try {
    const events = [];
    const targetCodex = { id: 'c-target', name: 'Target Codex', email: 't@codex.test', cachedQuota: null };
    const codexLiveMetric = { plan: 'PRO', gemini: '--', claudeGpt: '--', argon: '--', codex5h: '77%', codex7d: '64%', updatedAt: Date.now() };
    const targetAgy = { id: 'a-target', name: 'Target Agy', email: 't@agy.test', cachedQuota: null };
    const agyLiveMetric = { plan: 'PRO', gemini: '88%', claudeGpt: '91%', argon: '75%', updatedAt: Date.now() };

    const controller = new UIController(
      {
        getState: () => ({ selectedProvider: 'codex', activeProfileId: null }),
        listProfiles: () => [targetAgy],
        getProfile: (id) => (id === 'a-target' ? targetAgy : null),
        getLiveSessionInfoAsync: async () => ({ email: 'unsaved-agy@example.test', hasOAuthCreds: true, isExpired: false }),
        autoSaveUnsavedActiveSessionAsync: async (metric) => {
          events.push(['agy:autosave', metric?.gemini]);
          return { id: 'unsaved-agy', name: 'Unsaved Agy', email: 'unsaved-agy@example.test' };
        },
        updateProfileCachedQuota: () => {},
        switchProfile: async (id) => {
          events.push(['agy:switch', id]);
          return targetAgy;
        },
        setActiveCodexProfileId: () => {},
        saveState: () => {}
      },
      {
        getCachedSummary: () => ({
          email: 'unsaved-agy@example.test',
          planTier: 'PRO',
          groups: [{ displayName: 'Gemini', buckets: [{ window: '5h', remainingFraction: 0.88 }] }]
        }),
        parseMetrics: () => agyLiveMetric,
        refreshInactiveProfile: async () => null,
        respawnActiveDaemon: async () => 'respawned',
        invalidate: () => {},
        buildAccountsHoverTooltip: () => 'agy-hover'
      },
      {
        listProfiles: () => [targetCodex],
        getLiveSessionInfo: () => ({ email: 'unsaved-codex@example.test', accountId: 'acc-u', hasOAuthCreds: true }),
        findMatchingProfile: () => null,
        autoSaveUnsavedActiveSession: (metric) => {
          events.push(['codex:autosave', metric?.codex5h]);
          return { id: 'unsaved-codex', name: 'Unsaved Codex', email: 'unsaved-codex@example.test' };
        },
        switchProfile: async (id) => {
          events.push(['codex:switch', id]);
          return targetCodex;
        }
      },
      {
        getCachedMetric: () => codexLiveMetric,
        primeActiveAccountKey: () => {},
        invalidateCache: () => {},
        refreshProfileQuota: async () => null,
        hotSwapCodexAppServer: async () => 'swapped',
        buildCodexHoverTooltip: () => 'codex-hover'
      }
    );
    controller.update = async () => {};

    await controller.handleSwitch('c-target', 'codex', false);
    assert.equal(errorSeen, null);
    assert.deepEqual(events.slice(0, 2), [['codex:autosave', '77%'], ['codex:switch', 'c-target']]);

    // CLI Only on Antigravity runs isolated and does not trigger global autosave or disk switch
    await controller.handleSwitch('a-target', 'antigravity', true);
    assert.equal(errorSeen, null);
    assert.equal(events.length, 2);

    // Normal IDE Switch on Antigravity auto-saves active unsaved session with liveMetric
    await controller.handleSwitch('a-target', 'antigravity', false);
    assert.equal(errorSeen, null);
    assert.deepEqual(events.slice(2, 4), [['agy:autosave', '88%'], ['agy:switch', 'a-target']]);
    controller.dispose();
  } finally {
    vscode.window.setStatusBarMessage = prevMsg;
    vscode.window.showInformationMessage = prevInfo;
    vscode.window.showErrorMessage = prevErr;
    vscode.window.createTerminal = prevCreateTerm;
    vscode.window.terminals = prevTerminals;
  }
});

test('checkForNewUnsavedAccount probes Antigravity and Codex independently, persists Later until delete, and emits dedicated re-auth sync toast', async () => {
  const prevInfo = vscode.window.showInformationMessage;
  const prevWarn = vscode.window.showWarningMessage;
  const shown = [];
  let infoAction = 'Later';
  vscode.window.showInformationMessage = async (msg, ...btns) => {
    shown.push(msg);
    return btns.length > 0 ? infoAction : undefined;
  };
  vscode.window.showWarningMessage = async () => 'Delete Profile';

  try {
    let savedState = { selectedProvider: 'codex', promptedUnsavedEmails: [], promptedUnsavedCodexIdentities: [] };
    let codexProfiles = [];
    let agyProfiles = [];
    let codexAuthRevoked = false;
    let codexLive = { email: 'new-codex@example.test', accountId: 'acc-new', hasOAuthCreds: true };
    let agyLive = { email: 'new-agy@example.test', hasOAuthCreds: true, isExpired: false };

    const controller = new UIController(
      {
        getState: () => savedState,
        saveState: (patch) => { savedState = { ...savedState, ...patch }; },
        setActiveCodexProfileId: () => {},
        listProfiles: () => agyProfiles,
        getProfile: (id) => agyProfiles.find((p) => p.id === id) || null,
        deleteProfile: (id) => { agyProfiles = agyProfiles.filter((p) => p.id !== id); },
        invalidateLiveSessionCache: () => {},
        getLiveSessionInfoAsync: async () => agyLive
      },
      {
        getQuotaSummary: async () => null,
        invalidate: () => {},
        buildAccountsHoverTooltip: () => 'agy-hover'
      },
      {
        listProfiles: () => codexProfiles,
        getLiveSessionInfo: () => codexLive,
        invalidateLiveSessionCache: () => {},
        findMatchingProfile: (info) => codexProfiles.find((p) => p.accountId === info.accountId || p.email === info.email) || null,
        readDecodedActiveAuth: () => ({ ...codexLive, rawAuthJson: { tokens: { access_token: 'fresh' } } }),
        syncActiveCredentialsToProfile: (id) => {
          if (!codexAuthRevoked) return false;
          codexAuthRevoked = false;
          const p = codexProfiles.find((x) => x.id === id);
          if (p) p.authStatus = 'ok';
          return true;
        },
        deleteProfile: (id) => { codexProfiles = codexProfiles.filter((p) => p.id !== id); }
      },
      {
        refreshProfileQuota: async () => null,
        invalidateCache: () => {},
        buildCodexHoverTooltip: () => 'codex-hover'
      }
    );
    controller.update = async () => {};

    await controller.checkForNewUnsavedAccount();
    assert.equal(shown.some((m) => m.includes('New Antigravity account online (new-agy@example.test)')), true);
    assert.equal(shown.some((m) => m.includes('New OpenAI Codex account online (new-codex@example.test)')), true);

    // Selecting 'Later' suppresses repeat prompts for the same identity
    shown.length = 0;
    await controller.checkForNewUnsavedAccount();
    assert.equal(shown.length, 0);

    // Active profile cannot be deleted directly until switched inactive; once inactive, delete removes it and clears dismissal
    codexProfiles = [{ id: 'del-1', name: 'Del Codex', email: 'new-codex@example.test', accountId: 'acc-new' }];
    await controller.handleDelete('del-1', 'codex');
    assert.equal(codexProfiles.length, 1, 'active live Codex profile must be protected until inactive');
    codexLive = { email: 'other-codex@example.test', accountId: 'acc-other', hasOAuthCreds: true };
    await controller.handleDelete('del-1', 'codex');
    assert.equal(codexProfiles.length, 0, 'inactive standby Codex profile should delete once switched away');
    assert.equal(savedState.promptedUnsavedCodexIdentities.some((k) => k.endsWith('::new-codex@example.test')), false);

    // Re-authenticating a broken profile shows the dedicated recovery toast instead of new-account detection
    shown.length = 0;
    codexAuthRevoked = true;
    codexProfiles = [{ id: 'rec-1', name: 'Recover Me', email: 'rec@example.test', accountId: 'acc-rec', authStatus: 'revoked' }];
    codexLive = { email: 'rec@example.test', accountId: 'acc-rec', hasOAuthCreds: true };
    controller.handleLoginCompleted('codex');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(shown.some((m) => m.includes('Re-authenticated & synced Codex profile "Recover Me" (rec@example.test). Live quota restored.')), true);
    assert.equal(shown.some((m) => m.includes('New OpenAI Codex account online')), false);
    controller.dispose();
  } finally {
    vscode.window.showInformationMessage = prevInfo;
    vscode.window.showWarningMessage = prevWarn;
  }
});

test('CLI Only isolates per-profile env, preserves IDE session and Codex dials, and handles exit/re-run claims', async () => {
  const fs = nodeRequire('fs');
  const os = nodeRequire('os');
  const prevCreateTerm = vscode.window.createTerminal;
  const prevTerminals = vscode.window.terminals;
  const prevWarn = vscode.window.showWarningMessage;
  const prevMsg = vscode.window.setStatusBarMessage;
  const prevInfo = vscode.window.showInformationMessage;
  const prevErr = vscode.window.showErrorMessage;
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const prevPath = process.env[pathKey];
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-cli-bin-'));
  for (const name of process.platform === 'win32' ? ['codex.exe', 'agy.exe'] : ['codex', 'agy']) {
    const binPath = path.join(fakeBinDir, name);
    fs.writeFileSync(binPath, 'echo ok\n', { mode: 0o755 });
  }
  process.env[pathKey] = `${fakeBinDir}${path.delimiter}${prevPath || ''}`;

  const createdTerminals = [];
  const commandsSent = [];
  let showCalls = 0;
  let warnAnswer = 'Focus Claimed Terminal';
  let errorSeen = null;
  vscode.window.terminals = createdTerminals;
  vscode.window.createTerminal = (opts) => {
    const termName = opts?.name || String(opts);
    const term = {
      name: termName,
      options: opts,
      show: () => { showCalls++; },
      sendText: (txt) => { commandsSent.push([termName, txt]); }
    };
    createdTerminals.push(term);
    return term;
  };
  vscode.window.showWarningMessage = async () => warnAnswer;
  vscode.window.setStatusBarMessage = () => ({ dispose() {} });
  vscode.window.showInformationMessage = async () => undefined;
  vscode.window.showErrorMessage = async (msg) => { errorSeen = msg; };

  try {
    const c1 = { id: 'c1', name: 'Codex IDE', email: 'c1@example.test', cachedQuota: { updatedAt: Date.now() } };
    const c2 = { id: 'c2', name: 'Codex CLI', email: 'c2@example.test', cachedQuota: { updatedAt: Date.now() } };
    const a1 = { id: 'a1', name: 'Agy IDE', email: 'a1@example.test', cachedQuota: { updatedAt: Date.now() } };
    const a2 = { id: 'a2', name: 'Agy CLI', email: 'a2@example.test', cachedQuota: { updatedAt: Date.now() } };
    const switchedCodex = [];
    const switchedAgy = [];
    let codexInvalidates = 0;
    let agyInvalidates = 0;
    let activeLiveCodex = { email: 'c1@example.test', hasOAuthCreds: true };

    const controller = new UIController(
      {
        getState: () => ({ selectedProvider: 'codex', activeProfileId: 'a1', activeCodexProfileId: 'c1' }),
        setActiveCodexProfileId: () => {},
        saveState: () => {},
        listProfiles: () => [a1, a2],
        getProfile: (id) => [a1, a2].find((p) => p.id === id) || null,
        getLiveSessionInfoAsync: async () => ({ email: 'a1@example.test', hasOAuthCreds: true, isExpired: false }),
        autoSaveUnsavedActiveSessionAsync: async () => null,
        switchProfile: async (id) => { switchedAgy.push(id); return [a1, a2].find((p) => p.id === id); }
      },
      {
        getCachedSummary: () => null,
        refreshInactiveProfile: async () => null,
        invalidate: () => { agyInvalidates++; },
        buildAccountsHoverTooltip: () => 'agy-hover'
      },
      {
        listProfiles: () => [c1, c2],
        getLiveSessionInfo: () => activeLiveCodex,
        findMatchingProfile: (info) => [c1, c2].find((p) => p.email === info.email) || null,
        autoSaveUnsavedActiveSession: () => null,
        switchProfile: async (id) => {
          switchedCodex.push(id);
          activeLiveCodex = { email: `${id}@example.test`, hasOAuthCreds: true };
          return [c1, c2].find((p) => p.id === id);
        }
      },
      {
        getCachedMetric: () => ({ plan: 'PLUS', codex5h: '55%', codex7d: '91%', updatedAt: Date.now() }),
        primeActiveAccountKey: () => {},
        invalidateCache: () => { codexInvalidates++; },
        refreshProfileQuota: async () => null,
        hotSwapCodexAppServer: async () => 'swapped',
        buildCodexHoverTooltip: () => 'codex-hover'
      }
    );
    controller.update = async () => {};

    await controller.handleSwitch('c2', 'codex', true);
    assert.equal(errorSeen, null);
    assert.equal(createdTerminals.length, 1);
    assert.deepEqual(commandsSent[0], ['Charlier · Codex (Codex CLI)', 'codex --no-daemon']);
    assert.equal(controller.getClaimedProfileIds('codex').has('c2'), true);
    assert.deepEqual(switchedCodex, []);
    assert.equal(codexInvalidates, 0);
    assert.match(createdTerminals[0].options.env.CODEX_HOME, /cli-homes[\\/]+codex[\\/]+c2$/);

    // Repeat CLI Only focuses existing terminal instead of spawning a duplicate
    const prevShow = showCalls;
    await controller.handleSwitch('c2', 'codex', true);
    assert.equal(createdTerminals.length, 1);
    assert.equal(showCalls, prevShow + 1);

    // Normal IDE Switch on claimed profile warns and respects Focus Claimed Terminal
    await controller.handleSwitch('c2', 'codex', false);
    assert.deepEqual(switchedCodex, []);
    assert.equal(showCalls, prevShow + 2);

    // Command completion releases claim, and re-running `codex` in the same terminal re-claims it
    controller.handleTerminalCommandEnded(createdTerminals[0], 'codex --no-daemon');
    assert.equal(controller.getClaimedProfileIds('codex').has('c2'), false);
    controller.handleTerminalCommandStarted(createdTerminals[0], 'codex');
    assert.equal(controller.getClaimedProfileIds('codex').has('c2'), true);
    controller.handleTerminalCommandEnded(createdTerminals[0], 'codex');
    assert.equal(controller.getClaimedProfileIds('codex').has('c2'), false);

    // Antigravity spawns isolated `agy` terminal without touching IDE session/cache and releases on close
    await controller.handleSwitch('a2', 'antigravity', true);
    assert.equal(errorSeen, null);
    assert.equal(createdTerminals.length, 2);
    assert.deepEqual(commandsSent[1], ['Charlier · Antigravity (Agy CLI)', 'agy']);
    assert.equal(controller.getClaimedProfileIds('antigravity').has('a2'), true);
    assert.deepEqual(switchedAgy, []);
    assert.equal(agyInvalidates, 0);
    assert.match(createdTerminals[1].options.env.HOME, /cli-homes[\\/]+antigravity[\\/]+a2$/);
    if (process.platform === 'win32') {
      assert.equal(createdTerminals[1].options.env.USERPROFILE, createdTerminals[1].options.env.HOME);
      assert.equal(createdTerminals[1].options.env.WSL_DISTRO_NAME, 'Charlier');
    } else if (process.platform === 'darwin') {
      assert.equal(createdTerminals[1].options.env.WSL_DISTRO_NAME, 'Charlier');
    } else {
      assert.equal(createdTerminals[1].options.env.DBUS_SESSION_BUS_ADDRESS, null);
    }
    controller.handleTerminalClosed(createdTerminals[1]);
    assert.equal(controller.getClaimedProfileIds('antigravity').has('a2'), false);
    controller.dispose();
  } finally {
    if (prevPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = prevPath;
    }
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
    vscode.window.createTerminal = prevCreateTerm;
    vscode.window.terminals = prevTerminals;
    vscode.window.showWarningMessage = prevWarn;
    vscode.window.setStatusBarMessage = prevMsg;
    vscode.window.showInformationMessage = prevInfo;
    vscode.window.showErrorMessage = prevErr;
  }
});

test('CredentialWatcher fires a trailing callback after muteFor expires when an event arrives while muted', async () => {
  const fs = nodeRequire('fs');
  const os = nodeRequire('os');

  async function loadModule(entry) {
    const res = await esbuild.build({
      entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
      external: ['vscode'], write: false, logLevel: 'silent'
    });
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', res.outputFiles[0].text)(
      (n) => (n === 'vscode' ? vscode : nodeRequire(n)), mod, mod.exports, path.resolve('dist')
    );
    return mod.exports;
  }

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-watcher-mute-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  try {
    const watcherMod = await loadModule('src/watcher.ts');
    let callbackCount = 0;
    const watcher = new watcherMod.CredentialWatcher(() => {
      callbackCount++;
    });

    watcher.muteFor(60);
    // Simulate a file change event arriving during the 60ms mute window
    watcher.triggerDebounced();
    assert.equal(callbackCount, 0);

    // Wait for unmute timer + 300ms debounce to fire the trailing event automatically
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(callbackCount, 1);
    watcher.dispose();
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('end-to-end Antigravity lifecycle: 1st-click Add Account clears Hero dial, daemon-only unverified login saves without duplicates, CLI Only is locked until verified, and verification auto-heals', async () => {
  const fs = nodeRequire('fs');
  const os = nodeRequire('os');

  async function loadModule(entry) {
    const res = await esbuild.build({
      entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
      external: ['vscode'], write: false, logLevel: 'silent'
    });
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', res.outputFiles[0].text)(
      (n) => (n === 'vscode' ? vscode : nodeRequire(n)), mod, mod.exports, path.resolve('dist')
    );
    return mod.exports;
  }

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-e2e-lifecycle-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.CODEX_HOME;

  const prevWarn = vscode.window.showWarningMessage;
  const prevInfo = vscode.window.showInformationMessage;
  const prevErr = vscode.window.showErrorMessage;
  const prevMsg = vscode.window.setStatusBarMessage;
  const prevInput = vscode.window.showInputBox;
  const prevCreateTerm = vscode.window.createTerminal;
  const prevTerminals = vscode.window.terminals;
  const prevCommands = vscode.commands;

  const infoMessages = [];
  const warnMessages = [];
  const errorMessages = [];
  const createdTerminals = [];
  let nextWarnChoice = undefined;
  let nextInputValue = 'Gate Account';

  vscode.window.terminals = createdTerminals;
  vscode.window.createTerminal = (opts) => {
    const t = { name: opts?.name || String(opts), show() {}, sendText() {} };
    createdTerminals.push(t);
    return t;
  };
  vscode.window.setStatusBarMessage = () => ({ dispose() {} });
  vscode.window.showInformationMessage = async (msg) => {
    infoMessages.push(msg);
    return undefined;
  };
  vscode.window.showWarningMessage = async (msg) => {
    warnMessages.push(msg);
    return nextWarnChoice;
  };
  vscode.window.showErrorMessage = async (msg) => {
    errorMessages.push(msg);
  };
  vscode.window.showInputBox = async () => nextInputValue;
  vscode.commands = { executeCommand: async () => undefined };

  try {
    const vaultMod = await loadModule('src/vault.ts');
    const quotaMod = await loadModule('src/quota.ts');
    const codexMod = await loadModule('src/codex.ts');
    const mockKeyring = {
      read: () => null,
      readAsync: async () => null,
      write: () => false,
      writeAsync: async () => false,
      delete: () => true,
      deleteAsync: async () => true
    };

    const geminiDir = path.join(tmpHome, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(
      path.join(geminiDir, 'google_accounts.json'),
      JSON.stringify({ active: 'sernine@example.test', old: [] })
    );
    fs.writeFileSync(
      path.join(geminiDir, 'oauth_creds.json'),
      JSON.stringify({ refresh_token: 'rt-sernine-main', access_token: 'at-sernine' })
    );

    const vault = new vaultMod.Vault(mockKeyring);
    const codexVault = new codexMod.CodexVault();
    const quotaService = new quotaMod.QuotaService();
    const codexQuotaService = new codexMod.CodexQuotaService();

    // Seed initial active profile "Sernine"
    const initialProfile = await vault.saveCurrentAsProfileAsync('Sernine', {
      plan: 'PRO',
      gemini: '82%',
      claudeGpt: '64%',
      argon: '75%',
      updatedAt: Date.now()
    });
    assert.equal(initialProfile.email, 'sernine@example.test');

    // Simulate daemon still returning "sernine@example.test" during sign-out race
    let simulatedDaemonResponse = {
      email: 'sernine@example.test',
      planTier: 'PRO',
      groups: [
        {
          displayName: 'Gemini',
          buckets: [{ modelId: 'gemini-3-pro', remainingFraction: 0.82, resetTime: '4h' }]
        }
      ],
      fetchedAt: Date.now(),
      source: 'daemon',
      authStatus: 'ok'
    };
    quotaService.fetchFromDaemon = async () => simulatedDaemonResponse;
    quotaService.probeAllAuthHealth = async () => new Map();
    quotaService.refreshAllInactiveProfiles = async () => {};
    quotaService.respawnActiveDaemon = async () => 'respawned';
    codexQuotaService.probeAllAuthHealth = async () => new Map();

    const controller = new UIController(vault, quotaService, codexVault, codexQuotaService);
    const renderedStates = [];
    controller.attachSidebar({
      render: (state) => {
        renderedStates.push(JSON.parse(JSON.stringify({
          selectedProvider: state.selectedProvider,
          antigravity: {
            activeProfileId: state.antigravity.activeProfileId,
            sessionKind: state.antigravity.sessionKind,
            liveSession: state.antigravity.liveSession
          }
        })));
      }
    });

    await controller.update(true);
    assert.equal(renderedStates.at(-1).antigravity.sessionKind, 'saved');
    assert.equal(renderedStates.at(-1).antigravity.activeProfileId, initialProfile.id);

    // 1. Click "+ Add Account" ONCE while daemon still returns old email -> Hero dial MUST clear immediately on Click 1!
    await controller.handleAddAccount('antigravity');
    assert.equal(errorMessages.length, 0);
    assert.equal(vault.getState().activeProfileId, null);
    assert.equal(renderedStates.at(-1).antigravity.activeProfileId, null);
    assert.equal(renderedStates.at(-1).antigravity.sessionKind, 'none');

    // 2. User completes browser sign-in for a new Google account that hits Google's QR/phone verification gate
    // Note: google_accounts.json is still absent; identity comes only from daemon!
    simulatedDaemonResponse = {
      email: 'verify.gate@example.test',
      planTier: 'FREE',
      groups: [],
      fetchedAt: Date.now(),
      source: 'daemon',
      authStatus: 'unverified',
      authErrorCode: 'VALIDATION_REQUIRED',
      authErrorMessage: 'Verify your account to continue.',
      validationUrl: 'https://accounts.google.com/signin/continue?Email=verify.gate%40example.test'
    };

    await controller.update();
    const unverifiedUnsavedDeck = renderedStates.at(-1).antigravity;
    assert.equal(unverifiedUnsavedDeck.sessionKind, 'unsaved');
    assert.equal(unverifiedUnsavedDeck.liveSession.email, 'verify.gate@example.test');
    assert.equal(unverifiedUnsavedDeck.liveSession.authStatus, 'unverified');
    assert.match(controller.statusBarItem.text, /\$\(shield\) VERIFY NEEDED/);

    // 3. Click "Save to Vault" -> saves real email (not "Unknown"), transitions sessionKind to 'saved' so banner disappears!
    nextInputValue = 'Gate One';
    await controller.handleSaveCurrent('antigravity');
    assert.equal(errorMessages.length, 0);
    assert.equal(vault.listProfiles().length, 2);
    const savedGate = vault.listProfiles().find((p) => p.email === 'verify.gate@example.test');
    assert.ok(savedGate);
    assert.equal(savedGate.name, 'Gate One');
    assert.equal(savedGate.authStatus, 'unverified');
    assert.equal(renderedStates.at(-1).antigravity.sessionKind, 'saved');
    assert.equal(renderedStates.at(-1).antigravity.activeProfileId, savedGate.id);

    // 4. Calling Save to Vault again with a different name updates in-place with ZERO duplicates!
    nextInputValue = 'Gate Renamed';
    await controller.handleSaveCurrent('antigravity');
    assert.equal(vault.listProfiles().length, 2);
    const renamedGate = vault.listProfiles().find((p) => p.id === savedGate.id);
    assert.equal(renamedGate.name, 'Gate Renamed');
    assert.equal(renderedStates.at(-1).antigravity.sessionKind, 'saved');

    // Give the unverified profile a refresh token on disk so we can test switching back and forth
    fs.writeFileSync(
      path.join(geminiDir, 'charlier', 'profiles', savedGate.id, 'oauth_creds.json'),
      JSON.stringify({ refresh_token: 'rt-gate-user', access_token: 'at-gate-user' })
    );

    // Switch back to Sernine so Gate Renamed is an inactive standby profile with authStatus === 'unverified'
    simulatedDaemonResponse = {
      email: 'sernine@example.test',
      planTier: 'PRO',
      groups: [
        {
          displayName: 'Gemini',
          buckets: [{ modelId: 'gemini-3-pro', remainingFraction: 0.82, resetTime: '4h' }]
        }
      ],
      fetchedAt: Date.now(),
      source: 'daemon',
      authStatus: 'ok'
    };
    await controller.handleSwitch(initialProfile.id, 'antigravity', false);
    assert.equal(vault.getState().activeProfileId, initialProfile.id);

    // 5. Attempting "CLI Only" on inactive unverified profile is HARD-BLOCKED (never spawns CLI terminal)
    nextWarnChoice = undefined;
    warnMessages.length = 0;
    await controller.handleSwitch(savedGate.id, 'antigravity', true);
    assert.equal(warnMessages.length, 1);
    assert.match(warnMessages[0], /requires Google verification before Antigravity can use it/);
    assert.equal(createdTerminals.length, 0);
    assert.equal(vault.getState().activeProfileId, initialProfile.id);

    // 6. Choosing "Switch IDE to Verify" switches the IDE to the unverified profile cleanly without logout modal
    nextWarnChoice = 'Switch IDE to Verify';
    simulatedDaemonResponse = {
      email: 'verify.gate@example.test',
      planTier: 'FREE',
      groups: [],
      fetchedAt: Date.now(),
      source: 'daemon',
      authStatus: 'unverified',
      authErrorCode: 'VALIDATION_REQUIRED',
      authErrorMessage: 'Verify your account to continue.',
      validationUrl: 'https://accounts.google.com/signin/continue?Email=verify.gate%40example.test'
    };
    await controller.handleSwitch(savedGate.id, 'antigravity', true);
    assert.equal(createdTerminals.length, 0);
    assert.equal(vault.getState().activeProfileId, savedGate.id);

    // 7. User completes QR/phone verification -> daemon returns live quota groups -> auto-heals 'unverified' to 'ok'
    infoMessages.length = 0;
    simulatedDaemonResponse = {
      email: 'verify.gate@example.test',
      planTier: 'FREE',
      groups: [
        {
          displayName: 'Gemini',
          buckets: [{ modelId: 'gemini-3-flash', remainingFraction: 1, resetTime: '5h' }]
        }
      ],
      fetchedAt: Date.now(),
      source: 'daemon',
      authStatus: 'ok'
    };
    quotaService.invalidate();
    await controller.update();
    const healedProfile = vault.listProfiles().find((p) => p.id === savedGate.id);
    assert.equal(healedProfile.authStatus, 'ok');
    assert.equal(healedProfile.validationUrl, undefined);
    assert.equal(
      infoMessages.some((m) => m.includes('Verified & synced Antigravity profile "Gate Renamed"')),
      true
    );
    controller.dispose();
  } finally {
    vscode.window.createTerminal = prevCreateTerm;
    vscode.window.terminals = prevTerminals;
    vscode.window.showWarningMessage = prevWarn;
    vscode.window.showInformationMessage = prevInfo;
    vscode.window.showErrorMessage = prevErr;
    vscode.window.setStatusBarMessage = prevMsg;
    vscode.window.showInputBox = prevInput;
    vscode.commands = prevCommands;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('new Codex account flow: fires detection toaster reliably and keeps Hero dial steady without full-empty-full oscillation', async () => {
  const fs = nodeRequire('fs');
  const os = nodeRequire('os');

  async function loadModule(entry) {
    const res = await esbuild.build({
      entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
      external: ['vscode'], write: false, logLevel: 'silent'
    });
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', res.outputFiles[0].text)(
      (n) => (n === 'vscode' ? vscode : nodeRequire(n)), mod, mod.exports, path.resolve('dist')
    );
    return mod.exports;
  }

  const { UIController } = await loadModule('src/ui.ts');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-codex-new-acct-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  const codexHome = path.join(tmpHome, '.codex');
  process.env.CODEX_HOME = codexHome;

  const prevCreateTerm = vscode.window.createTerminal;
  const prevTerminals = vscode.window.terminals;
  const prevWarn = vscode.window.showWarningMessage;
  const prevInfo = vscode.window.showInformationMessage;
  const prevErr = vscode.window.showErrorMessage;
  const prevMsg = vscode.window.setStatusBarMessage;
  const prevInput = vscode.window.showInputBox;
  const prevCommands = vscode.commands;

  const infoMessages = [];
  const errorMessages = [];
  let nextInfoChoice = undefined;
  let nextInputValue = undefined;

  vscode.window.terminals = [];
  vscode.window.setStatusBarMessage = () => ({ dispose: () => {} });
  vscode.window.showInformationMessage = async (msg) => {
    infoMessages.push(msg);
    return nextInfoChoice;
  };
  vscode.window.showWarningMessage = async () => undefined;
  vscode.window.showErrorMessage = async (msg) => {
    errorMessages.push(msg);
  };
  vscode.window.showInputBox = async () => nextInputValue;
  vscode.commands = { executeCommand: async () => undefined };

  const makeJwt = (payload) => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.sig`;
  };

  try {
    const vaultMod = await loadModule('src/vault.ts');
    const quotaMod = await loadModule('src/quota.ts');
    const codexMod = await loadModule('src/codex.ts');
    const mockKeyring = {
      read: () => null,
      readAsync: async () => null,
      write: () => false,
      writeAsync: async () => false,
      delete: () => true,
      deleteAsync: () => true
    };

    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          account_id: 'acct-main-001',
          access_token: makeJwt({
            email: 'main.codex@example.test',
            'https://api.openai.com/auth': {
              chatgpt_account_id: 'acct-main-001',
              chatgpt_plan_type: 'plus'
            }
          }),
          id_token: makeJwt({
            email: 'main.codex@example.test',
            'https://api.openai.com/auth': {
              chatgpt_account_id: 'acct-main-001',
              chatgpt_plan_type: 'plus'
            }
          }),
          refresh_token: 'rt-main-001'
        }
      })
    );

    const vault = new vaultMod.Vault(mockKeyring);
    const codexVault = new codexMod.CodexVault();
    const quotaService = new quotaMod.QuotaService();
    const codexQuotaService = new codexMod.CodexQuotaService();

    // Save main Codex profile
    const mainCodex = codexVault.saveCurrentAsProfile('Sernine Main', {
      plan: 'PLUS',
      codex5h: '55%',
      codex7d: '91%',
      updatedAt: Date.now()
    });
    assert.equal(mainCodex.email, 'main.codex@example.test');

    // Pollute state.json promptedUnsavedCodexIdentities with both the saved profile AND a future new profile
    // to verify stale entries are pruned/cleared on fresh login transition!
    vault.saveState({
      promptedUnsavedEmails: [],
      promptedUnsavedCodexIdentities: [
        'acct-main-001::main.codex@example.test',
        'acct-new-002::fresh.codex@example.test'
      ]
    });

    quotaService.fetchFromDaemon = async () => null;
    quotaService.probeAllAuthHealth = async () => new Map();
    quotaService.refreshAllInactiveProfiles = async () => {};
    codexQuotaService.probeAllAuthHealth = async () => new Map();

    // Simulate slight async delay (e.g. 25ms) when fetching live wham/usage for the new unsaved Codex account
    codexQuotaService.fetchWhamUsage = async (_accessToken, accountId) => {
      await new Promise((r) => setTimeout(r, 25));
      const isNew = accountId === 'acct-new-002';
      return {
        plan_type: isNew ? 'free' : 'plus',
        rate_limit: {
          primary_window: {
            used_percent: isNew ? 0 : 45,
            reset_after_seconds: 18000
          },
          ...(isNew
            ? {}
            : {
                secondary_window: {
                  used_percent: 9,
                  reset_after_seconds: 345600
                }
              })
        }
      };
    };

    const controller = new UIController(vault, quotaService, codexVault, codexQuotaService);
    const codexFrames = [];
    controller.attachSidebar({
      render: (state) => {
        codexFrames.push(
          JSON.parse(
            JSON.stringify({
              sessionKind: state.codex.sessionKind,
              activeProfileId: state.codex.activeProfileId,
              email: state.codex.liveSession?.email || null,
              codex5h: state.codex.liveMetrics?.codex5h || null,
              codex7d: state.codex.liveMetrics?.codex7d || null,
              plan: state.codex.liveMetrics?.plan || null
            })
          )
        );
      }
    });

    await controller.update(false);
    assert.equal(codexFrames.at(-1).sessionKind, 'saved');
    assert.equal(codexFrames.at(-1).activeProfileId, mainCodex.id);

    // 1. Click "+ Add Codex Account" -> non-blocking heads-up toaster, sessionKind becomes 'none'
    infoMessages.length = 0;
    await controller.handleAddAccount('codex');
    assert.equal(errorMessages.length, 0);
    assert.equal(codexFrames.at(-1).sessionKind, 'none');

    // 2. Simulate user completing login to a brand-new Codex account (`fresh.codex@example.test`)
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          account_id: 'acct-new-002',
          access_token: makeJwt({
            email: 'fresh.codex@example.test',
            'https://api.openai.com/auth': {
              chatgpt_account_id: 'acct-new-002',
              chatgpt_plan_type: 'free'
            }
          }),
          id_token: makeJwt({
            email: 'fresh.codex@example.test',
            'https://api.openai.com/auth': {
              chatgpt_account_id: 'acct-new-002',
              chatgpt_plan_type: 'free'
            }
          }),
          refresh_token: 'rt-new-002'
        }
      })
    );

    codexFrames.length = 0;
    infoMessages.length = 0;

    // Trigger sequence of invalidations and fast/full updates that happen on login + focus waves
    codexQuotaService.invalidateCache();
    await controller.update(true);
    codexQuotaService.invalidateCache();
    await controller.update(false);
    codexQuotaService.invalidateCache();
    await controller.update(true);
    await controller.update(false);

    // Wait a tick for the fire-and-forget toaster promise to push into infoMessages
    await new Promise((r) => setTimeout(r, 40));

    // Verify new Codex account toaster fired!
    assert.equal(
      infoMessages.some((m) =>
        m.includes('New OpenAI Codex account online (fresh.codex@example.test). Save it as a profile in your vault?')
      ),
      true,
      `Expected new Codex account toaster in: ${JSON.stringify(infoMessages)}`
    );

    // Verify ZERO oscillation: every rendered frame for the new unsaved Codex session has codex5h === '100%'!
    assert.ok(codexFrames.length >= 2);
    for (const frame of codexFrames) {
      assert.equal(frame.sessionKind, 'unsaved');
      assert.equal(frame.email, 'fresh.codex@example.test');
      assert.equal(
        frame.codex5h,
        '100%',
        `Expected steady 100% Hero dial without oscillation across frames: ${JSON.stringify(codexFrames)}`
      );
    }

    // 3. Save the new Codex profile -> transitions cleanly to 'saved' and does NOT pollute promptedUnsavedCodexIdentities
    nextInputValue = 'Fresh Free';
    await controller.handleSaveCurrent('codex');
    assert.equal(codexFrames.at(-1).sessionKind, 'saved');
    assert.equal(
      (vault.getState().promptedUnsavedCodexIdentities || []).includes(
        'acct-new-002::fresh.codex@example.test'
      ),
      false
    );

    controller.dispose();
  } finally {
    vscode.window.createTerminal = prevCreateTerm;
    vscode.window.terminals = prevTerminals;
    vscode.window.showWarningMessage = prevWarn;
    vscode.window.showInformationMessage = prevInfo;
    vscode.window.showErrorMessage = prevErr;
    vscode.window.setStatusBarMessage = prevMsg;
    vscode.window.showInputBox = prevInput;
    vscode.commands = prevCommands;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('CredentialWatcher gates state.vscdb idle chatter and UIController reflects CLI claims + theme refreshes without churn', async () => {
  const fs = nodeRequire('fs');
  const os = nodeRequire('os');

  async function loadModule(entry) {
    const res = await esbuild.build({
      entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
      external: ['vscode'], write: false, logLevel: 'silent'
    });
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', res.outputFiles[0].text)(
      (n) => (n === 'vscode' ? vscode : nodeRequire(n)), mod, mod.exports, path.resolve('dist')
    );
    return mod.exports;
  }

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-watcher-vscdb-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevAppData = process.env.APPDATA;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.APPDATA = path.join(tmpHome, 'AppData', 'Roaming');

  const globalStorageDir = path.join(process.env.APPDATA, 'Antigravity', 'User', 'globalStorage');
  fs.mkdirSync(globalStorageDir, { recursive: true });
  fs.writeFileSync(path.join(globalStorageDir, 'state.vscdb-wal'), '0');

  let w = null;
  try {
    const watcherMod = await loadModule('src/watcher.ts');
    let awaitingLogin = false;
    let callbacks = 0;
    w = new watcherMod.CredentialWatcher(() => { callbacks++; }, {
      shouldWatchIdeStorage: () => awaitingLogin
    });

    // Idle state.vscdb-wal writes MUST be ignored (stops idle hover/cockpit flicker!)
    fs.writeFileSync(path.join(globalStorageDir, 'state.vscdb-wal'), '1');
    await new Promise((r) => setTimeout(r, 260));
    assert.equal(callbacks, 0);

    // When awaiting login, state.vscdb-wal fires callback normally
    awaitingLogin = true;
    fs.writeFileSync(path.join(globalStorageDir, 'state.vscdb-wal'), '2');
    await new Promise((r) => setTimeout(r, 320));
    assert.equal(callbacks, 1);
    w.dispose();
    w = null;

    // UIController status bar includes $(terminal) badge for claimed profiles and refreshForThemeChange repaints
    const { UIController } = await loadModule('src/ui.ts');
    const freshTs = Date.now();
    const p1 = { id: 'p1', name: 'Main', email: 'm@t.dev', provider: 'codex', updatedAt: freshTs, cachedQuota: { plan: 'PRO', codex5h: '80%', codex7d: '90%', updatedAt: freshTs } };
    const p2 = { id: 'p2', name: 'Cli2', email: 'c@t.dev', provider: 'codex', updatedAt: freshTs, cachedQuota: { plan: 'PLUS', codex5h: '75%', codex7d: '85%', updatedAt: freshTs } };
    let themePass = 0;
    const controller = new UIController(
      {
        listProfiles: () => [],
        getState: () => ({ activeProfileId: null, activeCodexProfileId: 'p1', selectedProvider: 'codex', lastUpdated: 1 }),
        saveState: () => {},
        setSelectedProvider: () => {},
        setActiveCodexProfileId: () => {},
        getLiveSessionInfoAsync: async () => ({ email: null, hasOAuthCreds: false, tokenExpiryDate: null, isExpired: false })
      },
      {
        getCachedSummary: () => null,
        getQuotaSummary: async () => null,
        refreshAllInactiveProfiles: async () => 0,
        formatResetCompact: () => '',
        buildAccountsHoverTooltip: () => ({ value: 'agy-hover' })
      },
      {
        listProfiles: () => [p1, p2],
        findMatchingProfile: (live) => (live?.email === 'm@t.dev' ? p1 : null),
        getLiveSessionInfo: () => ({ email: 'm@t.dev', accountId: 'acc1', hasOAuthCreds: true, tokenExpiryDate: null, isExpired: false })
      },
      {
        getCachedSummary: () => null,
        getCachedMetric: () => null,
        refreshAllProfiles: async () => 0,
        buildCodexHoverTooltip: () => ({ value: `hover-theme-${++themePass}` })
      }
    );
    const fakeTerm = { name: 'Charlier · Codex (Cli2)' };
    controller.claimedTerminals.set('codex:p2', { terminal: fakeTerm, provider: 'codex', profileId: 'p2', profileName: 'Cli2' });
    const prevTerms = vscode.window.terminals;
    vscode.window.terminals = [fakeTerm];
    try {
      await controller.update(true);
      assert.match(controller.statusBarItem.text, /· \$\(terminal\)$/);
      assert.equal(controller.statusBarItem.tooltip.value, 'hover-theme-1');
      controller.refreshForThemeChange();
      assert.equal(controller.statusBarItem.tooltip.value, 'hover-theme-2');
    } finally {
      vscode.window.terminals = prevTerms;
      controller.dispose();
    }
  } finally {
    w?.dispose();
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('host-scoped startup primacy, non-sticky auto-switch, stream focus signals, tokenless unverified profile visibility, 0ms QuickPick, and v2 icon font contract', async () => {
  const fs = nodeRequire('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.contributes.icons['charlier-codex-prompt'].default.fontPath, './media/charlier-status-v2.woff');
  assert.equal(fs.existsSync('media/charlier-status-v2.woff'), true);
  assert.equal(fs.existsSync('media/charlier-status.woff'), false);

  const prevAppName = vscode.env.appName;
  const prevCreateQuickPick = vscode.window.createQuickPick;
  const prevGetExtension = vscode.extensions.getExtension;
  const loadModule = async (entry) => {
    const res = await esbuild.build({
      entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
      external: ['vscode'], write: false, logLevel: 'silent'
    });
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', res.outputFiles[0].text)(
      (n) => (n === 'vscode' ? vscode : nodeRequire(n)), mod, mod.exports, path.resolve('dist')
    );
    return mod.exports;
  };
  const { UIController } = await loadModule('src/ui.ts');
  const { resolveEffectiveAuthStatus } = await loadModule('src/quota-values.ts');

  assert.equal(resolveEffectiveAuthStatus('ok', 'unverified'), 'unverified');
  assert.equal(resolveEffectiveAuthStatus('unverified', 'revoked'), 'revoked');

  const unverifiedTokenless = {
    id: 'agy-unver-1',
    name: 'Verify Me',
    email: 'verify@example.test',
    authStatus: 'unverified',
    validationUrl: 'https://accounts.google.com/signin/continue?Email=verify%40example.test',
    updatedAt: Date.now()
  };

  try {
    // 1. Antigravity IDE stays primary 'antigravity' at startup even if selectedProviderByHost.vscode === 'codex'
    vscode.env.appName = 'Antigravity';
    const hostCalls = [];
    const legacyCalls = [];
    const agyController = new UIController(
      {
        getState: () => ({
          selectedProvider: 'codex',
          selectedProviderByHost: { vscode: 'codex' },
          activeProfileId: unverifiedTokenless.id
        }),
        listProfiles: () => [unverifiedTokenless],
        getLiveSessionInfoAsync: async () => ({ email: null, hasOAuthCreds: false, tokenExpiryDate: null, isExpired: false }),
        updateProfileCachedQuota: () => {},
        setSelectedProvider: (p) => legacyCalls.push(p),
        setSelectedProviderForHost: (h, p) => hostCalls.push([h, p]),
        saveState: () => {}
      },
      {
        getQuotaSummary: async () => null,
        getCachedSummary: () => null,
        buildAccountsHoverTooltip: () => 'hover',
        refreshAllInactiveProfiles: async () => {}
      },
      {
        listProfiles: () => [],
        getLiveSessionInfo: () => ({ email: null, hasOAuthCreds: false }),
        findMatchingProfile: () => null
      },
      { buildCodexHoverTooltip: () => 'codex-hover' }
    );
    assert.equal(agyController.getSelectedProvider(), 'antigravity');

    // Tokenless unverified activeProfile stays visible in Status Bar instead of 'Switch'
    await agyController.update(true);
    assert.match(agyController.statusBarItem.text, /Verify Me/);
    assert.match(agyController.statusBarItem.text, /VERIFY NEEDED/);

    // Non-manual auto-switch does NOT overwrite persisted provider preferences
    await agyController.switchProvider('codex', { manual: false });
    assert.equal(agyController.getSelectedProvider(), 'codex');
    assert.deepEqual(hostCalls, []);
    assert.deepEqual(legacyCalls, []);

    // 'stream' focus signal switches even when extensions aren't loaded in IDE
    await agyController.switchProvider('antigravity', { manual: false });
    vscode.extensions.getExtension = () => undefined;
    agyController.manualProviderPinUntil = 0;
    agyController.handleFocusSignal('codex', 'stream');
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(agyController.getSelectedProvider(), 'codex');

    // QuickPick opens synchronously (0ms) before async quota resolution
    let shownImmediately = false;
    let releaseQuota;
    vscode.window.createQuickPick = () => ({
      items: [],
      title: '',
      placeholder: '',
      matchOnDescription: false,
      matchOnDetail: false,
      onDidTriggerItemButton: () => ({ dispose() {} }),
      onDidAccept: () => ({ dispose() {} }),
      onDidHide: () => ({ dispose() {} }),
      show: () => { shownImmediately = true; },
      hide: () => {},
      dispose: () => {}
    });
    agyController.selectedProvider = 'antigravity';
    agyController.quotaService.getQuotaSummary = () => new Promise((r) => { releaseQuota = r; });
    const qpPromise = agyController.showQuickPickMenu();
    assert.equal(shownImmediately, true, 'Antigravity QuickPick must open synchronously at 0ms');
    releaseQuota?.(null);
    await qpPromise;
    await new Promise((r) => setTimeout(r, 20));
    agyController.dispose();

    // 2. VS Code host honors selectedProviderByHost.vscode === 'codex' and persists manual flips for vscode
    vscode.env.appName = 'Visual Studio Code';
    const vsController = new UIController(
      {
        getState: () => ({ selectedProvider: 'antigravity', selectedProviderByHost: { vscode: 'codex' } }),
        listProfiles: () => [],
        getLiveSessionInfoAsync: async () => ({ email: null, hasOAuthCreds: false, tokenExpiryDate: null, isExpired: false }),
        updateProfileCachedQuota: () => {},
        setSelectedProvider: (p) => legacyCalls.push(p),
        setSelectedProviderForHost: (h, p) => hostCalls.push([h, p]),
        saveState: () => {}
      },
      { getQuotaSummary: async () => null, getCachedSummary: () => null, buildAccountsHoverTooltip: () => 'hover', refreshAllInactiveProfiles: async () => {} },
      { listProfiles: () => [], getLiveSessionInfo: () => ({ email: null, hasOAuthCreds: false }), findMatchingProfile: () => null },
      { buildCodexHoverTooltip: () => 'codex-hover' }
    );
    assert.equal(vsController.getSelectedProvider(), 'codex');
    await vsController.switchProvider('antigravity', { manual: true });
    assert.deepEqual(hostCalls, [['vscode', 'antigravity']]);
    vsController.dispose();

    // Output channel URIs resolve via path while workspace file URIs never trigger provider flips
    const extMod = await loadModule('src/extension.ts');
    assert.equal(extMod.detectProviderFromUri({ scheme: 'output', authority: '', path: 'extension-output-openai.chatgpt-#1-Codex' }), 'codex');
    assert.equal(extMod.detectProviderFromUri({ scheme: 'output', authority: '', path: 'extension-output-google.google-antigravity-#1-Antigravity' }), 'antigravity');
    assert.equal(extMod.detectProviderFromUri({ scheme: 'output', authority: '', path: 'extension-output-Sernine.charlier-#1-Charlier' }), null);
    assert.equal(extMod.detectProviderFromUri({ scheme: 'file', authority: '', path: '/workspace/openai.chatgpt/codex.ts' }), null);
  } finally {
    vscode.env.appName = prevAppName;
    vscode.window.createQuickPick = prevCreateQuickPick;
    vscode.extensions.getExtension = prevGetExtension;
  }
});

test('delete requires making active IDE and CLI CLAIMED profiles inactive first, omits active/claimed QuickPick trash buttons, and guides sole-active users', async () => {
  const fs = nodeRequire('fs');
  const os = nodeRequire('os');
  const prevCreateTerm = vscode.window.createTerminal;
  const prevTerminals = vscode.window.terminals;
  const prevWarn = vscode.window.showWarningMessage;
  const prevInfo = vscode.window.showInformationMessage;
  const prevQuickPick = vscode.window.showQuickPick;
  const prevCreateQp = vscode.window.createQuickPick;
  const prevMsg = vscode.window.setStatusBarMessage;
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const prevPath = process.env[pathKey];
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-del-bin-'));
  for (const name of process.platform === 'win32' ? ['codex.exe', 'agy.exe'] : ['codex', 'agy']) {
    fs.writeFileSync(path.join(fakeBinDir, name), 'echo ok\n', { mode: 0o755 });
  }
  process.env[pathKey] = `${fakeBinDir}${path.delimiter}${prevPath || ''}`;

  const warnings = [];
  const quickPickListCalls = [];
  const createdQuickPicks = [];
  const createdTerminals = [];
  let termShowCalls = 0;
  let nextWarnChoice;
  vscode.window.terminals = createdTerminals;
  vscode.window.createTerminal = (opts) => {
    const t = { name: opts?.name || String(opts), show: () => { termShowCalls++; }, sendText() {} };
    createdTerminals.push(t);
    return t;
  };
  vscode.window.showWarningMessage = async (msg, opts, ...btns) => {
    warnings.push({ msg, opts, btns });
    return typeof nextWarnChoice === 'function' ? nextWarnChoice(msg, btns) : nextWarnChoice;
  };
  vscode.window.showInformationMessage = async () => undefined;
  vscode.window.showQuickPick = async (items) => {
    quickPickListCalls.push(items);
    return undefined;
  };
  vscode.window.createQuickPick = () => {
    const qp = {
      items: [],
      title: '',
      placeholder: '',
      onDidTriggerItemButton: () => ({ dispose() {} }),
      onDidAccept: () => ({ dispose() {} }),
      onDidHide: () => ({ dispose() {} }),
      show() { createdQuickPicks.push(this); },
      hide() {},
      dispose() {}
    };
    return qp;
  };
  vscode.window.setStatusBarMessage = () => ({ dispose() {} });

  try {
    let agyProfiles = [
      { id: 'a1', name: 'Active IDE', email: 'a1@example.test', cachedQuota: { updatedAt: Date.now() } },
      { id: 'a2', name: 'CLI Claimed', email: 'a2@example.test', cachedQuota: { updatedAt: Date.now() } },
      { id: 'a3', name: 'Inactive Standby', email: 'a3@example.test', cachedQuota: { updatedAt: Date.now() } }
    ];
    let codexProfiles = [
      { id: 'c1', name: 'Codex Active', email: 'c1@example.test', accountId: 'acc-1', cachedQuota: { updatedAt: Date.now() } },
      { id: 'c2', name: 'Codex Idle', email: 'c2@example.test', accountId: 'acc-2', cachedQuota: { updatedAt: Date.now() } }
    ];
    let state = { selectedProvider: 'antigravity', activeProfileId: 'a1', activeCodexProfileId: 'c1' };

    const controller = new UIController(
      {
        getState: () => state,
        setSelectedProvider: (p) => { state.selectedProvider = p; },
        setSelectedProviderForHost: () => {},
        setActiveCodexProfileId: (id) => { state.activeCodexProfileId = id; },
        saveState: (p) => { Object.assign(state, p); },
        listProfiles: () => agyProfiles,
        getProfile: (id) => agyProfiles.find((p) => p.id === id) || null,
        getLiveSessionInfoAsync: async () => ({ email: 'a1@example.test', hasOAuthCreds: true, isExpired: false }),
        autoSaveUnsavedActiveSessionAsync: async () => null,
        deleteProfile: (id) => { agyProfiles = agyProfiles.filter((p) => p.id !== id); }
      },
      {
        getCachedSummary: () => null,
        getQuotaSummary: async () => null,
        refreshAllInactiveProfiles: async () => {},
        refreshInactiveProfile: async () => null,
        invalidate: () => {},
        buildAccountsHoverTooltip: () => ''
      },
      {
        listProfiles: () => codexProfiles,
        getLiveSessionInfo: () => ({ email: 'c1@example.test', accountId: 'acc-1', hasOAuthCreds: true }),
        findMatchingProfile: (info) => codexProfiles.find((p) => p.email === info.email) || null,
        autoSaveUnsavedActiveSession: () => null,
        deleteProfile: (id) => { codexProfiles = codexProfiles.filter((p) => p.id !== id); }
      },
      {
        getCachedSummary: () => null,
        getCachedMetric: () => null,
        getActiveQuotaSummary: async () => null,
        invalidateCache: () => {},
        refreshProfileQuota: async () => null,
        buildCodexHoverTooltip: () => ''
      }
    );
    controller.update = async () => {};

    // Claim a2 as CLI terminal (leaving a1 active in IDE)
    await controller.handleSwitch('a2', 'antigravity', true);
    assert.equal(controller.getClaimedProfileIds('antigravity').has('a2'), true);

    // QuickPick omits trash icon on active (a1) and CLI CLAIMED (a2) rows, keeping it only on inactive standby (a3)
    await controller.showQuickPickMenu();
    const qpItems = createdQuickPicks.at(-1).items;
    const itemA1 = qpItems.find((i) => i.profileId === 'a1');
    const itemA2 = qpItems.find((i) => i.profileId === 'a2');
    const itemA3 = qpItems.find((i) => i.profileId === 'a3');
    assert.equal(itemA1.buttons.some((b) => (b.tooltip || '').startsWith('Delete')), false);
    assert.equal(itemA2.buttons.some((b) => (b.tooltip || '').startsWith('Delete')), false);
    assert.equal(itemA3.buttons.some((b) => (b.tooltip || '').startsWith('Delete')), true);

    // Same for Codex QuickPick active row
    await controller.switchProvider('codex');
    await controller.showQuickPickMenu();
    const cItems = createdQuickPicks.at(-1).items;
    assert.equal(cItems.find((i) => i.profileId === 'c1').buttons.some((b) => (b.tooltip || '').startsWith('Delete')), false);
    assert.equal(cItems.find((i) => i.profileId === 'c2').buttons.some((b) => (b.tooltip || '').startsWith('Delete')), true);

    // Direct handleDelete on active IDE a1 is blocked
    warnings.length = 0;
    await controller.handleDelete('a1', 'antigravity');
    assert.equal(agyProfiles.some((p) => p.id === 'a1'), true);
    assert.match(warnings.at(-1).msg, /active in the IDE/i);

    // Direct handleDelete on CLI CLAIMED a2 is blocked with Focus Claimed Terminal
    nextWarnChoice = 'Focus Claimed Terminal';
    const prevShowCalls = termShowCalls;
    await controller.handleDelete('a2', 'antigravity');
    assert.equal(agyProfiles.some((p) => p.id === 'a2'), true);
    assert.equal(termShowCalls, prevShowCalls + 1);
    assert.ok(warnings.at(-1).btns.includes('Focus Claimed Terminal'));

    // Command Palette handleDelete() lists ONLY inactive standby profile a3
    quickPickListCalls.length = 0;
    await controller.handleDelete(undefined, 'antigravity');
    assert.deepEqual(quickPickListCalls[0].map((i) => i.profileId), ['a3']);

    // Close claimed terminal and confirm deleting a2 + a3 works once inactive
    nextWarnChoice = 'Delete Profile';
    controller.handleTerminalClosed(createdTerminals[0]);
    await controller.handleDelete('a2', 'antigravity');
    await controller.handleDelete('a3', 'antigravity');
    assert.deepEqual(agyProfiles.map((p) => p.id), ['a1']);

    // Sole remaining active profile guides user cleanly with + Add Account (Sign Out)
    warnings.length = 0;
    nextWarnChoice = undefined;
    await controller.handleDelete(undefined, 'antigravity');
    assert.equal(agyProfiles.length, 1);
    assert.ok(warnings.at(-1).btns.includes('+ Add Account (Sign Out)'));

    controller.dispose();
  } finally {
    if (prevPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = prevPath;
    }
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
    vscode.window.createTerminal = prevCreateTerm;
    vscode.window.terminals = prevTerminals;
    vscode.window.showWarningMessage = prevWarn;
    vscode.window.showInformationMessage = prevInfo;
    vscode.window.showQuickPick = prevQuickPick;
    vscode.window.createQuickPick = prevCreateQp;
    vscode.window.setStatusBarMessage = prevMsg;
  }
});

test('switchProvider paints instantaneously while triggering background telemetry refresh when target deck has no live update yet', async () => {
  const renders = [];
  let codexLiveCalls = 0;
  let agyLiveCalls = 0;
  const agyProf = {
    ...profile,
    id: 'a-live',
    cachedQuota: { plan: 'PRO', gemini: '92%', claudeGpt: '88%', argon: '80%', updatedAt: Date.now() }
  };
  const codexProf = {
    id: 'c-live',
    provider: 'codex',
    name: 'Codex Main',
    email: 'codex@example.test',
    accountId: 'acc-live',
    updatedAt: Date.now()
  };

  const vault = {
    getState: () => ({ selectedProvider: 'antigravity', activeProfileId: 'a-live', activeCodexProfileId: 'c-live' }),
    listProfiles: () => [agyProf],
    getLiveSessionInfoAsync: async () => ({ ...live }),
    updateProfileCachedQuota: () => {},
    setSelectedProviderForHost: () => {},
    setSelectedProvider: () => {},
    saveState: () => {}
  };
  const quota = {
    getQuotaSummary: async () => {
      agyLiveCalls++;
      return { email: live.email, groups: [{ modelLabel: 'Gemini', remainingFraction: 0.92 }], fetchedAt: Date.now() };
    },
    getCachedSummary: () => ({ email: live.email, groups: [{ modelLabel: 'Gemini', remainingFraction: 0.92 }], fetchedAt: Date.now() }),
    parseMetrics: () => agyProf.cachedQuota,
    buildAccountsHoverTooltip: () => 'agy-hover',
    refreshAllInactiveProfiles: async () => {}
  };
  const codexVault = {
    listProfiles: () => [codexProf],
    getLiveSessionInfo: () => ({ email: 'codex@example.test', accountId: 'acc-live', hasOAuthCreds: true, isExpired: false }),
    findMatchingProfile: () => codexProf,
    updateProfileCachedQuota: () => {}
  };
  const codexQuota = {
    getActiveQuotaSummary: async () => {
      codexLiveCalls++;
      return {
        summary: { email: 'codex@example.test', accountId: 'acc-live', fetchedAt: Date.now(), groups: [] },
        metric: { plan: 'PLUS', codex5h: '95%', codex7d: '84%', updatedAt: Date.now() }
      };
    },
    getCachedMetric: () => null,
    refreshAllProfiles: async () => [],
    refreshProfileQuota: async () => null,
    probeAllAuthHealth: async () => false,
    buildCodexHoverTooltip: () => 'codex-hover'
  };

  const controller = new UIController(vault, quota, codexVault, codexQuota);
  controller.attachSidebar({ render: (s) => renders.push(s.selectedProvider) });
  try {
    await controller.update(false);
    assert.equal(agyLiveCalls, 1);

    // Flipping from Antigravity to Codex immediately (<300s!) must still schedule a live Codex refresh
    const t0 = Date.now();
    await controller.switchProvider('codex');
    assert.ok(Date.now() - t0 < 50, 'switchProvider must paint synchronously without blocking');
    assert.equal(renders.at(-1), 'codex');

    await new Promise((r) => setTimeout(r, 180));
    assert.ok(codexLiveCalls >= 1, 'Codex deck flip must trigger live telemetry fetch instead of 5-min stale freeze');
  } finally {
    controller.dispose();
  }
});

test('UIController.handleSwitch routes Antigravity budget-exhausted safely to Extension Host restart without crashing backend', async () => {
  const prevExec = vscode.commands.executeCommand;
  const prevInfo = vscode.window.showInformationMessage;
  const prevErr = vscode.window.showErrorMessage;
  const prevMsg = vscode.window.setStatusBarMessage;
  const prevGetExt = vscode.extensions.getExtension;
  const prevAppName = vscode.env.appName;
  const executedCommands = [];
  const infoPrompts = [];
  const errorMessages = [];

  vscode.env.appName = 'Visual Studio Code';
  vscode.commands.executeCommand = async (id, ...args) => {
    executedCommands.push([id, ...args]);
    return undefined;
  };
  vscode.window.setStatusBarMessage = () => ({ dispose() {} });
  vscode.window.showErrorMessage = async (msg) => {
    errorMessages.push(msg);
    return undefined;
  };
  vscode.window.showInformationMessage = async (msg, ...btns) => {
    infoPrompts.push({ msg, btns });
    return 'Reload Extension Host';
  };
  vscode.extensions.getExtension = (id) =>
    id === 'openai.chatgpt' ? { id, isActive: true } : undefined;

  try {
    let profiles = [
      { id: 'a1', name: 'Main', email: 'a1@example.test', updatedAt: Date.now() },
      { id: 'a2', name: 'Backup', email: 'a2@example.test', updatedAt: Date.now() }
    ];
    let state = { selectedProvider: 'antigravity', activeProfileId: 'a1' };
    const controller = new UIController(
      {
        getState: () => state,
        saveState: (patch) => { state = { ...state, ...patch }; },
        listProfiles: () => profiles,
        getLiveSessionInfoAsync: async () => ({ email: 'a1@example.test', hasOAuthCreds: true, isExpired: false }),
        switchProfile: async (id) => {
          state = { ...state, activeProfileId: id };
          return profiles.find((p) => p.id === id);
        },
        autoSaveUnsavedActiveSessionAsync: async () => null,
        updateProfileCachedQuota: () => {},
        updateProfileAuthHealth: () => {},
        syncActiveCredentialsToProfileAsync: async () => false
      },
      {
        getQuotaSummary: async () => null,
        getCachedSummary: () => null,
        invalidate: () => {},
        respawnActiveDaemon: async () => 'budget-exhausted',
        refreshInactiveProfile: async () => null,
        buildAccountsHoverTooltip: () => 'hover',
        refreshAllInactiveProfiles: async () => {}
      },
      {
        listProfiles: () => [],
        getLiveSessionInfo: () => ({ email: null, hasOAuthCreds: false }),
        findMatchingProfile: () => null
      },
      {
        refreshAllProfiles: async () => [],
        buildCodexHoverTooltip: () => 'codex-hover'
      }
    );

    await controller.handleSwitch('a2', 'antigravity', false);
    assert.deepEqual(errorMessages, []);
    assert.ok(
      infoPrompts.some((p) => /restart limit|process_exit_nonzero/i.test(p.msg)),
      'co-running Codex prompts cleanly when surgical budget is exhausted'
    );
    assert.ok(
      executedCommands.some(([id]) => id === 'workbench.action.restartExtensionHost'),
      'Reload Extension Host executes clean VS Code host restart'
    );

    // Without Codex running and autoRestartExtensionHost enabled, auto-restarts Extension Host with zero prompt
    infoPrompts.length = 0;
    executedCommands.length = 0;
    vscode.extensions.getExtension = () => undefined;
    await controller.handleSwitch('a1', 'antigravity', false);
    assert.deepEqual(errorMessages, []);
    assert.equal(infoPrompts.length, 0);
    assert.ok(
      executedCommands.some(([id]) => id === 'workbench.action.restartExtensionHost')
    );

    controller.dispose();
  } finally {
    vscode.commands.executeCommand = prevExec;
    vscode.window.showInformationMessage = prevInfo;
    vscode.window.showErrorMessage = prevErr;
    vscode.window.setStatusBarMessage = prevMsg;
    vscode.extensions.getExtension = prevGetExt;
    vscode.env.appName = prevAppName;
  }
});

test('UIController hybrid auto-refresh: updates active Hero & CLI CLAIMED on focus/visibility/ticks, pauses unfocused, supports Wayland activity fallback, and guards providerAtStart', async () => {
  let agyHeroPulls = 0;
  let agyClaimedPulls = 0;
  let agyStandbyPulls = 0;
  let codexHeroPulls = 0;
  let codexClaimedPulls = 0;
  let codexStandbyPulls = 0;

  let agyFetchedAt = 0;
  let codexLastFetch = 0;
  const renders = [];

  const agyProfiles = [
    { id: 'a1', name: 'Hero', email: 'a1@example.test', updatedAt: Date.now(), cachedQuota: { plan: 'PRO', gemini: '80%', claudeGpt: '80%', argon: '80%', updatedAt: Date.now() } },
    { id: 'a2', name: 'CliAgy', email: 'a2@example.test', updatedAt: Date.now(), cachedQuota: { plan: 'PRO', gemini: '60%', claudeGpt: '60%', argon: '60%', updatedAt: Date.now() } }
  ];
  const codexProfiles = [
    { id: 'c1', name: 'CodexHero', email: 'c1@example.test', accountId: 'acc-1', updatedAt: Date.now(), cachedQuota: { plan: 'PRO', codex5h: '90%', codex7d: '85%', updatedAt: Date.now() } },
    { id: 'c2', name: 'CliCodex', email: 'c2@example.test', accountId: 'acc-2', updatedAt: Date.now(), cachedQuota: { plan: 'PLUS', codex5h: '50%', codex7d: '50%', updatedAt: Date.now() } }
  ];

  const controller = new UIController(
    {
      getState: () => ({ selectedProvider: 'antigravity', activeProfileId: 'a1', activeCodexProfileId: 'c1' }),
      saveState: () => {},
      setSelectedProvider: () => {},
      setSelectedProviderForHost: () => {},
      setActiveCodexProfileId: () => {},
      listProfiles: () => agyProfiles,
      getLiveSessionInfoAsync: async () => ({ email: 'a1@example.test', hasOAuthCreds: true, isExpired: false }),
      updateProfileCachedQuota: () => {},
      updateProfileAuthHealth: () => {}
    },
    {
      getCachedSummary: () => (agyFetchedAt ? { email: 'a1@example.test', planTier: 'PRO', groups: [], fetchedAt: agyFetchedAt } : null),
      getQuotaSummary: async () => {
        agyHeroPulls++;
        agyFetchedAt = Date.now();
        return {
          email: 'a1@example.test',
          planTier: 'PRO',
          groups: [{ displayName: 'Gemini', buckets: [{ remainingFraction: 0.7 }] }],
          fetchedAt: agyFetchedAt
        };
      },
      parseMetrics: () => ({ plan: 'PRO', gemini: '70%', claudeGpt: '70%', argon: '70%', updatedAt: Date.now() }),
      refreshProfileIds: async (_profs, ids) => {
        agyClaimedPulls += ids.size;
        return ids.size;
      },
      refreshAllInactiveProfiles: async () => { agyStandbyPulls++; },
      buildAccountsHoverTooltip: () => 'agy-hover'
    },
    {
      listProfiles: () => codexProfiles,
      getLiveSessionInfo: () => ({ email: 'c1@example.test', accountId: 'acc-1', hasOAuthCreds: true, authMode: 'chatgpt' }),
      findMatchingProfile: () => codexProfiles[0]
    },
    {
      getCachedSummary: () => null,
      getCachedMetric: () => codexProfiles[0].cachedQuota,
      getLastFetchTime: () => codexLastFetch,
      getActiveQuotaSummary: async () => {
        codexHeroPulls++;
        codexLastFetch = Date.now();
        return { summary: { email: 'c1@example.test', accountId: 'acc-1' }, metric: codexProfiles[0].cachedQuota };
      },
      refreshProfileIds: async (ids) => {
        codexClaimedPulls += ids.size;
        return ids.size;
      },
      refreshAllProfiles: async () => { codexStandbyPulls++; return 1; },
      buildCodexHoverTooltip: () => 'codex-hover'
    }
  );
  controller.attachSidebar({
    render: (st) => renders.push(st.selectedProvider)
  });

  try {
    await controller.update(false);
    const baselineAgy = agyHeroPulls;

    // Claim one standby profile on each provider
    const fakeTermA = { name: 'Charlier · Antigravity' };
    const fakeTermC = { name: 'Charlier · Codex' };
    controller.claimedTerminals.set('antigravity:a2', { terminal: fakeTermA, provider: 'antigravity', profileId: 'a2', profileName: 'CliAgy' });
    controller.claimedTerminals.set('codex:c2', { terminal: fakeTermC, provider: 'codex', profileId: 'c2', profileName: 'CliCodex' });

    // Unfocused window pauses ambient auto-refresh tick
    controller.handleWindowFocusChanged(false);
    agyFetchedAt = Date.now() - 120_000;
    await controller.runAutoRefreshTick();
    assert.equal(agyHeroPulls, baselineAgy, 'unfocused ambient tick must pause cleanly');

    // Wayland/macOS interaction fallback: user activity after blur resumes ambient tick
    controller.lastBlurAt = Date.now() - 500;
    controller.noteUserActivity();
    await controller.runAutoRefreshTick();
    assert.equal(agyHeroPulls, baselineAgy + 1, 'active Hero must refresh on focused/active tick');
    assert.equal(agyClaimedPulls, 1, 'CLI CLAIMED Antigravity profile must refresh on active tick');
    assert.equal(codexClaimedPulls, 1, 'CLI CLAIMED Codex profile must refresh on active tick');
    assert.equal(agyStandbyPulls, 0, 'unclaimed standbys must wait for 5m standby tier');

    // Cockpit reopen catch-up refreshes stale active Hero immediately
    agyFetchedAt = Date.now() - 30_000;
    controller.handleCockpitVisibilityChanged(true);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(agyHeroPulls, baselineAgy + 2, 'reopening Cockpit must refresh stale Hero');

    // Focus regain catch-up refreshes stale active Codex Hero when on Codex deck
    await controller.switchProvider('codex');
    codexLastFetch = Date.now() - 30_000;
    const baselineCodex = codexHeroPulls;
    controller.handleWindowFocusChanged(true);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(codexHeroPulls, baselineCodex + 1, 'window focus regain must catch up stale active Codex Hero');

    // Force standby tick refreshes unclaimed standby vaults cleanly
    await controller.runAutoRefreshTick({ forceStandby: true });
    assert.equal(agyStandbyPulls, 1);
    assert.equal(codexStandbyPulls, 1);

    // rateLimits/updated push triggers fast repaint with zero extra wham/usage calls
    const beforePush = codexHeroPulls;
    const beforeRenders = renders.length;
    controller.handleProviderActivity('codex', 'rateLimits/updated');
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(codexHeroPulls, beforePush);
    assert.ok(renders.length > beforeRenders);
  } finally {
    controller.dispose();
  }
});
