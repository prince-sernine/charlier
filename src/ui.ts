import * as vscode from 'vscode';
import { Vault } from './vault';
import { getProfilesDir } from './constants';
import { QuotaService } from './quota';
import { ProfileMetadata, QuotaSummary } from './types';

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

    if (activeProfile) {
      this.statusBarItem.text = `$(arrow-swap) Charlier: ${activeProfile.name}`;
      // Basic initial tooltip
      this.statusBarItem.tooltip = new vscode.MarkdownString(
        `**Charlier Profile: ${activeProfile.name}**\n\n` +
        `• Account: \`${activeProfile.email}\`\n` +
        `• Status: ${live.isExpired ? '⚠️ Token Expired' : '✅ Active'}\n\n` +
        `*Click to switch or manage profiles*`
      );
    } else if (live.email) {
      this.statusBarItem.text = `$(arrow-swap) Charlier: ${this.truncate(live.email, 18)}`;
      this.statusBarItem.tooltip = new vscode.MarkdownString(
        `**Charlier (Unsaved Session)**\n\n` +
        `• Active Account: \`${live.email}\`\n\n` +
        `*Click to save this session or switch profiles*`
      );
    } else {
      this.statusBarItem.text = `$(account) Charlier: Ready for login`;
      this.statusBarItem.tooltip = `Charlier: Ready for login.\nClick to sign in or load profile.`;
    }

    // Asynchronously enrich with real-time quota data
    if (activeProfile && !live.isExpired) {
      try {
        const quota = await this.quotaService.getQuotaSummary();
        if (seq === this.updateSeq && quota) {
          this.statusBarItem.tooltip = this.quotaService.buildMarkdownTooltip(
            activeProfile.name,
            activeProfile.email,
            live.isExpired,
            quota
          );
        }
      } catch {
        // Fall back to basic tooltip
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

    // Prefetch quota for live profile
    let liveQuota: QuotaSummary | null = null;
    try {
      liveQuota = await this.quotaService.getQuotaSummary();
    } catch {}

    const quotaSummaryLine = this.quotaService.getQuickSummaryLine(liveQuota);

    interface QuickPickActionItem extends vscode.QuickPickItem {
      actionType: 'switch' | 'save' | 'add' | 'delete' | 'open' | 'reload' | 'quota';
      profileId?: string;
    }

    const items: QuickPickActionItem[] = [];

    // 1. Profiles Section
    if (profiles.length > 0) {
      items.push({
        label: 'Profiles',
        kind: vscode.QuickPickItemKind.Separator,
        actionType: 'switch'
      });

      for (const profile of profiles) {
        const isActive =
          state.activeProfileId === profile.id ||
          (live.email && profile.email.toLowerCase() === live.email.toLowerCase());

        let detailText = isActive ? 'Currently active account' : 'Click to activate this account';
        if (isActive && quotaSummaryLine) {
          detailText = `${liveQuota?.tier || 'Plan'}: ${quotaSummaryLine}`;
        }

        items.push({
          label: `${isActive ? '$(check) ' : '$(account) '}${profile.name}`,
          description: profile.email + (isActive ? ' (Active)' : ''),
          detail: detailText,
          actionType: 'switch',
          profileId: profile.id
        });
      }
    }

    // 2. Actions Section
    items.push({
      label: 'Actions',
      kind: vscode.QuickPickItemKind.Separator,
      actionType: 'save'
    });

    if (liveQuota && liveQuota.groups.length > 0) {
      items.push({
        label: '$(graph) View Quota & Model Limits...',
        description: `${liveQuota.tier} • ${quotaSummaryLine}`,
        detail: 'Examine detailed 5-hour and weekly limits across all model pools',
        actionType: 'quota'
      });
    }

    items.push({
      label: '$(add) Add New Account...',
      description: 'Snapshot current session and prepare Antigravity for a fresh Google login',
      actionType: 'add'
    });

    items.push({
      label: '$(save) Save Current Session as Profile...',
      description: live.email ? `Snapshot "${live.email}"` : 'Snapshot active credentials',
      actionType: 'save'
    });

    if (profiles.length > 0) {
      items.push({
        label: '$(trash) Delete a Profile...',
        description: 'Remove a saved profile from rotation',
        actionType: 'delete'
      });
    }

    items.push({
      label: '$(folder) Open Profiles Directory',
      description: 'Reveal stored credential files on disk',
      actionType: 'open'
    });

    items.push({
      label: '$(refresh) Reload Window',
      description: 'Restart language server and reload VS Code window',
      actionType: 'reload'
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select an Antigravity account profile or management action',
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (!picked) return;

    switch (picked.actionType) {
      case 'switch':
        if (picked.profileId) {
          await this.handleSwitch(picked.profileId);
        }
        break;
      case 'quota':
        await this.showQuotaDetails();
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
  }

  public async handleSwitch(profileId: string): Promise<void> {
    try {
      const meta = this.vault.switchProfile(profileId);
      this.quotaService.invalidate();
      await this.update();

      // Transient non-blocking notification in status bar
      vscode.window.setStatusBarMessage(
        `$(check) Switched to profile "${meta.name}" (${meta.email})`,
        4000
      );

      // Lightweight non-blocking notification with optional reload button
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

  public async handleSaveCurrent(): Promise<void> {
    const live = this.vault.getLiveSessionInfo();
    const defaultName = live.email
      ? live.email.includes('@')
        ? live.email.split('@')[0]
        : live.email
      : 'Profile';

    const name = await vscode.window.showInputBox({
      title: 'Save Antigravity Profile',
      prompt: 'Enter a recognizable profile name (e.g. Work, Personal, Secondary)',
      value: defaultName,
      validateInput: (value) => {
        if (!value || !value.trim()) {
          return 'Profile name cannot be empty.';
        }
        return null;
      }
    });

    if (!name) return;

    try {
      const meta = this.vault.saveCurrentAsProfile(name.trim());
      this.quotaService.invalidate();
      await this.update();
      vscode.window.showInformationMessage(
        `Saved profile "${meta.name}" for ${meta.email}.`
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to save profile: ${err.message}`);
    }
  }

  public async handleAddAccount(): Promise<void> {
    try {
      // 1. Snapshot current credentials and clear OS Keyring + disk files
      this.vault.prepareNewLogin();
      this.quotaService.invalidate();
      await this.update();

      // 2. Dispatch native sign out RPC so daemon clears in-memory state
      try {
        await vscode.commands.executeCommand('antigravity.signOut');
      } catch {}

      // 3. Focus Antigravity panel
      try {
        await vscode.commands.executeCommand('antigravity.panel.focus');
      } catch {}

      // 4. Non-blocking status bar message
      vscode.window.setStatusBarMessage(
        '$(account) Ready for new login. Sign in via the Antigravity sidebar.',
        6000
      );

      // 5. Lightweight toast offering quick Save once logged in (No reload window modal!)
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
      vscode.window.showInformationMessage('No active quota information reported by the Antigravity daemon.');
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
        subheader += ' (Separate Pro Weekly Quota)';
      } else if (isClaudeGpt) {
        subheader += ' (Opus, Sonnet, GPT-OSS)';
      } else {
        subheader += quota.hasArgonGroup ? ' (Argon Separate)' : ' (Argon Included)';
      }

      items.push({
        label: subheader,
        kind: vscode.QuickPickItemKind.Separator
      });

      for (const bucket of group.buckets) {
        const windowLabel = bucket.window === '5h' ? '5-Hour Limit' : 'Weekly Limit';
        if (bucket.disabled) {
          items.push({
            label: `  ${windowLabel}: Limit Reached / Paused`,
            description: bucket.description
          });
        } else {
          const fraction = bucket.remainingFraction ?? 0;
          const pct = Math.round(fraction * 100);
          const bar = this.quotaService.renderProgressBar(fraction, 10);
          const resetStr = this.quotaService.formatResetTime(bucket.resetTime);

          items.push({
            label: `  ${windowLabel}: [${bar}] ${pct}%`,
            description: resetStr ? `(${resetStr})` : undefined,
            detail: bucket.description
          });
        }
      }
    }

    await vscode.window.showQuickPick(items, {
      placeHolder: `Antigravity Quota Breakdown (${quota.tier})`,
      canPickMany: false
    });
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
      `Are you sure you want to delete profile "${picked.label}"?`,
      'Delete',
      'Cancel'
    );

    if (confirm !== 'Delete') return;

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
