import * as vscode from 'vscode';
import { Vault } from './vault';
import { getProfilesDir } from './constants';

export class UIController {
  private statusBarItem: vscode.StatusBarItem;
  private vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'charlier.switchProfile';
    this.update();
    this.statusBarItem.show();
  }

  public update(): void {
    const live = this.vault.getLiveSessionInfo();
    const state = this.vault.getState();
    const profiles = this.vault.listProfiles();

    let activeProfile = state.activeProfileId
      ? profiles.find((p) => p.id === state.activeProfileId)
      : null;

    // Fallback: match by email if state not set
    if (!activeProfile && live.email) {
      activeProfile = profiles.find(
        (p) => p.email.toLowerCase() === live.email!.toLowerCase()
      ) || null;
    }

    if (activeProfile) {
      this.statusBarItem.text = `$(arrow-swap) Charlier: ${activeProfile.name}`;
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
      this.statusBarItem.text = `$(arrow-swap) Charlier: No Account`;
      this.statusBarItem.tooltip = `Charlier: No active Google Antigravity credentials found.\nClick to sign in or load profile.`;
    }
  }

  public async showQuickPickMenu(): Promise<void> {
    const live = this.vault.getLiveSessionInfo();
    const state = this.vault.getState();
    const profiles = this.vault.listProfiles();

    interface QuickPickActionItem extends vscode.QuickPickItem {
      actionType: 'switch' | 'save' | 'add' | 'delete' | 'open' | 'reload';
      profileId?: string;
    }

    const items: QuickPickActionItem[] = [];

    // Profiles Section
    if (profiles.length > 0) {
      for (const profile of profiles) {
        const isActive =
          state.activeProfileId === profile.id ||
          (live.email && profile.email.toLowerCase() === live.email.toLowerCase());

        items.push({
          label: `${isActive ? '$(check) ' : '$(account) '}${profile.name}`,
          description: profile.email,
          detail: isActive ? 'Currently active profile' : 'Click to activate this account',
          actionType: 'switch',
          profileId: profile.id
        });
      }
    }

    // Actions Section
    items.push({
      label: '$(save) Save Current Session as Profile...',
      description: live.email ? `Snapshot "${live.email}"` : 'Snapshot active credentials',
      actionType: 'save'
    });

    items.push({
      label: '$(add) Add New Account...',
      description: 'Clears active token so you can log in with another account',
      actionType: 'add'
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
      description: 'Force Antigravity language server to reload immediately',
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
      this.update();

      const choice = await vscode.window.showInformationMessage(
        `Switched to Antigravity profile "${meta.name}" (${meta.email}).`,
        'Reload Window',
        'Later'
      );

      if (choice === 'Reload Window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to switch profile: ${err.message}`);
    }
  }

  public async handleSaveCurrent(): Promise<void> {
    const live = this.vault.getLiveSessionInfo();
    const defaultName = live.email ? live.email.split('@')[0] : 'Profile';

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
      this.update();
      vscode.window.showInformationMessage(
        `Saved profile "${meta.name}" for ${meta.email}.`
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to save profile: ${err.message}`);
    }
  }

  public async handleAddAccount(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Charlier will preserve your current credentials and prepare Antigravity for a new login. Continue?',
      'Yes, Prepare New Login',
      'Cancel'
    );

    if (confirm !== 'Yes, Prepare New Login') return;

    try {
      this.vault.prepareNewLogin();
      this.update();

      const reload = await vscode.window.showInformationMessage(
        'Credentials cleared. Reload the window, open Antigravity, and sign in with your new account. Once logged in, run "Charlier: Save Current Profile".',
        'Reload Window Now',
        'Later'
      );

      if (reload === 'Reload Window Now') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to prepare login: ${err.message}`);
    }
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
    this.update();
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

