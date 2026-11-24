import * as vscode from 'vscode';
import { Vault } from './vault';
import { QuotaService, formatTimeAgo } from './quota';
import {
  CodexVault,
  CodexQuotaService,
  healExpiredCodexMetric
} from './codex';
import {
  ActiveProviderId,
  CachedQuotaMetric,
  LiveSessionInfo,
  ProfileMetadata,
  QuotaSummary,
  UserPlanTier
} from './types';
import {
  detectDefaultProvider,
  confirmAndReloadForProviderSwitch,
  PROVIDER_RUNTIME_REGISTRY
} from './providers';
import { CharlierSidebarProvider, CockpitCallbacks } from './sidebar';
import {
  CliBinaryResolution,
  cleanupProfileCliHome,
  prepareAntigravityCliHome,
  prepareCodexCliHome,
  resolveCliBinary,
  syncAntigravityCliHomeToVault,
  syncCodexCliHomeToVault
} from './cli-isolation';
import {
  codexMetricForDisplay,
  detectProviderFromTerminalCommand,
  formatAntigravityStatusBarSummary,
  formatUnifiedStatusBarText,
  isSyntheticCodexQuota,
  needsCodexLiveProbe,
  percentFromFraction,
  percentFromText,
  quotaMatchesIdentity,
  resolveAntigravityPrimaryPools,
  resolveBestStandbyProfile,
  resolveEffectiveAuthStatus,
  resolveQuotaTone,
  sortProfilesForDisplay
} from './quota-values';

interface ProfileQuickPickItem extends vscode.QuickPickItem {
  action:
    | 'switch'
    | 'save'
    | 'addAccount'
    | 'delete'
    | 'quota'
    | 'refresh'
    | 'rename'
    | 'switchProvider'
    | 'openCockpit'
    | 'openHoverSettings'
    | 'verifyAccount'
    | 'noop';
  profileId?: string;
  provider?: ActiveProviderId;
}

interface DeckFrame {
  profiles: ProfileMetadata[];
  activeProfile: ProfileMetadata | null;
  live: LiveSessionInfo;
  authenticated: boolean;
  isUnsaved: boolean;
  metrics: CachedQuotaMetric | null;
  cliProfileId: string | null;
}

interface RenderFrame {
  showStatusBarQuota: boolean;
  agy: DeckFrame & { quota: QuotaSummary | null };
  codex: DeckFrame;
}

export class UIController implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private vault: Vault;
  private quotaService: QuotaService;
  private codexVault: CodexVault;
  private codexQuotaService: CodexQuotaService;
  private workspaceState?: vscode.Memento;
  private sidebar: CharlierSidebarProvider | null = null;
  private selectedProvider: ActiveProviderId;
  private promptedEmails: Set<string> = new Set();
  private promptedCodexIdentities: Set<string> = new Set();
  private notifiedReauthKeys: Set<string> = new Set();
  private notifiedReauthRecoveryKeys: Set<string> = new Set();
  private inFlightPromptKeys: Set<string> = new Set();
  private sessionDismissedPromptKeys: Set<string> = new Set();
  private isAddingAccount = false;
  private suppressUnsavedPromptUntil = 0;
  private pendingReauthTarget: {
    provider: ActiveProviderId;
    profileId: string;
    email?: string;
    accountId?: string;
    startedAt?: number;
  } | null = null;
  private claimedTerminals = new Map<
    string,
    {
      terminal: vscode.Terminal;
      provider: ActiveProviderId;
      profileId: string;
      profileName: string;
    }
  >();
  private launchedCliTerminals = new WeakMap<
    vscode.Terminal,
    {
      provider: ActiveProviderId;
      profileId: string;
      profileName: string;
    }
  >();
  private manualProviderPinUntil = 0;
  private autoSwitchDebounceTimer: NodeJS.Timeout | null = null;
  private lastAntigravityBackgroundRefreshAttempt = 0;
  private lastCodexBackgroundRefreshAttempt = 0;
  private lastProviderFullUpdateAt: Record<ActiveProviderId, number> = {
    antigravity: 0,
    codex: 0
  };
  private isUpdating = false;
  private pendingUpdate = false;
  private lastStatusBarText: string | undefined;
  private lastStatusBarColorId: string | undefined;
  private lastStatusBarBgId: string | undefined;
  private lastStatusBarA11y: string | undefined;
  private lastTooltipValue: string | undefined;
  private cliAntigravityProfileId: string | null = null;
  private cliCodexProfileId: string | null = null;
  private muteExternalWatcher: ((durationMs: number) => void) | null = null;
  private shortenExternalWatcherMute: ((maxRemainingMs: number) => void) | null = null;
  private onCredentialsMutated: (() => void) | null = null;
  private onCliTerminalLaunched:
    | ((terminal: vscode.Terminal, provider: ActiveProviderId) => void)
    | null = null;
  private lastFrame: RenderFrame | null = null;
  private lastFrameAt = 0;
  private scheduledUpdateTimer: NodeJS.Timeout | null = null;
  private loginFollowUpTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private scheduledFast = false;
  private pendingFast = true;
  private switchesInFlight = new Set<string>();
  private awaitingLoginTimer: NodeJS.Timeout | null = null;
  private awaitingLoginUntil = 0;
  private awaitingLoginProvider: ActiveProviderId | null = null;
  private awaitingLoginPrevEmail: string | null = null;
  private hasCompletedInitialUpdate = false;
  private activeUnsavedAgyEmail: string | null = null;
  private activeUnsavedCodexKey: string | null = null;
  private autoRefreshTimer: NodeJS.Timeout | null = null;
  private activityRefreshTimers: Partial<Record<ActiveProviderId, NodeJS.Timeout>> = {};
  private lastActivityRefreshAt: Record<ActiveProviderId, number> = {
    antigravity: 0,
    codex: 0
  };
  private lastStandbyAutoRefreshAt = Date.now();
  private autoRefreshTickInFlight = false;
  private windowFocused = true;
  private sidebarVisible = false;
  private lastUserInteractionAt = Date.now();
  private lastBlurAt = 0;

  constructor(
    vault: Vault,
    quotaService: QuotaService,
    codexVault: CodexVault,
    codexQuotaService: CodexQuotaService,
    workspaceState?: vscode.Memento
  ) {
    this.vault = vault;
    this.quotaService = quotaService;
    this.codexVault = codexVault;
    this.codexQuotaService = codexQuotaService;
    this.workspaceState = workspaceState;

    const savedState = this.vault.getState();
    const host = this.getHostKey();
    const workspaceSaved =
      host === 'vscode'
        ? this.workspaceState?.get<ActiveProviderId>('charlier.selectedProvider')
        : undefined;
    const hostSaved = savedState.selectedProviderByHost?.[host];
    const savedProvider =
      workspaceSaved === 'antigravity' || workspaceSaved === 'codex'
        ? workspaceSaved
        : savedState.selectedProviderByHost !== undefined
          ? host === 'antigravity'
            ? 'antigravity'
            : (hostSaved ?? savedState.selectedProvider)
          : savedState.selectedProvider;
    this.selectedProvider =
      savedProvider === 'antigravity' || savedProvider === 'codex'
        ? savedProvider
        : detectDefaultProvider();

    const savedAgyEmails = new Set(
      (this.vault.listProfiles?.() || []).map((p) =>
        (p.email || '').trim().toLowerCase()
      )
    );
    const savedCodexProfiles = this.codexVault.listProfiles?.() || [];
    if (Array.isArray(savedState.promptedUnsavedEmails)) {
      for (const em of savedState.promptedUnsavedEmails) {
        if (typeof em === 'string' && em.trim()) {
          const norm = em.trim().toLowerCase();
          if (!savedAgyEmails.has(norm)) {
            this.promptedEmails.add(norm);
          }
        }
      }
    }
    if (Array.isArray(savedState.promptedUnsavedCodexIdentities)) {
      for (const idKey of savedState.promptedUnsavedCodexIdentities) {
        if (typeof idKey === 'string' && idKey.trim()) {
          const norm = idKey.trim().toLowerCase();
          const [accPart, emailPart] = norm.split('::');
          const matchesSaved = savedCodexProfiles.some(
            (p) =>
              (accPart && (p.accountId || '').toLowerCase() === accPart) ||
              (emailPart && (p.email || '').trim().toLowerCase() === emailPart)
          );
          if (!matchesSaved) {
            this.promptedCodexIdentities.add(norm);
          }
        }
      }
    }

    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      501
    );
    this.statusBarItem.command = 'charlier.switchProfile';
    this.statusBarItem.show();
    this.windowFocused = (vscode.window as any).state?.focused !== false;
  }

  private clearCodexUnsavedDismissal(
    accountId?: string | null,
    email?: string | null
  ): void {
    const acc = (accountId || '').trim().toLowerCase();
    const em = (email || '').trim().toLowerCase();
    if (!acc && !em) return;
    const exactKey = `${acc}::${em}`;
    let changed = this.promptedCodexIdentities.delete(exactKey);
    this.sessionDismissedPromptKeys.delete(`codex:${exactKey}`);
    for (const k of Array.from(this.promptedCodexIdentities)) {
      if (
        (acc && k.startsWith(`${acc}::`)) ||
        (em && k.endsWith(`::${em}`))
      ) {
        this.promptedCodexIdentities.delete(k);
        this.sessionDismissedPromptKeys.delete(`codex:${k}`);
        changed = true;
      }
    }
    for (const sk of Array.from(this.sessionDismissedPromptKeys)) {
      if (
        sk.startsWith('codex:') &&
        ((acc && sk.includes(`${acc}::`)) || (em && sk.endsWith(`::${em}`)))
      ) {
        this.sessionDismissedPromptKeys.delete(sk);
      }
    }
    if (changed) {
      this.persistPromptedUnsavedState();
    }
  }

  public attachSidebar(sidebar: CharlierSidebarProvider): void {
    this.sidebar = sidebar;
  }

  public attachWatcherMuter(muter: (durationMs: number) => void): void {
    this.muteExternalWatcher = muter;
  }

  public attachWatcherShortener(
    shortener: (maxRemainingMs: number) => void
  ): void {
    this.shortenExternalWatcherMute = shortener;
  }

  public attachCredentialsMutatedListener(listener: () => void): void {
    this.onCredentialsMutated = listener;
  }

  public attachCliTerminalLaunchedListener(
    listener: (terminal: vscode.Terminal, provider: ActiveProviderId) => void
  ): void {
    this.onCliTerminalLaunched = listener;
  }

  public refreshForThemeChange(): void {
    this.lastTooltipValue = undefined;
    if (this.lastFrame) {
      this.renderFrame(this.lastFrame);
    }
  }

  public isUnsavedPromptSuppressed(): boolean {
    return Date.now() < this.suppressUnsavedPromptUntil;
  }

  public isSwitchInFlightOrSuppressed(): boolean {
    return this.switchesInFlight.size > 0 || this.isUnsavedPromptSuppressed();
  }

  public isAwaitingNewLogin(): boolean {
    return Date.now() < this.awaitingLoginUntil;
  }

  private stopAwaitingLoginWatch(): void {
    if (this.awaitingLoginTimer) {
      clearTimeout(this.awaitingLoginTimer);
      clearInterval(this.awaitingLoginTimer);
      this.awaitingLoginTimer = null;
    }
    this.awaitingLoginUntil = 0;
    this.awaitingLoginProvider = null;
    this.awaitingLoginPrevEmail = null;
  }

  private startAwaitingLoginWatch(
    provider: ActiveProviderId,
    previousEmail?: string | null,
    durationMs = 300000
  ): void {
    this.stopAwaitingLoginWatch();
    if (this.disposed) return;
    this.awaitingLoginProvider = provider;
    this.awaitingLoginPrevEmail = previousEmail
      ? previousEmail.trim().toLowerCase()
      : null;
    const startedAt = Date.now();
    this.awaitingLoginUntil = startedAt + durationMs;
    let notifiedInitialUnverified = false;
    let tickInFlight = false;

    const scheduleNext = (delayMs: number): void => {
      if (this.disposed || Date.now() >= this.awaitingLoginUntil) {
        this.stopAwaitingLoginWatch();
        return;
      }
      this.awaitingLoginTimer = setTimeout(() => {
        void runTick();
      }, delayMs);
      (this.awaitingLoginTimer as any)?.unref?.();
    };

    const runTick = async (): Promise<void> => {
      this.awaitingLoginTimer = null;
      if (this.disposed || Date.now() >= this.awaitingLoginUntil) {
        this.stopAwaitingLoginWatch();
        return;
      }
      if (tickInFlight || this.switchesInFlight.size > 0) {
        scheduleNext(Date.now() - startedAt < 15000 ? 300 : 1000);
        return;
      }

      tickInFlight = true;
      let detected = false;
      try {
        if (provider === 'codex') {
          this.codexQuotaService.ensureStdoutObserver?.();
          this.codexVault.invalidateLiveSessionCache?.();
          const live = this.codexVault.getLiveSessionInfo?.(true);
          const email = (live?.email || live?.accountId || '').trim().toLowerCase();
          if (email) {
            detected = true;
            this.stopAwaitingLoginWatch();
            this.clearCodexUnsavedDismissal(live?.accountId, live?.email);
            this.codexQuotaService.invalidateCache?.();
            await this.update(true);
            void this.checkForNewUnsavedAccount('codex');
            return;
          }
        } else {
          this.vault.invalidateLiveSessionCache?.();
          const hasPeek =
            typeof (this.quotaService as any).peekDaemonIdentityAsync === 'function';
          const [live, peek] = await Promise.all([
            this.vault.getLiveSessionInfoAsync?.().catch(() => null),
            hasPeek
              ? (this.quotaService as any).peekDaemonIdentityAsync().catch(() => null)
              : this.quotaService.getQuotaSummary?.(true).catch(() => null)
          ]);
          if (this.disposed) return;

          const email = (live?.email || peek?.email || '').trim().toLowerCase();
          const sameAsLoggedOut = Boolean(
            email && this.awaitingLoginPrevEmail && email === this.awaitingLoginPrevEmail
          );
          const hasDiskEvidence = Boolean(live?.email || live?.hasOAuthCreds);

          if (email && (!sameAsLoggedOut || hasDiskEvidence || peek?.authStatus === 'unverified')) {
            if (peek?.authStatus === 'unverified') {
              if (!notifiedInitialUnverified) {
                notifiedInitialUnverified = true;
                this.promptedEmails.delete(email);
                this.sessionDismissedPromptKeys.delete(`antigravity:${email}`);
                await this.update(true);
                void this.checkForNewUnsavedAccount('antigravity');
              }
            } else if (
              live?.email ||
              live?.hasOAuthCreds ||
              (peek && (!sameAsLoggedOut || !hasPeek))
            ) {
              detected = true;
              this.stopAwaitingLoginWatch();
              this.promptedEmails.delete(email);
              this.sessionDismissedPromptKeys.delete(`antigravity:${email}`);
              await this.update(true);
              void this.checkForNewUnsavedAccount('antigravity');
              this.quotaService
                .getQuotaSummary?.(true)
                .then(() => {
                  if (!this.disposed) {
                    this.scheduleUpdate(40, true);
                  }
                })
                .catch(() => {});
              return;
            }
          }
        }
      } finally {
        tickInFlight = false;
        if (!detected && this.awaitingLoginUntil > Date.now() && !this.disposed) {
          scheduleNext(Date.now() - startedAt < 15000 ? 300 : 1000);
        }
      }
    };

    scheduleNext(150);
  }

  private syncIsolatedCliHomeToVault(
    provider: ActiveProviderId,
    profileId: string
  ): void {
    try {
      if (provider === 'codex') {
        if (syncCodexCliHomeToVault(profileId)) {
          this.codexVault.invalidateLiveSessionCache();
        }
      } else {
        if (syncAntigravityCliHomeToVault(profileId)) {
          this.vault.invalidateLiveSessionCache();
        }
      }
    } catch {}
  }

  private claimedTerminalKey(
    provider: ActiveProviderId,
    profileId: string
  ): string {
    return `${provider}:${profileId}`;
  }

  public getClaimedProfileIds(provider: ActiveProviderId): Set<string> {
    const activeTerminals = (vscode.window as any).terminals as
      | ReadonlyArray<vscode.Terminal>
      | undefined;
    const ids = new Set<string>();
    for (const [key, entry] of Array.from(this.claimedTerminals.entries())) {
      if (
        Array.isArray(activeTerminals) &&
        !activeTerminals.includes(entry.terminal)
      ) {
        this.syncIsolatedCliHomeToVault(entry.provider, entry.profileId);
        this.claimedTerminals.delete(key);
        continue;
      }
      if (entry.provider === provider) {
        ids.add(entry.profileId);
      }
    }
    return ids;
  }

  public handleTerminalClosed(terminal: vscode.Terminal): void {
    let changed = false;
    const launched = this.launchedCliTerminals.get(terminal);
    if (launched) {
      this.syncIsolatedCliHomeToVault(launched.provider, launched.profileId);
      this.launchedCliTerminals.delete(terminal);
    }
    const released: Array<{ provider: ActiveProviderId; profileId: string }> = [];
    for (const [key, entry] of Array.from(this.claimedTerminals.entries())) {
      if (entry.terminal === terminal) {
        if (!launched) {
          this.syncIsolatedCliHomeToVault(entry.provider, entry.profileId);
        }
        released.push({ provider: entry.provider, profileId: entry.profileId });
        this.claimedTerminals.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.scheduleUpdate(60, true);
      this.refreshReleasedCliProfiles(released);
    }
  }

  public handleTerminalCommandStarted(
    terminal: vscode.Terminal,
    commandLine: string
  ): void {
    const launched = this.launchedCliTerminals.get(terminal);
    if (!launched) return;
    if (detectProviderFromTerminalCommand(commandLine) !== launched.provider) {
      return;
    }
    const key = this.claimedTerminalKey(launched.provider, launched.profileId);
    const existing = this.claimedTerminals.get(key);
    if (!existing || existing.terminal !== terminal) {
      this.claimedTerminals.set(key, {
        terminal,
        provider: launched.provider,
        profileId: launched.profileId,
        profileName: launched.profileName
      });
      this.scheduleUpdate(60, true);
    }
  }

  public handleTerminalCommandEnded(
    terminal: vscode.Terminal,
    commandLine: string
  ): void {
    let changed = false;
    const released: Array<{ provider: ActiveProviderId; profileId: string }> = [];
    for (const [key, entry] of Array.from(this.claimedTerminals.entries())) {
      if (entry.terminal !== terminal) continue;
      if (detectProviderFromTerminalCommand(commandLine) === entry.provider) {
        this.syncIsolatedCliHomeToVault(entry.provider, entry.profileId);
        released.push({ provider: entry.provider, profileId: entry.profileId });
        this.claimedTerminals.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.scheduleUpdate(60, true);
      this.refreshReleasedCliProfiles(released);
    }
  }

  private refreshReleasedCliProfiles(
    released: Array<{ provider: ActiveProviderId; profileId: string }>
  ): void {
    if (this.disposed || released.length === 0) return;
    const agyIds = new Set(
      released.filter((r) => r.provider === 'antigravity').map((r) => r.profileId)
    );
    const codexIds = new Set(
      released.filter((r) => r.provider === 'codex').map((r) => r.profileId)
    );
    const tasks: Array<Promise<unknown>> = [];
    if (agyIds.size > 0 && typeof (this.quotaService as any).refreshProfileIds === 'function') {
      tasks.push(
        (this.quotaService as any).refreshProfileIds(
          this.vault.listProfiles(),
          agyIds,
          this.vault,
          true
        )
      );
    }
    if (codexIds.size > 0 && typeof (this.codexQuotaService as any).refreshProfileIds === 'function') {
      tasks.push(
        (this.codexQuotaService as any).refreshProfileIds(codexIds, this.codexVault)
      );
    }
    if (tasks.length > 0) {
      Promise.allSettled(tasks)
        .then(() => {
          if (!this.disposed) {
            this.scheduleUpdate(60, true);
          }
        })
        .catch(() => {});
    }
  }

  private getAutoRefreshIntervalMs(): number {
    const raw = vscode.workspace
      ?.getConfiguration?.('charlier')
      ?.get<number>('autoRefreshInterval', 60);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return 60_000;
    }
    if (raw <= 0) {
      return 0;
    }
    return Math.max(30, Math.min(3600, Math.round(raw))) * 1000;
  }

  private isActiveForAutoRefresh(): boolean {
    if (this.windowFocused) return true;
    // Cross-OS Linux/Wayland & macOS Spaces fallback: if focus event was missed
    // by the compositor but the user interacted inside VS Code after the last blur.
    const now = Date.now();
    return (
      this.lastUserInteractionAt > this.lastBlurAt &&
      now - this.lastUserInteractionAt < 90_000
    );
  }

  public noteUserActivity(): void {
    if (this.disposed) return;
    this.lastUserInteractionAt = Date.now();
  }

  public startAutoRefreshLoop(): void {
    this.stopAutoRefreshLoop();
    if (this.disposed) return;
    const intervalMs = this.getAutoRefreshIntervalMs();
    if (intervalMs <= 0) return;

    this.autoRefreshTimer = setInterval(() => {
      if (this.disposed) {
        this.stopAutoRefreshLoop();
        return;
      }
      if (!this.isActiveForAutoRefresh()) {
        return;
      }
      void this.runAutoRefreshTick();
    }, intervalMs);
    (this.autoRefreshTimer as any)?.unref?.();
  }

  public stopAutoRefreshLoop(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  public reconfigureAutoRefresh(): void {
    if (this.disposed) return;
    const intervalMs = this.getAutoRefreshIntervalMs();
    if (intervalMs <= 0) {
      this.stopAutoRefreshLoop();
      return;
    }
    this.startAutoRefreshLoop();
  }

  public handleCockpitVisibilityChanged(visible: boolean): void {
    if (this.disposed) return;
    this.sidebarVisible = visible;
    if (visible) {
      this.noteUserActivity();
      if (this.hasCompletedInitialUpdate) {
        void this.runAutoRefreshTick({ forceActive: true, maxActiveAgeMs: 15_000 });
      }
    }
  }

  public handleWindowFocusChanged(focused: boolean): void {
    if (this.disposed) return;
    this.windowFocused = focused;
    if (focused) {
      this.noteUserActivity();
      if (!this.autoRefreshTimer && this.getAutoRefreshIntervalMs() > 0) {
        this.startAutoRefreshLoop();
      }
      if (this.hasCompletedInitialUpdate) {
        void this.runAutoRefreshTick({ forceActive: true, maxActiveAgeMs: 20_000 });
      }
    } else {
      this.lastBlurAt = Date.now();
    }
  }

  public handleProviderActivity(
    provider: ActiveProviderId,
    event: 'stream' | 'turn/completed' | 'rateLimits/updated' = 'stream'
  ): void {
    if (this.disposed) return;
    this.noteUserActivity();

    if (provider === 'codex' && event === 'rateLimits/updated') {
      this.lastActivityRefreshAt.codex = Date.now();
      this.scheduleUpdate(40, true);
      return;
    }

    const delayMs = provider === 'codex' ? 1200 : 2500;
    const existing = this.activityRefreshTimers[provider];
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      delete this.activityRefreshTimers[provider];
      if (this.disposed || this.switchesInFlight.size > 0 || this.isAwaitingNewLogin()) {
        return;
      }
      const now = Date.now();
      if (provider === 'codex') {
        const lastCodexFetch =
          typeof (this.codexQuotaService as any).getLastFetchTime === 'function'
            ? (this.codexQuotaService as any).getLastFetchTime()
            : 0;
        if (now - lastCodexFetch < 5000) {
          this.scheduleUpdate(40, true);
          return;
        }
        if (now - this.lastActivityRefreshAt.codex < 12_000) return;
        this.lastActivityRefreshAt.codex = now;
        const live = this.codexVault.getLiveSessionInfo?.();
        if (!live || live.authMode === 'apikey' || (!live.email && !live.accountId && !live.hasOAuthCreds)) {
          return;
        }
        this.codexQuotaService
          .getActiveQuotaSummary?.(this.codexVault, true)
          ?.then((res) => {
            if (!this.disposed && res?.metric) {
              this.scheduleUpdate(50, true);
            }
          })
          .catch(() => {});
      } else {
        if (now - this.lastActivityRefreshAt.antigravity < 15_000) return;
        this.lastActivityRefreshAt.antigravity = now;
        this.quotaService
          .getQuotaSummary?.(true)
          ?.then((summary) => {
            if (!this.disposed && summary) {
              this.scheduleUpdate(50, true);
            }
          })
          .catch(() => {});
      }
    }, delayMs);
    (timer as any)?.unref?.();
    this.activityRefreshTimers[provider] = timer;
  }

  public async runAutoRefreshTick(options?: {
    forceActive?: boolean;
    forceStandby?: boolean;
    maxActiveAgeMs?: number;
  }): Promise<void> {
    if (
      this.disposed ||
      this.autoRefreshTickInFlight ||
      this.switchesInFlight.size > 0 ||
      this.isAwaitingNewLogin()
    ) {
      return;
    }
    const forceActive = Boolean(options?.forceActive);
    const forceStandby = Boolean(options?.forceStandby);
    if (!forceActive && !forceStandby && !this.isActiveForAutoRefresh()) {
      return;
    }

    this.autoRefreshTickInFlight = true;
    try {
      const now = Date.now();
      const configuredMs = this.getAutoRefreshIntervalMs();
      const effectiveIntervalMs = configuredMs > 0 ? configuredMs : 60_000;
      const maxActiveAgeMs = options?.maxActiveAgeMs ?? Math.max(15_000, effectiveIntervalMs - 2000);
      const standbyIntervalMs = Math.max(300_000, effectiveIntervalMs * 5);

      const tasks: Array<Promise<unknown>> = [];
      let shouldRepaint = false;

      // Tier 1: Active Hero telemetry for selected provider (plus instant local loopback daemon)
      if (this.selectedProvider === 'antigravity') {
        const cachedAgy = this.quotaService.getCachedSummary?.();
        const agyAge = cachedAgy?.fetchedAt ? now - cachedAgy.fetchedAt : Infinity;
        if (agyAge >= maxActiveAgeMs && typeof this.quotaService.getQuotaSummary === 'function') {
          shouldRepaint = true;
          tasks.push(this.quotaService.getQuotaSummary(true).catch(() => null));
        }
      } else {
        const codexLive = this.codexVault.getLiveSessionInfo?.();
        const hasCodexSession = Boolean(
          codexLive &&
            codexLive.authMode !== 'apikey' &&
            (codexLive.email || codexLive.accountId || codexLive.hasOAuthCreds)
        );
        const lastCodexFetch =
          typeof (this.codexQuotaService as any).getLastFetchTime === 'function'
            ? (this.codexQuotaService as any).getLastFetchTime()
            : 0;
        const codexAge = lastCodexFetch > 0 ? now - lastCodexFetch : Infinity;
        if (
          hasCodexSession &&
          codexAge >= maxActiveAgeMs &&
          typeof this.codexQuotaService.getActiveQuotaSummary === 'function'
        ) {
          shouldRepaint = true;
          tasks.push(
            this.codexQuotaService.getActiveQuotaSummary(this.codexVault, true).catch(() => null)
          );
        }
      }

      // Tier 2: CLI CLAIMED standby profiles refresh at active cadence so parallel terminal burn stays live
      const claimedAgy = this.getClaimedProfileIds('antigravity');
      const claimedCodex = this.getClaimedProfileIds('codex');
      if (
        claimedAgy.size > 0 &&
        typeof (this.quotaService as any).refreshProfileIds === 'function'
      ) {
        const agyProfiles = this.vault.listProfiles();
        shouldRepaint = true;
        tasks.push(
          (this.quotaService as any)
            .refreshProfileIds(agyProfiles, claimedAgy, this.vault, false)
            .catch(() => 0)
        );
      }
      if (
        claimedCodex.size > 0 &&
        typeof (this.codexQuotaService as any).refreshProfileIds === 'function'
      ) {
        shouldRepaint = true;
        tasks.push(
          (this.codexQuotaService as any)
            .refreshProfileIds(claimedCodex, this.codexVault)
            .catch(() => 0)
        );
      }

      // Tier 3: Unclaimed inactive standbys refresh gently (default every 5m while focused)
      const standbyDue =
        forceStandby ||
        (configuredMs > 0 && now - this.lastStandbyAutoRefreshAt >= standbyIntervalMs);
      if (standbyDue) {
        this.lastStandbyAutoRefreshAt = now;
        const agyProfiles = this.vault.listProfiles();
        const agyState = this.vault.getState();
        const agyLive = await this.vault.getLiveSessionInfoAsync().catch(() => null);
        if (agyProfiles.length > 0 && typeof this.quotaService.refreshAllInactiveProfiles === 'function') {
          this.lastAntigravityBackgroundRefreshAttempt = now;
          shouldRepaint = true;
          tasks.push(
            this.quotaService
              .refreshAllInactiveProfiles(
                agyProfiles,
                agyLive?.email ?? null,
                agyState.activeProfileId,
                this.vault,
                false
              )
              .catch(() => {})
          );
        }
        const codexProfiles = this.codexVault.listProfiles();
        if (
          codexProfiles.some((p) => p.authMode !== 'apikey') &&
          typeof this.codexQuotaService.refreshAllProfiles === 'function'
        ) {
          this.lastCodexBackgroundRefreshAttempt = now;
          shouldRepaint = true;
          tasks.push(
            this.codexQuotaService.refreshAllProfiles(this.codexVault).catch(() => 0)
          );
        }
      }

      if (tasks.length > 0) {
        await Promise.allSettled(tasks);
      }
      if (!this.disposed && shouldRepaint) {
        this.scheduleUpdate(60, true);
      }
    } finally {
      this.autoRefreshTickInFlight = false;
    }
  }

  public handleLoginCompleted(provider: ActiveProviderId): void {
    if (this.disposed) return;
    this.suppressUnsavedPromptUntil = 0;
    if (provider === 'codex') {
      this.codexVault.invalidateLiveSessionCache();
      const live = this.codexVault.getLiveSessionInfo?.(true);
      this.clearCodexUnsavedDismissal(live?.accountId, live?.email);
      this.codexQuotaService.invalidateCache();
      if (this.loginFollowUpTimer) {
        clearTimeout(this.loginFollowUpTimer);
      }
      this.loginFollowUpTimer = setTimeout(() => {
        this.loginFollowUpTimer = null;
        if (this.disposed) return;
        this.codexVault.invalidateLiveSessionCache?.();
        const latest = this.codexVault.getLiveSessionInfo?.(true);
        this.clearCodexUnsavedDismissal(latest?.accountId, latest?.email);
        void this.update();
        void this.checkForNewUnsavedAccount('codex');
      }, 350);
      (this.loginFollowUpTimer as any)?.unref?.();
    } else {
      this.vault.invalidateLiveSessionCache();
      this.quotaService.invalidate();
    }
    void this.checkForNewUnsavedAccount(provider);
  }

  public getSidebarCallbacks(): CockpitCallbacks {
    return {
      onSelectProvider: async (provider: ActiveProviderId) => {
        await this.switchProvider(provider);
      },
      onSwitchProfile: async (
        provider: ActiveProviderId,
        profileId: string,
        cliOnly?: boolean
      ) => {
        await this.handleSwitch(profileId, provider, Boolean(cliOnly));
      },
      onRefreshAll: async (provider: ActiveProviderId) => {
        await this.refreshQuota(provider);
      },
      onRefreshSingle: async (provider: ActiveProviderId, profileId: string) => {
        if (provider === 'codex') {
          await this.codexQuotaService.refreshProfileQuota(
            profileId,
            this.codexVault
          );
        } else {
          const prof = this.vault.getProfile(profileId);
          if (prof) {
            const live = await this.vault.getLiveSessionInfoAsync();
            const isActive = live.email
              ? live.email.toLowerCase() === prof.email.toLowerCase()
              : live.hasOAuthCreds && this.vault.getState().activeProfileId === prof.id;
            if (isActive) {
              await this.quotaService.getQuotaSummary(true);
            } else {
              await this.quotaService.refreshInactiveProfile(prof, this.vault, true);
            }
          }
        }
        await this.update(true);
      },
      onSaveActive: async (provider: ActiveProviderId) => {
        await this.handleSaveCurrent(provider);
      },
      onAddAccount: async (provider: ActiveProviderId) => {
        await this.handleAddAccount(provider);
      },
      onVerifyAccount: async (provider: ActiveProviderId, profileId?: string) => {
        if (provider === 'antigravity') {
          await this.handleVerifyAccount(profileId);
        }
      },
      onRenameProfile: async (provider: ActiveProviderId, profileId: string) => {
        await this.handleRename(profileId, provider);
      },
      onDeleteProfile: async (provider: ActiveProviderId, profileId: string) => {
        await this.handleDelete(profileId, provider);
      },
      onViewDetails: async (provider: ActiveProviderId, profileId: string) => {
        await this.showQuotaDetails(profileId, provider);
      },
      onVisibilityChanged: (visible: boolean) => {
        this.handleCockpitVisibilityChanged(visible);
      }
    };
  }

  public getSelectedProvider(): ActiveProviderId {
    return this.selectedProvider;
  }

  /**
   * Flips the active view deck between Antigravity and Codex.
   * View-only: never restarts or reloads any extension.
   */
  public async switchProvider(
    target?: ActiveProviderId,
    options?: { manual?: boolean }
  ): Promise<void> {
    const next: ActiveProviderId =
      target === 'antigravity' || target === 'codex'
        ? target
        : this.selectedProvider === 'antigravity'
          ? 'codex'
          : 'antigravity';

    const isManual = options?.manual !== false;
    if (isManual) {
      this.manualProviderPinUntil = Date.now() + 1200;
    }

    if (this.selectedProvider === next && this.lastFrame) {
      return;
    }

    this.selectedProvider = next;
    if (isManual) {
      const host = this.getHostKey();
      if (host === 'vscode' && typeof this.workspaceState?.update === 'function') {
        void Promise.resolve(
          this.workspaceState.update('charlier.selectedProvider', next)
        ).catch(() => {});
      }
      if (typeof this.vault.setSelectedProviderForHost === 'function') {
        if (host === 'vscode') {
          this.vault.setSelectedProviderForHost('vscode', next);
        }
      } else {
        this.vault.setSelectedProvider(next);
      }
    }
    // Instant flip: repaint the last computed frame for the other deck synchronously
    // (no disk, daemon, or network wait); refresh in background when the target deck is stale or missing.
    if (this.lastFrame) {
      this.renderFrame(this.lastFrame);
      const targetMetrics =
        next === 'antigravity' ? this.lastFrame.agy.metrics : this.lastFrame.codex.metrics;
      const targetAgeMs = Date.now() - this.lastProviderFullUpdateAt[next];
      if (
        !targetMetrics ||
        targetAgeMs > 15_000 ||
        Date.now() - this.lastFrameAt > 30_000
      ) {
        this.scheduleUpdate(10, false);
      }
    } else {
      await this.update();
    }
  }

  private getHostKey(): 'antigravity' | 'vscode' {
    return (vscode.env?.appName || '').toLowerCase().includes('antigravity')
      ? 'antigravity'
      : 'vscode';
  }

  public handleFocusSignal(
    target: ActiveProviderId,
    source: 'editor' | 'terminal' | 'stream'
  ): void {
    if (this.disposed) return;
    const autoMode = vscode.workspace
      .getConfiguration('charlier')
      .get<string>('autoSwitchProvider', 'auto');
    if (autoMode === 'off') return;
    if (Date.now() < this.manualProviderPinUntil) return;
    if (this.selectedProvider === target) return;
    if (
      source !== 'terminal' &&
      source !== 'stream' &&
      !PROVIDER_RUNTIME_REGISTRY[target]?.isRunningOrActive?.()
    ) {
      return;
    }
    if (this.autoSwitchDebounceTimer) {
      clearTimeout(this.autoSwitchDebounceTimer);
    }
    this.autoSwitchDebounceTimer = setTimeout(() => {
      this.autoSwitchDebounceTimer = null;
      if (this.disposed) return;
      if (Date.now() < this.manualProviderPinUntil) return;
      if (this.selectedProvider === target) return;
      this.switchProvider(target, { manual: false }).catch(() => {});
    }, 15);
  }

  public async runStartupAuthHeartbeat(): Promise<void> {
    const agyLive = await this.vault.getLiveSessionInfoAsync().catch(() => ({
      email: null,
      hasOAuthCreds: false,
      tokenExpiryDate: null,
      isExpired: false
    }));
    const agyState = this.vault.getState();

    await Promise.allSettled([
      typeof (this.quotaService as any).probeAllAuthHealth === 'function'
        ? this.quotaService.probeAllAuthHealth(
            this.vault,
            agyLive.email,
            agyState.activeProfileId
          )
        : Promise.resolve(false),
      typeof (this.codexQuotaService as any).probeAllAuthHealth === 'function'
        ? this.codexQuotaService.probeAllAuthHealth(this.codexVault)
        : Promise.resolve(false)
    ]);

    this.scheduleUpdate(60, true);
    await this.maybeNotifyActiveReauth();
  }

  private async maybeNotifyActiveReauth(): Promise<void> {
    const codexLive = this.codexVault.getLiveSessionInfo();
    const codexMatched = this.codexVault.findMatchingProfile(codexLive);
    const codexHealth =
      (this.codexQuotaService as any).getActiveAuthHealth?.(codexLive) || null;
    const codexStatus = codexMatched?.authStatus || codexHealth?.authStatus;
    const codexKey = `codex:${codexMatched?.id || codexLive.accountId || codexLive.email || 'active'}`;
    if (codexStatus === 'revoked' || codexStatus === 'expired') {
      if (!this.notifiedReauthKeys.has(codexKey)) {
        this.notifiedReauthKeys.add(codexKey);
        const label = codexMatched?.name || codexLive.email || 'Codex account';
        this.promptActiveReauthAction('codex', label);
      }
    } else if (codexStatus === 'ok') {
      this.notifiedReauthKeys.delete(codexKey);
    }

    const agyLive = await this.vault.getLiveSessionInfoAsync().catch(() => null);
    if (agyLive?.email) {
      const agyMatched = this.vault
        .listProfiles()
        .find((p) => p.email.toLowerCase() === agyLive.email!.toLowerCase());
      const agyHealth =
        (this.quotaService as any).getActiveAuthHealth?.(agyLive.email) || null;
      const agyStatus = agyMatched?.authStatus || agyHealth?.authStatus;
      const agyKey = `antigravity:${agyMatched?.id || agyLive.email}`;
      if (agyStatus === 'revoked' || agyStatus === 'expired') {
        if (!this.notifiedReauthKeys.has(agyKey)) {
          this.notifiedReauthKeys.add(agyKey);
          const label = agyMatched?.name || agyLive.email;
          this.promptActiveReauthAction('antigravity', label);
        }
      } else if (agyStatus === 'ok') {
        this.notifiedReauthKeys.delete(agyKey);
      }
    }
  }

  private promptActiveReauthAction(
    provider: ActiveProviderId,
    accountLabel: string
  ): void {
    const providerTitle = provider === 'codex' ? 'Codex' : 'Antigravity';
    Promise.resolve(
      vscode.window.showWarningMessage(
        `Charlier: Active ${providerTitle} session "${accountLabel}" appears signed out or revoked. Start re-login or switch accounts?`,
        'Start Re-Login',
        'Switch Account'
      )
    )
      .then((choice) => {
        if (choice === 'Start Re-Login') {
          return this.handleAddAccount(provider);
        }
        if (choice === 'Switch Account') {
          return this.switchProvider(provider, { manual: true }).then(() =>
            this.showQuickPickMenu()
          );
        }
        return undefined;
      })
      .catch(() => {});
  }

  /**
   * Coalesces bursts of background-triggered refreshes (watcher, quota pulls, daemon
   * respawn callbacks) into a single trailing render so the UI never repaints in waves.
   */
  public scheduleUpdate(delayMs = 120, fast = false): void {
    if (this.disposed) return;
    if (this.scheduledUpdateTimer) {
      // A full update requested by anyone must never be downgraded to a fast one.
      this.scheduledFast = this.scheduledFast && fast;
      return;
    }
    this.scheduledFast = fast;
    this.scheduledUpdateTimer = setTimeout(() => {
      this.scheduledUpdateTimer = null;
      if (this.disposed) return;
      const useFast = this.scheduledFast;
      this.scheduledFast = false;
      this.update(useFast).catch(() => {});
    }, delayMs);
    (this.scheduledUpdateTimer as any)?.unref?.();
  }

  /**
   * Synchronizes both Antigravity and Codex vault states, updates the Status Bar
   * and rich Markdown hover tooltip for the selected provider, and pushes a live
   * render frame to the Activity Bar Cockpit Webview.
   * `fast` renders from disk and in-memory caches only (no daemon RPC or network wait).
   */
  public async update(fast = false): Promise<void> {
    if (this.disposed) return;
    if (this.isUpdating) {
      this.pendingUpdate = true;
      this.pendingFast = this.pendingFast && fast;
      return;
    }
    this.isUpdating = true;
    try {
      let runFast = fast;
      do {
        if (this.disposed) break;
        this.pendingUpdate = false;
        this.pendingFast = true;
        await this.performUpdate(runFast);
        runFast = this.pendingFast;
      } while (this.pendingUpdate);
    } finally {
      this.isUpdating = false;
    }
  }

  private async performUpdate(fast = false): Promise<void> {
    if (this.disposed) return;
    const providerAtStart = this.selectedProvider;
    // 1. Gather Antigravity state (skip blocking on daemon when Codex deck is active)
    const agyProfiles = this.vault.listProfiles();
    const agyState = this.vault.getState();
    const skipDaemonWait = fast || providerAtStart !== 'antigravity';
    const [agyLive, agyQuota] = await Promise.all([
      this.vault.getLiveSessionInfoAsync(),
      this.getAntigravityQuotaWithoutBlocking(skipDaemonWait)
    ]);
    if (this.disposed) return;

    if (!agyLive.email && agyQuota?.email) {
      agyLive.email = agyQuota.email;
      agyLive.hasOAuthCreds = true;
    }
    if (
      !agyLive.email &&
      !agyQuota?.email &&
      typeof (this.quotaService as any).peekDaemonIdentityAsync === 'function'
    ) {
      const peek = await (this.quotaService as any)
        .peekDaemonIdentityAsync()
        .catch(() => null);
      if (this.disposed) return;
      if (peek?.email) {
        agyLive.email = peek.email;
        agyLive.hasOAuthCreds = true;
        if (peek.authStatus) {
          agyLive.authStatus = peek.authStatus;
        }
        if (peek.validationUrl) {
          agyLive.validationUrl = peek.validationUrl;
        }
      }
    }

    const agyAuthHealth = (this.quotaService as any).getActiveAuthHealth?.(agyLive.email);
    if (agyAuthHealth) {
      agyLive.authStatus = agyAuthHealth.authStatus;
      agyLive.authErrorCode = agyAuthHealth.authErrorCode;
      agyLive.authErrorMessage = agyAuthHealth.authErrorMessage;
      if (agyAuthHealth.validationUrl) {
        agyLive.validationUrl = agyAuthHealth.validationUrl;
      }
    }
    if (agyQuota?.authStatus === 'unverified') {
      agyLive.authStatus = 'unverified';
      agyLive.authErrorCode = agyQuota.authErrorCode || 'VALIDATION_REQUIRED';
      agyLive.authErrorMessage = agyQuota.authErrorMessage;
      if (agyQuota.validationUrl) {
        agyLive.validationUrl = agyQuota.validationUrl;
      }
    }

    const agyAuthenticated = Boolean(agyLive.email || agyLive.hasOAuthCreds);
    let agyActiveProfile: ProfileMetadata | null = null;
    let agyIsUnsavedSession = false;

    if (agyLive.email) {
      const matched = agyProfiles.find(
        (p) => p.email.toLowerCase() === agyLive.email!.toLowerCase()
      );
      if (matched) {
        const pinnedIdeId = this.vault.getState().activeProfileId;
        const pinnedIdeProfile =
          this.cliAntigravityProfileId &&
          matched.id === this.cliAntigravityProfileId &&
          pinnedIdeId &&
          pinnedIdeId !== matched.id
            ? agyProfiles.find((p) => p.id === pinnedIdeId) || null
            : null;
        if (pinnedIdeProfile) {
          // CLI Only staged `matched` for terminals; the IDE daemon still runs the pinned profile.
          agyActiveProfile = pinnedIdeProfile;
        } else {
          agyActiveProfile = matched;
          if (agyState.activeProfileId !== matched.id) {
            this.vault.saveState({ activeProfileId: matched.id });
          }
        }
      } else {
        agyIsUnsavedSession = true;
      }
    } else if (agyState.activeProfileId) {
      const stateProfile =
        agyProfiles.find((p) => p.id === agyState.activeProfileId) || null;
      if (agyAuthenticated || stateProfile?.authStatus === 'unverified') {
        agyActiveProfile = stateProfile;
      }
    }

    if (this.cliAntigravityProfileId && agyQuota?.email) {
      const daemonProfile = agyProfiles.find(
        (p) => p.email.toLowerCase() === agyQuota.email!.toLowerCase()
      );
      if (daemonProfile && daemonProfile.id !== this.cliAntigravityProfileId) {
        agyActiveProfile = daemonProfile;
        agyIsUnsavedSession = false;
        if (agyState.activeProfileId !== daemonProfile.id) {
          this.vault.saveState({ activeProfileId: daemonProfile.id });
        }
      } else if (daemonProfile && daemonProfile.id === this.cliAntigravityProfileId) {
        this.cliAntigravityProfileId = null;
      }
    }

    let agyLiveMetrics: CachedQuotaMetric | null = null;
    const agyQuotaMatchesLive =
      quotaMatchesIdentity(agyQuota?.email, agyLive.email) ||
      (this.cliAntigravityProfileId !== null &&
        quotaMatchesIdentity(agyQuota?.email, agyActiveProfile?.email ?? null));
    if (
      agyActiveProfile &&
      agyLive.authStatus === 'unverified' &&
      (!agyQuota || agyQuota.groups.length === 0) &&
      quotaMatchesIdentity(agyLive.email, agyActiveProfile.email)
    ) {
      this.vault.updateProfileAuthHealth(agyActiveProfile.id, {
        authStatus: 'unverified',
        authErrorCode: agyLive.authErrorCode || 'VALIDATION_REQUIRED',
        authErrorMessage: agyLive.authErrorMessage,
        validationUrl: agyLive.validationUrl || agyActiveProfile.validationUrl,
        authCheckedAt: Date.now()
      });
      agyActiveProfile.authStatus = 'unverified';
      agyActiveProfile.authErrorCode = agyLive.authErrorCode || 'VALIDATION_REQUIRED';
      agyActiveProfile.authErrorMessage = agyLive.authErrorMessage;
      if (agyLive.validationUrl) {
        agyActiveProfile.validationUrl = agyLive.validationUrl;
      }
    }
    if (agyQuotaMatchesLive && agyQuota && agyQuota.groups.length > 0) {
      agyLiveMetrics = this.quotaService.parseMetrics(
        agyQuota,
        agyActiveProfile?.planOverride
      );
      if (quotaMatchesIdentity(agyQuota.email, agyLive.email)) {
        agyLive.authStatus = 'ok';
        delete agyLive.authErrorCode;
        delete agyLive.authErrorMessage;
        delete agyLive.validationUrl;
      }
      if (agyActiveProfile && agyQuota.email?.toLowerCase() === agyActiveProfile.email.toLowerCase()) {
        this.vault.updateProfileCachedQuota(agyActiveProfile.id, agyLiveMetrics);
        agyActiveProfile.cachedQuota = agyLiveMetrics;
        const wasRevokedOrExpired =
          agyActiveProfile.authStatus === 'revoked' ||
          agyActiveProfile.authStatus === 'expired';
        const wasUnverified = agyActiveProfile.authStatus === 'unverified';
        if (wasRevokedOrExpired || wasUnverified) {
          this.vault.updateProfileAuthHealth(agyActiveProfile.id, {
            authStatus: 'ok',
            authCheckedAt: Date.now()
          });
          agyActiveProfile.authStatus = 'ok';
          delete agyActiveProfile.authErrorCode;
          delete agyActiveProfile.authErrorMessage;
          delete agyActiveProfile.validationUrl;
          this.notifiedReauthKeys.delete(`antigravity:${agyActiveProfile.id}`);
          this.vault.syncActiveCredentialsToProfileAsync(agyActiveProfile.id).catch(() => {});
          if (wasRevokedOrExpired) {
            void this.notifyProfileReauthenticated('antigravity', agyActiveProfile);
          } else if (wasUnverified) {
            vscode.window.showInformationMessage(
              `Verified & synced Antigravity profile "${agyActiveProfile.name}" (${agyActiveProfile.email}). Live quota unlocked.`
            );
          }
        }
      }
    }

    const agyHasStale = agyProfiles.some((p) => {
      if (agyActiveProfile && p.id === agyActiveProfile.id) return false;
      const updated = p.cachedQuota?.updatedAt || 0;
      return Date.now() - updated > 120000;
    });
    if (agyHasStale && Date.now() - this.lastAntigravityBackgroundRefreshAttempt > 120000) {
      this.lastAntigravityBackgroundRefreshAttempt = Date.now();
      this.quotaService
        .refreshAllInactiveProfiles(
          agyProfiles,
          agyLive.email,
          agyActiveProfile?.id || agyState.activeProfileId,
          this.vault,
          false
        )
        .then(() => {
          if (!this.disposed) {
            this.scheduleUpdate(80, true);
          }
        })
        .catch(() => {});
    }

    // 2. Gather Codex state
    const codexProfiles = this.codexVault.listProfiles();
    const codexLive = this.codexVault.getLiveSessionInfo();
    const codexSvc = this.codexQuotaService as any;
    const codexAuthHealth = codexSvc.getActiveAuthHealth?.(codexLive);
    if (codexAuthHealth) {
      codexLive.authStatus = codexAuthHealth.authStatus;
      codexLive.authErrorCode = codexAuthHealth.authErrorCode;
      codexLive.authErrorMessage = codexAuthHealth.authErrorMessage;
    }
    const codexAuthenticated = Boolean(
      codexLive.email || codexLive.accountId || codexLive.hasOAuthCreds
    );
    const codexMatched = this.codexVault.findMatchingProfile(codexLive);

    let codexActiveProfile: ProfileMetadata | null = null;
    let codexIsUnsavedSession = false;

    if (codexAuthenticated) {
      if (codexMatched) {
        const pinnedIdeCodexId = this.vault.getState().activeCodexProfileId;
        const pinnedIdeCodexProfile =
          this.cliCodexProfileId &&
          codexMatched.id === this.cliCodexProfileId &&
          pinnedIdeCodexId &&
          pinnedIdeCodexId !== codexMatched.id
            ? codexProfiles.find((p) => p.id === pinnedIdeCodexId) || null
            : null;

        if (pinnedIdeCodexProfile) {
          codexActiveProfile = pinnedIdeCodexProfile;
        } else {
          codexActiveProfile = codexMatched;
          if (this.cliCodexProfileId && codexMatched.id !== this.cliCodexProfileId) {
            this.cliCodexProfileId = null;
          }
          if (this.vault.getState().activeCodexProfileId !== codexMatched.id) {
            this.vault.setActiveCodexProfileId(codexMatched.id);
          }
        }
      } else if (codexLive.email || codexLive.accountId) {
        codexIsUnsavedSession = true;
      }
    }

    const codexHasStale = codexProfiles.some((p) => {
      if (p.authMode === 'apikey') return false;
      if (isSyntheticCodexQuota(p.cachedQuota)) return true;
      const updated = p.cachedQuota?.updatedAt || 0;
      return Date.now() - updated > 120000;
    });
    if (codexHasStale && Date.now() - this.lastCodexBackgroundRefreshAttempt > 120000) {
      this.lastCodexBackgroundRefreshAttempt = Date.now();
      this.codexQuotaService
        .refreshAllProfiles(this.codexVault)
        .then((count) => {
          if (!this.disposed && count > 0) {
            this.scheduleUpdate(80, true);
          }
        })
        .catch(() => {});
    }

    let rawCodexLiveMetric = codexActiveProfile?.cachedQuota;
    const isCodexReauthPending =
      codexActiveProfile?.authStatus === 'revoked' ||
      codexActiveProfile?.authStatus === 'expired' ||
      codexAuthHealth?.authStatus === 'revoked' ||
      codexAuthHealth?.authStatus === 'expired';
    const needsLiveCodexMetric =
      (codexIsUnsavedSession && codexLive.authMode !== 'apikey') ||
      (Boolean(
        codexActiveProfile &&
          codexActiveProfile.authMode !== 'apikey'
      ) &&
        needsCodexLiveProbe(
          rawCodexLiveMetric,
          codexActiveProfile?.authStatus,
          codexAuthHealth?.authStatus,
          Date.now(),
          45000
        ));
    if (needsLiveCodexMetric && typeof codexSvc.getActiveQuotaSummary === 'function') {
      const cachedSummary = codexSvc.getCachedSummary?.();
      const cachedMetric = codexSvc.getCachedMetric?.();
      const cacheMatchesLive =
        !isCodexReauthPending &&
        Boolean(
          cachedSummary &&
            cachedMetric &&
            ((codexLive.accountId && cachedSummary.accountId === codexLive.accountId) ||
              (codexLive.email &&
                cachedSummary.email?.toLowerCase() === codexLive.email.toLowerCase()))
        );
      if (cacheMatchesLive) {
        rawCodexLiveMetric = cachedMetric;
      } else if (
        !rawCodexLiveMetric &&
        !isCodexReauthPending &&
        this.lastFrame?.codex.metrics &&
        ((codexLive.accountId &&
          this.lastFrame.codex.live.accountId === codexLive.accountId) ||
          (codexLive.email &&
            this.lastFrame.codex.live.email?.toLowerCase() ===
              codexLive.email.toLowerCase()))
      ) {
        rawCodexLiveMetric = this.lastFrame.codex.metrics;
      }

      const cacheIsFresh =
        cacheMatchesLive &&
        (typeof codexSvc.isCacheFresh === 'function'
          ? codexSvc.isCacheFresh()
          : true);

      if (codexIsUnsavedSession && !rawCodexLiveMetric) {
        // First render of a brand-new unsaved Codex session: resolve its ~120ms wham/usage
        // snapshot immediately (even on a fast update) so the Hero dial mounts at its real capacity
        // instead of flashing empty.
        const initialRes = await Promise.race([
          this.codexQuotaService
            .getActiveQuotaSummary(this.codexVault, isCodexReauthPending)
            .catch(() => null),
          new Promise<null>((resolve) => {
            const t = setTimeout(() => resolve(null), 1200);
            (t as any)?.unref?.();
          })
        ]);
        if (initialRes?.metric) {
          rawCodexLiveMetric = initialRes.metric;
        }
      } else if (!fast && !cacheIsFresh) {
        const wasBrokenBeforeProbe = Boolean(
          isCodexReauthPending ||
            (codexActiveProfile &&
              this.pendingReauthTarget?.provider === 'codex' &&
              this.pendingReauthTarget.profileId === codexActiveProfile.id)
        );
        // Never block rendering on the network: fetch in the background, repaint once it lands.
        this.codexQuotaService
          .getActiveQuotaSummary(this.codexVault, isCodexReauthPending)
          .then((res) => {
            if (!this.disposed && res?.metric) {
              if (codexActiveProfile) {
                this.notifiedReauthKeys.delete(`codex:${codexActiveProfile.id}`);
                if (wasBrokenBeforeProbe) {
                  const latestProfile =
                    this.codexVault
                      .listProfiles()
                      .find((p) => p.id === codexActiveProfile.id) ||
                    codexActiveProfile;
                  this.notifyProfileReauthenticated('codex', latestProfile);
                }
              }
              this.scheduleUpdate(60, true);
            } else if (!this.disposed && !isCodexReauthPending) {
              const latestHealth = codexSvc.getActiveAuthHealth?.(codexLive);
              if (
                latestHealth &&
                (latestHealth.authStatus === 'revoked' ||
                  latestHealth.authStatus === 'expired') &&
                latestHealth.authStatus !== codexLive.authStatus
              ) {
                this.scheduleUpdate(60, true);
              }
            }
          })
          .catch(() => {});
      }
    }

    const codexLiveMetrics = codexMetricForDisplay(
      isCodexReauthPending
        ? rawCodexLiveMetric
        : healExpiredCodexMetric(rawCodexLiveMetric),
      codexActiveProfile?.authMode || codexLive.authMode
    ) || null;

    // 3. Snapshot a complete frame for both decks so provider flips can repaint instantly
    const config = vscode.workspace.getConfiguration('charlier');
    const showStatusBarQuota = config.get<boolean>('showStatusBarQuota', true);

    const frame: RenderFrame = {
      showStatusBarQuota,
      agy: {
        profiles: agyProfiles,
        activeProfile: agyActiveProfile,
        live: agyLive,
        authenticated: agyAuthenticated,
        quota: agyQuotaMatchesLive ? agyQuota : null,
        isUnsaved: agyIsUnsavedSession,
        metrics: agyLiveMetrics,
        cliProfileId:
          this.cliAntigravityProfileId &&
          this.cliAntigravityProfileId !== agyActiveProfile?.id
            ? this.cliAntigravityProfileId
            : null
      },
      codex: {
        profiles: codexProfiles,
        activeProfile: codexActiveProfile,
        live: codexLive,
        authenticated: codexAuthenticated,
        isUnsaved: codexIsUnsavedSession,
        metrics: codexLiveMetrics,
        cliProfileId:
          this.cliCodexProfileId && this.cliCodexProfileId !== codexActiveProfile?.id
            ? this.cliCodexProfileId
            : null
      }
    };
    this.lastFrame = frame;
    this.lastFrameAt = Date.now();
    if (!fast && !this.disposed) {
      this.lastProviderFullUpdateAt[providerAtStart] = Date.now();
    }
    this.renderFrame(frame);

    if (agyIsUnsavedSession && agyLive.email) {
      const normAgyEmail = agyLive.email.trim().toLowerCase();
      if (
        this.hasCompletedInitialUpdate &&
        this.activeUnsavedAgyEmail !== normAgyEmail
      ) {
        if (this.promptedEmails.delete(normAgyEmail)) {
          this.persistPromptedUnsavedState();
        }
        this.sessionDismissedPromptKeys.delete(`antigravity:${normAgyEmail}`);
      }
      this.activeUnsavedAgyEmail = normAgyEmail;
      void this.checkForNewUnsavedAccount('antigravity');
    } else {
      this.activeUnsavedAgyEmail = null;
    }

    if (codexIsUnsavedSession && (codexLive.email || codexLive.accountId)) {
      const codexIdKey = `${(codexLive.accountId || '').toLowerCase()}::${(codexLive.email || '').toLowerCase()}`;
      if (
        this.hasCompletedInitialUpdate &&
        this.activeUnsavedCodexKey !== codexIdKey
      ) {
        this.clearCodexUnsavedDismissal(codexLive.accountId, codexLive.email);
      }
      this.activeUnsavedCodexKey = codexIdKey;
      void this.checkForNewUnsavedAccount('codex');
    } else {
      this.activeUnsavedCodexKey = null;
    }

    this.hasCompletedInitialUpdate = true;
  }

  private async getAntigravityQuotaWithoutBlocking(
    fast: boolean
  ): Promise<QuotaSummary | null> {
    const svc = this.quotaService as any;
    const cached: QuotaSummary | null =
      typeof svc.getCachedSummary === 'function' ? svc.getCachedSummary() : null;
    if (fast) {
      return cached;
    }
    const pending: Promise<QuotaSummary | null> = this.quotaService.getQuotaSummary();
    const waitMs = cached ? 600 : 900;
    let timedOut = false;
    const result = await Promise.race([
      pending,
      new Promise<QuotaSummary | null>((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve(cached);
        }, waitMs)
      )
    ]);
    if (timedOut) {
      // The daemon is slow (respawning or busy): repaint cleanly once it finally answers.
      pending
        .then((late) => {
          if (!this.disposed && late) {
            this.scheduleUpdate(60, true);
          }
        })
        .catch(() => {});
    }
    return result;
  }

  private renderFrame(frame: RenderFrame): void {
    const { agy, codex, showStatusBarQuota } = frame;
    if (this.selectedProvider === 'codex') {
      this.updateCodexStatusBar(
        codex.profiles,
        codex.activeProfile,
        codex.live,
        codex.authenticated,
        codex.isUnsaved,
        codex.metrics,
        showStatusBarQuota
      );
    } else {
      this.updateAntigravityStatusBar(
        agy.profiles,
        agy.activeProfile,
        agy.live,
        agy.authenticated,
        agy.quota,
        agy.isUnsaved,
        showStatusBarQuota,
        agy.metrics
      );
    }

    if (this.sidebar) {
      this.sidebar.render({
        selectedProvider: this.selectedProvider,
        antigravity: {
          profiles: agy.profiles,
          activeProfileId: agy.activeProfile?.id || null,
          cliProfileId: agy.cliProfileId,
          claimedProfileIds: Array.from(this.getClaimedProfileIds('antigravity')),
          sessionKind: agy.activeProfile ? 'saved' : agy.isUnsaved ? 'unsaved' : agy.authenticated ? 'unidentified' : 'none',
          liveSession: agy.live,
          liveMetrics: agy.metrics,
          formatReset: (iso?: string) => this.quotaService.formatResetCompact(iso)
        },
        codex: {
          profiles: codex.profiles,
          activeProfileId: codex.activeProfile?.id || null,
          cliProfileId: codex.cliProfileId,
          claimedProfileIds: Array.from(this.getClaimedProfileIds('codex')),
          sessionKind: codex.activeProfile ? 'saved' : codex.isUnsaved ? 'unsaved' : codex.authenticated ? 'unidentified' : 'none',
          liveSession: codex.live,
          liveMetrics: codex.metrics
        }
      });
    }
  }

  private applyUnifiedStatusBar(
    provider: ActiveProviderId,
    label: string,
    needsReauth: boolean,
    needsVerification: boolean,
    showStatusBarQuota: boolean,
    quotaText: string,
    minPct: number | null,
    nextTooltip: vscode.MarkdownString | string,
    claimedCount = 0
  ): void {
    const providerTitle = provider === 'codex' ? 'Codex' : 'Antigravity';
    const nextText = formatUnifiedStatusBarText({
      provider,
      label,
      needsReauth,
      needsVerification,
      showStatusBarQuota,
      quotaText,
      claimedCount,
      includeHoverCue: false
    });
    const tone = resolveQuotaTone(
      showStatusBarQuota ? minPct : null,
      provider,
      needsReauth,
      needsVerification
    );
    const resolvedColorId = tone.bgId ? undefined : tone.colorId;
    const statusSuffix = needsReauth
      ? ', re-authentication required'
      : needsVerification
        ? ', verification needed'
        : showStatusBarQuota && minPct === 0
          ? ', quota depleted'
          : showStatusBarQuota && minPct !== null && minPct < 15
            ? ', low quota'
            : '';
    const cliSuffix =
      claimedCount > 0
        ? `, ${claimedCount} CLI terminal${claimedCount > 1 ? 's' : ''} claimed`
        : '';
    const nextA11y = `Charlier ${providerTitle}, ${label}${showStatusBarQuota && quotaText && !needsReauth && !needsVerification ? `, ${quotaText}` : ''}${cliSuffix}${statusSuffix}. Hover for live overlay or click to switch.`;

    if (this.lastStatusBarText !== nextText) {
      this.lastStatusBarText = nextText;
      this.statusBarItem.text = nextText;
    }

    const applyStatusBarColor = (): void => {
      if (this.lastStatusBarColorId !== resolvedColorId) {
        this.lastStatusBarColorId = resolvedColorId;
        this.statusBarItem.color = resolvedColorId
          ? new vscode.ThemeColor(resolvedColorId)
          : undefined;
      }
    };
    const applyStatusBarBg = (): void => {
      if (this.lastStatusBarBgId !== tone.bgId) {
        this.lastStatusBarBgId = tone.bgId;
        this.statusBarItem.backgroundColor = tone.bgId
          ? new vscode.ThemeColor(tone.bgId)
          : undefined;
      }
    };
    if (tone.bgId) {
      applyStatusBarBg();
      applyStatusBarColor();
    } else {
      applyStatusBarColor();
      applyStatusBarBg();
    }

    if (this.lastStatusBarA11y !== nextA11y) {
      this.lastStatusBarA11y = nextA11y;
      this.statusBarItem.accessibilityInformation = {
        label: nextA11y,
        role: 'button'
      };
    }

    const nextTooltipVal =
      typeof nextTooltip === 'string'
        ? nextTooltip
        : (nextTooltip as vscode.MarkdownString)?.value;
    if (
      this.lastTooltipValue === undefined ||
      nextTooltipVal === undefined ||
      this.lastTooltipValue !== nextTooltipVal
    ) {
      this.lastTooltipValue = nextTooltipVal;
      this.statusBarItem.tooltip = nextTooltip;
    }
  }

  private updateAntigravityStatusBar(
    profiles: ProfileMetadata[],
    activeProfile: ProfileMetadata | null,
    live: LiveSessionInfo,
    authenticated: boolean,
    quota: QuotaSummary | null,
    isUnsavedSession: boolean,
    showStatusBarQuota: boolean,
    liveMetrics: CachedQuotaMetric | null = null
  ): void {
    let label: string;
    if (activeProfile) {
      label = this.truncate(activeProfile.name, 14);
    } else if (isUnsavedSession && live.email) {
      const handle = live.email.includes('@')
        ? live.email.split('@')[0]
        : live.email;
      label = `${this.truncate(handle, 12)}*`;
    } else if (authenticated) {
      label = 'Online*';
    } else if (profiles.length > 0) {
      label = 'Switch';
    } else {
      label = 'Charlier';
    }

    const activeStatus = resolveEffectiveAuthStatus(
      activeProfile?.authStatus,
      live.authStatus,
      quota?.authStatus
    );
    const needsReauth =
      activeStatus === 'revoked' || activeStatus === 'expired';
    const needsVerification =
      !needsReauth && activeStatus === 'unverified';
    const { quotaText, minPct } = showStatusBarQuota
      ? formatAntigravityStatusBarSummary({
          activeProfile,
          liveEmail: live.email,
          quota,
          liveMetrics
        })
      : { quotaText: '', minPct: null };

    const agyClaimedIds = this.getClaimedProfileIds('antigravity');
    const nextTooltip = this.quotaService.buildAccountsHoverTooltip(
      profiles,
      activeProfile?.id || null,
      live.email,
      quota,
      agyClaimedIds
    );
    this.applyUnifiedStatusBar(
      'antigravity',
      label,
      needsReauth,
      needsVerification,
      showStatusBarQuota,
      quotaText,
      minPct,
      nextTooltip,
      agyClaimedIds.size
    );
  }

  private updateCodexStatusBar(
    profiles: ProfileMetadata[],
    activeProfile: ProfileMetadata | null,
    live: LiveSessionInfo,
    authenticated: boolean,
    isUnsavedSession: boolean,
    liveMetrics: CachedQuotaMetric | null,
    showStatusBarQuota: boolean
  ): void {
    let label: string;
    if (activeProfile) {
      label = this.truncate(activeProfile.name, 14);
    } else if (isUnsavedSession && live.email) {
      const handle = live.email.includes('@')
        ? live.email.split('@')[0]
        : live.email;
      label = `${this.truncate(handle, 12)}*`;
    } else if (authenticated) {
      label = 'Codex*';
    } else {
      label = 'Codex';
    }

    const activeStatus = resolveEffectiveAuthStatus(
      activeProfile?.authStatus,
      live.authStatus
    );
    const needsReauth =
      activeStatus === 'revoked' || activeStatus === 'expired';
    const needsVerification =
      !needsReauth && activeStatus === 'unverified';
    const p5h =
      showStatusBarQuota && liveMetrics
        ? percentFromText(liveMetrics.codex5h)
        : null;
    const p7d =
      showStatusBarQuota && liveMetrics
        ? percentFromText(liveMetrics.codex7d)
        : null;
    const candidates = [p5h, p7d].filter((n): n is number => n !== null);
    const minPct = candidates.length > 0 ? Math.min(...candidates) : null;
    const parts: string[] = [];
    if (p5h !== null) parts.push(`5h ${p5h}%`);
    if (p7d !== null) parts.push(`7d ${p7d}%`);
    const quotaText = parts.join(' · ');

    const codexClaimedIds = this.getClaimedProfileIds('codex');
    const nextTooltip = this.codexQuotaService.buildCodexHoverTooltip(
      profiles,
      activeProfile?.id || null,
      liveMetrics,
      live,
      codexClaimedIds
    );
    this.applyUnifiedStatusBar(
      'codex',
      label,
      needsReauth,
      needsVerification,
      showStatusBarQuota,
      quotaText,
      minPct,
      nextTooltip,
      codexClaimedIds.size
    );
  }

  private persistPromptedUnsavedState(): void {
    try {
      this.vault.saveState({
        promptedUnsavedEmails: Array.from(this.promptedEmails).slice(-50),
        promptedUnsavedCodexIdentities: Array.from(this.promptedCodexIdentities).slice(-50)
      });
    } catch {}
  }

  private notifyProfileReauthenticated(
    provider: ActiveProviderId,
    profile: ProfileMetadata
  ): void {
    const recoveryKey = `${provider}:${profile.id}`;
    if (this.notifiedReauthRecoveryKeys.has(recoveryKey)) {
      return;
    }
    this.notifiedReauthRecoveryKeys.add(recoveryKey);
    this.notifiedReauthKeys.delete(recoveryKey);
    if (
      this.pendingReauthTarget?.provider === provider &&
      this.pendingReauthTarget.profileId === profile.id
    ) {
      this.pendingReauthTarget = null;
    }
    const providerTitle = provider === 'codex' ? 'Codex' : 'Antigravity';
    vscode.window.showInformationMessage(
      `Re-authenticated & synced ${providerTitle} profile "${profile.name}" (${profile.email}). Live quota restored.`
    );
  }

  private async detectAndSyncReauthenticatedSession(
    provider: ActiveProviderId
  ): Promise<boolean> {
    if (provider === 'codex') {
      const decoded = this.codexVault.readDecodedActiveAuth();
      if (!decoded || (!decoded.email && !decoded.accountId)) {
        return false;
      }
      const matched = this.codexVault.findMatchingProfile({
        accountId: decoded.accountId,
        email: decoded.email
      });
      if (!matched) {
        if (
          this.pendingReauthTarget?.provider === 'codex' &&
          decoded.email?.toLowerCase() !==
            this.pendingReauthTarget.email?.toLowerCase()
        ) {
          this.pendingReauthTarget = null;
        }
        return false;
      }

      const pendingMatches =
        this.pendingReauthTarget?.provider === 'codex' &&
        this.pendingReauthTarget.profileId === matched.id;
      const wasBroken =
        matched.authStatus === 'revoked' ||
        matched.authStatus === 'expired' ||
        pendingMatches;
      if (!wasBroken) {
        return false;
      }

      const synced = this.codexVault.syncActiveCredentialsToProfile(
        matched.id,
        decoded.rawAuthJson,
        decoded
      );
      const verifiedOkAfterPending =
        matched.authStatus === 'ok' &&
        pendingMatches &&
        (matched.authCheckedAt || 0) >= (this.pendingReauthTarget?.startedAt || 0);
      if (!synced && !verifiedOkAfterPending) {
        return false;
      }

      if (!this.cliCodexProfileId || this.cliCodexProfileId === matched.id) {
        this.vault.setActiveCodexProfileId(matched.id);
      }
      const updatedProfile =
        this.codexVault.listProfiles().find((p) => p.id === matched.id) || matched;
      this.notifyProfileReauthenticated('codex', updatedProfile);
      this.codexQuotaService
        .refreshProfileQuota(matched.id, this.codexVault, true)
        .then(() => this.scheduleUpdate(60, true))
        .catch(() => {});
      this.scheduleUpdate(60, true);
      return true;
    }

    const agyLive = await this.vault.getLiveSessionInfoAsync();
    if (!agyLive.email) {
      return false;
    }
    const matched = this.vault
      .listProfiles()
      .find((p) => p.email.toLowerCase() === agyLive.email!.toLowerCase());
    if (!matched) {
      if (
        this.pendingReauthTarget?.provider === 'antigravity' &&
        agyLive.email.toLowerCase() !==
          this.pendingReauthTarget.email?.toLowerCase()
      ) {
        this.pendingReauthTarget = null;
      }
      return false;
    }

    const pendingMatches =
      this.pendingReauthTarget?.provider === 'antigravity' &&
      this.pendingReauthTarget.profileId === matched.id;
    const wasBroken =
      matched.authStatus === 'revoked' ||
      matched.authStatus === 'expired' ||
      pendingMatches;
    if (!wasBroken) {
      return false;
    }

    const summary = await this.quotaService.getQuotaSummary(true).catch(() => null);
    if (
      !summary ||
      !summary.groups?.length ||
      summary.email?.toLowerCase() !== matched.email.toLowerCase()
    ) {
      return false;
    }

    await this.vault.syncActiveCredentialsToProfileAsync(matched.id);
    const updatedProfile = this.vault.getProfile(matched.id) || matched;
    this.notifyProfileReauthenticated('antigravity', updatedProfile);
    this.scheduleUpdate(60, true);
    return true;
  }

  /**
   * Detects when a user logs into a brand-new Antigravity or Codex account that isn't
   * saved in the Charlier vault yet (or re-authenticates a previously broken profile),
   * showing independent non-blocking notifications per provider.
   */
  public async checkForNewUnsavedAccount(
    providerFilter?: ActiveProviderId
  ): Promise<void> {
    const checkAntigravity = providerFilter !== 'codex';
    const checkCodex = providerFilter !== 'antigravity';

    const tasks: Array<Promise<void>> = [];
    if (checkAntigravity) {
      tasks.push(this.checkAntigravityUnsavedOrRecovered());
    }
    if (checkCodex) {
      tasks.push(this.checkCodexUnsavedOrRecovered());
    }
    await Promise.allSettled(tasks);
  }

  private async checkAntigravityUnsavedOrRecovered(): Promise<void> {
    if (await this.detectAndSyncReauthenticatedSession('antigravity')) {
      return;
    }
    if (Date.now() < this.suppressUnsavedPromptUntil) {
      return;
    }

    const agyLive = await this.vault.getLiveSessionInfoAsync();
    if (!agyLive.email && typeof (this.quotaService as any).peekDaemonIdentityAsync === 'function') {
      const peek = await (this.quotaService as any).peekDaemonIdentityAsync().catch(() => null);
      if (peek?.email) {
        agyLive.email = peek.email;
        agyLive.hasOAuthCreds = true;
      }
    }
    if (!agyLive.email) {
      const liveQ = await this.quotaService.getQuotaSummary().catch(() => null);
      if (liveQ?.email) {
        agyLive.email = liveQ.email;
        agyLive.hasOAuthCreds = true;
      }
    }
    if (!agyLive.email) return;

    const normalizedEmail = agyLive.email.toLowerCase();
    const promptKey = `antigravity:${normalizedEmail}`;
    if (
      this.inFlightPromptKeys.has(promptKey) ||
      this.sessionDismissedPromptKeys.has(promptKey) ||
      this.promptedEmails.has(normalizedEmail)
    ) {
      return;
    }

    const existing = this.vault
      .listProfiles()
      .find((p) => p.email.toLowerCase() === normalizedEmail);
    if (existing) return;

    this.inFlightPromptKeys.add(promptKey);
    try {
      const action = await vscode.window.showInformationMessage(
        `New Antigravity account online (${agyLive.email}). Save it as a profile in your vault?`,
        'Save Profile',
        'Later'
      );
      if (action === 'Save Profile') {
        await this.handleSaveCurrent('antigravity');
      } else if (action === 'Later') {
        this.promptedEmails.add(normalizedEmail);
        this.persistPromptedUnsavedState();
      } else {
        this.sessionDismissedPromptKeys.add(promptKey);
      }
    } finally {
      this.inFlightPromptKeys.delete(promptKey);
    }
  }

  private async checkCodexUnsavedOrRecovered(): Promise<void> {
    if (await this.detectAndSyncReauthenticatedSession('codex')) {
      return;
    }
    if (Date.now() < this.suppressUnsavedPromptUntil) {
      return;
    }

    const codexLive = this.codexVault.getLiveSessionInfo(true);
    if (!codexLive.email && !codexLive.accountId) return;

    const existingCodex = this.codexVault.findMatchingProfile(codexLive);
    if (existingCodex) return;

    const identityKey = `${(codexLive.accountId || '').toLowerCase()}::${(codexLive.email || '').toLowerCase()}`;
    const promptKey = `codex:${identityKey}`;
    if (
      this.inFlightPromptKeys.has(promptKey) ||
      this.sessionDismissedPromptKeys.has(promptKey) ||
      this.promptedCodexIdentities.has(identityKey)
    ) {
      return;
    }

    this.inFlightPromptKeys.add(promptKey);
    try {
      const displayLabel =
        codexLive.email || codexLive.accountId || 'Codex Account';
      const action = await vscode.window.showInformationMessage(
        `New OpenAI Codex account online (${displayLabel}). Save it as a profile in your vault?`,
        'Save Profile',
        'Later'
      );
      if (action === 'Save Profile') {
        await this.handleSaveCurrent('codex');
      } else if (action === 'Later') {
        this.promptedCodexIdentities.add(identityKey);
        this.persistPromptedUnsavedState();
      } else {
        this.sessionDismissedPromptKeys.add(promptKey);
      }
    } finally {
      this.inFlightPromptKeys.delete(promptKey);
    }
  }

  public async showQuickPickMenu(): Promise<void> {
    if (this.selectedProvider === 'codex') {
      await this.showCodexQuickPickMenu();
    } else {
      await this.showAntigravityQuickPickMenu();
    }
  }

  private buildAntigravityQuickPickItems(
    profiles: ProfileMetadata[],
    activeProfile: ProfileMetadata | null,
    live: LiveSessionInfo,
    authenticated: boolean,
    quota: QuotaSummary | null
  ): ProfileQuickPickItem[] {
    const items: ProfileQuickPickItem[] = [];

    if (authenticated && !activeProfile) {
      items.push({
        label: '$(sparkle) Unsaved Antigravity Session',
        kind: vscode.QuickPickItemKind.Separator,
        action: 'noop'
      });

      const liveEmail = live.email || 'Authenticated Session';
      items.push({
        label: `$(add) Save "${liveEmail}" to Vault`,
        description: quota ? `${quota.planTier} Plan` : 'Active now',
        detail:
          ' Snapshot your current Google login so you can switch back in 1 click',
        action: 'save',
        provider: 'antigravity'
      });
    }

    if (profiles.length > 0) {
      items.push({
        label: `Antigravity Vault (${profiles.length})`,
        kind: vscode.QuickPickItemKind.Separator,
        action: 'noop'
      });

      const agyClaimedIds = this.getClaimedProfileIds('antigravity');
      const sortedProfiles = sortProfilesForDisplay(
        profiles,
        activeProfile?.id || null,
        agyClaimedIds,
        live.email
      );
      const activeAgyPools = resolveAntigravityPrimaryPools(
        activeProfile,
        null,
        quota,
        live.email
      );
      const activeAgyStatus = resolveEffectiveAuthStatus(
        activeProfile?.authStatus,
        live.authStatus,
        quota?.authStatus
      );
      const bestAgyStandby = resolveBestStandbyProfile({
        provider: 'antigravity',
        profiles,
        activeProfileId: activeProfile?.id || null,
        activeMinPct: activeAgyPools.avgPct,
        activeNeedsAction:
          activeAgyStatus === 'revoked' ||
          activeAgyStatus === 'expired' ||
          activeAgyStatus === 'unverified' ||
          (!activeProfile && !authenticated),
        activePrimaryPools: { gemini: activeAgyPools.gPct, claude: activeAgyPools.cPct },
        claimedProfileIds: agyClaimedIds
      });

      for (const prof of sortedProfiles) {
        const isCurrent = Boolean(
          activeProfile && prof.id === activeProfile.id
        );
        const isClaimed = agyClaimedIds.has(prof.id);
        const isBestNext = Boolean(
          bestAgyStandby && bestAgyStandby.profile.id === prof.id
        );
        const cq = prof.cachedQuota;
        const planName =
          prof.planOverride ||
          cq?.plan ||
          (isCurrent && quota ? quota.planTier : 'FREE');

        const buttons: vscode.QuickInputButton[] = [
          ...(!isCurrent && prof.authStatus !== 'unverified'
            ? [
                {
                  iconPath: new vscode.ThemeIcon('terminal'),
                  tooltip: isClaimed
                    ? `Focus claimed CLI terminal for "${prof.name}"`
                    : `Switch CLI Only for "${prof.name}" (Isolated agy terminal)`
                }
              ]
            : []),
          {
            iconPath: new vscode.ThemeIcon('graph'),
            tooltip: `Inspect 5h & Weekly Pools for "${prof.name}"`
          },
          {
            iconPath: new vscode.ThemeIcon('edit'),
            tooltip: `Rename or Set Plan Tier for "${prof.name}"`
          },
          ...(!isCurrent && !isClaimed
            ? [
                {
                  iconPath: new vscode.ThemeIcon('trash'),
                  tooltip: `Delete "${prof.name}"`
                }
              ]
            : [])
        ];

        const detailLine =
          prof.authStatus === 'unverified'
            ? `${isCurrent ? 'Active' : 'Switch IDE to verify'}  ·  Verification needed`
            : this.formatProfileDetailLine(cq, planName, isCurrent);
        const cliTag = isClaimed ? '  ·  $(terminal) CLI CLAIMED' : '';
        const nextTag = isBestNext
          ? `  ·  $(zap) NEXT UP (${bestAgyStandby!.scorePct}%)`
          : '';
        const reauthTag =
          prof.authStatus === 'revoked' || prof.authStatus === 'expired'
            ? '  ·  $(warning) RE-AUTH'
            : prof.authStatus === 'unverified'
              ? '  ·  $(shield) VERIFY NEEDED'
              : '';

        items.push({
          label: `${isCurrent ? '$(check)' : '$(charlier-antigravity-star)'} ${prof.name}`,
          description: `${prof.email}  ·  ${planName}${reauthTag}${cliTag}${nextTag}`,
          detail: `    ${detailLine}`,
          action: isCurrent ? 'quota' : 'switch',
          profileId: prof.id,
          provider: 'antigravity',
          buttons
        });
      }
    }

    items.push({
      label: 'Deck & Actions',
      kind: vscode.QuickPickItemKind.Separator,
      action: 'noop'
    });

    items.push({
      label: '$(arrow-swap) Switch Deck to OpenAI Codex',
      description: `${this.codexVault.listProfiles().length} saved`,
      detail: '    View and switch Codex accounts without restarting extensions',
      action: 'switchProvider',
      provider: 'codex'
    });

    items.push({
      label: '$(layout-sidebar-left) Open Charlier Cockpit Sidebar',
      description: 'Visual gauges & multi-provider deck',
      action: 'openCockpit'
    });

    items.push({
      label: '$(person-add) Add Another Antigravity Account',
      description: activeProfile
        ? `Auto-updates "${activeProfile.name}" & opens Google sign-in`
        : authenticated
          ? 'Auto-saves active session & opens Google sign-in'
          : 'Open Google sign-in in Antigravity',
      action: 'addAccount',
      provider: 'antigravity'
    });

    if (
      live.authStatus === 'unverified' ||
      activeProfile?.authStatus === 'unverified'
    ) {
      items.push({
        label: '$(shield) Complete Google Account Verification',
        description: live.email || activeProfile?.email || 'VERIFY NEEDED',
        detail:
          '    Open Google verification (QR code / phone check) so Antigravity can unlock quota',
        action: 'verifyAccount',
        profileId: activeProfile?.id,
        provider: 'antigravity'
      });
    }

    if (authenticated) {
      items.push({
        label: activeProfile
          ? `$(cloud-upload) Update "${activeProfile.name}" Snapshot`
          : '$(add) Save Current Session as New Profile',
        description: live.email || 'Active session',
        action: 'save',
        provider: 'antigravity'
      });
    }

    if ((quota && quota.groups.length > 0) || profiles.length > 0) {
      items.push({
        label: '$(pulse) Inspect Active Pool Limits & Reset Clocks',
        description: quota ? `${quota.planTier} Plan` : 'Saved pools',
        action: 'quota',
        provider: 'antigravity'
      });
    }

    items.push({
      label: '$(sync) Refresh All Antigravity Quotas',
      description: 'Sync active daemon and background vault profiles',
      action: 'refresh',
      provider: 'antigravity'
    });

    items.push({
      label: '$(chevron-up) Hover Status Bar Pill for Live Quota Overlay',
      description: 'Adjust workbench.hover.delay in Settings if needed',
      action: 'openHoverSettings'
    });

    return items;
  }

  private async showAntigravityQuickPickMenu(): Promise<void> {
    const resolveSessionState = (
      currentProfiles: ProfileMetadata[],
      currentLive: LiveSessionInfo,
      currentQuota: QuotaSummary | null
    ) => {
      const normalizedLive: LiveSessionInfo = { ...currentLive };
      if (!normalizedLive.email && currentQuota?.email) {
        normalizedLive.email = currentQuota.email;
        normalizedLive.hasOAuthCreds = true;
      }
      const authenticated = Boolean(
        normalizedLive.email || normalizedLive.hasOAuthCreds
      );
      const state = this.vault.getState();
      const matched = normalizedLive.email
        ? currentProfiles.find(
            (p) => p.email.toLowerCase() === normalizedLive.email!.toLowerCase()
          ) || null
        : state.activeProfileId
          ? currentProfiles.find((p) => p.id === state.activeProfileId) || null
          : null;
      const activeProfile =
        matched && (authenticated || matched.authStatus === 'unverified')
          ? matched
          : null;
      return { live: normalizedLive, authenticated, activeProfile };
    };

    let profiles = this.vault.listProfiles();
    const cachedSummary =
      typeof (this.quotaService as any).getCachedSummary === 'function'
        ? this.quotaService.getCachedSummary()
        : null;
    const seedLive: LiveSessionInfo = this.lastFrame?.agy.live
      ? { ...this.lastFrame.agy.live }
      : {
          email: null,
          hasOAuthCreds: false,
          tokenExpiryDate: null,
          isExpired: false
        };
    let currentQuota: QuotaSummary | null =
      cachedSummary ?? this.lastFrame?.agy.quota ?? null;
    let session = resolveSessionState(profiles, seedLive, currentQuota);

    const fingerprintFor = (
      profs: ProfileMetadata[],
      sess: { live: LiveSessionInfo; authenticated: boolean; activeProfile: ProfileMetadata | null },
      q: QuotaSummary | null
    ) =>
      `${sess.activeProfile?.id || ''}|${sess.live.email || ''}|${sess.live.authStatus || ''}|${q?.email || ''}|${q?.groups?.length || 0}|${profs.map((p) => `${p.id}:${p.authStatus || ''}:${p.cachedQuota?.updatedAt || 0}`).join(',')}`;

    const quickPick = vscode.window.createQuickPick<ProfileQuickPickItem>();
    const applyItems = () => {
      quickPick.title = session.activeProfile
        ? `Charlier · Antigravity · ${session.activeProfile.name} (${session.activeProfile.email})`
        : session.live.email
          ? `Charlier · Antigravity · ${session.live.email} (Unsaved Session)`
          : 'Charlier · Google Antigravity Deck';
      quickPick.items = this.buildAntigravityQuickPickItems(
        profiles,
        session.activeProfile,
        session.live,
        session.authenticated,
        currentQuota
      );
    };

    quickPick.placeholder =
      'Select an Antigravity account to switch, click ">_" for CLI-only swap, or flip to Codex';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    let lastFingerprint = fingerprintFor(profiles, session, currentQuota);
    applyItems();

    let closed = false;

    quickPick.onDidTriggerItemButton(async (event) => {
      const item = event.item;
      if (!item.profileId) return;
      const prof =
        this.vault.listProfiles().find((p) => p.id === item.profileId) ||
        profiles.find((p) => p.id === item.profileId);
      if (!prof) return;

      const tooltip = event.button.tooltip || '';
      quickPick.hide();

      if (tooltip.startsWith('Switch CLI Only') || tooltip.startsWith('Focus claimed CLI')) {
        await this.handleSwitch(prof.id, 'antigravity', true);
      } else if (tooltip.startsWith('Inspect')) {
        await this.showQuotaDetails(prof.id, 'antigravity');
      } else if (tooltip.startsWith('Rename')) {
        await this.handleRename(prof, 'antigravity');
      } else if (tooltip.startsWith('Delete')) {
        await this.handleDelete(prof.id, 'antigravity');
      }
    });

    quickPick.onDidAccept(async () => {
      const picked = quickPick.selectedItems[0];
      quickPick.hide();
      if (!picked || picked.action === 'noop') return;

      switch (picked.action) {
        case 'switch':
          if (picked.profileId) {
            await this.handleSwitch(picked.profileId, 'antigravity');
          }
          break;
        case 'switchProvider':
          await this.switchProvider('codex');
          await this.showQuickPickMenu();
          break;
        case 'openCockpit':
          await vscode.commands.executeCommand('charlier.openCockpit');
          break;
        case 'save':
          await this.handleSaveCurrent('antigravity');
          break;
        case 'addAccount':
          await this.handleAddAccount('antigravity');
          break;
        case 'quota':
          await this.showQuotaDetails(picked.profileId, 'antigravity');
          break;
        case 'refresh':
          await this.refreshQuota('antigravity');
          break;
        case 'verifyAccount':
          await this.handleVerifyAccount(picked.profileId);
          break;
        case 'openHoverSettings':
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'workbench.hover.delay'
          );
          break;
      }
    });

    quickPick.onDidHide(() => {
      closed = true;
      quickPick.dispose();
    });
    quickPick.show();

    void Promise.all([
      this.vault.getLiveSessionInfoAsync(),
      this.quotaService.getQuotaSummary()
    ])
      .then(([freshLive, freshQuota]) => {
        if (closed || this.disposed) return;
        profiles = this.vault.listProfiles();
        currentQuota = freshQuota ?? currentQuota;
        session = resolveSessionState(profiles, freshLive, currentQuota);
        if (
          session.activeProfile &&
          currentQuota &&
          currentQuota.groups.length > 0 &&
          quotaMatchesIdentity(currentQuota.email, session.activeProfile.email)
        ) {
          const parsed = this.quotaService.parseMetrics(
            currentQuota,
            session.activeProfile.planOverride
          );
          this.vault.updateProfileCachedQuota(session.activeProfile.id, parsed);
          session.activeProfile.cachedQuota = parsed;
        }
        const nextFingerprint = fingerprintFor(profiles, session, currentQuota);
        if (nextFingerprint !== lastFingerprint) {
          lastFingerprint = nextFingerprint;
          applyItems();
        }
      })
      .catch(() => {});
  }

  private async showCodexQuickPickMenu(): Promise<void> {
    let profiles = this.codexVault.listProfiles();
    let live = this.codexVault.getLiveSessionInfo();
    let activeProfile = this.codexVault.findMatchingProfile(live);
    let cachedCodexMetric =
      this.codexQuotaService.getCachedMetric() ||
      this.lastFrame?.codex.metrics ||
      null;

    const buildCodexItems = (): {
      items: ProfileQuickPickItem[];
      fingerprint: string;
      title: string;
    } => {
      const authenticated = Boolean(
        live.email || live.accountId || live.hasOAuthCreds
      );
      const items: ProfileQuickPickItem[] = [];

      if (authenticated && !activeProfile && (live.email || live.accountId)) {
        items.push({
          label: '$(sparkle) Unsaved Codex Session',
          kind: vscode.QuickPickItemKind.Separator,
          action: 'noop'
        });

        const liveEmail =
          live.email || live.accountId || 'Authenticated Codex Session';
        items.push({
          label: `$(add) Save "${liveEmail}" to Vault`,
          description: `${live.planTier || 'PLUS'} Plan`,
          detail:
            ' Snapshot your current ~/.codex/auth.json login so you can switch back in 1 click',
          action: 'save',
          provider: 'codex'
        });
      }

      if (profiles.length > 0) {
        items.push({
          label: `OpenAI Codex Vault (${profiles.length})`,
          kind: vscode.QuickPickItemKind.Separator,
          action: 'noop'
        });

        const codexClaimedIds = this.getClaimedProfileIds('codex');
        const sortedProfiles = sortProfilesForDisplay(
          profiles,
          activeProfile?.id || null,
          codexClaimedIds
        );
        const activeCodexStatus = resolveEffectiveAuthStatus(
          activeProfile?.authStatus,
          live.authStatus
        );
        const activeCodexNeedsAction =
          activeCodexStatus === 'revoked' ||
          activeCodexStatus === 'expired' ||
          (!activeProfile && !authenticated);
        const activeCodexRaw = cachedCodexMetric || activeProfile?.cachedQuota;
        const activeCodexMetric = codexMetricForDisplay(
          activeCodexNeedsAction
            ? activeCodexRaw
            : healExpiredCodexMetric(activeCodexRaw),
          activeProfile?.authMode || live.authMode
        );
        const activeCodexKnown = [
          percentFromText(activeCodexMetric?.codex5h),
          percentFromText(activeCodexMetric?.codex7d)
        ].filter((n): n is number => n !== null);
        const bestCodexStandby = resolveBestStandbyProfile({
          provider: 'codex',
          profiles,
          activeProfileId: activeProfile?.id || null,
          activeMinPct: activeCodexKnown.length
            ? Math.min(...activeCodexKnown)
            : null,
          activeNeedsAction: activeCodexNeedsAction,
          claimedProfileIds: codexClaimedIds,
          normalizeCodexMetric: (cm, am) =>
            codexMetricForDisplay(healExpiredCodexMetric(cm), am)
        });

        for (const prof of sortedProfiles) {
          const isCurrent = Boolean(
            activeProfile && prof.id === activeProfile.id
          );
          const isClaimed = codexClaimedIds.has(prof.id);
          const isBestNext = Boolean(
            bestCodexStandby && bestCodexStandby.profile.id === prof.id
          );
          const profNeedsReauth =
            prof.authStatus === 'revoked' || prof.authStatus === 'expired';
          const rawMetric = isCurrent
            ? cachedCodexMetric &&
              (!prof.cachedQuota?.updatedAt ||
                (cachedCodexMetric.updatedAt || 0) >= prof.cachedQuota.updatedAt)
              ? cachedCodexMetric
              : prof.cachedQuota
            : prof.cachedQuota;
          const cq = codexMetricForDisplay(
            profNeedsReauth ? rawMetric : healExpiredCodexMetric(rawMetric),
            prof.authMode
          );
          const planName =
            prof.planOverride ||
            cq?.plan ||
            (prof.authMode === 'apikey'
              ? 'API_KEY'
              : isCurrent && live.planTier
                ? live.planTier
                : 'PLUS');

          const buttons: vscode.QuickInputButton[] = [
            ...(!isCurrent
              ? [
                  {
                    iconPath: new vscode.ThemeIcon('terminal'),
                    tooltip: isClaimed
                      ? `Focus claimed CLI terminal for "${prof.name}"`
                      : `Switch CLI Only for "${prof.name}" (Zero Extension Reload)`
                  }
                ]
              : []),
            {
              iconPath: new vscode.ThemeIcon('graph'),
              tooltip: `Inspect 5h & Weekly Pools for "${prof.name}"`
            },
            {
              iconPath: new vscode.ThemeIcon('edit'),
              tooltip: `Rename "${prof.name}"`
            },
            ...(!isCurrent && !isClaimed
              ? [
                  {
                    iconPath: new vscode.ThemeIcon('trash'),
                    tooltip: `Delete "${prof.name}"`
                  }
                ]
              : [])
          ];

          const detailLine = this.formatCodexProfileDetailLine(
            cq,
            planName,
            isCurrent
          );
          const cliTag = isClaimed ? '  ·  $(terminal) CLI CLAIMED' : '';
          const nextTag = isBestNext
            ? `  ·  $(zap) NEXT UP (${bestCodexStandby!.scorePct}%)`
            : '';
          const reauthTag =
            prof.authStatus === 'revoked' || prof.authStatus === 'expired'
              ? '  ·  $(warning) RE-AUTH'
              : '';

          items.push({
            label: `${isCurrent ? '$(check)' : '$(charlier-codex-prompt)'} ${prof.name}`,
            description: `${prof.email}  ·  ${planName}${reauthTag}${cliTag}${nextTag}`,
            detail: `    ${detailLine}`,
            action: isCurrent ? 'quota' : 'switch',
            profileId: prof.id,
            provider: 'codex',
            buttons
          });
        }
      }

      items.push({
        label: 'Deck & Actions',
        kind: vscode.QuickPickItemKind.Separator,
        action: 'noop'
      });

      items.push({
        label: '$(arrow-swap) Switch Deck to Google Antigravity',
        description: `${this.vault.listProfiles().length} saved`,
        detail:
          '    View and switch Antigravity accounts without restarting extensions',
        action: 'switchProvider',
        provider: 'antigravity'
      });

      items.push({
        label: '$(layout-sidebar-left) Open Charlier Cockpit Sidebar',
        description: 'Visual gauges & multi-provider deck',
        action: 'openCockpit'
      });

      items.push({
        label: '$(person-add) Add Another Codex Account',
        description: activeProfile
          ? `Backs up "${activeProfile.name}" & prepares new Codex login`
          : 'Backs up ~/.codex/auth.json & prepares new Codex login',
        action: 'addAccount',
        provider: 'codex'
      });

      if (authenticated) {
        items.push({
          label: activeProfile
            ? `$(cloud-upload) Update "${activeProfile.name}" Snapshot`
            : '$(add) Save Current ~/.codex/auth.json as New Profile',
          description: live.email || 'Active Codex session',
          action: 'save',
          provider: 'codex'
        });
      }

      items.push({
        label: '$(sync) Refresh All Codex Quotas',
        description:
          'Query live 5h & 7d wham/usage across all saved Codex profiles',
        action: 'refresh',
        provider: 'codex'
      });

      items.push({
        label: '$(chevron-up) Hover Status Bar Pill for Live Quota Overlay',
        description: 'Adjust workbench.hover.delay in Settings if needed',
        action: 'openHoverSettings'
      });

      const title = activeProfile
        ? `Charlier · OpenAI Codex · ${activeProfile.name} (${activeProfile.email})`
        : live.email
          ? `Charlier · OpenAI Codex · ${live.email} (Unsaved Session)`
          : 'Charlier · OpenAI Codex Deck';
      const fingerprint = JSON.stringify(
        items.map((it) => [it.label, it.description, it.detail, it.action, it.profileId])
      );
      return { items, fingerprint, title };
    };

    const quickPick = vscode.window.createQuickPick<ProfileQuickPickItem>();
    let closed = false;
    const initial = buildCodexItems();
    let lastFingerprint = initial.fingerprint;
    quickPick.title = initial.title;
    quickPick.placeholder =
      'Select a Codex account to switch, click ">_" for CLI-only swap, or flip to Antigravity';
    quickPick.items = initial.items;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    quickPick.onDidTriggerItemButton(async (event) => {
      const item = event.item;
      if (!item.profileId) return;
      const prof = profiles.find((p) => p.id === item.profileId);
      if (!prof) return;

      const tooltip = event.button.tooltip || '';
      quickPick.hide();

      if (tooltip.startsWith('Switch CLI Only') || tooltip.startsWith('Focus claimed CLI')) {
        await this.handleSwitch(prof.id, 'codex', true);
      } else if (tooltip.startsWith('Inspect')) {
        await this.showQuotaDetails(prof.id, 'codex');
      } else if (tooltip.startsWith('Rename')) {
        await this.handleRename(prof, 'codex');
      } else if (tooltip.startsWith('Delete')) {
        await this.handleDelete(prof.id, 'codex');
      }
    });

    quickPick.onDidAccept(async () => {
      const picked = quickPick.selectedItems[0];
      quickPick.hide();
      if (!picked || picked.action === 'noop') return;

      switch (picked.action) {
        case 'switch':
          if (picked.profileId) {
            await this.handleSwitch(picked.profileId, 'codex', false);
          }
          break;
        case 'switchProvider':
          await this.switchProvider('antigravity');
          await this.showQuickPickMenu();
          break;
        case 'openCockpit':
          await vscode.commands.executeCommand('charlier.openCockpit');
          break;
        case 'save':
          await this.handleSaveCurrent('codex');
          break;
        case 'addAccount':
          await this.handleAddAccount('codex');
          break;
        case 'quota':
          await this.showQuotaDetails(picked.profileId, 'codex');
          break;
        case 'refresh':
          await this.refreshQuota('codex');
          break;
        case 'verifyAccount':
          await this.handleVerifyAccount(picked.profileId);
          break;
        case 'openHoverSettings':
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'workbench.hover.delay'
          );
          break;
      }
    });

    quickPick.onDidHide(() => {
      closed = true;
      quickPick.dispose();
    });
    quickPick.show();

    const activeAgeMs = cachedCodexMetric?.updatedAt
      ? Date.now() - cachedCodexMetric.updatedAt
      : Infinity;
    if (
      (live.email || live.accountId || live.hasOAuthCreds) &&
      live.authMode !== 'apikey' &&
      activeAgeMs > 45_000
    ) {
      void this.codexQuotaService
        .getActiveQuotaSummary(this.codexVault, false)
        .then((res) => {
          if (closed || this.disposed) return;
          profiles = this.codexVault.listProfiles();
          live = this.codexVault.getLiveSessionInfo();
          activeProfile = this.codexVault.findMatchingProfile(live);
          cachedCodexMetric = res?.metric || cachedCodexMetric;
          const next = buildCodexItems();
          if (next.fingerprint !== lastFingerprint) {
            lastFingerprint = next.fingerprint;
            quickPick.title = next.title;
            quickPick.items = next.items;
          }
        })
        .catch(() => {});
    }
  }

  public async handleRename(
    profileOrId: ProfileMetadata | string,
    providerOverride?: ActiveProviderId
  ): Promise<void> {
    const provider: ActiveProviderId =
      providerOverride ||
      (typeof profileOrId !== 'string' &&
      (profileOrId.provider === 'antigravity' || profileOrId.provider === 'codex')
        ? profileOrId.provider
        : undefined) ||
      this.selectedProvider;

    const profile =
      typeof profileOrId === 'string'
        ? (provider === 'codex'
            ? this.codexVault.listProfiles()
            : this.vault.listProfiles()
          ).find((p) => p.id === profileOrId)
        : profileOrId;

    if (!profile) return;

    const newName = await vscode.window.showInputBox({
      title: `Rename ${provider === 'codex' ? 'Codex' : 'Antigravity'} Profile (${profile.email})`,
      prompt: 'Enter a clean display label for this account',
      value: profile.name,
      validateInput: (val) =>
        !val || !val.trim() ? 'Profile name cannot be empty.' : null
    });

    if (!newName) return;

    if (provider === 'codex') {
      const updated = this.codexVault.renameProfile(profile.id, newName.trim());
      if (updated) {
        await this.update(true);
        vscode.window.setStatusBarMessage(
          `$(check) Updated Codex profile "${updated.name}"`,
          3500
        );
      }
      return;
    }

    const currentPlan =
      profile.planOverride || profile.cachedQuota?.plan || 'FREE';
    const planPick = await vscode.window.showQuickPick(
      [
        {
          label: 'Auto-Detect from Daemon',
          description: `Currently ${profile.cachedQuota?.plan || 'FREE'}`,
          tier: null as UserPlanTier | null
        },
        {
          label: 'FREE',
          description:
            'Google AI Free tier (Gemini starter quota; hides Claude & GPT)',
          tier: 'FREE' as UserPlanTier
        },
        {
          label: 'PRO',
          description:
            'Google AI Pro tier (unified Gemini 4 + Claude & GPT 5h and weekly pools)',
          tier: 'PRO' as UserPlanTier
        },
        {
          label: 'ULTRA',
          description:
            'Google AI Ultra tier (highest-capacity Gemini 4 + Claude & GPT pools)',
          tier: 'ULTRA' as UserPlanTier
        }
      ],
      {
        title: `Plan Tier for "${newName.trim()}"`,
        placeHolder: `Current tier: ${currentPlan} (choose Auto-Detect or lock a specific tier)`
      }
    );

    const nextOverride =
      planPick === undefined ? profile.planOverride : planPick.tier;

    const updated = this.vault.renameProfile(
      profile.id,
      newName.trim(),
      nextOverride
    );
    if (updated) {
      await this.update(true);
      vscode.window.setStatusBarMessage(
        `$(check) Updated profile "${updated.name}"`,
        3500
      );
    }
  }

  private resolveProfileProvider(
    profileId: string,
    providerOverride?: ActiveProviderId
  ): ActiveProviderId {
    let provider: ActiveProviderId = providerOverride || this.selectedProvider;
    if (!providerOverride) {
      const inCurrent =
        provider === 'codex'
          ? this.codexVault.listProfiles().some((p) => p.id === profileId)
          : this.vault.listProfiles().some((p) => p.id === profileId);
      if (!inCurrent) {
        const other: ActiveProviderId =
          provider === 'codex' ? 'antigravity' : 'codex';
        const inOther =
          other === 'codex'
            ? this.codexVault.listProfiles().some((p) => p.id === profileId)
            : this.vault.listProfiles().some((p) => p.id === profileId);
        if (inOther) {
          provider = other;
        }
      }
    }
    return provider;
  }

  public async handleSwitch(
    profileId: string,
    providerOverride?: ActiveProviderId,
    cliOnly: boolean = false
  ): Promise<void> {
    // Resolve the actual target provider BEFORE taking the per-provider switch lock so
    // an Antigravity switch from the other deck cannot collide with a Codex switch.
    const provider = this.resolveProfileProvider(profileId, providerOverride);
    if (this.switchesInFlight.has(provider)) {
      vscode.window.setStatusBarMessage('$(sync~spin) Still finishing the previous switch...', 1800);
      return;
    }
    this.switchesInFlight.add(provider);
    try {
      await this.performSwitch(profileId, provider, cliOnly);
    } finally {
      this.switchesInFlight.delete(provider);
    }
  }

  private async autoSaveActiveBeforeSwitch(
    provider: ActiveProviderId
  ): Promise<ProfileMetadata | null> {
    if (provider === 'codex') {
      const cachedMetric = this.codexQuotaService.getCachedMetric();
      const saved = this.codexVault.autoSaveUnsavedActiveSession(cachedMetric);
      if (saved) {
        this.clearCodexUnsavedDismissal(saved.accountId, saved.email);
        vscode.window.showInformationMessage(
          `Auto-saved "${saved.name}" (${saved.email}) to your Codex vault before switching.`
        );
      }
      return saved;
    }

    const cachedSummary = this.quotaService.getCachedSummary();
    const live = await this.vault.getLiveSessionInfoAsync();
    const resolvedEmail = (
      live.email ||
      cachedSummary?.email ||
      this.lastFrame?.agy.live.email ||
      ''
    ).trim();
    const liveMetric =
      cachedSummary &&
      cachedSummary.groups.length > 0 &&
      quotaMatchesIdentity(cachedSummary.email, resolvedEmail || null)
        ? this.quotaService.parseMetrics(cachedSummary)
        : null;
    const activeHealth = (this.quotaService as any).getActiveAuthHealth?.(resolvedEmail || null);
    const saved = await this.vault.autoSaveUnsavedActiveSessionAsync(liveMetric, {
      email: resolvedEmail || undefined,
      authStatus:
        live.authStatus ||
        cachedSummary?.authStatus ||
        activeHealth?.authStatus ||
        this.lastFrame?.agy.live.authStatus,
      authErrorCode:
        live.authErrorCode ||
        cachedSummary?.authErrorCode ||
        activeHealth?.authErrorCode ||
        this.lastFrame?.agy.live.authErrorCode,
      authErrorMessage:
        live.authErrorMessage ||
        cachedSummary?.authErrorMessage ||
        activeHealth?.authErrorMessage ||
        this.lastFrame?.agy.live.authErrorMessage,
      validationUrl:
        live.validationUrl ||
        cachedSummary?.validationUrl ||
        activeHealth?.validationUrl ||
        this.lastFrame?.agy.live.validationUrl
    });
    if (saved) {
      if (saved.email && saved.email !== 'Unknown') {
        const lower = saved.email.toLowerCase();
        if (this.promptedEmails.delete(lower)) {
          this.persistPromptedUnsavedState();
        }
        this.sessionDismissedPromptKeys.delete(`antigravity:${lower}`);
      }
      vscode.window.showInformationMessage(
        `Auto-saved "${saved.name}" (${saved.email}) to your Antigravity vault before switching.`
      );
    }
    return saved;
  }

  private getCliResolutionInputs(): {
    configuredExecutable?: string;
    extensionPaths?: string[];
  } {
    let configuredExecutable: string | undefined;
    try {
      const chatgptCfg = vscode.workspace?.getConfiguration?.('chatgpt');
      const raw = chatgptCfg?.get?.<string>('cliExecutable');
      if (typeof raw === 'string' && raw.trim()) {
        configuredExecutable = raw.trim();
      }
    } catch {}
    const extensionPaths: string[] = [];
    try {
      const extPath = vscode.extensions?.getExtension?.('openai.chatgpt')?.extensionPath;
      if (typeof extPath === 'string' && extPath.trim()) {
        extensionPaths.push(extPath.trim());
      }
    } catch {}
    return { configuredExecutable, extensionPaths };
  }

  private resolveCliBinaryForProvider(
    provider: ActiveProviderId
  ): CliBinaryResolution | null {
    const inputs = this.getCliResolutionInputs();
    return resolveCliBinary(provider === 'codex' ? 'codex' : 'agy', inputs);
  }

  private promptMissingCliBinary(provider: ActiveProviderId): void {
    const isCodex = provider === 'codex';
    const message = isCodex
      ? 'Codex CLI ("codex") was not found in PATH, the OpenAI Codex extension bundle, or standard install locations. Install the Codex CLI (or set "chatgpt.cliExecutable") to use isolated Codex CLI sessions.'
      : 'Antigravity CLI ("agy") was not found in PATH or ~/.gemini/bin. Install the "agy" shell command from Antigravity to use isolated Antigravity CLI sessions.';
    const actionLabel = isCodex ? 'Install Codex CLI' : 'Install agy CLI';

    vscode.window.setStatusBarMessage(
      `$(warning) ${isCodex ? 'codex' : 'agy'} CLI not found`,
      5000
    );

    if (typeof vscode.window.showErrorMessage === 'function') {
      void Promise.resolve(
        vscode.window.showErrorMessage(message, { modal: true }, actionLabel)
      )
        .then((choice) => {
          if (choice !== actionLabel) return;
          if (!isCodex) {
            void Promise.resolve(
              vscode.commands.executeCommand?.('antigravity.installInPATH')
            ).then(undefined, () => {
              if (typeof vscode.env?.openExternal === 'function' && vscode.Uri?.parse) {
                void vscode.env.openExternal(vscode.Uri.parse('https://antigravity.google/'));
              }
            });
          } else if (typeof vscode.env?.openExternal === 'function' && vscode.Uri?.parse) {
            void vscode.env.openExternal(
              vscode.Uri.parse('https://developers.openai.com/codex/cli')
            );
          }
        })
        .catch(() => {});
    }
  }

  private launchClaimedCliTerminal(
    provider: ActiveProviderId,
    meta: ProfileMetadata
  ): boolean {
    const inputs = this.getCliResolutionInputs();
    const binaryName = provider === 'codex' ? 'codex' : 'agy';
    const resolved = resolveCliBinary(binaryName, inputs);
    if (!resolved) {
      this.promptMissingCliBinary(provider);
      return false;
    }

    const providerTitle = provider === 'codex' ? 'Codex' : 'Antigravity';
    const isolated =
      provider === 'codex'
        ? prepareCodexCliHome(meta.id, inputs)
        : prepareAntigravityCliHome(meta.id, inputs);

    if (typeof vscode.window.createTerminal === 'function') {
      const term = vscode.window.createTerminal({
        name: `Charlier · ${providerTitle} (${meta.name})`,
        isTransient: true,
        env: isolated.env
      });
      this.onCliTerminalLaunched?.(term, provider);
      term.show?.(false);
      term.sendText?.(
        provider === 'codex' ? 'codex --no-daemon' : 'agy',
        true
      );
      this.claimedTerminals.set(this.claimedTerminalKey(provider, meta.id), {
        terminal: term,
        provider,
        profileId: meta.id,
        profileName: meta.name
      });
      this.launchedCliTerminals.set(term, {
        provider,
        profileId: meta.id,
        profileName: meta.name
      });
      return true;
    }
    return false;
  }

  private async startTargetScopedReauth(
    provider: ActiveProviderId,
    targetMeta: ProfileMetadata
  ): Promise<void> {
    if (this.isAddingAccount) return;
    this.isAddingAccount = true;
    try {
      await this.autoSaveActiveBeforeSwitch(provider);
      this.pendingReauthTarget = {
        provider,
        profileId: targetMeta.id,
        email: targetMeta.email,
        accountId: targetMeta.accountId,
        startedAt: Date.now()
      };
      this.notifiedReauthRecoveryKeys.delete(`${provider}:${targetMeta.id}`);
      this.suppressUnsavedPromptUntil = Date.now() + 2500;

      if (provider === 'codex') {
        this.muteExternalWatcher?.(4000);
        this.cliCodexProfileId = null;
        this.vault.setActiveCodexProfileId(null);
        this.codexQuotaService.markLoggingOut();
        await this.codexVault.prepareNewLoginAsync({
          deferFileUnlink: false,
          liveMetric: this.codexQuotaService.getCachedMetric()
        });
        await this.codexQuotaService.hotSwapCodexAppServer(null);
        this.codexVault.unlinkActiveAuthFileIfPresent?.();
        this.codexQuotaService.invalidateCache();
        this.suppressUnsavedPromptUntil = 0;
        this.onCredentialsMutated?.();
        this.shortenExternalWatcherMute?.(250);
        await this.update(true);
        this.startAwaitingLoginWatch('codex', targetMeta.email);
        await vscode.commands
          .executeCommand('chatgpt.openSidebar')
          .then(undefined, () => {});

        vscode.window.setStatusBarMessage(
          `$(key) Ready to re-authenticate "${targetMeta.name}"...`,
          5000
        );
        const action = await vscode.window.showInformationMessage(
          `Backed up your previous session. Sign back into Codex profile "${targetMeta.name}" (${targetMeta.email}) in the Codex sidebar or via "codex login".`,
          'Open Terminal (codex login)',
          'Got It'
        );
        if (
          action === 'Open Terminal (codex login)' &&
          typeof vscode.window.createTerminal === 'function'
        ) {
          const resolvedCodex = this.resolveCliBinaryForProvider('codex');
          if (!resolvedCodex) {
            this.promptMissingCliBinary('codex');
            return;
          }
          const term = vscode.window.createTerminal({
            name: `Charlier · Re-Auth (${targetMeta.name})`,
            env: resolvedCodex.pathOverride
          });
          this.onCliTerminalLaunched?.(term, 'codex');
          term.show?.();
          term.sendText?.('codex login');
        }
        return;
      }

      this.muteExternalWatcher?.(4000);
      this.cliAntigravityProfileId = null;
      const cachedSummary = this.quotaService.getCachedSummary();
      const agyLive = await this.vault.getLiveSessionInfoAsync();
      const prevEmail =
        (agyLive.email && agyLive.email !== 'Unknown' ? agyLive.email : undefined) ||
        (cachedSummary?.email && cachedSummary.email !== 'Unknown'
          ? cachedSummary.email
          : undefined) ||
        (this.lastFrame?.agy.live.email &&
        this.lastFrame.agy.live.email !== 'Unknown'
          ? this.lastFrame.agy.live.email
          : undefined);
      const liveMetric =
        cachedSummary &&
        cachedSummary.groups.length > 0 &&
        quotaMatchesIdentity(cachedSummary.email, prevEmail || agyLive.email)
          ? this.quotaService.parseMetrics(cachedSummary)
          : null;
      const sessionHint: Partial<LiveSessionInfo> = {
        email: prevEmail,
        authStatus:
          agyLive.authStatus ||
          cachedSummary?.authStatus ||
          this.lastFrame?.agy.live.authStatus,
        authErrorCode:
          agyLive.authErrorCode ||
          cachedSummary?.authErrorCode ||
          this.lastFrame?.agy.live.authErrorCode,
        authErrorMessage:
          agyLive.authErrorMessage ||
          cachedSummary?.authErrorMessage ||
          this.lastFrame?.agy.live.authErrorMessage,
        validationUrl:
          agyLive.validationUrl ||
          cachedSummary?.validationUrl ||
          this.lastFrame?.agy.live.validationUrl
      };
      (this.quotaService as any).markLoggingOut?.(prevEmail, 4000);
      await this.vault.prepareNewLoginAsync({ liveMetric, sessionHint });
      this.vault.saveState({ activeProfileId: null, lastUpdated: Date.now() });
      this.quotaService.invalidate();
      this.suppressUnsavedPromptUntil = 0;
      this.onCredentialsMutated?.();
      this.shortenExternalWatcherMute?.(250);
      await this.update(true);
      this.startAwaitingLoginWatch('antigravity', prevEmail);

      await Promise.race([
        Promise.allSettled([
          vscode.commands
            .executeCommand('antigravity.internal.logout')
            .then(undefined, () =>
              vscode.commands.executeCommand('antigravity.signOut')
            ),
          vscode.commands
            .executeCommand('antigravity.prioritized.chat.open')
            .then(undefined, () =>
              vscode.commands.executeCommand('antigravity.panel.focus')
            )
        ]),
        new Promise((resolve) => setTimeout(resolve, 400))
      ]).catch(() => {});

      this.quotaService.invalidate();

      vscode.window.setStatusBarMessage(
        `$(key) Ready to re-authenticate "${targetMeta.name}"...`,
        5000
      );
      vscode.window.showInformationMessage(
        `Backed up your previous session. Sign back into Antigravity profile "${targetMeta.name}" (${targetMeta.email}) in the Antigravity sidebar.`
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Failed to start re-authentication: ${err.message}`
      );
    } finally {
      this.isAddingAccount = false;
    }
  }

  private async performSwitch(
    profileId: string,
    provider: ActiveProviderId,
    cliOnly: boolean = false
  ): Promise<void> {
    // Prune closed terminals before checking live CLI claims
    const liveClaimedIds = this.getClaimedProfileIds(provider);
    if (cliOnly && liveClaimedIds.has(profileId)) {
      const existingClaim = this.claimedTerminals.get(
        this.claimedTerminalKey(provider, profileId)
      );
      if (existingClaim) {
        existingClaim.terminal.show?.(false);
        const providerTitle = provider === 'codex' ? 'Codex' : 'Antigravity';
        vscode.window.setStatusBarMessage(
          `$(terminal) Focused active ${providerTitle} CLI terminal for "${existingClaim.profileName}"`,
          4000
        );
        return;
      }
    }

    const targetProfiles =
      provider === 'codex'
        ? this.codexVault.listProfiles()
        : this.vault.listProfiles();
    const targetMeta = targetProfiles.find((p) => p.id === profileId);

    if (
      cliOnly &&
      targetMeta &&
      targetMeta.authStatus === 'unverified'
    ) {
      if (typeof vscode.window.showWarningMessage === 'function') {
        const verifyChoice = await vscode.window.showWarningMessage(
          `Charlier: "${targetMeta.name}" (${targetMeta.email}) requires Google verification before Antigravity can use it. CLI Only is locked until verified. Switch the IDE to this account to complete verification first?`,
          { modal: true },
          'Switch IDE to Verify'
        );
        if (verifyChoice === 'Switch IDE to Verify') {
          await this.performSwitch(profileId, provider, false);
        }
      }
      return;
    }

    if (
      !cliOnly &&
      liveClaimedIds.has(profileId) &&
      typeof vscode.window.showWarningMessage === 'function'
    ) {
      const claim = this.claimedTerminals.get(
        this.claimedTerminalKey(provider, profileId)
      );
      if (claim) {
        const providerTitle = provider === 'codex' ? 'Codex' : 'Antigravity';
        const cliChoice = await vscode.window.showWarningMessage(
          `Charlier: "${claim.profileName}" is currently claimed by an open ${providerTitle} CLI terminal. Focus that terminal or also switch the IDE onto "${claim.profileName}"?`,
          { modal: true },
          'Focus Claimed Terminal',
          'Switch IDE Anyway'
        );
        if (cliChoice === 'Focus Claimed Terminal') {
          claim.terminal.show?.(false);
          return;
        }
        if (cliChoice !== 'Switch IDE Anyway') {
          return;
        }
      }
    }

    if (
      !cliOnly &&
      targetMeta &&
      (targetMeta.authStatus === 'revoked' ||
        targetMeta.authStatus === 'expired') &&
      typeof vscode.window.showWarningMessage === 'function'
    ) {
      const choice = await vscode.window.showWarningMessage(
        `Charlier: "${targetMeta.name}" (${targetMeta.email}) appears signed out or revoked (${targetMeta.authErrorCode || targetMeta.authStatus}). Switching now will show a login screen until you re-authenticate.`,
        { modal: true },
        'Switch & Start Re-Login',
        'Switch Only (Manual Login)'
      );
      if (choice === 'Switch & Start Re-Login') {
        await this.startTargetScopedReauth(provider, targetMeta);
        return;
      }
      if (choice !== 'Switch Only (Manual Login)') {
        return;
      }
      this.pendingReauthTarget = {
        provider,
        profileId: targetMeta.id,
        email: targetMeta.email,
        accountId: targetMeta.accountId,
        startedAt: Date.now()
      };
      this.notifiedReauthRecoveryKeys.delete(`${provider}:${targetMeta.id}`);
    }

    if (
      cliOnly &&
      targetMeta &&
      (targetMeta.authStatus === 'revoked' ||
        targetMeta.authStatus === 'expired') &&
      typeof vscode.window.showWarningMessage === 'function'
    ) {
      const cliReauthChoice = await vscode.window.showWarningMessage(
        `Charlier: "${targetMeta.name}" (${targetMeta.email}) appears signed out or revoked (${targetMeta.authErrorCode || targetMeta.authStatus}). Launching an isolated CLI terminal may show a login prompt.`,
        { modal: true },
        'Launch CLI Anyway'
      );
      if (cliReauthChoice !== 'Launch CLI Anyway') {
        return;
      }
    }

    if (cliOnly) {
      if (provider === 'codex') {
        try {
          const codexProfiles = this.codexVault.listProfiles();
          const meta = codexProfiles.find((p) => p.id === profileId);
          if (!meta) {
            throw new Error(`Codex profile "${profileId}" does not exist.`);
          }
          const activeIdeId = this.vault.getState().activeCodexProfileId;
          const ideName =
            activeIdeId && activeIdeId !== meta.id
              ? codexProfiles.find((p) => p.id === activeIdeId)?.name || null
              : null;

          const launched = this.launchClaimedCliTerminal('codex', meta);
          if (!launched) {
            return;
          }
          vscode.window.setStatusBarMessage(
            `$(terminal) Launched isolated Codex CLI terminal for "${meta.name}"`,
            5000
          );
          vscode.window.showInformationMessage(
            `Launched isolated Codex CLI terminal for "${meta.name}" (${meta.email}).${
              ideName ? ` Your IDE stays on "${ideName}".` : ''
            }`
          );
          await this.update(true);

          if (!meta.cachedQuota?.updatedAt || Date.now() - meta.cachedQuota.updatedAt > 45000) {
            this.codexQuotaService
              .refreshProfileQuota(meta.id, this.codexVault, false)
              .then(() => this.scheduleUpdate(60, true))
              .catch(() => {});
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Switch failed: ${err.message}`);
        }
        return;
      }

      try {
        const profiles = this.vault.listProfiles();
        const meta = profiles.find((p) => p.id === profileId);
        if (!meta) {
          throw new Error(`Profile "${profileId}" does not exist.`);
        }
        const activeIdeId = this.vault.getState().activeProfileId;
        const ideName =
          activeIdeId && activeIdeId !== meta.id
            ? profiles.find((p) => p.id === activeIdeId)?.name || null
            : null;

        const launched = this.launchClaimedCliTerminal('antigravity', meta);
        if (!launched) {
          return;
        }
        vscode.window.setStatusBarMessage(
          `$(terminal) Launched isolated Antigravity CLI terminal for "${meta.name}"`,
          5000
        );
        vscode.window.showInformationMessage(
          `Launched isolated Antigravity CLI terminal for "${meta.name}" (${meta.email}).${
            ideName ? ` Your IDE stays on "${ideName}".` : ''
          }`
        );
        await this.update(true);

        if (!meta.cachedQuota?.updatedAt || Date.now() - meta.cachedQuota.updatedAt > 45000) {
          this.quotaService
            .refreshInactiveProfile(meta, this.vault, false)
            .then(() => this.scheduleUpdate(60, true))
            .catch(() => {});
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Switch failed: ${err.message}`);
      }
      return;
    }

    this.suppressUnsavedPromptUntil = Date.now() + 3000;

    if (provider === 'codex') {
      try {
        this.muteExternalWatcher?.(4000);
        await this.autoSaveActiveBeforeSwitch('codex');
        const prevLiveInfo = this.codexVault.getLiveSessionInfo();
        const prevMatched = this.codexVault.findMatchingProfile(prevLiveInfo);
        const cachedActiveMetric = this.codexQuotaService.getCachedMetric();
        if (prevMatched && prevMatched.id !== profileId && cachedActiveMetric) {
          this.codexVault.updateProfileCachedQuota(prevMatched.id, cachedActiveMetric);
        }

        const meta = await this.codexVault.switchProfile(profileId, cachedActiveMetric);
        this.codexQuotaService.primeActiveAccountKey(this.codexVault);
        this.cliCodexProfileId = null;
        this.vault.setActiveCodexProfileId(meta.id);
        this.codexQuotaService.invalidateCache();
        this.onCredentialsMutated?.();

        const triggerPostSwitchCodexRefresh = () => {
          const refreshTasks: Array<Promise<any>> = [
            this.codexQuotaService.refreshProfileQuota(meta.id, this.codexVault, true)
          ];
          if (prevMatched && prevMatched.id !== profileId) {
            refreshTasks.push(
              this.codexQuotaService.refreshProfileQuota(prevMatched.id, this.codexVault, false)
            );
          }
          Promise.allSettled(refreshTasks)
            .then(() => {
              this.onCredentialsMutated?.();
              this.scheduleUpdate(60, true);
            })
            .catch(() => {});
        };

        const config = vscode.workspace.getConfiguration('charlier');
        const useCodexSurgical = config.get<boolean>(
          'codexSurgicalReload',
          true
        );

        if (useCodexSurgical) {
          // Kick off surgical stdio hot-swap concurrently with Cockpit/Status Bar repaint
          // so the Codex sidebar starts transitioning in the exact same tick as Charlier.
          const swapPromise = this.codexQuotaService.hotSwapCodexAppServer(
            meta.authMode || 'chatgpt'
          );
          const [, swapStatus] = await Promise.all([this.update(true), swapPromise]);
          triggerPostSwitchCodexRefresh();
          if (swapStatus === 'swapped' || swapStatus === 'not-running') {
            vscode.window.setStatusBarMessage(
              `$(check) Switched Codex to "${meta.name}" (${meta.email}) · ${
                swapStatus === 'swapped'
                  ? 'Sidebar & CLI hot-swapped live'
                  : 'CLI & next sidebar launch ready'
              }`,
              4500
            );
            return;
          }
        } else {
          await this.update(true);
          triggerPostSwitchCodexRefresh();
        }

        vscode.window.setStatusBarMessage(
          `$(check) Switched Codex to "${meta.name}" (${meta.email})`,
          4000
        );

        await confirmAndReloadForProviderSwitch('codex', meta.name, {
          isFallbackFromSurgical: useCodexSurgical
        });
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to switch Codex profile: ${err.message}`
        );
      }
      return;
    }

    // Antigravity switch flow
    try {
      this.muteExternalWatcher?.(8000);
      const autoSaved = await this.autoSaveActiveBeforeSwitch('antigravity');
      const profiles = this.vault.listProfiles();
      const prevIdeAntigravityId =
        autoSaved?.id || this.vault.getState().activeProfileId;
      const cachedSummary = this.quotaService.getCachedSummary();
      const outgoing =
        (prevIdeAntigravityId &&
          profiles.find((p) => p.id === prevIdeAntigravityId)) ||
        (cachedSummary?.email
          ? profiles.find(
              (p) => p.email.toLowerCase() === cachedSummary.email!.toLowerCase()
            )
          : undefined);

      if (
        outgoing &&
        cachedSummary &&
        cachedSummary.groups.length > 0 &&
        quotaMatchesIdentity(cachedSummary.email, outgoing.email)
      ) {
        const parsed = this.quotaService.parseMetrics(
          cachedSummary,
          outgoing.planOverride
        );
        this.vault.updateProfileCachedQuota(outgoing.id, parsed);
      }

      if (
        targetMeta &&
        targetMeta.authStatus === 'unverified' &&
        !this.vault.getProfileRefreshToken(profileId)
      ) {
        const daemonSnap =
          (await (this.quotaService as any).peekDaemonIdentityAsync?.()) || null;
        const activeEmail =
          daemonSnap?.email ||
          cachedSummary?.email ||
          this.lastFrame?.agy.live.email;
        if (
          activeEmail &&
          activeEmail.toLowerCase() === targetMeta.email.toLowerCase()
        ) {
          this.cliAntigravityProfileId = null;
          this.vault.saveState({
            activeProfileId: targetMeta.id,
            lastUpdated: Date.now()
          });
          await this.update(true);
          await this.handleVerifyAccount(targetMeta.id);
          return;
        }

        const prevLive = await this.vault.getLiveSessionInfoAsync();
        const prevMetric =
          cachedSummary &&
          cachedSummary.groups.length > 0 &&
          quotaMatchesIdentity(cachedSummary.email, activeEmail || prevLive.email)
            ? this.quotaService.parseMetrics(cachedSummary)
            : null;
        (this.quotaService as any).markLoggingOut?.(activeEmail, 10000);
        await this.vault.prepareNewLoginAsync({
          liveMetric: prevMetric,
          sessionHint: {
            email: activeEmail || prevLive.email,
            authStatus: prevLive.authStatus || cachedSummary?.authStatus,
            validationUrl: prevLive.validationUrl || cachedSummary?.validationUrl
          }
        });
        this.cliAntigravityProfileId = null;
        this.vault.saveState({
          activeProfileId: targetMeta.id,
          lastUpdated: Date.now()
        });
        this.quotaService.invalidate();
        await this.update(true);
        await Promise.race([
          Promise.allSettled([
            vscode.commands
              .executeCommand('antigravity.internal.logout')
              .then(undefined, () =>
                vscode.commands.executeCommand('antigravity.signOut')
              ),
            vscode.commands
              .executeCommand('antigravity.prioritized.chat.open')
              .then(undefined, () =>
                vscode.commands.executeCommand('antigravity.panel.focus')
              )
          ]),
          new Promise((resolve) => setTimeout(resolve, 1200))
        ]).catch(() => {});
        this.startAwaitingLoginWatch('antigravity', activeEmail);
        await this.handleVerifyAccount(targetMeta.id);
        return;
      }

      const meta = await this.vault.switchProfile(profileId);
      this.cliAntigravityProfileId = null;
      this.quotaService.invalidate();
      this.onCredentialsMutated?.();

      // Refresh outgoing profile quota over Cloud Code HTTPS in the background so
      // any Gemini/Claude burn right before the switch is captured without blocking the switch!
      if (outgoing && outgoing.id !== meta.id) {
        this.quotaService
          .refreshInactiveProfile(outgoing, this.vault, true)
          .then(() => this.scheduleUpdate(60, true))
          .catch(() => {});
      }

      const config = vscode.workspace.getConfiguration('charlier');
      const useSurgical = config.get<boolean>('antigravitySurgicalReload', true);

      if (useSurgical) {
        const onDaemonSynced = () => {
          this.onCredentialsMutated?.();
          this.quotaService
            .getQuotaSummary(true)
            .then(() => this.scheduleUpdate(60, true))
            .catch(() => {});
        };
        const hydrateFn = (this.quotaService as any).hydrateActiveDaemonInPlace;
        // Start in-place HasAuthToken hydration concurrently with Cockpit/Status Bar repaint
        // so `antigravity.reconnect` fires in ~15-20ms right alongside Charlier's own UI update.
        const hydratePromise: Promise<'hydrated' | 'not-running' | 'needs-respawn'> =
          typeof hydrateFn === 'function'
            ? hydrateFn.call(this.quotaService, meta.email, onDaemonSynced)
            : Promise.resolve('needs-respawn');
        const [, hydrateStatus] = await Promise.all([this.update(true), hydratePromise]);
        const respawnStatus =
          hydrateStatus === 'hydrated'
            ? 'hydrated'
            : hydrateStatus === 'not-running'
              ? 'not-running'
              : await this.quotaService.respawnActiveDaemon(onDaemonSynced);
        if (respawnStatus === 'budget-exhausted') {
          await confirmAndReloadForProviderSwitch('antigravity', meta.name, {
            isFallbackFromSurgical: true,
            isBudgetGuard: true
          });
          return;
        }
        if (
          respawnStatus === 'hydrated' ||
          respawnStatus === 'respawned' ||
          respawnStatus === 'not-running'
        ) {
          if (respawnStatus === 'not-running') {
            this.quotaService
              .refreshInactiveProfile(meta, this.vault, false)
              .then(() => this.scheduleUpdate(60, true))
              .catch(() => {});
          }
          if (meta.authStatus === 'unverified') {
            this.startAwaitingLoginWatch('antigravity');
            vscode.window.setStatusBarMessage(
              `$(shield) Switched to "${meta.name}" (${meta.email}) · Complete Google verification to unlock quota`,
              5000
            );
            await vscode.commands
              .executeCommand('antigravity.prioritized.chat.open')
              .then(undefined, () =>
                vscode.commands.executeCommand('antigravity.panel.focus')
              )
              .then(undefined, () => {});
            return;
          }
          vscode.window.setStatusBarMessage(
            `$(check) Switched Antigravity to "${meta.name}" (${meta.email}) · ${
              respawnStatus === 'hydrated'
                ? 'Session hot-swapped live'
                : respawnStatus === 'respawned'
                  ? 'Daemon respawned cleanly'
                  : 'CLI & next IDE launch ready'
            }`,
            4500
          );
          return;
        }
      } else {
        await this.update(true);
      }

      await confirmAndReloadForProviderSwitch('antigravity', meta.name, {
        isFallbackFromSurgical: useSurgical
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to switch profile: ${err.message}`);
    }
  }

  public async handleSaveCurrent(
    providerOverride?: ActiveProviderId
  ): Promise<void> {
    const provider = providerOverride || this.selectedProvider;

    if (provider === 'codex') {
      const live = this.codexVault.getLiveSessionInfo();
      const existingCodex = this.codexVault.findMatchingProfile(live);
      const defaultName =
        existingCodex?.name ||
        (live.email
          ? live.email.includes('@')
            ? live.email.split('@')[0]
            : live.email
          : 'Codex Profile');

      const name = await vscode.window.showInputBox({
        title: 'Save OpenAI Codex Profile',
        prompt: live.email
          ? `Save active Codex account (${live.email}) to your Charlier vault`
          : 'Enter a Codex profile name',
        value: defaultName,
        validateInput: (value) =>
          !value || !value.trim() ? 'Name cannot be empty.' : null
      });

      if (!name) return;

      try {
        const meta = this.codexVault.saveCurrentAsProfile(name.trim());
        this.clearCodexUnsavedDismissal(meta.accountId, meta.email);
        this.vault.setActiveCodexProfileId(meta.id);
        const cachedMetric = this.codexQuotaService.getCachedMetric();
        if (cachedMetric) {
          this.codexVault.updateProfileCachedQuota(meta.id, cachedMetric);
        }
        this.codexQuotaService.invalidateCache();
        await this.update(true);
        this.codexQuotaService
          .refreshProfileQuota(meta.id, this.codexVault)
          .then(() => {
            if (!this.disposed) {
              this.scheduleUpdate(40, true);
            }
          })
          .catch(() => {});
        vscode.window.setStatusBarMessage(
          `$(check) Saved Codex profile "${meta.name}" (${meta.email})`,
          4000
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to save Codex profile: ${err.message}`
        );
      }
      return;
    }

    const live = await this.vault.getLiveSessionInfoAsync();
    const cachedSummary = this.quotaService.getCachedSummary();
    const activeHealth = (this.quotaService as any).getActiveAuthHealth?.(
      live.email || cachedSummary?.email
    );
    const liveEmail =
      (live.email && live.email !== 'Unknown' ? live.email : undefined) ||
      (cachedSummary?.email && cachedSummary.email !== 'Unknown'
        ? cachedSummary.email
        : undefined) ||
      (this.lastFrame?.agy.live.email &&
      this.lastFrame.agy.live.email !== 'Unknown'
        ? this.lastFrame.agy.live.email
        : undefined);
    const existingProfile = liveEmail
      ? this.vault
          .listProfiles()
          .find((p) => p.email.toLowerCase() === liveEmail.toLowerCase())
      : undefined;
    const defaultName =
      existingProfile?.name ||
      (liveEmail
        ? liveEmail.includes('@')
          ? liveEmail.split('@')[0]
          : liveEmail
        : 'Profile');

    const name = await vscode.window.showInputBox({
      title: 'Save Antigravity Profile',
      prompt: liveEmail
        ? `Save active account (${liveEmail}) to your Charlier vault`
        : 'Enter a profile name',
      value: defaultName,
      validateInput: (value) =>
        !value || !value.trim() ? 'Name cannot be empty.' : null
    });

    if (!name) return;

    try {
      const liveMetric =
        cachedSummary &&
        cachedSummary.groups.length > 0 &&
        quotaMatchesIdentity(cachedSummary.email, liveEmail)
          ? this.quotaService.parseMetrics(cachedSummary)
          : null;
      const sessionHint: Partial<LiveSessionInfo> = {
        email: liveEmail,
        authStatus:
          live.authStatus ||
          cachedSummary?.authStatus ||
          activeHealth?.authStatus ||
          this.lastFrame?.agy.live.authStatus,
        authErrorCode:
          live.authErrorCode ||
          cachedSummary?.authErrorCode ||
          activeHealth?.authErrorCode ||
          this.lastFrame?.agy.live.authErrorCode,
        authErrorMessage:
          live.authErrorMessage ||
          cachedSummary?.authErrorMessage ||
          activeHealth?.authErrorMessage ||
          this.lastFrame?.agy.live.authErrorMessage,
        validationUrl:
          live.validationUrl ||
          cachedSummary?.validationUrl ||
          activeHealth?.validationUrl ||
          this.lastFrame?.agy.live.validationUrl
      };
      const meta = await this.vault.saveCurrentAsProfileAsync(
        name.trim(),
        liveMetric,
        sessionHint
      );
      if (meta.email && meta.email !== 'Unknown') {
        const lower = meta.email.toLowerCase();
        if (this.promptedEmails.delete(lower)) {
          this.persistPromptedUnsavedState();
        }
        this.sessionDismissedPromptKeys.delete(`antigravity:${lower}`);
      }
      this.quotaService.invalidate();
      await this.update(true);
      if (this.selectedProvider === 'antigravity') {
        this.quotaService
          .getQuotaSummary(true)
          .then(() => {
            if (!this.disposed) {
              this.scheduleUpdate(40, true);
            }
          })
          .catch(() => {});
      }
      vscode.window.setStatusBarMessage(
        `$(check) Saved profile "${meta.name}" (${meta.email})`,
        4000
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to save profile: ${err.message}`);
    }
  }

  public async handleAddAccount(
    providerOverride?: ActiveProviderId
  ): Promise<void> {
    if (this.isAddingAccount) return;
    this.isAddingAccount = true;
    this.suppressUnsavedPromptUntil = Date.now() + 2500;
    const provider = providerOverride || this.selectedProvider;

    if (provider === 'codex') {
      try {
        this.muteExternalWatcher?.(4000);
        vscode.window.setStatusBarMessage(
          '$(sync~spin) Backing up current Codex session and preparing new login...',
          2500
        );
        const liveBefore = this.codexVault.getLiveSessionInfo();
        const activeBefore = this.codexVault.findMatchingProfile(liveBefore);
        const activeHealthBefore = (this.codexQuotaService as any).getActiveAuthHealth?.(liveBefore);
        if (
          activeBefore &&
          (activeBefore.authStatus === 'revoked' ||
            activeBefore.authStatus === 'expired' ||
            activeHealthBefore?.authStatus === 'revoked' ||
            activeHealthBefore?.authStatus === 'expired')
        ) {
          this.pendingReauthTarget = {
            provider: 'codex',
            profileId: activeBefore.id,
            email: activeBefore.email,
            accountId: activeBefore.accountId,
            startedAt: Date.now()
          };
          this.notifiedReauthRecoveryKeys.delete(`codex:${activeBefore.id}`);
        } else {
          this.pendingReauthTarget = null;
        }

        const cachedMetric = this.codexQuotaService.getCachedMetric();
        this.cliCodexProfileId = null;
        this.vault.setActiveCodexProfileId(null);
        this.codexQuotaService.markLoggingOut();
        const { backedUpProfile, wasExisting } =
          await this.codexVault.prepareNewLoginAsync({
            deferFileUnlink: false,
            liveMetric: cachedMetric
          });

        // Revoke-free process replacement mounts /login without calling OpenAI /oauth/revoke
        await this.codexQuotaService.hotSwapCodexAppServer(null);
        this.codexVault.unlinkActiveAuthFileIfPresent?.();

        this.codexQuotaService.invalidateCache();
        this.activeUnsavedCodexKey = null;
        this.suppressUnsavedPromptUntil = 0;
        this.onCredentialsMutated?.();
        this.shortenExternalWatcherMute?.(250);
        await this.update(true);
        this.startAwaitingLoginWatch('codex', liveBefore.email);
        await vscode.commands
          .executeCommand('chatgpt.openSidebar')
          .then(undefined, () => {});
        this.codexQuotaService.ensureStdoutObserver?.();

        let headsUpCopy: string;
        if (backedUpProfile && wasExisting) {
          headsUpCopy = `Refreshed "${backedUpProfile.name}" (${backedUpProfile.email}) in your Codex vault. Sign in with your next account in the Codex sidebar or via "codex login".`;
        } else if (backedUpProfile && !wasExisting) {
          headsUpCopy = `Auto-saved "${backedUpProfile.name}" (${backedUpProfile.email}) to your Codex vault. Sign in with your next account in the Codex sidebar or via "codex login".`;
        } else {
          headsUpCopy =
            'Session cleared. Sign in with your next account in the OpenAI Codex sidebar or via "codex login".';
        }

        vscode.window.setStatusBarMessage(
          '$(account) Ready for new OpenAI Codex login.',
          5000
        );
        Promise.resolve(
          vscode.window.showInformationMessage(
            headsUpCopy,
            'Open Terminal (codex login)',
            'Got It'
          )
        )
          .then((action) => {
            if (
              action === 'Open Terminal (codex login)' &&
              typeof vscode.window.createTerminal === 'function'
            ) {
              const resolvedCodex = this.resolveCliBinaryForProvider('codex');
              if (!resolvedCodex) {
                this.promptMissingCliBinary('codex');
                return;
              }
              const term = vscode.window.createTerminal({
                name: 'Charlier · Codex Login',
                env: resolvedCodex.pathOverride
              });
              this.onCliTerminalLaunched?.(term, 'codex');
              term.show();
              term.sendText('codex login');
            }
          })
          .catch(() => {});
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to prepare Codex login: ${err.message}`
        );
      } finally {
        this.isAddingAccount = false;
      }
      return;
    }

    try {
      this.muteExternalWatcher?.(4000);
      vscode.window.setStatusBarMessage(
        '$(sync~spin) Backing up current session and preparing new login...',
        2500
      );

      const cachedSummary = this.quotaService.getCachedSummary();
      const agyLiveBefore = await this.vault.getLiveSessionInfoAsync();
      const prevEmail =
        (agyLiveBefore.email && agyLiveBefore.email !== 'Unknown'
          ? agyLiveBefore.email
          : undefined) ||
        (cachedSummary?.email && cachedSummary.email !== 'Unknown'
          ? cachedSummary.email
          : undefined) ||
        (this.lastFrame?.agy.live.email &&
        this.lastFrame.agy.live.email !== 'Unknown'
          ? this.lastFrame.agy.live.email
          : undefined);
      const agyMatchedBefore = prevEmail
        ? this.vault
            .listProfiles()
            .find((p) => p.email.toLowerCase() === prevEmail.toLowerCase()) || null
        : null;
      const agyHealthBefore = (this.quotaService as any).getActiveAuthHealth?.(prevEmail);
      if (
        agyMatchedBefore &&
        (agyMatchedBefore.authStatus === 'revoked' ||
          agyMatchedBefore.authStatus === 'expired' ||
          agyHealthBefore?.authStatus === 'revoked' ||
          agyHealthBefore?.authStatus === 'expired')
      ) {
        this.pendingReauthTarget = {
          provider: 'antigravity',
          profileId: agyMatchedBefore.id,
          email: agyMatchedBefore.email,
          startedAt: Date.now()
        };
        this.notifiedReauthRecoveryKeys.delete(`antigravity:${agyMatchedBefore.id}`);
      } else {
        this.pendingReauthTarget = null;
      }

      const liveMetric =
        cachedSummary &&
        cachedSummary.groups.length > 0 &&
        quotaMatchesIdentity(cachedSummary.email, prevEmail)
          ? this.quotaService.parseMetrics(cachedSummary)
          : null;
      const sessionHint: Partial<LiveSessionInfo> = {
        email: prevEmail,
        authStatus:
          agyLiveBefore.authStatus ||
          cachedSummary?.authStatus ||
          agyHealthBefore?.authStatus ||
          this.lastFrame?.agy.live.authStatus,
        authErrorCode:
          agyLiveBefore.authErrorCode ||
          cachedSummary?.authErrorCode ||
          agyHealthBefore?.authErrorCode ||
          this.lastFrame?.agy.live.authErrorCode,
        authErrorMessage:
          agyLiveBefore.authErrorMessage ||
          cachedSummary?.authErrorMessage ||
          agyHealthBefore?.authErrorMessage ||
          this.lastFrame?.agy.live.authErrorMessage,
        validationUrl:
          agyLiveBefore.validationUrl ||
          cachedSummary?.validationUrl ||
          agyHealthBefore?.validationUrl ||
          this.lastFrame?.agy.live.validationUrl
      };

      this.cliAntigravityProfileId = null;
      (this.quotaService as any).markLoggingOut?.(prevEmail, 4000);
      const { backedUpProfile, wasExisting } =
        await this.vault.prepareNewLoginAsync({ liveMetric, sessionHint });
      this.quotaService.invalidate();
      this.activeUnsavedAgyEmail = null;
      this.suppressUnsavedPromptUntil = 0;
      this.onCredentialsMutated?.();
      this.shortenExternalWatcherMute?.(250);
      await this.update(true);
      this.startAwaitingLoginWatch('antigravity', prevEmail);

      await Promise.race([
        Promise.allSettled([
          vscode.commands
            .executeCommand('antigravity.internal.logout')
            .then(undefined, () =>
              vscode.commands.executeCommand('antigravity.signOut')
            ),
          vscode.commands
            .executeCommand('antigravity.prioritized.chat.open')
            .then(undefined, () =>
              vscode.commands.executeCommand('antigravity.panel.focus')
            )
        ]),
        new Promise((resolve) => setTimeout(resolve, 400))
      ]).catch(() => {});

      this.quotaService.invalidate();

      let headsUpCopy: string;
      if (backedUpProfile && wasExisting) {
        headsUpCopy = `Refreshed "${backedUpProfile.name}" (${backedUpProfile.email}) in your vault. Sign in with your next account in the Antigravity sidebar.`;
      } else if (backedUpProfile && !wasExisting) {
        headsUpCopy = `Auto-saved "${backedUpProfile.name}" (${backedUpProfile.email}) to your vault so nothing is lost. Sign in with your next account in the Antigravity sidebar.`;
      } else {
        headsUpCopy =
          'Session cleared. Sign in with your Google account in the Antigravity sidebar.';
      }

      vscode.window.setStatusBarMessage(
        '$(account) Ready for new Antigravity login.',
        5000
      );
      vscode.window.showInformationMessage(headsUpCopy);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to prepare login: ${err.message}`);
    } finally {
      this.isAddingAccount = false;
    }
  }

  public async handleVerifyAccount(profileId?: string): Promise<void> {
    const profiles = this.vault.listProfiles();
    const target = profileId
      ? profiles.find((p) => p.id === profileId)
      : undefined;
    const matchesTarget = (email?: string | null) =>
      !target || quotaMatchesIdentity(target.email, email);
    const cachedSummary = this.quotaService.getCachedSummary();
    const activeHealth = (this.quotaService as any).getActiveAuthHealth?.(
      target?.email || cachedSummary?.email || this.lastFrame?.agy.live.email
    );
    const validationUrl =
      target?.validationUrl ||
      (matchesTarget(cachedSummary?.email)
        ? cachedSummary?.validationUrl
        : undefined) ||
      (matchesTarget(activeHealth?.email ?? this.lastFrame?.agy.live.email)
        ? activeHealth?.validationUrl
        : undefined) ||
      (matchesTarget(this.lastFrame?.agy.live.email)
        ? this.lastFrame?.agy.live.validationUrl
        : undefined);

    this.startAwaitingLoginWatch('antigravity');

    await Promise.race([
      vscode.commands
        .executeCommand('antigravity.prioritized.chat.open')
        .then(undefined, () =>
          vscode.commands.executeCommand('antigravity.panel.focus')
        )
        .then(undefined, () => {}),
      new Promise((resolve) => setTimeout(resolve, 400))
    ]).catch(() => {});

    if (
      validationUrl &&
      /^https:\/\//i.test(validationUrl) &&
      typeof vscode.env?.openExternal === 'function'
    ) {
      await vscode.env
        .openExternal(vscode.Uri.parse(validationUrl))
        .then(undefined, () => {});
      vscode.window.setStatusBarMessage(
        '$(shield) Opened Google account verification in your browser...',
        5000
      );
      return;
    }

    const label = target
      ? `"${target.name}" (${target.email})`
      : this.lastFrame?.agy.live.email || 'your Google account';
    vscode.window.showInformationMessage(
      `Complete Google verification for ${label} in the Antigravity panel (click Verify and scan the QR code or confirm on your phone). Charlier will unlock quota automatically once verified.`
    );
  }

  private formatProfileDetailLine(
    cq: CachedQuotaMetric | undefined,
    planName: string,
    isActive: boolean
  ): string {
    const modeLabel = isActive ? 'Active' : 'Switch';
    if (!cq || !cq.gemini || cq.gemini === '--') {
      return `${modeLabel}  ·  ${planName} Plan`;
    }

    const parts: string[] = [modeLabel];

    const gPct = parseInt(cq.gemini, 10);
    const gReset = cq.geminiReset
      ? this.quotaService.formatResetCompact(cq.geminiReset)
      : '';
    const gSuffix =
      gReset && Number.isFinite(gPct) && gPct < 100 ? ` (${gReset})` : '';
    parts.push(`Gemini ${cq.gemini}${gSuffix}`);

    if (planName !== 'FREE' && cq.claudeGpt && cq.claudeGpt !== '--') {
      const cPct = parseInt(cq.claudeGpt, 10);
      const cReset = cq.claudeReset
        ? this.quotaService.formatResetCompact(cq.claudeReset)
        : '';
      const cSuffix =
        cReset && Number.isFinite(cPct) && cPct < 100 ? ` (${cReset})` : '';
      parts.push(`Claude ${cq.claudeGpt}${cSuffix}`);
    }

    if (planName !== 'FREE' && cq.carbon && cq.carbon !== '--' && cq.carbon !== 'incl.') {
      const cbPct = parseInt(cq.carbon, 10);
      const cbReset = cq.carbonReset
        ? this.quotaService.formatResetCompact(cq.carbonReset)
        : '';
      if (cbPct === 0) {
        parts.push(`Carbon 0% (${cbReset ? cbReset : 'Depleted'})`);
      } else {
        const cbSuffix =
          cbReset && Number.isFinite(cbPct) && cbPct < 100 ? ` (${cbReset})` : '';
        parts.push(`Carbon ${cq.carbon}${cbSuffix}`);
      }
    }

    if (!isActive && cq.updatedAt) {
      parts.push(this.quotaService.formatTimeAgo(cq.updatedAt));
    }

    return parts.join('  ·  ');
  }

  private formatCodexProfileDetailLine(
    cq: CachedQuotaMetric | undefined,
    planName: string,
    isActive: boolean
  ): string {
    const modeLabel = isActive ? 'Active' : 'Switch';
    if (!cq || !cq.codex5h || cq.codex5h === '--') {
      return `${modeLabel}  ·  ${planName} Plan`;
    }

    const parts: string[] = [modeLabel];

    const p5 = parseInt(cq.codex5h, 10);
    const r5 = cq.codex5hReset || '';
    const s5 = r5 && Number.isFinite(p5) && p5 < 100 ? ` (${r5})` : '';
    parts.push(`5h Pool ${cq.codex5h}${s5}`);

    const p7 = parseInt(cq.codex7d || '', 10);
    const r7 = cq.codex7dReset || '';
    const s7 = r7 && Number.isFinite(p7) && p7 < 100 ? ` (${r7})` : '';
    if (cq.codex7d && cq.codex7d !== '--') {
      parts.push(`7d Weekly ${cq.codex7d}${s7}`);
    }

    if (typeof cq.codexResetCredits === 'number') {
      parts.push(`Reset Credits ${cq.codexResetCredits}`);
    }

    if (cq.updatedAt) {
      parts.push(formatTimeAgo(cq.updatedAt));
    }

    return parts.join('  ·  ');
  }

  private buildPoolRow(
    icon: string,
    poolLabel: string,
    pctStr: string | undefined,
    resetDisplayOrIso: string | undefined,
    modelScope: string,
    fallbackNote?: string,
    isPreformattedCountdown = false
  ): vscode.QuickPickItem {
    const pct = percentFromText(pctStr);
    if (pct !== null) {
      const frac = Math.max(0, Math.min(1, pct / 100));
      const meter = this.quotaService.renderLinenMeter(frac, 8);
      const resetStr = resetDisplayOrIso
        ? isPreformattedCountdown
          ? resetDisplayOrIso
          : this.quotaService.formatResetCompact(resetDisplayOrIso)
        : '';
      const paddedPct = `${pct}%`.padStart(4, ' ');

      let statusText: string;
      if (pct === 0) {
        statusText = resetStr
          ? `Depleted · Resets in ${resetStr}`
          : 'Depleted for window';
      } else if (pct === 100) {
        statusText = 'Full capacity';
      } else {
        statusText = resetStr ? `Resets in ${resetStr}` : 'Active';
      }

      return {
        label: `  $(${icon}) ${poolLabel.padEnd(18, ' ')} ${meter}  ${paddedPct}`,
        description: `${statusText}  ·  ${modelScope}`
      };
    }

    const badge = pctStr === 'incl.' ? 'INCL' : '--';
    return {
      label: `  $(${icon}) ${poolLabel.padEnd(18, ' ')} ▒▒▒▒▒▒▒▒  ${badge.padStart(4, ' ')}`,
      description:
        fallbackNote ||
        (pctStr === 'incl.'
          ? modelScope
          : `Usage unavailable · ${modelScope}`)
    };
  }

  public async showQuotaDetails(
    profileId?: string,
    providerOverride?: ActiveProviderId
  ): Promise<void> {
    const provider = providerOverride || this.selectedProvider;

    if (provider === 'codex') {
      await this.showCodexQuotaDetails(profileId);
      return;
    }

    // Read disk/memory state synchronously so the QuickPick opens at 0ms
    const profiles = this.vault.listProfiles();
    let live =
      this.vault.getLiveSessionInfo?.() ||
      this.lastFrame?.agy.live || {
        email: null,
        hasOAuthCreds: false,
        tokenExpiryDate: null,
        isExpired: false
      };
    const state = this.vault.getState();
    const target = profileId
      ? profiles.find((p) => p.id === profileId) || null
      : null;

    const isTargetActive = target
      ? this.cliAntigravityProfileId
        ? state.activeProfileId === target.id
        : Boolean(
            (live.email &&
              target.email.toLowerCase() === live.email.toLowerCase()) ||
              (!live.email && state.activeProfileId === target.id)
          )
      : true;

    const buildCachedAntigravityRows = (
      cached: CachedQuotaMetric | null | undefined,
      planLabel: string,
      emptyNote: string
    ): Array<vscode.QuickPickItem & { action?: string }> => {
      const rows: Array<vscode.QuickPickItem & { action?: string }> = [];
      if (cached && (cached.gemini !== '--' || cached.claudeGpt !== '--')) {
        const g5h = cached.gemini5h || cached.gemini || '--';
        const g5hReset = cached.gemini5hReset || cached.geminiReset;
        const g7d = cached.gemini7d || cached.gemini || '--';
        const g7dReset = cached.gemini7dReset;
        const geminiModelScope =
          planLabel === 'FREE' ? 'Hydrogen, Flash & Pro' : 'Hydrogen, Neon & Carbon';

        rows.push({
          label: 'GEMINI',
          kind: vscode.QuickPickItemKind.Separator
        });
        rows.push(
          this.buildPoolRow('pulse', '5-Hour Fast Pool', g5h, g5hReset, geminiModelScope)
        );
        rows.push(
          this.buildPoolRow('calendar', '7-Day Weekly Pool', g7d, g7dReset, geminiModelScope)
        );

        if (planLabel !== 'FREE') {
          const c5h = cached.claude5h || '--';
          const c5hReset = cached.claude5hReset;
          const c7d = cached.claude7d || cached.claudeGpt || '--';
          const c7dReset = cached.claude7dReset || cached.claudeReset;

          rows.push({
            label: 'CLAUDE & GPT',
            kind: vscode.QuickPickItemKind.Separator
          });
          rows.push(
            this.buildPoolRow('pulse', '5-Hour Fast Pool', c5h, c5hReset, 'Opus & Sonnet')
          );
          rows.push(
            this.buildPoolRow('calendar', '7-Day Weekly Pool', c7d, c7dReset, 'Opus & Sonnet')
          );

          if (cached.carbon && cached.carbon !== '--' && cached.carbon !== 'incl.') {
            rows.push({
              label: 'GEMINI 4 CARBON',
              kind: vscode.QuickPickItemKind.Separator
            });
            rows.push(
              this.buildPoolRow(
                'flame',
                '7-Day Weekly Pool',
                cached.carbon,
                cached.carbonReset,
                `${planLabel === 'ULTRA' ? 'Ultra' : 'Pro'} allowance`
              )
            );
          }
        }
      } else {
        rows.push({
          label: `  $(info) ${emptyNote}`,
          description: 'Select Refresh below to pull live usage from Google'
        });
      }
      return rows;
    };

    if (!isTargetActive && target) {
      let cached = target.cachedQuota;
      const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { action?: string }>();
      let closed = false;

      const applyInactive = (syncing = false) => {
        if (closed || this.disposed) return;
        const planLabel = target.planOverride || cached?.plan || 'FREE';
        const timeAgo = cached?.updatedAt
          ? this.quotaService.formatTimeAgo(cached.updatedAt)
          : syncing
            ? 'syncing...'
            : 'not yet synced';
        const items: Array<vscode.QuickPickItem & { action?: string }> = [
          ...buildCachedAntigravityRows(
            cached,
            planLabel,
            syncing
              ? `Fetching latest usage for "${target.name}"...`
              : `No usage snapshot recorded for "${target.name}"`
          ),
          {
            label: 'ACTIONS',
            kind: vscode.QuickPickItemKind.Separator
          },
          {
            label: `  $(sync) Refresh "${target.name}" usage now`,
            description: 'Pull live 5h & weekly limits in background without switching',
            action: 'refreshInactive'
          },
          {
            label: `  $(arrow-swap) Switch to "${target.name}"`,
            description: `Activate ${target.email}`,
            action: 'switch'
          }
        ];
        qp.title = `Charlier · ${target.name} (${planLabel} Plan)`;
        qp.placeholder = `${target.email}  ·  ${
          syncing ? 'Refreshing live snapshot...' : `Updated ${timeAgo}`
        }  ·  Select an action or press Esc`;
        qp.items = items;
      };

      const runInactiveRefresh = (force: boolean) => {
        qp.busy = true;
        applyInactive(true);
        void this.quotaService
          .refreshInactiveProfile(target, this.vault, force)
          .then((refreshed) => {
            if (refreshed) {
              cached = refreshed;
              this.scheduleUpdate(60, true);
              if (force) {
                vscode.window.setStatusBarMessage(
                  `$(check) Updated usage snapshot for "${target.name}".`,
                  3000
                );
              }
            } else if (force) {
              vscode.window.showWarningMessage(
                `Could not refresh "${target.name}" right now. Showing last saved snapshot.`
              );
            }
          })
          .catch(() => {})
          .finally(() => {
            if (!closed && !this.disposed) {
              qp.busy = false;
              applyInactive(false);
            }
          });
      };

      qp.onDidAccept(async () => {
        const choice = qp.selectedItems[0];
        if (!choice?.action) return;
        if (choice.action === 'refreshInactive') {
          runInactiveRefresh(true);
          return;
        }
        qp.hide();
        if (choice.action === 'switch') {
          await this.handleSwitch(target.id, 'antigravity');
        }
      });
      qp.onDidHide(() => {
        closed = true;
        qp.dispose();
      });

      const needsBgRefresh =
        !cached || !cached.updatedAt || Date.now() - cached.updatedAt > 45_000;
      applyInactive(needsBgRefresh);
      qp.show();
      if (needsBgRefresh) {
        runInactiveRefresh(false);
      }
      return;
    }

    // Active Antigravity profile: open synchronously at 0ms from cached daemon/vault snapshot,
    // then refresh live daemon telemetry in the background without blocking QuickPick open.
    const resolveActiveProf = (): ProfileMetadata | null =>
      target ||
      (live.email
        ? profiles.find((p) => p.email.toLowerCase() === live.email!.toLowerCase()) || null
        : null);

    let currentQuota: QuotaSummary | null =
      this.quotaService.getCachedSummary() || this.lastFrame?.agy.quota || null;
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { action?: string }>();
    let closed = false;

    const applyActive = (syncing = false) => {
      if (closed || this.disposed) return;
      const activeProf = resolveActiveProf();
      const targetEmail = activeProf?.email || live.email || currentQuota?.email || '';
      const validQuota =
        currentQuota &&
        currentQuota.groups.length > 0 &&
        (!currentQuota.email ||
          !targetEmail ||
          quotaMatchesIdentity(currentQuota.email, targetEmail))
          ? currentQuota
          : null;

      const unverifiedTarget =
        (activeProf?.authStatus === 'unverified' ? activeProf : null) ||
        (live.email
          ? profiles.find(
              (p) =>
                p.email.toLowerCase() === live.email!.toLowerCase() &&
                p.authStatus === 'unverified'
            ) || null
          : null);
      const isUnverified = Boolean(
        live.authStatus === 'unverified' ||
          currentQuota?.authStatus === 'unverified' ||
          unverifiedTarget
      );

      const planTier = (
        activeProf?.planOverride ||
        validQuota?.planTier ||
        activeProf?.cachedQuota?.plan ||
        'FREE'
      ).toUpperCase();
      const activeTitleName =
        activeProf?.name ||
        (live.email ? live.email.split('@')[0] : 'Active Session');

      const items: Array<vscode.QuickPickItem & { action?: string }> = [];

      if (validQuota) {
        for (const group of validQuota.groups) {
          const lowerGroup = group.displayName.toLowerCase();
          const isArgon = lowerGroup.includes('argon');
          const isCarbon = lowerGroup.includes('carbon');
          const isClaudeGpt =
            lowerGroup.includes('claude') || lowerGroup.includes('gpt');
          const isGemini = lowerGroup.includes('gemini') && !isCarbon && !isArgon;
          const isExtraPool = isCarbon || (!isArgon && !isClaudeGpt && !isGemini);

          if (isArgon || (planTier === 'FREE' && (isExtraPool || isClaudeGpt))) {
            continue;
          }

          const groupHeader = isCarbon
            ? 'GEMINI 4 CARBON'
            : isClaudeGpt
              ? 'CLAUDE & GPT'
              : isGemini
                ? 'GEMINI'
                : (group.displayName || 'EXTRA POOL').toUpperCase();

          items.push({
            label: groupHeader,
            kind: vscode.QuickPickItemKind.Separator
          });

          const orderedBuckets = [...group.buckets].sort((a, b) =>
            a.window === '5h' && b.window !== '5h'
              ? -1
              : b.window === '5h' && a.window !== '5h'
                ? 1
                : 0
          );

          for (const bucket of orderedBuckets) {
            const is5h = bucket.window === '5h';
            const windowTitle = is5h ? '5-Hour Fast Pool' : '7-Day Weekly Pool';
            const icon = isExtraPool ? 'flame' : is5h ? 'pulse' : 'calendar';
            const modelScope = isExtraPool
              ? `${planTier === 'ULTRA' ? 'Ultra' : 'Pro'} allowance`
              : isClaudeGpt
                ? 'Opus & Sonnet'
                : planTier === 'FREE'
                  ? 'Hydrogen, Flash & Pro'
                  : 'Hydrogen, Neon & Carbon';

            if (bucket.disabled) {
              items.push(
                this.buildPoolRow(icon, windowTitle, '--', undefined, modelScope)
              );
            } else {
              const percent = percentFromFraction(bucket.remainingFraction);
              const pctStr = percent === null ? '--' : `${percent}%`;
              items.push(
                this.buildPoolRow(
                  icon,
                  windowTitle,
                  pctStr,
                  bucket.resetTime,
                  modelScope
                )
              );
            }
          }
        }
      } else if (isUnverified) {
        items.push({
          label: '  $(shield) Google verification required',
          description: 'Complete verification in Antigravity to unlock live quota',
          action: 'verifyAccount'
        });
      } else if (
        activeProf?.cachedQuota &&
        (activeProf.cachedQuota.gemini !== '--' ||
          activeProf.cachedQuota.claudeGpt !== '--')
      ) {
        items.push(
          ...buildCachedAntigravityRows(
            activeProf.cachedQuota,
            planTier,
            'No usage snapshot recorded'
          )
        );
      } else {
        items.push({
          label: syncing
            ? '  $(sync~spin) Querying local Antigravity daemon...'
            : '  $(info) No active quota reported by daemon',
          description: syncing
            ? 'Pulling live 5h & weekly windows'
            : 'Click Refresh below once Antigravity finishes syncing'
        });
      }

      items.push({
        label: 'ACTIONS',
        kind: vscode.QuickPickItemKind.Separator
      });
      if (isUnverified) {
        items.push({
          label: '  $(shield) Verify Account now',
          description: 'Open Google verification flow',
          action: 'verifyAccount'
        });
      }
      items.push({
        label: '  $(sync) Refresh live telemetry',
        description: 'Query local Antigravity daemon in place',
        action: 'refreshActive'
      });

      qp.title = `Charlier · ${activeTitleName} (${planTier} Plan · Active)`;
      qp.placeholder = `${targetEmail ? `${targetEmail}  ·  ` : ''}${
        syncing ? 'Refreshing live daemon telemetry...' : 'Live daemon telemetry'
      }  ·  Press Esc to close`;
      qp.items = items;
    };

    const runActiveRefresh = (force: boolean) => {
      qp.busy = true;
      applyActive(true);
      void Promise.all([
        this.vault.getLiveSessionInfoAsync().catch(() => live),
        this.quotaService.getQuotaSummary(force).catch(() => null)
      ])
        .then(([freshLive, freshQuota]) => {
          if (freshLive) live = freshLive;
          if (freshQuota) currentQuota = freshQuota;
          const activeProf = resolveActiveProf();
          if (
            activeProf &&
            currentQuota &&
            currentQuota.groups.length > 0 &&
            currentQuota.email &&
            quotaMatchesIdentity(currentQuota.email, activeProf.email)
          ) {
            const parsed = this.quotaService.parseMetrics(
              currentQuota,
              activeProf.planOverride
            );
            this.vault.updateProfileCachedQuota(activeProf.id, parsed);
            activeProf.cachedQuota = parsed;
            this.scheduleUpdate(60, true);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!closed && !this.disposed) {
            qp.busy = false;
            applyActive(false);
          }
        });
    };

    qp.onDidAccept(async () => {
      const picked = qp.selectedItems[0];
      if (!picked?.action) return;
      if (picked.action === 'refreshActive') {
        runActiveRefresh(true);
        return;
      }
      qp.hide();
      if (picked.action === 'verifyAccount') {
        const activeProf = resolveActiveProf();
        await this.handleVerifyAccount(activeProf?.id || target?.id);
      }
    });
    qp.onDidHide(() => {
      closed = true;
      qp.dispose();
    });

    const summaryAgeMs = currentQuota?.fetchedAt
      ? Date.now() - currentQuota.fetchedAt
      : Infinity;
    const needsBgRefresh =
      !currentQuota ||
      currentQuota.groups.length === 0 ||
      summaryAgeMs > 15_000;
    applyActive(needsBgRefresh);
    qp.show();
    if (needsBgRefresh) {
      runActiveRefresh(false);
    }
  }

  private buildCodexWindowQuickPickRows(
    cached: CachedQuotaMetric | null | undefined,
    planLabel: string
  ): Array<vscode.QuickPickItem & { action?: string }> {
    const rows: Array<vscode.QuickPickItem & { action?: string }> = [
      {
        label: 'OPENAI CODEX RATE WINDOWS',
        kind: vscode.QuickPickItemKind.Separator
      },
      this.buildPoolRow(
        'pulse',
        '5-Hour Primary Pool',
        cached?.codex5h || '--',
        cached?.codex5hReset,
        'GPT-5.4 / Codex Agent',
        undefined,
        true
      )
    ];

    const isFreeSingleWindow =
      planLabel === 'FREE' &&
      Boolean(cached?.codex5h && cached.codex5h !== '--') &&
      (!cached?.codex7d || cached.codex7d === '--');
    if (!isFreeSingleWindow) {
      rows.push(
        this.buildPoolRow(
          'calendar',
          '7-Day Weekly Pool',
          cached?.codex7d || '--',
          cached?.codex7dReset,
          'Weekly Codex allowance',
          undefined,
          true
        )
      );
    }

    const hasCodexPools = Boolean(
      (cached?.codex5h && cached.codex5h !== '--') ||
        (cached?.codex7d && cached.codex7d !== '--')
    );
    if (cached?.codexCodeReview && cached.codexCodeReview !== '--') {
      rows.push(
        this.buildPoolRow(
          'git-pull-request',
          'Code Review Pool',
          cached.codexCodeReview,
          cached.codexCodeReviewReset,
          'Automated PR reviews',
          undefined,
          true
        )
      );
    } else if (planLabel !== 'FREE' && planLabel !== 'API_KEY' && hasCodexPools) {
      rows.push({
        label: '  $(git-pull-request) Code Review Pool           [ Included ]',
        description: 'PR review allowance · On demand'
      });
    }

    if (typeof cached?.codexResetCredits === 'number') {
      rows.push({
        label: 'CREDITS & ALLOWANCE',
        kind: vscode.QuickPickItemKind.Separator
      });
      rows.push({
        label: `  $(zap) Reset Credits Available       ${cached.codexResetCredits}`,
        description: 'Rate-limit reset credits on this Codex account'
      });
    }

    return rows;
  }

  private async showCodexQuotaDetails(profileId?: string): Promise<void> {
    const profiles = this.codexVault.listProfiles();
    const live = this.codexVault.getLiveSessionInfo();
    const activeProf = this.codexVault.findMatchingProfile(live);
    const target = profileId
      ? profiles.find((p) => p.id === profileId) || activeProf
      : activeProf || profiles[0] || null;

    if (!target) {
      if (live.email || live.accountId) {
        const liveHealth = (this.codexQuotaService as any).getActiveAuthHealth?.(live);
        const liveIsStale =
          live.authStatus === 'revoked' ||
          live.authStatus === 'expired' ||
          liveHealth?.authStatus === 'revoked' ||
          liveHealth?.authStatus === 'expired';
        const initialRaw =
          this.codexQuotaService.getCachedMetric() ||
          this.lastFrame?.codex.metrics ||
          undefined;
        let cached = codexMetricForDisplay(
          liveIsStale ? initialRaw : healExpiredCodexMetric(initialRaw),
          live.authMode
        );
        const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { action?: string }>();
        let closed = false;

        const applyUnsaved = (syncing = false) => {
          if (closed || this.disposed) return;
          const planLabel = (cached?.plan || live.planTier || 'FREE').toUpperCase();
          const items: Array<vscode.QuickPickItem & { action?: string }> = [
            ...this.buildCodexWindowQuickPickRows(cached, planLabel),
            {
              label: 'ACTIONS',
              kind: vscode.QuickPickItemKind.Separator
            },
            {
              label: '  $(add) Save active Codex session to Vault',
              description: live.email || live.accountId || '',
              action: 'saveCodex'
            },
            {
              label: '  $(sync) Refresh live usage now',
              description: 'Query live chatgpt.com/backend-api/wham/usage',
              action: 'refreshUnsaved'
            }
          ];
          qp.title = `Charlier · Codex · ${live.email || 'Active'} (${planLabel} Plan · Unsaved)`;
          qp.placeholder = `${live.email || ''}  ·  ${
            syncing ? 'Refreshing live wham/usage...' : 'Unsaved active session'
          }  ·  Select an action or press Esc`;
          qp.items = items;
        };

        const runUnsavedRefresh = (force: boolean) => {
          qp.busy = true;
          applyUnsaved(true);
          void this.codexQuotaService
            .getActiveQuotaSummary(this.codexVault, force)
            .then((activeRes) => {
              if (activeRes?.metric) {
                cached = codexMetricForDisplay(
                  liveIsStale
                    ? activeRes.metric
                    : healExpiredCodexMetric(activeRes.metric),
                  live.authMode
                );
                this.scheduleUpdate(60, true);
              }
            })
            .catch(() => {})
            .finally(() => {
              if (!closed && !this.disposed) {
                qp.busy = false;
                applyUnsaved(false);
              }
            });
        };

        qp.onDidAccept(async () => {
          const choice = qp.selectedItems[0];
          if (!choice?.action) return;
          if (choice.action === 'refreshUnsaved') {
            runUnsavedRefresh(true);
            return;
          }
          qp.hide();
          if (choice.action === 'saveCodex') {
            await this.handleSaveCurrent('codex');
          }
        });
        qp.onDidHide(() => {
          closed = true;
          qp.dispose();
        });

        const needsBgRefresh =
          live.authMode !== 'apikey' &&
          (!cached || !cached.updatedAt || Date.now() - cached.updatedAt > 15_000);
        applyUnsaved(needsBgRefresh);
        qp.show();
        if (needsBgRefresh) {
          runUnsavedRefresh(false);
        }
        return;
      }
      vscode.window.showInformationMessage(
        'No saved Codex profiles found. Save your active Codex session first.'
      );
      return;
    }

    const isTargetActive = Boolean(activeProf && activeProf.id === target.id);
    const targetNeedsReauth =
      target.authStatus === 'revoked' || target.authStatus === 'expired';
    const liveActiveMetric = isTargetActive
      ? this.codexQuotaService.getCachedMetric() ||
        this.lastFrame?.codex.metrics ||
        null
      : null;
    const bestRawMetric =
      liveActiveMetric &&
      (!target.cachedQuota?.updatedAt ||
        (liveActiveMetric.updatedAt || 0) >= target.cachedQuota.updatedAt)
        ? liveActiveMetric
        : target.cachedQuota;
    let cached = codexMetricForDisplay(
      targetNeedsReauth ? bestRawMetric : healExpiredCodexMetric(bestRawMetric),
      target.authMode
    );

    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { action?: string }>();
    let closed = false;

    const applySaved = (syncing = false) => {
      if (closed || this.disposed) return;
      const planLabel = (
        target.planOverride ||
        cached?.plan ||
        (target.authMode === 'apikey' ? 'API_KEY' : 'PLUS')
      ).toUpperCase();
      const timeAgo = cached?.updatedAt
        ? formatTimeAgo(cached.updatedAt)
        : syncing
          ? 'syncing...'
          : 'not yet synced';

      const items: Array<vscode.QuickPickItem & { action?: string }> = [
        ...this.buildCodexWindowQuickPickRows(cached, planLabel),
        {
          label: 'ACTIONS',
          kind: vscode.QuickPickItemKind.Separator
        },
        {
          label: `  $(sync) Refresh "${target.name}" usage now`,
          description: 'Query live chatgpt.com/backend-api/wham/usage',
          action: 'refreshCodex'
        }
      ];

      if (!isTargetActive) {
        items.push({
          label: `  $(arrow-swap) Switch to "${target.name}" (IDE + CLI)`,
          description: `Activate ${target.email}`,
          action: 'switch'
        });
        items.push({
          label: `  $(terminal) Switch CLI Only to "${target.name}"`,
          description: 'Launch isolated CODEX_HOME terminal with zero IDE reload',
          action: 'switchCliOnly'
        });
      }

      qp.title = `Charlier · Codex · ${target.name} (${planLabel} Plan${isTargetActive ? ' · Active' : ''})`;
      qp.placeholder = `${target.email}  ·  ${
        syncing ? 'Refreshing live wham/usage...' : `Updated ${timeAgo}`
      }  ·  Select an action or press Esc`;
      qp.items = items;
    };

    const runSavedRefresh = (force: boolean) => {
      qp.busy = true;
      applySaved(true);
      const task = isTargetActive
        ? this.codexQuotaService
            .getActiveQuotaSummary(this.codexVault, force)
            .then((r) => r?.metric || null)
        : this.codexQuotaService.refreshProfileQuota(target.id, this.codexVault, force);
      void task
        .then((refreshed) => {
          if (refreshed) {
            cached = codexMetricForDisplay(refreshed, target.authMode);
            this.scheduleUpdate(60, true);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!closed && !this.disposed) {
            qp.busy = false;
            applySaved(false);
          }
        });
    };

    qp.onDidAccept(async () => {
      const choice = qp.selectedItems[0];
      if (!choice?.action) return;
      if (choice.action === 'refreshCodex') {
        runSavedRefresh(true);
        return;
      }
      qp.hide();
      if (choice.action === 'switch') {
        await this.handleSwitch(target.id, 'codex', false);
      } else if (choice.action === 'switchCliOnly') {
        await this.handleSwitch(target.id, 'codex', true);
      }
    });
    qp.onDidHide(() => {
      closed = true;
      qp.dispose();
    });

    const staleThresholdMs = isTargetActive ? 15_000 : 45_000;
    const needsBgRefresh =
      target.authMode !== 'apikey' &&
      cached?.plan !== 'API_KEY' &&
      (!cached || !cached.updatedAt || Date.now() - cached.updatedAt > staleThresholdMs);
    applySaved(needsBgRefresh);
    qp.show();
    if (needsBgRefresh) {
      runSavedRefresh(false);
    }
  }

  public async refreshQuota(
    providerOverride?: ActiveProviderId
  ): Promise<void> {
    const refreshAgy = !providerOverride || providerOverride === 'antigravity';
    const refreshCodex = !providerOverride || providerOverride === 'codex';
    const scopeLabel =
      refreshAgy && refreshCodex
        ? 'Antigravity and Codex vaults'
        : refreshAgy
          ? 'Antigravity vault'
          : 'Codex vault';

    vscode.window.setStatusBarMessage(
      `$(sync~spin) Refreshing limits across ${scopeLabel}...`,
      2500
    );

    const tasks: Array<Promise<unknown>> = [];
    if (refreshAgy) {
      this.quotaService.invalidate();
      const agyProfiles = this.vault.listProfiles();
      const agyLive = await this.vault.getLiveSessionInfoAsync();
      const agyState = this.vault.getState();
      tasks.push(
        this.quotaService.getQuotaSummary(true),
        this.quotaService.refreshAllInactiveProfiles(
          agyProfiles,
          agyLive.email,
          agyState.activeProfileId,
          this.vault,
          true
        )
      );
    }
    if (refreshCodex) {
      this.codexQuotaService.invalidateCache();
      tasks.push(this.codexQuotaService.refreshAllProfiles(this.codexVault));
    }

    await Promise.allSettled(tasks);

    await this.update();
    vscode.window.setStatusBarMessage(
      `$(check) Limits refreshed across ${scopeLabel}.`,
      3500
    );
  }

  private async resolveActiveIdeProfileId(
    provider: ActiveProviderId,
    profiles: ProfileMetadata[]
  ): Promise<string | null> {
    const state = this.vault.getState?.() || {};
    if (provider === 'codex') {
      if (this.cliCodexProfileId && state.activeCodexProfileId) {
        return state.activeCodexProfileId;
      }
      const live =
        this.codexVault.getLiveSessionInfo?.(true) ??
        this.codexVault.getLiveSessionInfo?.();
      const matched = live ? this.codexVault.findMatchingProfile?.(live) : null;
      if (matched) {
        return matched.id;
      }
      if (live?.email) {
        const byIdentity = profiles.find(
          (p) =>
            p.email?.toLowerCase() === live.email!.toLowerCase() &&
            (!p.accountId || !live.accountId || p.accountId === live.accountId)
        );
        if (byIdentity) {
          return byIdentity.id;
        }
      }
      if (!live?.email && !live?.accountId && live?.hasOAuthCreds && state.activeCodexProfileId) {
        return state.activeCodexProfileId;
      }
      return null;
    }

    if (this.cliAntigravityProfileId && state.activeProfileId) {
      return state.activeProfileId;
    }
    const live = await this.vault.getLiveSessionInfoAsync?.().catch(() => null);
    const cachedSummary = this.quotaService.getCachedSummary?.() || null;
    const liveEmail =
      (live?.email && live.email !== 'Unknown' ? live.email : undefined) ||
      (cachedSummary?.email && cachedSummary.email !== 'Unknown'
        ? cachedSummary.email
        : undefined);
    if (liveEmail) {
      const matched = profiles.find(
        (p) => p.email?.toLowerCase() === liveEmail.toLowerCase()
      );
      if (matched) {
        return matched.id;
      }
    }
    if (live?.hasOAuthCreds && state.activeProfileId) {
      return state.activeProfileId;
    }
    return null;
  }

  public async handleDelete(
    profileId?: string,
    providerOverride?: ActiveProviderId
  ): Promise<void> {
    const provider = providerOverride || this.selectedProvider;
    const providerTitle = provider === 'codex' ? 'Codex' : 'Antigravity';
    const profiles =
      provider === 'codex'
        ? this.codexVault.listProfiles()
        : this.vault.listProfiles();

    if (profiles.length === 0) {
      vscode.window.showInformationMessage('No profiles to delete.');
      return;
    }

    const [activeIdeId, claimedIds] = await Promise.all([
      this.resolveActiveIdeProfileId(provider, profiles),
      Promise.resolve(this.getClaimedProfileIds(provider))
    ]);

    let target: ProfileMetadata | undefined;
    if (profileId) {
      target = profiles.find((p) => p.id === profileId);
    } else {
      const deletable = profiles.filter(
        (p) => p.id !== activeIdeId && !claimedIds.has(p.id)
      );
      if (deletable.length === 0) {
        const claimedProf = profiles.find((p) => claimedIds.has(p.id));
        if (claimedProf && claimedIds.size > 0 && profiles.every((p) => p.id === activeIdeId || claimedIds.has(p.id))) {
          const claim = this.claimedTerminals.get(
            this.claimedTerminalKey(provider, claimedProf.id)
          );
          const choice = await vscode.window.showWarningMessage(
            `No inactive standby ${providerTitle} profile is available to delete right now. Switch accounts or close the claimed CLI terminal first.`,
            { modal: true },
            'Focus Claimed Terminal'
          );
          if (choice === 'Focus Claimed Terminal') {
            claim?.terminal.show?.(false);
          }
          return;
        }
        const activeProf =
          profiles.find((p) => p.id === activeIdeId) || profiles[0];
        const choice = await vscode.window.showWarningMessage(
          `"${activeProf.name}" (${activeProf.email}) is currently active in the IDE. Switch to another account or start + Add Account (Sign Out) to make it inactive before deleting it.`,
          { modal: true },
          '+ Add Account (Sign Out)'
        );
        if (choice === '+ Add Account (Sign Out)') {
          await this.handleAddAccount(provider);
        }
        return;
      }

      const picked = await vscode.window.showQuickPick(
        deletable.map((p) => ({
          label: p.name,
          description: p.email,
          profileId: p.id
        })),
        {
          placeHolder: `Select an inactive ${providerTitle} profile to permanently remove`
        }
      );
      if (!picked) return;
      target = deletable.find((p) => p.id === picked.profileId);
    }

    if (!target) return;

    if (activeIdeId && target.id === activeIdeId) {
      const hasOtherStandby = profiles.some((p) => p.id !== activeIdeId);
      if (hasOtherStandby) {
        await vscode.window.showWarningMessage(
          `Cannot delete "${target.name}" (${target.email}) while it is active in the IDE. Switch to another account first to make it inactive, then delete it.`,
          { modal: true }
        );
      } else {
        const choice = await vscode.window.showWarningMessage(
          `Cannot delete "${target.name}" (${target.email}) while it is active in the IDE. Start + Add Account (Sign Out) first to make it inactive before deleting.`,
          { modal: true },
          '+ Add Account (Sign Out)'
        );
        if (choice === '+ Add Account (Sign Out)') {
          await this.handleAddAccount(provider);
        }
      }
      return;
    }

    if (claimedIds.has(target.id)) {
      const claim = this.claimedTerminals.get(
        this.claimedTerminalKey(provider, target.id)
      );
      const choice = await vscode.window.showWarningMessage(
        `Cannot delete "${target.name}" (${target.email}) while an isolated ${providerTitle} CLI terminal is running on it. Exit/close that CLI terminal first, then delete it.`,
        { modal: true },
        'Focus Claimed Terminal'
      );
      if (choice === 'Focus Claimed Terminal') {
        claim?.terminal.show?.(false);
      }
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Permanently delete ${providerTitle} profile "${target.name}" (${target.email})?\n\nThis will remove its stored credentials from ~/.gemini/charlier/.`,
      { modal: true },
      'Delete Profile'
    );

    if (confirm !== 'Delete Profile') return;

    if (provider === 'codex') {
      this.codexVault.deleteProfile(target.id);
      cleanupProfileCliHome('codex', target.id);
      if (this.vault.getState().activeCodexProfileId === target.id) {
        this.vault.setActiveCodexProfileId(null);
      }
      if (this.cliCodexProfileId === target.id) {
        this.cliCodexProfileId = null;
      }
      const exactKey = `${(target.accountId || '').toLowerCase()}::${(target.email || '').toLowerCase()}`;
      this.promptedCodexIdentities.delete(exactKey);
      if (target.email) {
        const lowerEmail = target.email.toLowerCase();
        for (const k of Array.from(this.promptedCodexIdentities)) {
          if (k.endsWith(`::${lowerEmail}`)) {
            this.promptedCodexIdentities.delete(k);
          }
        }
      }
      this.sessionDismissedPromptKeys.delete(`codex:${exactKey}`);
      this.notifiedReauthKeys.delete(`codex:${target.id}`);
      this.notifiedReauthRecoveryKeys.delete(`codex:${target.id}`);
      this.claimedTerminals.delete(this.claimedTerminalKey('codex', target.id));
      this.persistPromptedUnsavedState();
      this.codexQuotaService.invalidateCache();
    } else {
      this.vault.deleteProfile(target.id);
      cleanupProfileCliHome('antigravity', target.id);
      if (this.cliAntigravityProfileId === target.id) {
        this.cliAntigravityProfileId = null;
      }
      if (target.email) {
        const lowerEmail = target.email.toLowerCase();
        this.promptedEmails.delete(lowerEmail);
        this.sessionDismissedPromptKeys.delete(`antigravity:${lowerEmail}`);
      }
      this.notifiedReauthKeys.delete(`antigravity:${target.id}`);
      this.notifiedReauthRecoveryKeys.delete(`antigravity:${target.id}`);
      this.claimedTerminals.delete(this.claimedTerminalKey('antigravity', target.id));
      this.persistPromptedUnsavedState();
      this.quotaService.invalidate();
    }

    await this.update(true);
    vscode.window.showInformationMessage(`Deleted profile "${target.name}".`);
  }

  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 1) + '…';
  }

  public dispose(): void {
    this.disposed = true;
    this.stopAwaitingLoginWatch();
    this.stopAutoRefreshLoop();
    for (const key of Object.keys(this.activityRefreshTimers) as ActiveProviderId[]) {
      const t = this.activityRefreshTimers[key];
      if (t) clearTimeout(t);
    }
    this.activityRefreshTimers = {};
    if (this.scheduledUpdateTimer) {
      clearTimeout(this.scheduledUpdateTimer);
      this.scheduledUpdateTimer = null;
    }
    if (this.loginFollowUpTimer) {
      clearTimeout(this.loginFollowUpTimer);
      this.loginFollowUpTimer = null;
    }
    if (this.autoSwitchDebounceTimer) {
      clearTimeout(this.autoSwitchDebounceTimer);
      this.autoSwitchDebounceTimer = null;
    }
    this.claimedTerminals.clear();
    this.statusBarItem.dispose();
  }
}
