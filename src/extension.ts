import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Vault } from './vault';
import { UIController } from './ui';
import { CredentialWatcher } from './watcher';
import { KeyringManager } from './keyring';
import { QuotaService } from './quota';
import { CodexVault, CodexQuotaService } from './codex';
import { CharlierSidebarProvider } from './sidebar';
import { confirmGeneralExtensionHostRestart } from './providers';
import { detectProviderFromTerminalCommand, sortProfilesForDisplay } from './quota-values';
import {
  getActiveCodexAuthPath,
  getActiveGoogleAccountsPath,
  getActiveOAuthCredsPath,
  getCodexProfilesDir,
  getIdeGlobalStorageDirs,
  getProfilesDir
} from './constants';
import { ActiveProviderId } from './types';

let uiController: UIController | null = null;
let watcher: CredentialWatcher | null = null;
let quotaService: QuotaService | null = null;
let vaultInstance: Vault | null = null;
let codexVaultInstance: CodexVault | null = null;
let codexQuotaService: CodexQuotaService | null = null;
let sidebarProvider: CharlierSidebarProvider | null = null;
let keyringInstance: KeyringManager | null = null;
let focusFollowUpTimer: NodeJS.Timeout | null = null;
let focusSecondFollowUpTimer: NodeJS.Timeout | null = null;
let focusThirdFollowUpTimer: NodeJS.Timeout | null = null;
let startupUnsavedTimer: NodeJS.Timeout | null = null;
let startupHeartbeatTimer: NodeJS.Timeout | null = null;
let observerRetryTimers: NodeJS.Timeout[] = [];

function clearExtensionTimers(): void {
  for (const timer of observerRetryTimers) {
    clearTimeout(timer);
  }
  observerRetryTimers = [];
  if (focusFollowUpTimer) {
    clearTimeout(focusFollowUpTimer);
    focusFollowUpTimer = null;
  }
  if (focusSecondFollowUpTimer) {
    clearTimeout(focusSecondFollowUpTimer);
    focusSecondFollowUpTimer = null;
  }
  if (focusThirdFollowUpTimer) {
    clearTimeout(focusThirdFollowUpTimer);
    focusThirdFollowUpTimer = null;
  }
  if (startupUnsavedTimer) {
    clearTimeout(startupUnsavedTimer);
    startupUnsavedTimer = null;
  }
  if (startupHeartbeatTimer) {
    clearTimeout(startupHeartbeatTimer);
    startupHeartbeatTimer = null;
  }
}

function detectProviderFromToken(raw: string): ActiveProviderId | null {
  const lower = (raw || '').toLowerCase();
  if (!lower || lower.includes('charlier')) return null;
  if (
    lower.includes('openai.chatgpt') ||
    lower.includes('chatgpt.') ||
    /\bchatgpt[-_]/.test(lower) ||
    lower.includes('openai-codex') ||
    lower.includes('codexviewcontainer') ||
    lower.includes('codexsecondaryviewcontainer') ||
    /\bcodex[-_./]/.test(lower) ||
    lower.endsWith('.codex') ||
    lower === 'codex'
  ) {
    return 'codex';
  }
  if (
    lower.includes('antigravity') ||
    lower.includes('jetski.') ||
    lower.includes('jetski-')
  ) {
    return 'antigravity';
  }
  return null;
}

export function detectProviderFromUri(uri: any): ActiveProviderId | null {
  if (!uri || typeof uri !== 'object') return null;
  const scheme = String(uri.scheme || '').toLowerCase();
  const uriPath = String(uri.path || uri.fsPath || '');
  if (scheme === 'file' || scheme === 'untitled') {
    if (
      scheme === 'file' &&
      /[\\/]\.gemini[\\/](?:antigravity|antigravity-ide)[\\/](?:brain|annotations|conversations)[\\/]/i.test(
        uriPath
      )
    ) {
      return 'antigravity';
    }
    return null;
  }
  return (
    detectProviderFromToken(scheme) ||
    detectProviderFromToken(uri.authority || '') ||
    (scheme === 'output' ? detectProviderFromToken(uriPath) : null)
  );
}

function isFileOrUntitledUri(uri: any): boolean {
  const scheme = String(uri?.scheme || '').toLowerCase();
  return scheme === 'file' || scheme === 'untitled';
}

function detectProviderFromTab(
  tab: vscode.Tab | undefined
): ActiveProviderId | null {
  if (!tab) return null;
  const input = tab.input as any;
  if (input && typeof input === 'object') {
    if (typeof input.viewType === 'string') {
      const byViewType = detectProviderFromToken(input.viewType);
      if (byViewType) return byViewType;
    }
    if (typeof input.id === 'string') {
      const byId = detectProviderFromToken(input.id);
      if (byId) return byId;
    }
    const byMainUri =
      detectProviderFromUri(input.uri) ||
      detectProviderFromUri(input.sourceUri) ||
      detectProviderFromUri(input.modified) ||
      detectProviderFromUri(input.original);
    if (byMainUri) return byMainUri;
  }
  const hasDiskUri = Boolean(
    isFileOrUntitledUri(input?.uri) ||
      isFileOrUntitledUri(input?.modified) ||
      isFileOrUntitledUri(input?.original)
  );
  if (!hasDiskUri && typeof tab.label === 'string') {
    const lowerLabel = tab.label.toLowerCase();
    if (lowerLabel.includes('charlier')) return null;
    if (lowerLabel === 'codex' || lowerLabel.startsWith('codex ')) {
      return 'codex';
    }
    if (lowerLabel === 'antigravity' || lowerLabel.startsWith('antigravity ')) {
      return 'antigravity';
    }
  }
  return null;
}

function parseCommandStringArg(arg: any): string {
  let raw = arg;
  if (Array.isArray(arg) && arg.length > 0) {
    raw = arg[0];
  }
  let str: string;
  if (typeof raw === 'string') {
    try {
      str = decodeURIComponent(raw);
    } catch {
      str = raw;
    }
  } else {
    str = String(raw || '');
  }
  if (str.startsWith('"') && str.endsWith('"')) {
    try {
      str = JSON.parse(str);
    } catch {}
  }
  return str.trim();
}

export function activate(context: vscode.ExtensionContext): void {
  const keyring = new KeyringManager(context.extensionPath);
  keyringInstance = keyring;
  vaultInstance = new Vault(keyring);
  quotaService = new QuotaService();
  codexVaultInstance = new CodexVault();
  codexQuotaService = new CodexQuotaService();
  codexQuotaService.primeActiveAccountKey(codexVaultInstance);

  uiController = new UIController(
    vaultInstance,
    quotaService,
    codexVaultInstance,
    codexQuotaService
  );
  codexQuotaService.setClaimedProfileIdsProvider(
    () => uiController?.getClaimedProfileIds('codex') ?? new Set()
  );
  quotaService.setClaimedProfileIdsProvider(
    () => uiController?.getClaimedProfileIds('antigravity') ?? new Set()
  );

  sidebarProvider = new CharlierSidebarProvider(
    uiController.getSidebarCallbacks()
  );
  uiController.attachSidebar(sidebarProvider);

  // Initial UI render + tiered focus-aware live telemetry loop
  uiController.update().catch(() => {});
  uiController.startAutoRefreshLoop();

  // Watcher automatically updates the status bar/cockpit, hot-swaps any local Codex app-server
  // if switched from another window, and probes if a new account logged in externally
  const statToken = (p: string): string => {
    try {
      const s = fs.statSync(p);
      return `${Math.round(s.mtimeMs)}:${s.size}`;
    } catch {
      return '0';
    }
  };

  let lastWatcherCodexStat = statToken(getActiveCodexAuthPath());
  let lastFocusFingerprint: string | null = null;

  const getActiveStorageStats = (): string => {
    if (!uiController?.isAwaitingNewLogin()) return '';
    const stats: string[] = [];
    for (const dir of getIdeGlobalStorageDirs()) {
      for (const fileName of ['state.vscdb', 'state.vscdb-wal']) {
        const full = path.join(dir, fileName);
        if (fs.existsSync(full)) {
          stats.push(`${full}:${statToken(full)}`);
        }
      }
    }
    return stats.join(';');
  };

  const captureAuthFingerprint = async (): Promise<string> => {
    const [agyLive, codexLive] = await Promise.all([
      vaultInstance
        ? vaultInstance.getLiveSessionInfoAsync().catch(() => null)
        : Promise.resolve(null),
      Promise.resolve(
        codexVaultInstance ? codexVaultInstance.getLiveSessionInfo() : null
      )
    ]);
    let daemonIdentity = '';
    if ((!agyLive?.email || uiController?.isAwaitingNewLogin?.()) && quotaService) {
      const peeked = await quotaService.peekDaemonIdentityAsync().catch(() => null);
      if (peeked?.email) {
        daemonIdentity = `${peeked.email}:${peeked.authStatus || 'ok'}`;
      }
    }
    return [
      agyLive?.email || '',
      daemonIdentity,
      agyLive?.tokenExpiryDate || '',
      agyLive?.hasOAuthCreds ? '1' : '0',
      statToken(getActiveOAuthCredsPath()),
      statToken(getActiveGoogleAccountsPath()),
      getActiveStorageStats(),
      codexLive?.accountId || '',
      codexLive?.email || '',
      codexLive?.tokenExpiryDate || '',
      codexLive?.hasOAuthCreds ? '1' : '0',
      statToken(getActiveCodexAuthPath())
    ].join('|');
  };

  let fingerprintEpoch = 0;

  const refreshBaselineFingerprints = async (): Promise<void> => {
    const epoch = ++fingerprintEpoch;
    lastWatcherCodexStat = statToken(getActiveCodexAuthPath());
    const fp = await captureAuthFingerprint().catch(() => null);
    if (fp !== null && epoch === fingerprintEpoch) {
      lastFocusFingerprint = fp;
    }
  };

  void refreshBaselineFingerprints();

  const isAntigravityIdeHost = (vscode.env?.appName || '')
    .toLowerCase()
    .includes('antigravity');
  const agConfig = vscode.workspace?.getConfiguration?.('antigravity');
  const agServerArgs = agConfig?.get<string[]>('serverArgs', []);
  const explicitIdeAppData =
    Boolean(agConfig?.get<boolean>('isAntigravityIde', false)) ||
    (Array.isArray(agServerArgs) &&
      agServerArgs.some((arg) => String(arg || '').includes('antigravity-ide')));
  const antigravityActivitySubdirs =
    isAntigravityIdeHost || explicitIdeAppData
      ? ['antigravity', 'antigravity-ide']
      : ['antigravity'];

  watcher = new CredentialWatcher(
    () => {
      void (async () => {
        const epoch = fingerprintEpoch;
        vaultInstance?.invalidateLiveSessionCache();
        codexVaultInstance?.invalidateLiveSessionCache();
        const nextFp = await captureAuthFingerprint().catch(() => null);
        if (epoch !== fingerprintEpoch) {
          return;
        }
        if (
          nextFp !== null &&
          lastFocusFingerprint !== null &&
          nextFp === lastFocusFingerprint
        ) {
          return;
        }
        if (nextFp !== null) {
          lastFocusFingerprint = nextFp;
        }
        const curCodexStat = statToken(getActiveCodexAuthPath());
        const codexChanged = curCodexStat !== lastWatcherCodexStat;
        lastWatcherCodexStat = curCodexStat;
        if (codexChanged) {
          codexQuotaService?.invalidateCache();
          if (codexVaultInstance) {
            codexQuotaService
              ?.syncExternalAuthChange(codexVaultInstance)
              .catch(() => {});
          }
        } else {
          quotaService?.invalidate();
        }
        uiController?.scheduleUpdate(30, true);
        if (codexChanged && uiController?.getSelectedProvider() === 'codex') {
          uiController?.scheduleUpdate(60, false);
        } else if (!codexChanged && uiController?.getSelectedProvider() === 'antigravity') {
          uiController?.scheduleUpdate(60, false);
        }
        uiController?.checkForNewUnsavedAccount(
          codexChanged ? 'codex' : 'antigravity'
        );
      })();
    },
    {
      shouldWatchIdeStorage: () => Boolean(uiController?.isAwaitingNewLogin()),
      antigravityActivitySubdirs,
      onAntigravityActivity: () => {
        if (vscode.window.state?.focused === false) {
          return;
        }
        uiController?.handleFocusSignal('antigravity', 'stream');
        uiController?.handleProviderActivity('antigravity', 'stream');
      }
    }
  );
  uiController.attachWatcherMuter((ms) => watcher?.muteFor(ms));
  uiController.attachWatcherShortener?.((maxMs) => watcher?.shortenMute(maxMs));
  uiController.attachCredentialsMutatedListener(() => {
    void refreshBaselineFingerprints();
  });

  // Check for unsaved/new account and run read-only auth heartbeat shortly after startup
  startupUnsavedTimer = setTimeout(() => {
    startupUnsavedTimer = null;
    uiController?.checkForNewUnsavedAccount();
  }, 1500);

  let codexObserverPoll: NodeJS.Timeout | null = null;
  const ensureCodexObserverArmed = () => {
    if (codexQuotaService?.ensureStdoutObserver()) {
      if (codexObserverPoll) {
        clearInterval(codexObserverPoll);
        codexObserverPoll = null;
      }
      return;
    }
    if (!codexObserverPoll && vscode.extensions?.getExtension?.('openai.chatgpt')) {
      codexObserverPoll = setInterval(() => {
        if (codexQuotaService?.ensureStdoutObserver()) {
          if (codexObserverPoll) {
            clearInterval(codexObserverPoll);
            codexObserverPoll = null;
          }
        }
      }, 600);
      (codexObserverPoll as any)?.unref?.();
    }
  };

  startupHeartbeatTimer = setTimeout(() => {
    startupHeartbeatTimer = null;
    ensureCodexObserverArmed();
    uiController?.runStartupAuthHeartbeat().catch(() => {});
  }, 700);

  for (const delay of [1500, 4000]) {
    const retryTimer = setTimeout(() => {
      ensureCodexObserverArmed();
    }, delay);
    (retryTimer as any)?.unref?.();
    observerRetryTimers.push(retryTimer);
  }

  // Check when window regains focus (e.g. returning from browser OAuth login),
  // deduplicated by live auth fingerprint so unchanged Alt+Tabs cost zero daemon/UI work
  // while still letting the live telemetry controller catch up stale Hero/CLI meters.
  const windowFocusSub = vscode.window.onDidChangeWindowState((state) => {
    uiController?.handleWindowFocusChanged(Boolean(state.focused));
    if (state.focused) {
      if (focusFollowUpTimer) clearTimeout(focusFollowUpTimer);
      if (focusSecondFollowUpTimer) clearTimeout(focusSecondFollowUpTimer);
      if (focusThirdFollowUpTimer) clearTimeout(focusThirdFollowUpTimer);
      ensureCodexObserverArmed();

      const probeFocusState = async () => {
        if (uiController?.isSwitchInFlightOrSuppressed()) {
          return;
        }
        const epoch = fingerprintEpoch;
        vaultInstance?.invalidateLiveSessionCache();
        codexVaultInstance?.invalidateLiveSessionCache();
        const nextFp = await captureAuthFingerprint().catch(() => null);
        if (epoch !== fingerprintEpoch) {
          return;
        }
        if (
          nextFp !== null &&
          lastFocusFingerprint !== null &&
          nextFp === lastFocusFingerprint
        ) {
          return;
        }
        if (nextFp !== null) {
          lastFocusFingerprint = nextFp;
        }
        const curCodexStat = statToken(getActiveCodexAuthPath());
        const codexChanged = curCodexStat !== lastWatcherCodexStat;
        lastWatcherCodexStat = curCodexStat;
        if (codexChanged) {
          codexQuotaService?.invalidateCache();
          if (codexVaultInstance) {
            codexQuotaService
              ?.syncExternalAuthChange(codexVaultInstance)
              .catch(() => {});
          }
        } else {
          quotaService?.invalidate();
        }
        uiController?.scheduleUpdate(30, true);
        if (codexChanged && uiController?.getSelectedProvider() === 'codex') {
          uiController?.scheduleUpdate(60, false);
        } else if (!codexChanged && uiController?.getSelectedProvider() === 'antigravity') {
          uiController?.scheduleUpdate(60, false);
        }
        uiController?.checkForNewUnsavedAccount();
      };

      void probeFocusState();
      const awaitingLogin = Boolean(uiController?.isAwaitingNewLogin());
      focusFollowUpTimer = setTimeout(() => {
        focusFollowUpTimer = null;
        void probeFocusState();
      }, awaitingLogin ? 250 : 1200);
      focusSecondFollowUpTimer = setTimeout(() => {
        focusSecondFollowUpTimer = null;
        void probeFocusState();
      }, awaitingLogin ? 900 : 3500);
      focusThirdFollowUpTimer = setTimeout(() => {
        focusThirdFollowUpTimer = null;
        void probeFocusState();
      }, awaitingLogin ? 2500 : 7500);
    }
  });

  // Zero-polling auto-switch listeners + real-time telemetry push hooks
  const focusAutoSwitchSubs: vscode.Disposable[] = [];
  if (typeof codexQuotaService.onRateLimitsUpdated === 'function') {
    const unsubRl = codexQuotaService.onRateLimitsUpdated((rateLimits) => {
      if (!codexVaultInstance || !codexQuotaService) return;
      const updated = codexQuotaService.applyLiveRateLimitsPush(codexVaultInstance, rateLimits);
      if (updated) {
        uiController?.handleProviderActivity('codex', 'rateLimits/updated');
      }
    });
    focusAutoSwitchSubs.push({ dispose: () => unsubRl() });
  }
  if (typeof codexQuotaService.onActivity === 'function') {
    const unsub = codexQuotaService.onActivity((evt) => {
      if (evt === 'account/login/completed') {
        uiController?.handleLoginCompleted('codex');
        uiController?.scheduleUpdate(80);
      } else if (evt === 'turn/completed') {
        uiController?.handleProviderActivity('codex', 'turn/completed');
      } else if (evt === 'rateLimits/updated') {
        return;
      }
      if (vscode.window.state?.focused === false) {
        return;
      }
      uiController?.noteUserActivity();
      uiController?.handleFocusSignal('codex', 'stream');
    });
    focusAutoSwitchSubs.push({ dispose: () => unsub() });
  }
  if (typeof vscode.workspace?.onDidChangeConfiguration === 'function') {
    focusAutoSwitchSubs.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('charlier.autoRefreshInterval')) {
          uiController?.reconfigureAutoRefresh();
        }
        if (e.affectsConfiguration('charlier.showStatusBarQuota')) {
          uiController?.scheduleUpdate(30, true);
        }
      })
    );
  }
  if (typeof codexQuotaService.onProcessExited === 'function') {
    const unsubExit = codexQuotaService.onProcessExited(() => {
      ensureCodexObserverArmed();
    });
    focusAutoSwitchSubs.push({ dispose: () => unsubExit() });
  }
  const tabGroupsApi = (vscode.window as any).tabGroups;
  if (tabGroupsApi?.onDidChangeTabGroups) {
    focusAutoSwitchSubs.push(
      tabGroupsApi.onDidChangeTabGroups(() => {
        const provider = detectProviderFromTab(
          tabGroupsApi.activeTabGroup?.activeTab
        );
        if (provider) {
          uiController?.handleFocusSignal(provider, 'editor');
        }
      })
    );
  }
  if (tabGroupsApi?.onDidChangeTabs) {
    focusAutoSwitchSubs.push(
      tabGroupsApi.onDidChangeTabs(
        (ev: {
          opened?: vscode.Tab[];
          closed?: vscode.Tab[];
          changed?: vscode.Tab[];
        }) => {
          codexQuotaService?.ensureStdoutObserver();
          const activeTab = tabGroupsApi.activeTabGroup?.activeTab;
          if (!activeTab) return;
          const hasSpecificTabs =
            (Array.isArray(ev?.opened) && ev.opened.length > 0) ||
            (Array.isArray(ev?.changed) && ev.changed.length > 0) ||
            (Array.isArray(ev?.closed) && ev.closed.length > 0);
          const activeTouched =
            !hasSpecificTabs ||
            Boolean(ev?.opened?.includes(activeTab)) ||
            Boolean(ev?.changed?.includes(activeTab)) ||
            Boolean(ev?.closed && ev.closed.length > 0);
          if (!activeTouched) {
            return;
          }
          const provider = detectProviderFromTab(activeTab);
          if (provider) {
            uiController?.handleFocusSignal(provider, 'editor');
          }
        }
      )
    );
  }
  if (typeof vscode.window.onDidChangeActiveColorTheme === 'function') {
    focusAutoSwitchSubs.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        uiController?.refreshForThemeChange();
      })
    );
  }
  if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
    focusAutoSwitchSubs.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        uiController?.noteUserActivity();
        const uri = editor?.document?.uri;
        if (!uri) return;
        const provider = detectProviderFromUri(uri);
        if (provider) {
          uiController?.handleFocusSignal(provider, 'editor');
        }
      })
    );
  }
  if (typeof vscode.window.onDidChangeVisibleTextEditors === 'function') {
    focusAutoSwitchSubs.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        ensureCodexObserverArmed();
        const activeUri = vscode.window.activeTextEditor?.document?.uri;
        const activeProvider = activeUri ? detectProviderFromUri(activeUri) : null;
        if (activeProvider) {
          uiController?.handleFocusSignal(activeProvider, 'editor');
          return;
        }
        for (const ed of editors) {
          const p = detectProviderFromUri(ed?.document?.uri);
          if (p) {
            uiController?.handleFocusSignal(p, 'editor');
            break;
          }
        }
      })
    );
  }
  if (typeof vscode.extensions?.onDidChange === 'function') {
    focusAutoSwitchSubs.push(
      vscode.extensions.onDidChange(() => {
        ensureCodexObserverArmed();
      })
    );
  }
  const terminalProviderMap = new WeakMap<vscode.Terminal, ActiveProviderId>();
  let lastClosedTerminalAt = 0;
  uiController.attachCliTerminalLaunchedListener?.((term, provider) => {
    terminalProviderMap.set(term, provider);
  });
  const winAny = vscode.window as any;
  if (typeof winAny.onDidStartTerminalShellExecution === 'function') {
    focusAutoSwitchSubs.push(
      winAny.onDidStartTerminalShellExecution((event: any) => {
        const cmd = String(event?.execution?.commandLine?.value || '');
        if (event?.terminal) {
          uiController?.handleTerminalCommandStarted(event.terminal, cmd);
        }
        const detected = detectProviderFromTerminalCommand(cmd);
        if (detected && event?.terminal) {
          terminalProviderMap.set(event.terminal, detected);
          uiController?.handleFocusSignal(detected, 'terminal');
        }
      })
    );
  }
  if (typeof vscode.window.onDidChangeActiveTerminal === 'function') {
    focusAutoSwitchSubs.push(
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (!terminal) return;
        uiController?.noteUserActivity();
        if (Date.now() - lastClosedTerminalAt < 400) return;
        const mapped = terminalProviderMap.get(terminal);
        if (mapped) {
          uiController?.handleFocusSignal(mapped, 'terminal');
          return;
        }
        const nameLower = (terminal.name || '').trim().toLowerCase();
        if (/^(?:codex|charlier\s*·\s*codex)(\b|$)/.test(nameLower)) {
          uiController?.handleFocusSignal('codex', 'terminal');
        } else if (/^(?:agy|antigravity|charlier\s*·\s*antigravity)(\b|$)/.test(nameLower)) {
          uiController?.handleFocusSignal('antigravity', 'terminal');
        }
      })
    );
  }
  if (typeof vscode.window.onDidCloseTerminal === 'function') {
    focusAutoSwitchSubs.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        terminalProviderMap.delete(terminal);
        lastClosedTerminalAt = Date.now();
        uiController?.handleTerminalClosed(terminal);
      })
    );
  }
  if (typeof winAny.onDidEndTerminalShellExecution === 'function') {
    focusAutoSwitchSubs.push(
      winAny.onDidEndTerminalShellExecution((event: any) => {
        if (event?.terminal) {
          const cmd = String(event?.execution?.commandLine?.value || '');
          if (detectProviderFromTerminalCommand(cmd)) {
            terminalProviderMap.delete(event.terminal);
          }
          uiController?.handleTerminalCommandEnded(event.terminal, cmd);
        }
      })
    );
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CharlierSidebarProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand('charlier.switchProfile', async () => {
      await uiController?.showQuickPickMenu();
    }),
    vscode.commands.registerCommand('charlier.showMenu', async () => {
      await uiController?.showQuickPickMenu();
    }),
    vscode.commands.registerCommand(
      'charlier.switchProvider',
      async (arg?: any) => {
        const parsed = parseCommandStringArg(arg);
        const target: ActiveProviderId | undefined =
          parsed === 'antigravity' || parsed === 'codex' ? parsed : undefined;
        await uiController?.switchProvider(target);
      }
    ),
    vscode.commands.registerCommand(
      'charlier.switchProfileDirect',
      async (arg: any) => {
        const idStr = parseCommandStringArg(arg);
        if (idStr) {
          await uiController?.handleSwitch(idStr);
        }
      }
    ),
    vscode.commands.registerCommand(
      'charlier.switchCodexCliOnly',
      async (arg: any) => {
        let idStr: string | undefined = parseCommandStringArg(arg);
        if (!idStr) {
          const profiles = codexVaultInstance?.listProfiles() || [];
          if (profiles.length === 0) {
            vscode.window.showInformationMessage('No saved OpenAI Codex profiles in vault yet.');
            return;
          }
          const state = vaultInstance?.getState();
          const claimedIds = uiController?.getClaimedProfileIds?.('codex');
          const sorted = sortProfilesForDisplay(
            profiles,
            state?.activeCodexProfileId || null,
            claimedIds
          );
          const picked = await vscode.window.showQuickPick(
            sorted.map((p) => {
              const plan =
                p.planOverride ||
                p.cachedQuota?.plan ||
                (p.authMode === 'apikey' ? 'API_KEY' : 'PLUS');
              const isClaimed = claimedIds?.has(p.id);
              const needsReauth = p.authStatus === 'revoked' || p.authStatus === 'expired';
              const tags = [
                needsReauth ? '$(warning) RE-AUTH' : '',
                isClaimed ? '$(terminal) CLI CLAIMED' : ''
              ]
                .filter(Boolean)
                .join('  ·  ');
              return {
                label: `$(charlier-codex-prompt) ${p.name}`,
                description: `${p.email}  ·  ${plan}${tags ? `  ·  ${tags}` : ''}`,
                id: p.id
              };
            }),
            {
              title: 'Charlier: Launch Isolated Codex CLI (CLI Only)',
              placeHolder:
                'Select a saved Codex profile to launch in an isolated CODEX_HOME terminal without touching IDE'
            }
          );
          idStr = picked?.id;
        }
        if (idStr) {
          await uiController?.handleSwitch(idStr, 'codex', true);
        }
      }
    ),
    vscode.commands.registerCommand('charlier.openCockpit', async () => {
      await vscode.commands
        .executeCommand('charlier.cockpitView.focus')
        .then(undefined, () =>
          vscode.commands.executeCommand('workbench.view.extension.charlier')
        );
    }),
    vscode.commands.registerCommand('charlier.viewQuota', async () => {
      await uiController?.showQuotaDetails();
    }),
    vscode.commands.registerCommand('charlier.refreshQuota', async () => {
      await uiController?.refreshQuota();
    }),
    vscode.commands.registerCommand(
      'charlier.renameProfile',
      async (arg?: any) => {
        const parsedId = parseCommandStringArg(arg);
        const activeProvider = uiController?.getSelectedProvider() || 'antigravity';
        const fallbackId =
          activeProvider === 'codex'
            ? vaultInstance?.getState().activeCodexProfileId
            : vaultInstance?.getState().activeProfileId;
        let targetId = parsedId || fallbackId || null;
        if (!targetId) {
          const profiles =
            activeProvider === 'codex'
              ? codexVaultInstance?.listProfiles() || []
              : vaultInstance?.listProfiles() || [];
          if (profiles.length === 0) {
            vscode.window.showInformationMessage('No saved profiles in vault to rename.');
            return;
          }
          const picked = await vscode.window.showQuickPick(
            profiles.map((p) => ({
              label: p.name,
              description: p.email,
              id: p.id
            })),
            {
              title: `Charlier: Rename ${activeProvider === 'codex' ? 'Codex' : 'Antigravity'} Profile`,
              placeHolder: 'Select a profile to rename or override its plan tier'
            }
          );
          targetId = picked?.id || null;
        }
        if (targetId) {
          await uiController?.handleRename(targetId, activeProvider);
        }
      }
    ),
    vscode.commands.registerCommand('charlier.saveProfile', async () => {
      await uiController?.handleSaveCurrent();
    }),
    vscode.commands.registerCommand('charlier.addAccount', async () => {
      await uiController?.handleAddAccount();
    }),
    vscode.commands.registerCommand('charlier.verifyAccount', async (arg?: any) => {
      const profileId = parseCommandStringArg(arg);
      await uiController?.handleVerifyAccount(profileId || undefined);
    }),
    vscode.commands.registerCommand('charlier.deleteProfile', async () => {
      await uiController?.handleDelete();
    }),
    vscode.commands.registerCommand('charlier.openVault', async () => {
      const activeProvider = uiController?.getSelectedProvider() || 'antigravity';
      const dir =
        activeProvider === 'codex' ? getCodexProfilesDir() : getProfilesDir();
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
      await vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(dir)
      );
    }),
    vscode.commands.registerCommand(
      'charlier.restartExtensionHost',
      async () => {
        await confirmGeneralExtensionHostRestart();
      }
    ),
    vscode.commands.registerCommand('charlier.reloadWindow', async () => {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),
    windowFocusSub,
    ...focusAutoSwitchSubs,
    {
      dispose: () => {
        if (codexObserverPoll) {
          clearInterval(codexObserverPoll);
          codexObserverPoll = null;
        }
        clearExtensionTimers();
        watcher?.dispose();
        keyring.dispose();
        codexQuotaService?.dispose();
        uiController?.dispose();
      }
    }
  );
}

export function deactivate(): void {
  clearExtensionTimers();
  watcher?.dispose();
  keyringInstance?.dispose();
  codexQuotaService?.dispose();
  uiController?.dispose();
  watcher = null;
  uiController = null;
  quotaService = null;
  vaultInstance = null;
  codexVaultInstance = null;
  codexQuotaService = null;
  sidebarProvider = null;
}
