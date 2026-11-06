import * as vscode from 'vscode';
import { Vault } from './vault';
import { getProfilesDir } from './constants';
import { QuotaService } from './quota';
import { ProfileMetadata, QuotaSummary, CachedQuotaMetric } from './types';

interface CharlierQuickPickItem extends vscode.QuickPickItem {
  actionType:
    | 'switch'
    | 'save'
    | 'add'
    | 'delete'
    | 'open'
    | 'reload'
    | 'quota'
    | 'refreshAll'
    | 'restartExtensionHost';
  profileId?: string;
  isCurrentActive?: boolean;
}

export class UIController {
  private statusBarItem: vscode.StatusBarItem;
  private vault: Vault;
  private quotaService: QuotaService;
  private promptedEmails = new Set<string>();
  private updateSeq = 0;
  private isAddingAccount = false;
  private suppressUnsavedPromptUntil = 0;

  constructor(vault: Vault, quotaService: QuotaService) {
    this.vault = vault;
    this.quotaService = quotaService;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'charlier.switchProfile';
    this.update();
    this.statusBarItem.show();
  }

  public async update(): Promise<void> {
    const seq = ++this.updateSeq;
    const live = await this.vault.getLiveSessionInfoAsync();
    const state = this.vault.getState();
    const profiles = this.vault.listProfiles();

    let activeProfile: ProfileMetadata | null = null;

    if (live.email) {
      activeProfile =
        profiles.find((p) => p.email.toLowerCase() === live.email!.toLowerCase()) ||
        null;
    } else if (state.activeProfileId) {
      activeProfile = profiles.find((p) => p.id === state.activeProfileId) || null;
    }

    if (activeProfile && state.activeProfileId !== activeProfile.id) {
      this.vault.saveState({
        activeProfileId: activeProfile.id,
        lastUpdated: Date.now()
      });
    }

    const cachedQuota = this.quotaService.getCachedSummary();
    const effectiveActiveEmail = activeProfile?.email || live.email;
    const quotaMatchesSession = Boolean(
      cachedQuota &&
        cachedQuota.email &&
        effectiveActiveEmail &&
        cachedQuota.email.toLowerCase() === effectiveActiveEmail.toLowerCase()
    );
    const validLiveQuota = quotaMatchesSession ? cachedQuota : null;

    if (activeProfile) {
      this.statusBarItem.text = `$(layers) Charlier: ${activeProfile.name}`;
      this.statusBarItem.tooltip = this.quotaService.buildAccountsHoverTooltip(
        profiles,
        activeProfile.id,
        live.email || activeProfile.email,
        validLiveQuota
      );
    } else if (live.email) {
      const shortHandle = this.truncate(live.email.split('@')[0], 14);
      this.statusBarItem.text = `$(sparkle) Charlier: ${shortHandle} · Unsaved`;
      this.statusBarItem.tooltip = this.quotaService.buildAccountsHoverTooltip(
        profiles,
        null,
        live.email,
        validLiveQuota
      );
    } else {
      this.statusBarItem.text = `$(account) Charlier: Ready for login`;
      this.statusBarItem.tooltip = this.quotaService.buildAccountsHoverTooltip(
        profiles,
        null,
        null,
        null
      );
    }

    // Background refresh for inactive profiles (respects 45s per-profile cooldown)
    if (profiles.length > 0) {
      this.quotaService
        .refreshAllInactiveProfiles(
          profiles,
          effectiveActiveEmail,
          activeProfile?.id || null,
          this.vault,
          false
        )
        .then(() => {
          if (seq === this.updateSeq) {
            const latestProfiles = this.vault.listProfiles();
            const latestSummary = this.quotaService.getCachedSummary();
            const latestMatches = Boolean(
              latestSummary &&
                latestSummary.email &&
                effectiveActiveEmail &&
                latestSummary.email.toLowerCase() === effectiveActiveEmail.toLowerCase()
            );
            this.statusBarItem.tooltip = this.quotaService.buildAccountsHoverTooltip(
              latestProfiles,
              activeProfile ? activeProfile.id : null,
              live.email || activeProfile?.email || null,
              latestMatches ? latestSummary : null
            );
          }
        })
        .catch(() => {});
    }

    // Query live daemon quota asynchronously for the active session
    if ((activeProfile || live.email) && !live.isExpired) {
      try {
        const quota = await this.quotaService.getQuotaSummary();
        if (seq === this.updateSeq && quota) {
          const emailMatches = Boolean(
            quota.email &&
              effectiveActiveEmail &&
              quota.email.toLowerCase() === effectiveActiveEmail.toLowerCase()
          );

          if (emailMatches && activeProfile) {
            const metrics = this.quotaService.parseMetrics(
              quota,
              activeProfile.planOverride
            );
            this.vault.updateProfileCachedQuota(activeProfile.id, metrics);
          }

          const refreshedProfiles = this.vault.listProfiles();
          this.statusBarItem.tooltip = this.quotaService.buildAccountsHoverTooltip(
            refreshedProfiles,
            activeProfile ? activeProfile.id : null,
            live.email || activeProfile?.email || null,
            emailMatches ? quota : null
          );
        }
      } catch {
        // Fallback maintained
      }
    }
  }

  public async checkForNewUnsavedAccount(): Promise<void> {
    if (this.isAddingAccount || Date.now() < this.suppressUnsavedPromptUntil) {
      return;
    }

    const live = await this.vault.getLiveSessionInfoAsync();
    if (!live.email) return;

    const emailLower = live.email.toLowerCase();
    if (this.promptedEmails.has(emailLower)) return;

    const profiles = this.vault.listProfiles();
    const isSaved = profiles.some((p) => p.email.toLowerCase() === emailLower);

    if (!isSaved) {
      this.promptedEmails.add(emailLower);
      const choice = await vscode.window.showInformationMessage(
        `New Antigravity account online (${live.email}). Save it as a profile in your vault?`,
        'Save Profile',
        'Later'
      );

      if (choice === 'Save Profile') {
        await this.handleSaveCurrent();
      }
    }
  }

  public async showQuickPickMenu(): Promise<void> {
    const live = await this.vault.getLiveSessionInfoAsync();
    const state = this.vault.getState();
    let profiles = this.vault.listProfiles();

    const liveQuota: QuotaSummary | null = this.quotaService.getCachedSummary();
    const liveMetrics = this.quotaService.parseMetrics(liveQuota);

    const graphBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('graph'),
      tooltip: 'View or refresh quota details'
    };

    const editBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('edit'),
      tooltip: 'Rename profile'
    };

    const quickPick = vscode.window.createQuickPick<CharlierQuickPickItem>();
    quickPick.placeholder =
      'Select an Antigravity account profile or management action';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    let isDisposed = false;
    quickPick.onDidHide(() => {
      isDisposed = true;
      quickPick.dispose();
    });

    const buildItems = (
      currentProfiles: ProfileMetadata[],
      metrics: CachedQuotaMetric
    ): CharlierQuickPickItem[] => {
      const result: CharlierQuickPickItem[] = [];

      const isSavedLive = Boolean(
        live.email &&
          currentProfiles.some(
            (p) => p.email.toLowerCase() === live.email!.toLowerCase()
          )
      );
      const isUnsavedActive = Boolean(live.email && !isSavedLive);

      // 0. If active account is not saved in vault, pin a prominent Save card at the very top
      if (isUnsavedActive && live.email) {
        const handle = live.email.split('@')[0];
        const unsavedPlan =
          metrics.plan && metrics.plan !== '--' ? metrics.plan : 'FREE';
        result.push({
          label: `Save active account: ${handle}`,
          iconPath: new vscode.ThemeIcon(
            'sparkle',
            new vscode.ThemeColor('charts.yellow')
          ),
          description: `${live.email}  ·  [Active · Not Saved]`,
          detail: `New session online · ${unsavedPlan} Plan · Click to save this account to your vault`,
          actionType: 'save'
        });
      }

      // 1. Saved Profiles Section (Active pinned at top)
      if (currentProfiles.length > 0) {
        const sortedProfiles = [...currentProfiles].sort((a, b) => {
          const aActive =
            (live.email && a.email.toLowerCase() === live.email.toLowerCase()) ||
            (!live.email && state.activeProfileId === a.id);
          const bActive =
            (live.email && b.email.toLowerCase() === live.email.toLowerCase()) ||
            (!live.email && state.activeProfileId === b.id);
          if (aActive && !bActive) return -1;
          if (!aActive && bActive) return 1;
          return (b.updatedAt || 0) - (a.updatedAt || 0);
        });

        for (const profile of sortedProfiles) {
          const isActive =
            (live.email &&
              profile.email.toLowerCase() === live.email.toLowerCase()) ||
            (!live.email && state.activeProfileId === profile.id);

          const planName =
            profile.planOverride ||
            (isActive
              ? metrics.plan !== '--'
                ? metrics.plan
                : profile.cachedQuota?.plan || 'FREE'
              : profile.cachedQuota?.plan || 'FREE');

          const buttons: vscode.QuickInputButton[] = [graphBtn, editBtn];

          let icon: vscode.ThemeIcon;
          let description: string;
          let detailText: string;

          if (isActive) {
            icon = new vscode.ThemeIcon(
              'check',
              new vscode.ThemeColor('charts.green')
            );
            description = `${profile.email}  ·  [Active]`;
            detailText = `Active Session · Antigravity Connected · ${planName} Plan`;
          } else {
            icon = new vscode.ThemeIcon(
              'arrow-swap',
              new vscode.ThemeColor('textLink.foreground')
            );
            description = profile.email;
            const cq = profile.cachedQuota;
            if (cq && cq.gemini && cq.gemini !== '--') {
              const snapAge = cq.updatedAt
                ? this.quotaService.formatTimeAgo(cq.updatedAt)
                : '';
              const claudePart =
                cq.claudeGpt && cq.claudeGpt !== '--' && planName !== 'FREE'
                  ? ` · Claude ${cq.claudeGpt}`
                  : '';
              detailText = `Switch to this account · ${planName} Plan · Gemini ${cq.gemini}${claudePart}${
                snapAge ? ` (snapped ${snapAge})` : ''
              }`;
            } else {
              detailText = `Switch to this account · ${planName} Plan`;
            }
          }

          result.push({
            label: profile.name,
            iconPath: icon,
            description,
            detail: detailText,
            actionType: 'switch',
            profileId: profile.id,
            isCurrentActive: isActive,
            buttons
          });
        }
      }

      // 2. Actions Section
      result.push({
        label: 'Actions',
        kind: vscode.QuickPickItemKind.Separator,
        actionType: 'save'
      });

      result.push({
        label: 'Add new account',
        description:
          'Auto-backup current session and sign in with another Google account',
        iconPath: new vscode.ThemeIcon('add'),
        actionType: 'add'
      });

      result.push({
        label: 'Save session as profile',
        description: live.email
          ? `Snapshot "${live.email}"`
          : 'Snapshot current credentials',
        iconPath: new vscode.ThemeIcon('save'),
        actionType: 'save'
      });

      result.push({
        label: 'Refresh all limits',
        description:
          'Update quotas for active session and dormant vault profiles',
        iconPath: new vscode.ThemeIcon('refresh'),
        actionType: 'refreshAll'
      });

      if (currentProfiles.length > 0) {
        result.push({
          label: 'Delete profile',
          description: 'Remove saved profile from vault',
          iconPath: new vscode.ThemeIcon('trash'),
          actionType: 'delete'
        });
      }

      result.push({
        label: 'Open vault folder',
        description: 'Reveal ~/.gemini/charlier/',
        iconPath: new vscode.ThemeIcon('folder'),
        actionType: 'open'
      });

      result.push({
        label: 'Restart extension host',
        description:
          'Soft reload Antigravity & extensions without closing tabs',
        iconPath: new vscode.ThemeIcon('debug-restart'),
        actionType: 'restartExtensionHost'
      });

      result.push({
        label: 'Reload window',
        description: 'Restart language server and full VS Code window',
        iconPath: new vscode.ThemeIcon('sync'),
        actionType: 'reload'
      });

      return result;
    };

    quickPick.items = buildItems(profiles, liveMetrics);

    // Refresh active daemon and inactive profiles non-blockingly in background
    this.quotaService.getQuotaSummary().then((fresh) => {
      if (!isDisposed && fresh) {
        const freshMetrics = this.quotaService.parseMetrics(fresh);
        profiles = this.vault.listProfiles();
        quickPick.items = buildItems(profiles, freshMetrics);
      }
    });

    this.quotaService
      .refreshAllInactiveProfiles(
        profiles,
        live.email,
        state.activeProfileId,
        this.vault,
        false
      )
      .then(() => {
        if (!isDisposed) {
          profiles = this.vault.listProfiles();
          const latestQ = this.quotaService.getCachedSummary();
          const latestM = this.quotaService.parseMetrics(latestQ);
          quickPick.items = buildItems(profiles, latestM);
        }
      })
      .catch(() => {});

    quickPick.onDidTriggerItemButton(async (e) => {
      quickPick.hide();
      if (!e.item.profileId) return;

      if (e.button === graphBtn) {
        await this.showQuotaDetails(e.item.profileId);
      } else if (e.button === editBtn) {
        await this.handleRename(e.item.profileId);
      }
    });

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      quickPick.hide();
      if (!selected) return;

      switch (selected.actionType) {
        case 'switch':
          if (selected.profileId) {
            if (selected.isCurrentActive) {
              await this.showActiveProfileSubmenu(selected.profileId);
            } else {
              await this.handleSwitch(selected.profileId);
            }
          }
          break;
        case 'save':
          await this.handleSaveCurrent();
          break;
        case 'add':
          await this.handleAddAccount();
          break;
        case 'refreshAll':
          await this.refreshQuota();
          break;
        case 'delete':
          await this.handleDelete();
          break;
        case 'open':
          await vscode.commands.executeCommand(
            'revealFileInOS',
            vscode.Uri.file(getProfilesDir())
          );
          break;
        case 'restartExtensionHost':
          await vscode.commands.executeCommand(
            'workbench.action.restartExtensionHost'
          );
          break;
        case 'reload':
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          break;
      }
    });

    quickPick.show();
  }

  private async showActiveProfileSubmenu(profileId: string): Promise<void> {
    const profile = this.vault.getProfile(profileId);
    if (!profile) return;

    vscode.window.setStatusBarMessage(
      `$(check) "${profile.name}" is already the active profile.`,
      3000
    );

    const choice = await vscode.window.showQuickPick(
      [
        {
          label: 'View quota details',
          description:
            'Detailed 5-hour and weekly limits across all model pools',
          iconPath: new vscode.ThemeIcon('graph'),
          action: 'quota'
        },
        {
          label: 'Rename profile',
          description: `Change label for "${profile.name}"`,
          iconPath: new vscode.ThemeIcon('edit'),
          action: 'rename'
        },
        {
          label: 'Refresh all limits',
          description:
            'Query live daemon and refresh background vault snapshots',
          iconPath: new vscode.ThemeIcon('refresh'),
          action: 'refresh'
        }
      ],
      {
        placeHolder: `Profile: ${profile.name} (${profile.email}) is already active`
      }
    );

    if (!choice) return;

    if (choice.action === 'quota') {
      await this.showQuotaDetails(profileId);
    } else if (choice.action === 'rename') {
      await this.handleRename(profileId);
    } else if (choice.action === 'refresh') {
      await this.refreshQuota();
    }
  }

  public async handleSwitch(profileId: string): Promise<void> {
    const state = this.vault.getState();
    const live = await this.vault.getLiveSessionInfoAsync();
    const target = this.vault.getProfile(profileId);

    const isAlreadyActive =
      (live.email &&
        target &&
        live.email.toLowerCase() === target.email.toLowerCase()) ||
      (!live.email && state.activeProfileId === profileId);

    if (isAlreadyActive) {
      vscode.window.setStatusBarMessage(
        `$(check) "${target?.name || profileId}" is already active.`,
        3000
      );
      return;
    }

    try {
      this.suppressUnsavedPromptUntil = Date.now() + 4000;
      const meta = await this.vault.switchProfile(profileId);
      this.quotaService.invalidate();

      const config = vscode.workspace.getConfiguration('charlier');
      const autoRestart = config.get<boolean>('autoRestartExtensionHost', true);

      if (autoRestart) {
        vscode.window.setStatusBarMessage(
          `$(check) Switched to profile "${meta.name}" · Restarting Antigravity...`,
          3000
        );
        await vscode.commands.executeCommand(
          'workbench.action.restartExtensionHost'
        );
        return;
      }

      await this.update();
      vscode.window.setStatusBarMessage(
        `$(check) Switched to profile "${meta.name}"`,
        4000
      );
      vscode.window
        .showInformationMessage(
          `Switched to Antigravity profile "${meta.name}".`,
          'Restart Extension Host'
        )
        .then((choice) => {
          if (choice === 'Restart Extension Host') {
            vscode.commands.executeCommand(
              'workbench.action.restartExtensionHost'
            );
          }
        });
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Failed to switch profile: ${err.message}`
      );
    }
  }

  public async handleRename(profileId: string): Promise<void> {
    const profile = this.vault.getProfile(profileId);
    if (!profile) return;

    const newName = await vscode.window.showInputBox({
      title: 'Rename Profile',
      prompt: `Enter new name for profile "${profile.name}"`,
      value: profile.name,
      validateInput: (v) => (!v || !v.trim() ? 'Name cannot be empty.' : null)
    });

    if (!newName || newName.trim() === profile.name) return;

    try {
      this.vault.renameProfile(profileId, newName.trim());
      await this.update();
      vscode.window.setStatusBarMessage(
        `$(check) Renamed profile to "${newName.trim()}"`,
        3000
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Failed to rename profile: ${err.message}`
      );
    }
  }

  public async handleSaveCurrent(): Promise<void> {
    const live = await this.vault.getLiveSessionInfoAsync();
    const defaultName = live.email
      ? live.email.includes('@')
        ? live.email.split('@')[0]
        : live.email
      : 'Profile';

    const name = await vscode.window.showInputBox({
      title: 'Save Profile',
      prompt: live.email
        ? `Save active account (${live.email}) to your Charlier vault`
        : 'Enter a profile name',
      value: defaultName,
      validateInput: (value) =>
        !value || !value.trim() ? 'Name cannot be empty.' : null
    });

    if (!name) return;

    try {
      const meta = await this.vault.saveCurrentAsProfileAsync(name.trim());
      if (meta.email && meta.email !== 'Unknown') {
        this.promptedEmails.add(meta.email.toLowerCase());
      }
      this.quotaService.invalidate();
      await this.update();
      vscode.window.setStatusBarMessage(
        `$(check) Saved profile "${meta.name}" (${meta.email})`,
        4000
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to save profile: ${err.message}`);
    }
  }

  public async handleAddAccount(): Promise<void> {
    if (this.isAddingAccount) return;
    this.isAddingAccount = true;
    this.suppressUnsavedPromptUntil = Date.now() + 6000;

    try {
      vscode.window.setStatusBarMessage(
        '$(sync~spin) Backing up current session and preparing new login...',
        2500
      );

      const { backedUpProfile, wasExisting } =
        await this.vault.prepareNewLoginAsync();
      this.quotaService.invalidate();
      await this.update();

      // Fire signOut and panel focus concurrently without blocking if unavailable
      Promise.allSettled([
        vscode.commands.executeCommand('antigravity.signOut'),
        vscode.commands.executeCommand('antigravity.panel.focus')
      ]).catch(() => {});

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

  public async showQuotaDetails(profileId?: string): Promise<void> {
    const profiles = this.vault.listProfiles();
    const live = await this.vault.getLiveSessionInfoAsync();
    const state = this.vault.getState();
    const target = profileId
      ? profiles.find((p) => p.id === profileId) || null
      : null;

    const isTargetActive = target
      ? Boolean(
          (live.email &&
            target.email.toLowerCase() === live.email.toLowerCase()) ||
            (!live.email && state.activeProfileId === target.id)
        )
      : true;

    if (!isTargetActive && target) {
      // Trigger a fresh background snapshot if never fetched or older than 45s
      let cached = target.cachedQuota;
      if (!cached || !cached.updatedAt || Date.now() - cached.updatedAt > 45000) {
        vscode.window.setStatusBarMessage(
          `$(sync~spin) Fetching latest usage for "${target.name}"...`,
          2000
        );
        const refreshed = await this.quotaService.refreshInactiveProfile(
          target,
          this.vault,
          false
        );
        if (refreshed) {
          cached = refreshed;
          await this.update();
        }
      }

      const planLabel = target.planOverride || cached?.plan || 'FREE';
      const timeAgo = cached?.updatedAt
        ? this.quotaService.formatTimeAgo(cached.updatedAt)
        : 'not yet recorded';
      const items: Array<vscode.QuickPickItem & { action?: string }> = [];

      items.push({
        label: `Quota Snapshot · ${target.name} (${planLabel} Plan · snapped ${timeAgo})`,
        kind: vscode.QuickPickItemKind.Separator
      });

      if (cached && (cached.gemini !== '--' || cached.claudeGpt !== '--')) {
        const gPct = parseInt(cached.gemini, 10);
        const gFrac = Number.isFinite(gPct) ? gPct / 100 : 0;
        const gMeter = this.quotaService.renderLinenMeter(gFrac, 8);
        const gReset = cached.geminiReset
          ? this.quotaService.formatResetCompact(cached.geminiReset)
          : '';

        items.push({
          label: `  Gemini Models (Flash, Pro)   ${gMeter}  ${cached.gemini}`,
          description: `${
            gReset && gPct < 100 ? `Resets in ${gReset} · ` : ''
          }Snapped ${timeAgo}`,
          detail: 'First-party Gemini pool capacity'
        });

        if (
          planLabel !== 'FREE' &&
          cached.claudeGpt &&
          cached.claudeGpt !== '--'
        ) {
          const cPct = parseInt(cached.claudeGpt, 10);
          const cFrac = Number.isFinite(cPct) ? cPct / 100 : 0;
          const cMeter = this.quotaService.renderLinenMeter(cFrac, 8);
          const cReset = cached.claudeReset
            ? this.quotaService.formatResetCompact(cached.claudeReset)
            : '';

          items.push({
            label: `  Claude & GPT Models          ${cMeter}  ${cached.claudeGpt}`,
            description: `${
              cReset && cPct < 100 ? `Resets in ${cReset} · ` : ''
            }Snapped ${timeAgo}`,
            detail: 'Weekly reserve for Claude Opus, Sonnet, and GPT-OSS'
          });
        }

        if (planLabel === 'PRO' && cached.argon && cached.argon !== '--') {
          const aPct = parseInt(cached.argon, 10);
          const aFrac = Number.isFinite(aPct) ? aPct / 100 : 0;
          const aMeter = this.quotaService.renderLinenMeter(aFrac, 8);
          const aReset = cached.argonReset
            ? this.quotaService.formatResetCompact(cached.argonReset)
            : '';

          items.push({
            label: `  Gemini 4 Argon               ${aMeter}  ${cached.argon}`,
            description: `${
              aReset && aPct < 100 ? `Resets in ${aReset} · ` : ''
            }Last active daemon snapshot`,
            detail: 'Pro weekly allowance for Gemini 4 Argon'
          });
        }
      } else {
        items.push({
          label: `  No usage snapshot recorded for "${target.name}"`,
          description: 'Click Refresh below to pull live usage from Google',
          detail:
            'Refreshes directly in the background without interrupting your active session'
        });
      }

      items.push({
        label: 'Actions',
        kind: vscode.QuickPickItemKind.Separator
      });

      items.push({
        label: `$(refresh) Refresh "${target.name}" usage now`,
        description:
          'Pulls live Gemini & Claude limits without switching your active session',
        action: 'refreshInactive'
      });

      items.push({
        label: `$(arrow-swap) Switch to "${target.name}"`,
        description: `Activate ${target.email}`,
        action: 'switch'
      });

      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: `Quota Snapshot · ${target.name} (${target.email}) · Snapped ${timeAgo}`
      });

      if (choice?.action === 'refreshInactive') {
        vscode.window.setStatusBarMessage(
          `$(sync~spin) Refreshing "${target.name}" usage...`,
          2500
        );
        await this.quotaService.refreshInactiveProfile(target, this.vault, true);
        await this.update();
        vscode.window.setStatusBarMessage(
          `$(check) Updated usage snapshot for "${target.name}".`,
          3000
        );
        await this.showQuotaDetails(target.id);
      } else if (choice?.action === 'switch') {
        await this.handleSwitch(target.id);
      }
      return;
    }

    const quota = await this.quotaService.getQuotaSummary(true);
    if (!quota || quota.groups.length === 0) {
      vscode.window.showInformationMessage(
        'No active quota reported by daemon.'
      );
      return;
    }

    const items: vscode.QuickPickItem[] = [];

    items.push({
      label: `Antigravity Quota Dashboard · ${quota.tier}`,
      kind: vscode.QuickPickItemKind.Separator
    });

    for (const group of quota.groups) {
      const isArgon = group.displayName.toLowerCase().includes('argon');
      const isClaudeGpt =
        group.displayName.toLowerCase().includes('claude') ||
        group.displayName.toLowerCase().includes('gpt');

      if (quota.planTier === 'FREE' && (isArgon || isClaudeGpt)) {
        continue;
      }

      let groupHeader = group.displayName.toUpperCase();
      if (isArgon) {
        groupHeader = 'GEMINI 4 ARGON · Pro Weekly Allowance';
      } else if (isClaudeGpt) {
        groupHeader = 'CLAUDE & GPT MODELS · Opus, Sonnet, GPT-OSS';
      } else {
        groupHeader =
          quota.planTier === 'ULTRA'
            ? 'GEMINI MODELS · Argon Included'
            : 'GEMINI MODELS · Flash & Pro';
      }

      items.push({
        label: groupHeader,
        kind: vscode.QuickPickItemKind.Separator
      });

      for (const bucket of group.buckets) {
        const is5h = bucket.window === '5h';
        const windowTitle = is5h
          ? '5-Hour Fast Pool    '
          : '7-Day Rolling Pool  ';
        const fraction = bucket.disabled ? 0 : bucket.remainingFraction ?? 0;
        const pct = Math.round(fraction * 100);
        const meter = this.quotaService.renderLinenMeter(fraction, 8);
        const resetStr = this.quotaService.formatResetCompact(bucket.resetTime);

        let statusPill = '';
        if (bucket.disabled) {
          statusPill = 'Inactive (weekly reserve applied)';
        } else if (pct === 0) {
          statusPill = resetStr
            ? `Depleted · Resets in ${resetStr}`
            : 'Depleted';
        } else if (pct === 100) {
          statusPill = '100% Full Capacity';
        } else {
          statusPill = resetStr ? `Active · Resets in ${resetStr}` : 'Active';
        }

        let scopeDetail = '';
        if (isArgon) {
          scopeDetail =
            'Dedicated allocation for Gemini 4 Argon reasoning models';
        } else if (isClaudeGpt) {
          scopeDetail = is5h
            ? 'Short-term burst limit for Claude and GPT models'
            : 'Weekly capacity reserve for Claude Opus, Claude Sonnet, and GPT-OSS';
        } else {
          scopeDetail = is5h
            ? 'Rolling 5-hour demand-smoothing pool for Gemini Flash & Pro'
            : 'Weekly baseline capacity pool for Gemini Flash & Pro';
        }

        items.push({
          label: `  ${windowTitle}  ${meter}  ${pct}%`,
          description: statusPill,
          detail: scopeDetail
        });
      }
    }

    await vscode.window.showQuickPick(items, {
      placeHolder: `Antigravity Quota · ${quota.tier} · Live from Daemon`,
      canPickMany: false
    });
  }

  public async refreshQuota(): Promise<void> {
    vscode.window.setStatusBarMessage(
      '$(sync~spin) Refreshing limits for active session and vault profiles...',
      2500
    );
    this.quotaService.invalidate();
    const profiles = this.vault.listProfiles();
    const live = await this.vault.getLiveSessionInfoAsync();
    const state = this.vault.getState();

    await Promise.allSettled([
      this.quotaService.getQuotaSummary(true),
      this.quotaService.refreshAllInactiveProfiles(
        profiles,
        live.email,
        state.activeProfileId,
        this.vault,
        true
      )
    ]);

    await this.update();
    vscode.window.setStatusBarMessage(
      '$(check) Limits refreshed across active session and vault profiles.',
      3500
    );
  }

  public async handleDelete(): Promise<void> {
    const profiles = this.vault.listProfiles();
    if (profiles.length === 0) {
      vscode.window.showInformationMessage('No profiles to delete.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      profiles.map((p) => ({
        label: p.name,
        description: p.email,
        profileId: p.id
      })),
      { placeHolder: 'Select a profile to permanently remove' }
    );

    if (!picked) return;

    const confirm = await vscode.window.showWarningMessage(
      `Permanently delete profile "${picked.label}" (${picked.description})?\n\nThis will remove its stored credentials from ~/.gemini/charlier/.`,
      { modal: true },
      'Delete Profile'
    );

    if (confirm !== 'Delete Profile') return;

    this.vault.deleteProfile(picked.profileId);
    this.quotaService.invalidate();
    await this.update();
    vscode.window.showInformationMessage(`Deleted profile "${picked.label}".`);
  }

  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 1) + '…';
  }

  public dispose(): void {
    this.statusBarItem.dispose();
  }
}
