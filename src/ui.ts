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

          const effectiveCq = isActive && metrics.gemini !== '--' ? metrics : profile.cachedQuota;
          const icon = isActive
            ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
            : new vscode.ThemeIcon('arrow-swap', new vscode.ThemeColor('textLink.foreground'));

          const description = isActive
            ? `${profile.email}  ·  ${planName}  ·  Active`
            : `${profile.email}  ·  ${planName}`;

          const detailText = this.formatProfileDetailLine(
            effectiveCq,
            planName,
            Boolean(isActive)
          );

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
        if (live.email && fresh.email && live.email.toLowerCase() === fresh.email.toLowerCase()) {
          const activeProf = profiles.find(
            (p) => p.email.toLowerCase() === live.email!.toLowerCase()
          );
          if (activeProf) {
            this.vault.updateProfileCachedQuota(activeProf.id, freshMetrics);
          }
        }
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
    const profiles = this.vault.listProfiles();
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

      // Auto-snapshot the outgoing active profile's live credentials and dual-window quota
      const currentActive = live.email
        ? profiles.find((p) => p.email.toLowerCase() === live.email!.toLowerCase()) || null
        : state.activeProfileId
          ? profiles.find((p) => p.id === state.activeProfileId) || null
          : null;

      if (currentActive && currentActive.id !== profileId) {
        try {
          const liveSummary = this.quotaService.getCachedSummary();
          if (
            liveSummary &&
            liveSummary.email &&
            currentActive.email &&
            liveSummary.email.toLowerCase() === currentActive.email.toLowerCase()
          ) {
            const metrics = this.quotaService.parseMetrics(
              liveSummary,
              currentActive.planOverride
            );
            this.vault.updateProfileCachedQuota(currentActive.id, metrics);
          }
          await this.vault.updateProfileCredentialsAsync(currentActive.id);
        } catch {
          // Non-fatal: proceed with switch even if outgoing snapshot fails
        }
      }

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

    if (planName === 'PRO') {
      if (cq.argon && cq.argon !== '--' && cq.argon !== 'incl.') {
        const aPct = parseInt(cq.argon, 10);
        const aReset = cq.argonReset
          ? this.quotaService.formatResetCompact(cq.argonReset)
          : '';
        if (aPct === 0) {
          parts.push(`Argon 0% (${aReset ? aReset : 'Depleted'})`);
        } else {
          const aSuffix =
            aReset && Number.isFinite(aPct) && aPct < 100 ? ` (${aReset})` : '';
          parts.push(`Argon ${cq.argon}${aSuffix}`);
        }
      } else {
        parts.push('Argon Pro');
      }
    } else if (planName === 'ULTRA') {
      parts.push('Argon Included');
    }

    if (!isActive && cq.updatedAt) {
      parts.push(this.quotaService.formatTimeAgo(cq.updatedAt));
    }

    return parts.join('  ·  ');
  }

  private buildPoolRow(
    icon: string,
    poolLabel: string,
    pctStr: string | undefined,
    resetIso: string | undefined,
    modelScope: string,
    fallbackNote?: string
  ): vscode.QuickPickItem {
    const pct = parseInt(pctStr || '', 10);
    if (Number.isFinite(pct)) {
      const frac = Math.max(0, Math.min(1, pct / 100));
      const meter = this.quotaService.renderLinenMeter(frac, 8);
      const resetStr = resetIso
        ? this.quotaService.formatResetCompact(resetIso)
        : '';
      const paddedPct = `${pct}%`.padStart(4, ' ');

      let statusText: string;
      if (pct === 0) {
        statusText = resetStr
          ? `Depleted · Resets in ${resetStr}`
          : 'Depleted for weekly window';
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

    const badge = pctStr === 'incl.' ? 'INCL' : 'PRO';
    return {
      label: `  $(${icon}) ${poolLabel.padEnd(18, ' ')} ▒▒▒▒▒▒▒▒  ${badge.padStart(4, ' ')}`,
      description: fallbackNote || `Included in ${modelScope}`
    };
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
        : 'not yet synced';
      const items: Array<vscode.QuickPickItem & { action?: string }> = [];

      if (cached && (cached.gemini !== '--' || cached.claudeGpt !== '--')) {
        const g5h = cached.gemini5h || cached.gemini || '--';
        const g5hReset = cached.gemini5hReset || cached.geminiReset;
        const g7d = cached.gemini7d || cached.gemini || '--';
        const g7dReset = cached.gemini7dReset;

        items.push({
          label: 'GEMINI',
          kind: vscode.QuickPickItemKind.Separator
        });
        items.push(
          this.buildPoolRow(
            'pulse',
            '5-Hour Fast Pool',
            g5h,
            g5hReset,
            'Flash & Pro'
          )
        );
        items.push(
          this.buildPoolRow(
            'calendar',
            '7-Day Weekly Pool',
            g7d,
            g7dReset,
            'Flash & Pro'
          )
        );

        if (planLabel !== 'FREE') {
          const c5h = cached.claude5h || cached.claudeGpt || '--';
          const c5hReset = cached.claude5hReset;
          const c7d = cached.claude7d || cached.claudeGpt || '--';
          const c7dReset = cached.claude7dReset || cached.claudeReset;

          items.push({
            label: 'CLAUDE & GPT',
            kind: vscode.QuickPickItemKind.Separator
          });
          items.push(
            this.buildPoolRow(
              'pulse',
              '5-Hour Fast Pool',
              c5h,
              c5hReset,
              'Opus, Sonnet, GPT-OSS'
            )
          );
          items.push(
            this.buildPoolRow(
              'calendar',
              '7-Day Weekly Pool',
              c7d,
              c7dReset,
              'Opus, Sonnet, GPT-OSS'
            )
          );
        }

        if (planLabel === 'PRO') {
          items.push({
            label: 'GEMINI 4 ARGON',
            kind: vscode.QuickPickItemKind.Separator
          });
          items.push(
            this.buildPoolRow(
              'flame',
              '7-Day Weekly Pool',
              cached.argon,
              cached.argonReset,
              'Pro weekly allowance',
              'Included in Pro · Switch once to sync weekly meter'
            )
          );
        } else if (planLabel === 'ULTRA') {
          items.push({
            label: 'GEMINI 4 ARGON',
            kind: vscode.QuickPickItemKind.Separator
          });
          items.push(
            this.buildPoolRow(
              'sparkle',
              'Unified Ultra Pool',
              '100%',
              undefined,
              'Bundled with Gemini 5h & 7d pools'
            )
          );
        }
      } else {
        items.push({
          label: `  $(info) No usage snapshot recorded for "${target.name}"`,
          description: 'Select Refresh below to pull live usage from Google'
        });
      }

      items.push({
        label: 'ACTIONS',
        kind: vscode.QuickPickItemKind.Separator
      });

      items.push({
        label: `  $(sync) Refresh "${target.name}" usage now`,
        description:
          'Pull live 5h & weekly limits in background without switching',
        action: 'refreshInactive'
      });

      items.push({
        label: `  $(arrow-swap) Switch to "${target.name}"`,
        description: `Activate ${target.email}`,
        action: 'switch'
      });

      const choice = await vscode.window.showQuickPick(items, {
        title: `Charlier · ${target.name} (${planLabel} Plan)`,
        placeHolder: `${target.email}  ·  Updated ${timeAgo}  ·  Select an action or press Esc`
      });

      if (choice?.action === 'refreshInactive') {
        vscode.window.setStatusBarMessage(
          `$(sync~spin) Refreshing "${target.name}" usage...`,
          2500
        );
        const updated = await this.quotaService.refreshInactiveProfile(
          target,
          this.vault,
          true
        );
        await this.update();
        if (updated) {
          vscode.window.setStatusBarMessage(
            `$(check) Updated usage snapshot for "${target.name}".`,
            3000
          );
        } else {
          vscode.window.showWarningMessage(
            `Could not refresh "${target.name}" right now. Showing last saved snapshot.`
          );
        }
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

    const activeProf =
      target ||
      (live.email
        ? profiles.find(
            (p) => p.email.toLowerCase() === live.email!.toLowerCase()
          ) || null
        : null);

    if (activeProf && quota.email && activeProf.email.toLowerCase() === quota.email.toLowerCase()) {
      const parsed = this.quotaService.parseMetrics(quota, activeProf.planOverride);
      this.vault.updateProfileCachedQuota(activeProf.id, parsed);
    }

    const planTier = activeProf?.planOverride || quota.planTier;
    const activeTitleName = activeProf?.name || (live.email ? live.email.split('@')[0] : 'Active Session');
    const activeEmail = activeProf?.email || live.email || quota.email || '';

    const items: Array<vscode.QuickPickItem & { action?: string }> = [];

    for (const group of quota.groups) {
      const isArgon = group.displayName.toLowerCase().includes('argon');
      const isClaudeGpt =
        group.displayName.toLowerCase().includes('claude') ||
        group.displayName.toLowerCase().includes('gpt');

      if (planTier === 'FREE' && (isArgon || isClaudeGpt)) {
        continue;
      }

      const groupHeader = isArgon
        ? 'GEMINI 4 ARGON'
        : isClaudeGpt
          ? 'CLAUDE & GPT'
          : 'GEMINI';

      items.push({
        label: groupHeader,
        kind: vscode.QuickPickItemKind.Separator
      });

      const orderedBuckets = [...group.buckets].sort((a, b) =>
        a.window === '5h' && b.window !== '5h' ? -1 : b.window === '5h' && a.window !== '5h' ? 1 : 0
      );

      for (const bucket of orderedBuckets) {
        const is5h = bucket.window === '5h';
        const windowTitle = is5h ? '5-Hour Fast Pool' : '7-Day Weekly Pool';
        const icon = isArgon ? 'flame' : is5h ? 'pulse' : 'calendar';
        const modelScope = isArgon
          ? 'Pro weekly allowance'
          : isClaudeGpt
            ? 'Opus, Sonnet, GPT-OSS'
            : 'Flash & Pro';

        if (bucket.disabled) {
          const weeklyBucket = group.buckets.find((b) => b.window === 'weekly') || bucket;
          const wkPct = `${Math.round((weeklyBucket.remainingFraction ?? 1) * 100)}%`;
          items.push(
            this.buildPoolRow(
              icon,
              windowTitle,
              wkPct,
              undefined,
              modelScope
            )
          );
        } else {
          const pctStr = `${Math.round((bucket.remainingFraction ?? 0) * 100)}%`;
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

    if (planTier === 'ULTRA' && !quota.hasArgonGroup) {
      items.push({
        label: 'GEMINI 4 ARGON',
        kind: vscode.QuickPickItemKind.Separator
      });
      items.push(
        this.buildPoolRow(
          'sparkle',
          'Unified Ultra Pool',
          '100%',
          undefined,
          'Bundled with Gemini 5h & 7d pools'
        )
      );
    }

    items.push({
      label: 'ACTIONS',
      kind: vscode.QuickPickItemKind.Separator
    });
    items.push({
      label: '  $(sync) Refresh live telemetry',
      description: 'Query local Antigravity daemon and vault snapshots',
      action: 'refreshActive'
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: `Charlier · ${activeTitleName} (${planTier} Plan · Active)`,
      placeHolder: `${activeEmail ? `${activeEmail}  ·  ` : ''}Live daemon telemetry  ·  Press Esc to close`,
      canPickMany: false
    });

    if (picked?.action === 'refreshActive') {
      await this.refreshQuota();
      await this.showQuotaDetails(activeProf?.id);
    }
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
