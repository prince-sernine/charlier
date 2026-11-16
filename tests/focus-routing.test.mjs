import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const nodeRequire = createRequire(import.meta.url);

function makeEmitter() {
  const listeners = new Set();
  const register = (fn) => {
    listeners.add(fn);
    return { dispose() { listeners.delete(fn); } };
  };
  register.fire = (value) => {
    for (const fn of Array.from(listeners)) {
      fn(value);
    }
  };
  return register;
}

async function createExtensionHarness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-focus-e2e-'));
  const home = path.join(root, 'home');
  const appData = path.join(root, 'appdata');
  const localAppData = path.join(root, 'localappdata');
  const fakeBin = path.join(root, 'bin');
  const geminiDir = path.join(home, '.gemini');
  const codexDir = path.join(home, '.codex');
  const charlierDir = path.join(geminiDir, 'charlier');
  const profilesDir = path.join(charlierDir, 'profiles');
  const codexProfilesDir = path.join(charlierDir, 'providers', 'codex', 'profiles');
  const convDir = path.join(geminiDir, 'antigravity-ide', 'conversations');
  const vsConvDir = path.join(geminiDir, 'antigravity', 'conversations');

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.mkdirSync(codexProfilesDir, { recursive: true });
  fs.mkdirSync(convDir, { recursive: true });
  fs.mkdirSync(vsConvDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });

  for (const name of process.platform === 'win32' ? ['codex.exe', 'agy.exe'] : ['codex', 'agy']) {
    fs.writeFileSync(path.join(fakeBin, name), 'echo ok\n', { mode: 0o755 });
  }

  // Seed vault profiles on disk (both metadata.json per profile folder + state.json)
  fs.mkdirSync(path.join(profilesDir, 'agy-1'), { recursive: true });
  fs.mkdirSync(path.join(profilesDir, 'agy-2'), { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, 'agy-1', 'metadata.json'),
    JSON.stringify({ id: 'agy-1', provider: 'antigravity', name: 'Agy One', email: 'agy1@example.test', updatedAt: Date.now() })
  );
  fs.writeFileSync(
    path.join(profilesDir, 'agy-2', 'metadata.json'),
    JSON.stringify({ id: 'agy-2', provider: 'antigravity', name: 'Agy Two', email: 'agy2@example.test', updatedAt: Date.now() })
  );
  fs.writeFileSync(
    path.join(profilesDir, 'agy-1', 'oauth_creds.json'),
    JSON.stringify({ access_token: 'tok-a1', refresh_token: 'ref-a1', expiry_date: Date.now() + 3600_000 })
  );
  fs.writeFileSync(
    path.join(profilesDir, 'agy-2', 'oauth_creds.json'),
    JSON.stringify({ access_token: 'tok-a2', refresh_token: 'ref-a2', expiry_date: Date.now() + 3600_000 })
  );
  fs.mkdirSync(path.join(codexProfilesDir, 'c-1'), { recursive: true });
  fs.mkdirSync(path.join(codexProfilesDir, 'c-2'), { recursive: true });
  fs.writeFileSync(
    path.join(codexProfilesDir, 'c-1', 'metadata.json'),
    JSON.stringify({ id: 'c-1', provider: 'codex', name: 'Codex One', email: 'c1@example.test', accountId: 'acc-1', updatedAt: Date.now() })
  );
  fs.writeFileSync(
    path.join(codexProfilesDir, 'c-2', 'metadata.json'),
    JSON.stringify({ id: 'c-2', provider: 'codex', name: 'Codex Two', email: 'c2@example.test', accountId: 'acc-2', updatedAt: Date.now() })
  );
  fs.writeFileSync(
    path.join(codexProfilesDir, 'c-1', 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'x', access_token: 'c1', refresh_token: 'r1', account_id: 'acc-1' } })
  );
  fs.writeFileSync(
    path.join(codexProfilesDir, 'c-2', 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'x', access_token: 'c2', refresh_token: 'r2', account_id: 'acc-2' } })
  );
  fs.writeFileSync(
    path.join(charlierDir, 'state.json'),
    JSON.stringify({
      selectedProvider: 'antigravity',
      activeProfileId: 'agy-1',
      activeCodexProfileId: 'c-1',
      profiles: [
        { id: 'agy-1', provider: 'antigravity', name: 'Agy One', email: 'agy1@example.test', updatedAt: Date.now() },
        { id: 'agy-2', provider: 'antigravity', name: 'Agy Two', email: 'agy2@example.test', updatedAt: Date.now() }
      ],
      codexProfiles: [
        { id: 'c-1', provider: 'codex', name: 'Codex One', email: 'c1@example.test', accountId: 'acc-1', updatedAt: Date.now() },
        { id: 'c-2', provider: 'codex', name: 'Codex Two', email: 'c2@example.test', accountId: 'acc-2', updatedAt: Date.now() }
      ],
      lastUpdated: Date.now()
    })
  );

  const prevEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    PATH: process.env.PATH,
    Path: process.env.Path
  };
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CODEX_HOME = codexDir;
  process.env.APPDATA = appData;
  process.env.LOCALAPPDATA = localAppData;
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
  process.env[pathKey] = `${fakeBin}${path.delimiter}${prevEnv[pathKey] || ''}`;

  const onDidChangeActiveTextEditor = makeEmitter();
  const onDidChangeVisibleTextEditors = makeEmitter();
  const onDidChangeTabs = makeEmitter();
  const onDidChangeActiveTerminal = makeEmitter();
  const onDidCloseTerminal = makeEmitter();
  const onDidStartTerminalShellExecution = makeEmitter();
  const onDidEndTerminalShellExecution = makeEmitter();
  const onDidChangeWindowState = makeEmitter();
  const onDidChangeConfiguration = makeEmitter();
  const onDidChangeExtensions = makeEmitter();

  const registeredCommands = new Map();
  const webviewMessages = [];
  let webviewViewHandler = null;
  let webviewProvider = null;
  let statusBarItem = null;
  const terminals = [];

  let codexExtensionActive = false;

  const vscode = {
    StatusBarAlignment: { Right: 2 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class {
      value = '';
      appendMarkdown(v) { this.value += v; }
    },
    Uri: {
      parse: (u) => ({ toString: () => String(u), fsPath: String(u), path: String(u), scheme: String(u).split(':')[0] || 'file' }),
      file: (p) => ({ toString: () => `file://${p}`, fsPath: p, path: p, scheme: 'file' })
    },
    env: { appName: options.appName || 'Antigravity', openExternal: async () => true },
    extensions: {
      get all() {
        return codexExtensionActive
          ? [{ id: 'openai.chatgpt', isActive: true, extensionPath: '' }]
          : [];
      },
      getExtension: (id) =>
        id === 'openai.chatgpt'
          ? { id: 'openai.chatgpt', isActive: codexExtensionActive, extensionPath: '' }
          : undefined,
      onDidChange: onDidChangeExtensions
    },
    commands: {
      registerCommand: (id, fn) => {
        registeredCommands.set(id, fn);
        return { dispose() { registeredCommands.delete(id); } };
      },
      executeCommand: async (id, ...args) => {
        const fn = registeredCommands.get(id);
        return fn ? await fn(...args) : undefined;
      }
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({ get: (_k, fallback) => fallback }),
      onDidChangeConfiguration
    },
    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      activeTerminal: undefined,
      terminals,
      state: { focused: true },
      tabGroups: {
        all: [{ tabs: [], activeTab: undefined }],
        get activeTabGroup() {
          return this.all.find((g) => g.isActive) || this.all[0];
        },
        onDidChangeTabs
      },
      onDidChangeActiveTextEditor,
      onDidChangeVisibleTextEditors,
      onDidChangeActiveTerminal,
      onDidCloseTerminal,
      onDidStartTerminalShellExecution,
      onDidEndTerminalShellExecution,
      onDidChangeWindowState,
      createStatusBarItem: (_align, priority) => {
        statusBarItem = {
          priority,
          text: '',
          color: undefined,
          backgroundColor: undefined,
          accessibilityInformation: undefined,
          tooltip: undefined,
          show() {},
          hide() {},
          dispose() {}
        };
        return statusBarItem;
      },
      createTerminal: (opts) => {
        const term = {
          name: opts?.name || String(opts),
          options: opts,
          show() { vscode.window.activeTerminal = term; },
          sendText() {},
          dispose() {}
        };
        terminals.push(term);
        return term;
      },
      registerWebviewViewProvider: (_id, provider) => {
        webviewProvider = provider;
        provider.resolveWebviewView({
          visible: true,
          onDidDispose: makeEmitter(),
          onDidChangeVisibility: makeEmitter(),
          webview: {
            options: {},
            html: '',
            postMessage: async (msg) => { webviewMessages.push(msg); return true; },
            onDidReceiveMessage: (fn) => { webviewViewHandler = fn; return { dispose() {} }; }
          }
        });
        return { dispose() {} };
      },
      setStatusBarMessage: () => ({ dispose() {} }),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined
    }
  };

  const built = await esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
    logLevel: 'silent'
  });

  const osProxy = { ...os, homedir: () => home };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', built.outputFiles[0].text)(
    (name) => (name === 'vscode' ? vscode : name === 'os' ? osProxy : nodeRequire(name)),
    mod,
    mod.exports,
    path.resolve('dist')
  );

  const subscriptions = [];
  const context = {
    extensionPath: root,
    subscriptions,
    workspaceState: { get: () => undefined, update: async () => {} }
  };

  await mod.exports.activate(context);
  await wait(120);

  const lastSelectedProvider = () => {
    for (let i = webviewMessages.length - 1; i >= 0; i--) {
      const m = webviewMessages[i];
      if (m && typeof m.selectedProvider === 'string') return m.selectedProvider;
    }
    return statusBarItem?.text?.includes('Codex') || statusBarItem?.text?.includes('charlier-codex-prompt')
      ? 'codex'
      : 'antigravity';
  };

  return {
    root,
    home,
    convDir,
    vsConvDir,
    vscode,
    statusBarItem,
    terminals,
    webviewMessages,
    lastSelectedProvider,
    sendWebviewAction: (msg) => webviewViewHandler?.(msg),
    setCodexExtensionActive: (v) => {
      codexExtensionActive = v;
      onDidChangeExtensions.fire();
    },
    emitters: {
      onDidChangeActiveTextEditor,
      onDidChangeVisibleTextEditors,
      onDidChangeTabs,
      onDidChangeActiveTerminal,
      onDidCloseTerminal,
      onDidStartTerminalShellExecution,
      onDidEndTerminalShellExecution,
      onDidChangeWindowState
    },
    dispose: () => {
      for (const s of subscriptions) {
        try { s?.dispose?.(); } catch {}
      }
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('extension activate E2E: closing Antigravity CLI terminal never flips back to Codex after shell command ends', async () => {
  const env = await createExtensionHarness();
  try {
    assert.equal(env.lastSelectedProvider(), 'antigravity');

    // A separate shell terminal runs `codex`, finishes, and exits codex process
    const otherTerm = { name: 'bash', show() {}, sendText() {}, dispose() {} };
    env.terminals.push(otherTerm);
    env.emitters.onDidStartTerminalShellExecution.fire({
      terminal: otherTerm,
      execution: { commandLine: { value: 'codex --no-daemon' } }
    });
    await wait(120);
    assert.equal(env.lastSelectedProvider(), 'codex', 'active codex command flips to Codex');

    env.emitters.onDidEndTerminalShellExecution.fire({
      terminal: otherTerm,
      execution: { commandLine: { value: 'codex --no-daemon' } }
    });

    // Focus Antigravity artifact to auto-switch back to Antigravity without manual pin, then spawn CLI Only on agy-2
    env.emitters.onDidChangeActiveTextEditor.fire({
      document: {
        uri: {
          toString: () => 'file:///C:/Users/dev/.gemini/antigravity-ide/brain/conv-1/task.md',
          scheme: 'file',
          path: '/C:/Users/dev/.gemini/antigravity-ide/brain/conv-1/task.md',
          fsPath: 'C:\\Users\\dev\\.gemini\\antigravity-ide\\brain\\conv-1\\task.md'
        }
      }
    });
    await wait(120);
    await env.sendWebviewAction({
      type: 'SWITCH_PROFILE',
      provider: 'antigravity',
      profileId: 'agy-2',
      cliOnly: true
    });
    await wait(120);
    assert.equal(env.lastSelectedProvider(), 'antigravity');
    const agyTerm = env.terminals.find((t) => t.name.includes('Antigravity'));
    assert.ok(agyTerm, 'Antigravity CLI terminal should have been created');

    // Close the Antigravity CLI terminal while VS Code fires onDidChangeActiveTerminal -> otherTerm
    const idx = env.terminals.indexOf(agyTerm);
    if (idx >= 0) env.terminals.splice(idx, 1);
    env.emitters.onDidCloseTerminal.fire(agyTerm);
    env.emitters.onDidChangeActiveTerminal.fire(otherTerm);
    await wait(120);

    assert.equal(
      env.lastSelectedProvider(),
      'antigravity',
      'closing Antigravity CLI terminal must NOT flip Cockpit to Codex'
    );

    // Wait past the 400ms close guard, then explicitly focus a Codex-named terminal -> DOES flip to Codex
    await wait(450);
    const codexTerm = { name: 'Charlier · Codex (Codex Two)', show() {}, sendText() {}, dispose() {} };
    env.emitters.onDidChangeActiveTerminal.fire(codexTerm);
    await wait(120);
    assert.equal(env.lastSelectedProvider(), 'codex', 'explicitly focusing Codex terminal later flips to Codex');
  } finally {
    env.dispose();
  }
});

test('extension activate E2E: lazy Codex activation + artifacts/conversations/tabs auto-switch back and forth across OSes', async () => {
  const env = await createExtensionHarness();
  try {
    // Wait past CredentialWatcher startup grace (2000ms) for antigravity-ide conversation writes
    await wait(2150);

    // Activate Codex lazily (>2s after boot) and open a visible chatgpt output/panel
    env.setCodexExtensionActive(true);
    env.emitters.onDidChangeVisibleTextEditors.fire([
      { document: { uri: { toString: () => 'output:openai.chatgpt.Codex', scheme: 'output', path: 'openai.chatgpt.Codex' }, fileName: '' } }
    ]);
    await wait(120);
    assert.equal(env.lastSelectedProvider(), 'codex', 'visible Codex output editor flips to Codex');

    // Focus Antigravity artifact inside .gemini/antigravity-ide/brain/ via active editor
    env.emitters.onDidChangeActiveTextEditor.fire({
      document: {
        uri: {
          toString: () => 'file:///C:/Users/dev/.gemini/antigravity-ide/brain/conv-1/task.md',
          scheme: 'file',
          path: '/C:/Users/dev/.gemini/antigravity-ide/brain/conv-1/task.md',
          fsPath: 'C:\\Users\\dev\\.gemini\\antigravity-ide\\brain\\conv-1\\task.md'
        },
        fileName: 'C:\\Users\\dev\\.gemini\\antigravity-ide\\brain\\conv-1\\task.md'
      }
    });
    await wait(120);
    assert.equal(env.lastSelectedProvider(), 'antigravity', 'Antigravity brain artifact editor flips back to Antigravity');

    // Flip back to Codex via chatgpt tab group
    env.vscode.window.tabGroups.all = [
      {
        isActive: true,
        activeTab: { label: 'Codex', input: { viewType: 'chatgpt.sidebar' } },
        tabs: []
      }
    ];
    env.emitters.onDidChangeTabs.fire({});
    await wait(120);
    assert.equal(env.lastSelectedProvider(), 'codex', 'Codex webview tab switches back to Codex');

    // Active Antigravity conversation write in ~/.gemini/antigravity-ide/conversations/*.pb flips back to Antigravity via stream signal
    fs.writeFileSync(path.join(env.convDir, 'conv-live.pb'), Buffer.from('turn-data'));
    await wait(300);
    assert.equal(env.lastSelectedProvider(), 'antigravity', 'live Antigravity conversation write flips back to Antigravity');
  } finally {
    env.dispose();
  }
});

test('Codex attachStdoutObserver ignores initial thread/read warmup (<=1200ms) and detects turn/start + post-warmup thread/read', async () => {
  const built = await esbuild.build({
    entryPoints: ['src/codex.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
    logLevel: 'silent'
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', built.outputFiles[0].text)(
    (name) => (name === 'vscode' ? {} : nodeRequire(name)),
    mod,
    mod.exports,
    path.resolve('dist')
  );
  const { CodexQuotaService } = mod.exports;
  const svc = new CodexQuotaService();
  let signals = 0;
  svc.onActivity(() => { signals++; });

  const stdout = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.write = () => true;
  const fakeProc = {
    pid: 999999,
    exitCode: null,
    signalCode: null,
    killed: false,
    spawnfile: 'codex',
    spawnargs: ['codex', 'app-server'],
    stdout,
    stdin,
    once() {}
  };

  const prevGetHandles = process._getActiveHandles;
  process._getActiveHandles = () => [fakeProc];
  try {
    assert.equal(svc.ensureStdoutObserver(), true);

    // Within 1200ms warmup window: thread/read does NOT fire, turn/start DOES fire
    fakeProc.stdin.write(JSON.stringify({ id: 1, method: 'thread/read' }) + '\n');
    assert.equal(signals, 0, 'warmup thread/read should be ignored');

    fakeProc.stdin.write(JSON.stringify({ id: 2, method: 'turn/start' }) + '\n');
    assert.equal(signals, 1, 'turn/start always fires');

    // Internal charlier-* probes never fire activity
    fakeProc.stdin.write(JSON.stringify({ id: 'charlier-1', method: 'turn/start' }) + '\n');
    assert.equal(signals, 1);

    // After >1200ms: user opening a Codex thread triggers thread/read activity
    await wait(1260);
    fakeProc.stdin.write(JSON.stringify({ id: 3, method: 'thread/read' }) + '\n');
    assert.equal(signals, 2, 'post-warmup thread/read should signal Codex focus');
  } finally {
    process._getActiveHandles = prevGetHandles;
  }
});

test('detectProviderFromTerminalCommand handles quotes, backslashes, call operator, wrappers, and nested shells across OSes', async () => {
  const built = await esbuild.build({
    entryPoints: ['src/quota-values.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
    logLevel: 'silent'
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', built.outputFiles[0].text)(
    (name) => (name === 'vscode' ? {} : nodeRequire(name)),
    mod,
    mod.exports,
    path.resolve('dist')
  );
  const { detectProviderFromTerminalCommand } = mod.exports;

  assert.equal(detectProviderFromTerminalCommand('"C:\\Users\\dev\\proj\\" && codex'), 'codex');
  assert.equal(detectProviderFromTerminalCommand("& 'C:\\Program Files\\Codex\\codex.exe' --no-daemon"), 'codex');
  assert.equal(detectProviderFromTerminalCommand('cmd /c "codex --no-daemon"'), 'codex');
  assert.equal(detectProviderFromTerminalCommand('bash -lc "agy --help"'), 'antigravity');
  assert.equal(detectProviderFromTerminalCommand('npx -y @openai/codex@latest'), 'codex');
  assert.equal(detectProviderFromTerminalCommand('cross-env NODE_ENV=prod dotenvx run -- codex'), 'codex');
  assert.equal(detectProviderFromTerminalCommand('git status && npm test'), null);
  assert.equal(detectProviderFromTerminalCommand('echo codex'), null);
});

test('VS Code host ignores antigravity-ide background streams, .done/.db-shm noise, unfocused windows, and codex workspace diffs', async () => {
  const env = await createExtensionHarness({ appName: 'Visual Studio Code' });
  try {
    await wait(2150);

    // Boot in VS Code -> focus Codex tab first (needs active Codex runtime in VS Code)
    env.setCodexExtensionActive(true);
    env.vscode.window.tabGroups.all = [
      {
        isActive: true,
        activeTab: { label: 'Codex', input: { viewType: 'chatgpt.panelView' } },
        tabs: []
      }
    ];
    env.emitters.onDidChangeTabs.fire({});
    await wait(120);
    assert.equal(env.lastSelectedProvider(), 'codex');

    // Antigravity IDE background conversation writes must NOT hijack standard VS Code Codex focus
    fs.writeFileSync(path.join(env.convDir, 'bg-ide.db-wal'), Buffer.from('ide-turn'));
    await wait(260);
    assert.equal(env.lastSelectedProvider(), 'codex', 'VS Code host must ignore antigravity-ide conversation writes');

    // Background .done and .db-shm markers in ~/.gemini/antigravity/conversations must NOT flip focus
    fs.writeFileSync(path.join(env.vsConvDir, '.c1.done'), Buffer.from(''));
    fs.writeFileSync(path.join(env.vsConvDir, 'c1.db-shm'), Buffer.from('shm'));
    await wait(260);
    assert.equal(env.lastSelectedProvider(), 'codex', 'idle .done and .db-shm writes must not trigger auto-switch');

    // Real conversation turn while window is unfocused must NOT flip VS Code
    env.vscode.window.state.focused = false;
    fs.writeFileSync(path.join(env.vsConvDir, 'c1.db-wal'), Buffer.from('turn-while-unfocused'));
    await wait(260);
    assert.equal(env.lastSelectedProvider(), 'codex', 'unfocused window must ignore stream signals');

    // Git diff tab on user file named codex-notes.md stays ignored; active focused Antigravity turn flips back
    env.vscode.window.state.focused = true;
    env.vscode.window.tabGroups.all = [
      {
        isActive: true,
        activeTab: {
          label: 'codex-notes.md (Working Tree)',
          input: {
            modified: { scheme: 'file', path: '/repo/codex-notes.md', fsPath: 's:\\repo\\codex-notes.md' },
            original: { scheme: 'git', path: '/repo/codex-notes.md', fsPath: 's:\\repo\\codex-notes.md' }
          }
        },
        tabs: []
      }
    ];
    env.emitters.onDidChangeTabs.fire({});
    await wait(120);
    assert.equal(env.lastSelectedProvider(), 'codex');

    fs.writeFileSync(path.join(env.vsConvDir, 'c2.db-wal'), Buffer.from('foreground-turn'));
    await wait(300);
    assert.equal(env.lastSelectedProvider(), 'antigravity', 'focused VS Code Antigravity turn switches to Antigravity');
  } finally {
    env.dispose();
  }
});

test('isCodexAppServerProcess matches shell:true spawns across OSes and CodexQuotaService notifies on process exit', async () => {
  const built = await esbuild.build({
    entryPoints: ['src/codex.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
    logLevel: 'silent'
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', built.outputFiles[0].text)(
    (name) => (name === 'vscode' ? {} : nodeRequire(name)),
    mod,
    mod.exports,
    path.resolve('dist')
  );
  const qvBuilt = await esbuild.build({
    entryPoints: ['src/quota-values.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
    logLevel: 'silent'
  });
  const qvMod = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', qvBuilt.outputFiles[0].text)(
    (name) => (name === 'vscode' ? {} : nodeRequire(name)),
    qvMod,
    qvMod.exports,
    path.resolve('dist')
  );
  const { isCodexAppServerProcess } = qvMod.exports;
  assert.equal(
    isCodexAppServerProcess({
      exitCode: null,
      signalCode: null,
      killed: false,
      spawnfile: 'C:\\Windows\\system32\\cmd.exe',
      spawnargs: ['C:\\Windows\\system32\\cmd.exe', '/d', '/s', '/c', '"codex.exe app-server"']
    }),
    true
  );
  assert.equal(
    isCodexAppServerProcess({
      exitCode: null,
      signalCode: null,
      killed: false,
      spawnfile: '/bin/sh',
      spawnargs: ['/bin/sh', '-c', 'codex app-server']
    }),
    true
  );
  assert.equal(
    isCodexAppServerProcess({
      exitCode: null,
      signalCode: null,
      killed: false,
      spawnfile: '/bin/sh',
      spawnargs: ['/bin/sh', '-c', 'echo app-server']
    }),
    false
  );

  const svc = new mod.exports.CodexQuotaService();
  let signals = 0;
  let exits = 0;
  svc.onActivity(() => { signals++; });
  svc.onProcessExited(() => { exits++; });

  const proc1 = new EventEmitter();
  Object.assign(proc1, {
    exitCode: null,
    signalCode: null,
    killed: false,
    spawnfile: '/bin/sh',
    spawnargs: ['/bin/sh', '-c', 'codex app-server'],
    stdout: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: () => true })
  });

  const prevGetHandles = process._getActiveHandles;
  let active = [proc1];
  process._getActiveHandles = () => active;
  try {
    assert.equal(svc.ensureStdoutObserver(), true);
    proc1.stdin.write(JSON.stringify({ id: 10, method: 'thread/readState/update' }) + '\n');
    assert.equal(signals, 1);

    proc1.exitCode = 0;
    proc1.emit('exit', 0);
    assert.equal(exits, 1, 'exit must trigger re-arm notification');

    const proc2 = new EventEmitter();
    Object.assign(proc2, {
      exitCode: null,
      signalCode: null,
      killed: false,
      spawnfile: 'cmd.exe',
      spawnargs: ['cmd.exe', '/c', 'codex.exe app-server'],
      stdout: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { write: () => true })
    });
    active = [proc2];
    assert.equal(svc.ensureStdoutObserver(), true);
    proc2.stdin.write(JSON.stringify({ id: 11, method: 'turn/steer' }) + '\n');
    assert.equal(signals, 2, 're-armed shell:true replacement process must emit activity');
  } finally {
    process._getActiveHandles = prevGetHandles;
  }
});
