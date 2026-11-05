import * as vscode from 'vscode';
import { Vault } from './vault';
import { getProfilesDir } from './constants';
import { QuotaService } from './quota';
import { ProfileMetadata, QuotaSummary } from './types';

interface CharlierQuickPickItem extends vscode.QuickPickItem {
  actionType: 'switch' | 'save' | 'add' | 'delete' | 'open' | 'reload' | 'quota' | 'restartExtensionHost';
  profileId?: string;
  isCurrentActive?: boolean;
}

export class UIController {
  private statusBarItem: vscode.StatusBarItem;
  private vault: Vault;
  private quotaService: QuotaService;
  private promptedEmails = new Set<string>();
  private updateSeq = 0;

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
    const live = this.vault.getLiveSessionInfo();
    const state = this.vault.getState();
    const profiles = this.vault.listProfiles();

    let activeProfile: ProfileMetadata | null = null;

    if (live.email) {
      activeProfile = profiles.find(
        (p) => p.email.toLowerCase() === live.email!.toLowerCase()
      ) || null;
    }

    if (!activeProfile && state.activeProfileId) {
      activeProfile = profiles.find((p) => p.id === state.activeProfileId) || null;
    }

    if (activeProfile && state.activeProfileId !== activeProfile.id) {
      this.vault.saveState({ activeProfileId: activeProfile.id, lastUpdated: Date.now() });
    }

    const cachedQuota = this.quotaService.getCachedSummary();
    const quotaMatchesSession = Boolean(
      cachedQuota &&
      cachedQuota.email &&
      live.email &&
      cachedQuota.email.toLowerCase() === live.email.toLowerCase()
    );
    const validLiveQuota = quotaMatchesSession ? cachedQuota : null;

    if (activeProfile) {
      this.statusBarItem.text = `$(layers) Charlier: ${activeProfile.name}`;
      this.statusBarItem.tooltip = this.quotaService.buildAccountsHoverTooltip(
        profiles,
        activeProfile.id,
        live.email,
        validLiveQuota
      );
    } else if (live.email) {
      this.statusBarItem.text = `$(layers) Charlier: ${this.truncate(live.email, 18)}`;
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

    // Query live quota asynchronously
    if ((activeProfile || live.email) && !live.isExpired) {
      try {
        const quota = await this.quotaService.getQuotaSummary();
        if (seq === this.updateSeq && quota) {
          const emailMatches = Boolean(
            quota.email &&
            activeProfile?.email &&
            quota.email.toLowerCase() === activeProfile.email.toLowerCase()
          );

          if (emailMatches && activeProfile) {
            // Only cache if the daemon is actually authenticated to this active profile
            const metrics = this.quotaService.parseMetrics(quota);
            this.vault.updateProfileCachedQuota(activeProfile.id, metrics);
          }

          // Update hover panel with fresh live table only if email matches
          const refreshedProfiles = this.vault.listProfiles();
          this.statusBarItem.tooltip = this.quotaService.buildAccountsHoverTooltip(
            refreshedProfiles,
            activeProfile ? activeProfile.id : null,
            live.email,
            emailMatches ? quota : null
          );
        }
      } catch {
        // Fallback maintained
      }
    }
  }

  public async checkForNewUnsavedAccount(): Promise<void> {
    const live = this.vault.getLiveSessionInfo();
    if (!live.email) return;

    const emailLower = live.email.toLowerCase();
    if (this.promptedEmails.has(emailLower)) return;

    const profiles = this.vault.listProfiles();
    const isSaved = profiles.some((p) => p.email.toLowerCase() === emailLower);

    if (!isSaved) {
      this.promptedEmails.add(emailLower);
      const choice = await vscode.window.showInformationMessage(
        `Charlier detected an active Antigravity account (${live.email}). Save as profile?`,
        'Save Profile',
        'Not Now'
      );

      if (choice === 'Save Profile') {
        await this.handleSaveCurrent();
      }
    }
  }

  public async showQuickPickMenu(): Promise<void> {
    const live = this.vault.getLiveSessionInfo();
    const state = this.vault.getState();
    const profiles = this.vault.listProfiles();

    // Synchronous immediate open with cached quota - zero lag on click
    let liveQuota: QuotaSummary | null = this.quotaService.getCachedSummary();
    let liveMetrics = this.quotaService.parseMetrics(liveQuota);

    const graphBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('graph'),
      tooltip: 'View quota details'
    };

    const editBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('edit'),
      tooltip: 'Rename profile'
    };

    const quickPick = vscode.window.createQuickPick<CharlierQuickPickItem>();
    quickPick.placeholder = 'Select an Antigravity account profile or management action';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    const buildItems = (metrics: CachedQuotaMetric): CharlierQuickPickItem[] => {
      const result: CharlierQuickPickItem[] = [];

      // 1. Profiles Section (Active pinned at top, no redundant 'Profiles' separator)
      if (profiles.length > 0) {
        const sortedProfiles = [...profiles].sort((a, b) => {
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
            (live.email && profile.email.toLowerCase() === live.email.toLowerCase()) ||
            (!live.email && state.activeProfileId === profile.id);

          const planName = isActive
            ? (metrics.plan !== '--' ? metrics.plan : (profile.cachedQuota?.plan || 'FREE'))
            : (profile.cachedQuota?.plan || 'FREE');

          // Always provide both View Quotas [graphBtn] and Rename [editBtn] across all accounts
          const buttons: vscode.QuickInputButton[] = [graphBtn, editBtn];

          let icon: vscode.ThemeIcon;
          let description: string;
          let detailText: string;

          if (isActive) {
            // One prominent green checkmark icon. No cheesy duplicate checkmark in detail.
            icon = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
            description = `${profile.email}  ·  [Active]`;
            detailText = `Active Session · Antigravity Connected · ${planName} Plan`;
          } else {
            // Actionable swap icon in theme accent blue. Restrained typography with no duplicate icon in detail.
            icon = new vscode.ThemeIcon('arrow-swap', new vscode.ThemeColor('textLink.foreground'));
            description = profile.email;
            detailText = `Switch to this account · ${planName} Plan`;
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
        description: 'Prepare new Google sign-in',
        iconPath: new vscode.ThemeIcon('add'),
        actionType: 'add'
      });

      result.push({
        label: 'Save session as profile',
        description: live.email ? `Snapshot "${live.email}"` : 'Snapshot current credentials',
        iconPath: new vscode.ThemeIcon('save'),
        actionType: 'save'
      });

      if (profiles.length > 0) {
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
        description: 'Soft reload Antigravity & extensions without closing tabs',
        iconPath: new vscode.ThemeIcon('refresh'),
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

    quickPick.items = buildItems(liveMetrics);

    // Refresh non-blockingly in background
    this.quotaService.getQuotaSummary().then((fresh) => {
      if (fresh) {
        const freshMetrics = this.quotaService.parseMetrics(fresh);
        quickPick.items = buildItems(freshMetrics);
      }
    });

    // Handle button clicks directly on rows
    quickPick.onDidTriggerItemButton(async (e) => {
      quickPick.hide();
      if (!e.item.profileId) return;

      if (e.button === graphBtn) {
        await this.showQuotaDetails(e.item.profileId);
      } else if (e.button === editBtn) {
        await this.handleRename(e.item.profileId);
      }
    });

    // Handle row selections
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
          await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
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
          description: 'Detailed 5-hour and weekly limits across all model pools',
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
          label: 'Refresh limits',
          description: 'Query live daemon for updated token limits',
          iconPath: new vscode.ThemeIcon('refresh'),
          action: 'refresh'
        }
      ],
      { placeHolder: `Profile: ${profile.name} (${profile.email}) is already active` }
    );

    if (!choice) return;

    if (choice.action === 'quota') {
      await this.showQuotaDetails();
    } else if (choice.action === 'rename') {
      await this.handleRename(profileId);
    } else if (choice.action === 'refresh') {
      await this.refreshQuota();
    }
  }

  public async handleSwitch(profileId: string): Promise<void> {
    const state = this.vault.getState();
    const live = this.vault.getLiveSessionInfo();
    const target = this.vault.getProfile(profileId);

    const isAlreadyActive =
      state.activeProfileId === profileId ||
      (live.email && target && live.email.toLowerCase() === target.email.toLowerCase());

    if (isAlreadyActive) {
      vscode.window.setStatusBarMessage(
        `$(check) "${target?.name || profileId}" is already active.`,
        3000
      );
      return;
    }

    try {
      const meta = await this.vault.switchProfile(profileId);
      this.quotaService.invalidate();

      const config = vscode.workspace.getConfiguration('charlier');
      const autoRestart = config.get<boolean>('autoRestartExtensionHost', true);

      if (autoRestart) {
        vscode.window.setStatusBarMessage(
          `$(check) Switched to profile "${meta.name}" · Restarting Antigravity...`,
          3000
        );
        // Instant non-blocking extension host restart without stalling on daemon RPC
        await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
        return;
      }

      await this.update();
      vscode.window.setStatusBarMessage(
        `$(check) Switched to profile "${meta.name}"`,
        4000
      );
      vscode.window.showInformationMessage(
        `Switched to Antigravity profile "${meta.name}".`,
        'Restart Extension Host'
      ).then((choice) => {
        if (choice === 'Restart Extension Host') {
          vscode.commands.executeCommand('workbench.action.restartExtensionHost');
        }
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to switch profile: ${err.message}`);
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
      vscode.window.showErrorMessage(`Failed to rename profile: ${err.message}`);
    }
  }

  public async handleSaveCurrent(): Promise<void> {
    const live = this.vault.getLiveSessionInfo();
    const defaultName = live.email
      ? live.email.includes('@')
        ? live.email.split('@')[0]
        : live.email
      : 'Profile';

    const name = await vscode.window.showInputBox({
      title: 'Save Profile',
      prompt: 'Enter a profile name',
      value: defaultName,
      validateInput: (value) => (!value || !value.trim() ? 'Name cannot be empty.' : null)
    });

    if (!name) return;

    try {
      const meta = this.vault.saveCurrentAsProfile(name.trim());
      this.quotaService.invalidate();
      await this.update();
      vscode.window.setStatusBarMessage(
        `$(check) Saved profile "${meta.name}" for ${meta.email}`,
        4000
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to save profile: ${err.message}`);
    }
  }

  public async handleAddAccount(): Promise<void> {
    try {
      this.vault.prepareNewLogin();
      this.quotaService.invalidate();
      await this.update();

      try {
        await vscode.commands.executeCommand('antigravity.signOut');
      } catch {}

      try {
        await vscode.commands.executeCommand('antigravity.panel.focus');
      } catch {}

      vscode.window.setStatusBarMessage(
        '$(account) Antigravity ready for new login.',
        5000
      );

      vscode.window.showInformationMessage(
        'Antigravity is ready for a new login. Sign in via the sidebar, then save the profile.',
        'Save Profile'
      ).then((choice) => {
        if (choice === 'Save Profile') {
          this.handleSaveCurrent();
        }
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to prepare login: ${err.message}`);
    }
  }

  public async showQuotaDetails(profileId?: string): Promise<void> {
    const profiles = this.vault.listProfiles();
    const live = await this.vault.getLiveSessionInfo();
    const target = profileId ? profiles.find((p) => p.id === profileId) : null;
    const isTargetActive = target
      ? (live.email && target.email.toLowerCase() === live.email.toLowerCase())
      : true;

    if (!isTargetActive && target) {
      const cached = target.cachedQuota;
      const items: vscode.QuickPickItem[] = [];

      items.push({
        label: `Quota Snapshot · ${target.name} (${cached?.plan || 'FREE'} Plan)`,
        kind: vscode.QuickPickItemKind.Separator
      });

      if (cached && (cached.gemini !== '--' || cached.claudeGpt !== '--')) {
        const timeAgo = cached.updatedAt ? this.quotaService.formatTimeAgo(cached.updatedAt) : 'previously';
        items.push({
          label: `  Gemini Models (Flash, Pro): ${cached.gemini}`,
          description: `Snapshot from ${timeAgo}`,
          detail: 'Capacity recorded during last active session on this account'
        });
        if (cached.claudeGpt && cached.claudeGpt !== '--') {
          items.push({
            label: `  Claude & GPT Models: ${cached.claudeGpt}`,
            description: `Snapshot from ${timeAgo}`,
            detail: 'Capacity recorded during last active session on this account'
          });
        }
        if (cached.argon && cached.argon !== '--' && cached.argon !== 'incl.') {
          items.push({
            label: `  Gemini 4 Argon: ${cached.argon}`,
            description: `Snapshot from ${timeAgo}`,
            detail: 'Capacity recorded during last active session on this account'
          });
        }
      } else {
        items.push({
          label: `  No quota snapshot cached for "${target.name}"`,
          description: 'Not yet recorded in active session',
          detail: 'Switch to this account to query real-time quota from the Antigravity daemon'
        });
      }

      items.push({
        label: `$(arrow-swap) Activate "${target.name}"`,
        description: `Switch to ${target.email}`
      });

      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: `Quota Snapshot · ${target.name} (${target.email})`
      });

      if (choice && choice.label.startsWith('$(arrow-swap)')) {
        await this.handleSwitch(target.id);
      }
      return;
    }

    const quota = await this.quotaService.getQuotaSummary(true);
    if (!quota || quota.groups.length === 0) {
      vscode.window.showInformationMessage('No active quota reported by daemon.');
      return;
    }

    const items: vscode.QuickPickItem[] = [];

    items.push({
      label: `Antigravity Quota Dashboard · ${quota.tier}`,
      kind: vscode.QuickPickItemKind.Separator
    });

    for (const group of quota.groups) {
      const isArgon = group.displayName.toLowerCase().includes('argon');
      const isClaudeGpt = group.displayName.toLowerCase().includes('claude') || group.displayName.toLowerCase().includes('gpt');

      let groupHeader = group.displayName.toUpperCase();
      if (isArgon) {
        groupHeader = 'GEMINI 4 ARGON · Pro Weekly Allowance';
      } else if (isClaudeGpt) {
        groupHeader = 'CLAUDE & GPT MODELS · Opus, Sonnet, GPT-OSS';
      } else {
        groupHeader = quota.planTier === 'ULTRA' ? 'GEMINI MODELS · Argon Included' : 'GEMINI MODELS · Flash & Pro';
      }

      items.push({
        label: groupHeader,
        kind: vscode.QuickPickItemKind.Separator
      });

      for (const bucket of group.buckets) {
        const is5h = bucket.window === '5h';
        const windowTitle = is5h ? '5-Hour Fast Pool    ' : '7-Day Rolling Pool  ';
        const fraction = bucket.disabled ? 0 : (bucket.remainingFraction ?? 0);
        const pct = Math.round(fraction * 100);
        const meter = this.quotaService.renderLinenMeter(fraction, 8);
        const resetStr = this.quotaService.formatResetCompact(bucket.resetTime);

        let statusPill = '';
        if (bucket.disabled) {
          statusPill = 'Inactive (weekly reserve applied)';
        } else if (pct === 0) {
          statusPill = resetStr ? `Depleted · Resets in ${resetStr}` : 'Depleted';
        } else if (pct === 100) {
          statusPill = '100% Full Capacity';
        } else {
          statusPill = resetStr ? `Active · Resets in ${resetStr}` : 'Active';
        }

        let scopeDetail = '';
        if (isArgon) {
          scopeDetail = 'Dedicated allocation for Gemini 4 Argon reasoning models';
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
      placeHolder: `Antigravity Quota · ${quota.tier}`,
      canPickMany: false
    });
  }

  public async refreshQuota(): Promise<void> {
    this.quotaService.invalidate();
    await this.update();
    vscode.window.setStatusBarMessage('$(refresh) Limits refreshed from daemon.', 3000);
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

    // Explicit heads-up modal confirmation (Point 8)
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
