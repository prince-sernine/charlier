import * as vscode from 'vscode';
import { Vault } from './vault';
import { getProfilesDir } from './constants';
import { QuotaService } from './quota';
import { ProfileMetadata, QuotaSummary } from './types';

interface CharlierQuickPickItem extends vscode.QuickPickItem {
  actionType: 'switch' | 'save' | 'add' | 'delete' | 'open' | 'reload' | 'quota';
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

    let activeProfile = state.activeProfileId
      ? profiles.find((p) => p.id === state.activeProfileId)
      : null;

    if (!activeProfile && live.email) {
      activeProfile = profiles.find(
        (p) => p.email.toLowerCase() === live.email!.toLowerCase()
      ) || null;
    }

    const cachedQuota = this.quotaService.getCachedSummary();

    if (activeProfile) {
      this.statusBarItem.text = `$(layers) Charlier: ${activeProfile.name}`;
      this.statusBarItem.tooltip = this.quotaService.buildAccountsHoverTooltip(
        profiles,
        activeProfile.id,
        live.email,
        cachedQuota
      );
    } else if (live.email) {
      this.statusBarItem.text = `$(layers) Charlier: ${this.truncate(live.email, 18)}`;
      this.statusBarItem.tooltip = this.quotaService.buildAccountsHoverTooltip(
        profiles,
        null,
        live.email,
        cachedQuota
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
          if (activeProfile) {
            // Cache metrics on the profile for future offline / inactive table rendering
            const metrics = this.quotaService.parseMetrics(quota);
            this.vault.updateProfileCachedQuota(activeProfile.id, metrics);
          }

          // Update hover panel with fresh live table
          const refreshedProfiles = this.vault.listProfiles();
          this.statusBarItem.tooltip = this.quotaService.buildAccountsHoverTooltip(
            refreshedProfiles,
            activeProfile ? activeProfile.id : null,
            live.email,
            quota
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

      // 1. Profiles Section
      if (profiles.length > 0) {
        result.push({
          label: 'Profiles',
          kind: vscode.QuickPickItemKind.Separator,
          actionType: 'switch'
        });

        for (const profile of profiles) {
          const isActive =
            state.activeProfileId === profile.id ||
            (live.email && profile.email.toLowerCase() === live.email.toLowerCase());

          let detailText = 'Click to activate';
          let buttons: vscode.QuickInputButton[] = [editBtn];

          if (isActive) {
            buttons = [graphBtn, editBtn];
            if (metrics.plan !== '—') {
              const argonPart = metrics.argon !== '—' && metrics.argon !== 'incl.' ? ` · Argon: ${metrics.argon}` : '';
              detailText = `${metrics.plan} · Gemini: ${metrics.gemini} · Claude: ${metrics.claudeGpt}${argonPart}`;
            } else {
              detailText = 'Active account';
            }
          } else if (profile.cachedQuota) {
            const q = profile.cachedQuota;
            const argonPart = q.argon !== '—' && q.argon !== 'incl.' ? ` · Argon: ${q.argon}` : '';
            detailText = `${q.plan} · Gemini: ${q.gemini} · Claude: ${q.claudeGpt}${argonPart}`;
          }

          result.push({
            label: profile.name,
            iconPath: isActive
              ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
              : new vscode.ThemeIcon('account'),
            description: profile.email + (isActive ? ' · Active' : ''),
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
        label: 'Reload window',
        description: 'Restart language server and reload VS Code',
        iconPath: new vscode.ThemeIcon('refresh'),
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
        await this.showQuotaDetails();
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
      const meta = this.vault.switchProfile(profileId);
      this.quotaService.invalidate();
      await this.update();

      vscode.window.setStatusBarMessage(
        `$(check) Switched to profile "${meta.name}"`,
        4000
      );

      vscode.window.showInformationMessage(
        `Switched to Antigravity profile "${meta.name}".`,
        'Reload Window'
      ).then((choice) => {
        if (choice === 'Reload Window') {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
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

  public async showQuotaDetails(): Promise<void> {
    const quota = await this.quotaService.getQuotaSummary(true);
    if (!quota || quota.groups.length === 0) {
      vscode.window.showInformationMessage('No active quota reported by daemon.');
      return;
    }

    const items: vscode.QuickPickItem[] = [];

    items.push({
      label: `Antigravity Plan: ${quota.tier}`,
      kind: vscode.QuickPickItemKind.Separator
    });

    for (const group of quota.groups) {
      const isArgon = group.displayName.toLowerCase().includes('argon');
      const isClaudeGpt = group.displayName.toLowerCase().includes('claude') || group.displayName.toLowerCase().includes('gpt');

      let subheader = group.displayName;
      if (isArgon) {
        subheader += ' (Pro Weekly Allowance)';
      } else if (isClaudeGpt) {
        subheader += ' (Opus, Sonnet, GPT-OSS)';
      } else {
        subheader += quota.planTier === 'ULTRA' ? ' (Argon Included)' : ' (Flash, Pro)';
      }

      items.push({
        label: subheader,
        kind: vscode.QuickPickItemKind.Separator
      });

      for (const bucket of group.buckets) {
        const windowLabel = bucket.window === '5h' ? '5-Hour Limit' : 'Weekly Limit';
        if (bucket.disabled) {
          items.push({
            label: `  ${windowLabel}:  ${this.quotaService.renderLinenMeter(0, 8)}   0%`,
            description: bucket.description
          });
        } else {
          const fraction = bucket.remainingFraction ?? 0;
          const pct = Math.round(fraction * 100);
          const meter = this.quotaService.renderLinenMeter(fraction, 8);
          const resetStr = this.quotaService.formatResetCompact(bucket.resetTime);

          items.push({
            label: `  ${windowLabel}:  ${meter}  ${pct}%`,
            description: resetStr ? `(resets in ${resetStr})` : undefined,
            detail: bucket.description
          });
        }
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
