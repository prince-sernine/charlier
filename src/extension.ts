import * as vscode from 'vscode';
import { Vault } from './vault';
import { UIController } from './ui';
import { CredentialWatcher } from './watcher';
import { KeyringManager } from './keyring';
import { QuotaService } from './quota';
import { getProfilesDir } from './constants';

let uiController: UIController | null = null;
let watcher: CredentialWatcher | null = null;
let quotaService: QuotaService | null = null;
let vaultInstance: Vault | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const keyring = new KeyringManager();
  vaultInstance = new Vault(keyring);
  quotaService = new QuotaService();
  uiController = new UIController(vaultInstance, quotaService);

  // Watcher automatically updates the status bar and probes if new account logged in externally
  watcher = new CredentialWatcher(() => {
    quotaService?.invalidate();
    uiController?.update();
    uiController?.checkForNewUnsavedAccount();
  });

  // Check for unsaved/new account on startup
  setTimeout(() => {
    uiController?.checkForNewUnsavedAccount();
  }, 1500);

  // Check when window regains focus (e.g. returning from browser Google login)
  const windowFocusSub = vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      uiController?.update();
      uiController?.checkForNewUnsavedAccount();
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('charlier.switchProfile', async () => {
      await uiController?.showQuickPickMenu();
    }),
    vscode.commands.registerCommand('charlier.switchProfileDirect', async (arg: any) => {
      let rawId = arg;
      if (Array.isArray(arg) && arg.length > 0) {
        rawId = arg[0];
      }
      let idStr = typeof rawId === 'string' ? decodeURIComponent(rawId) : String(rawId || '');
      if (idStr.startsWith('"') && idStr.endsWith('"')) {
        try {
          idStr = JSON.parse(idStr);
        } catch {}
      }
      if (idStr) {
        await uiController?.handleSwitch(idStr);
      }
    }),
    vscode.commands.registerCommand('charlier.viewQuota', async () => {
      await uiController?.showQuotaDetails();
    }),
    vscode.commands.registerCommand('charlier.refreshQuota', async () => {
      await uiController?.refreshQuota();
    }),
    vscode.commands.registerCommand('charlier.renameProfile', async (profileId?: string) => {
      const targetId = profileId || vaultInstance?.getState().activeProfileId;
      if (targetId) {
        await uiController?.handleRename(targetId);
      }
    }),
    vscode.commands.registerCommand('charlier.saveProfile', async () => {
      await uiController?.handleSaveCurrent();
    }),
    vscode.commands.registerCommand('charlier.addAccount', async () => {
      await uiController?.handleAddAccount();
    }),
    vscode.commands.registerCommand('charlier.deleteProfile', async () => {
      await uiController?.handleDelete();
    }),
    vscode.commands.registerCommand('charlier.openVault', async () => {
      await vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(getProfilesDir())
      );
    }),
    vscode.commands.registerCommand('charlier.reloadWindow', async () => {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),
    windowFocusSub,
    {
      dispose: () => {
        watcher?.dispose();
        uiController?.dispose();
      }
    }
  );
}

export function deactivate(): void {
  watcher?.dispose();
  uiController?.dispose();
  watcher = null;
  uiController = null;
  quotaService = null;
  vaultInstance = null;
}
