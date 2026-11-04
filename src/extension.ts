import * as vscode from 'vscode';
import { Vault } from './vault';
import { UIController } from './ui';
import { CredentialWatcher } from './watcher';
import { KeyringManager } from './keyring';
import { getProfilesDir } from './constants';

let uiController: UIController | null = null;
let watcher: CredentialWatcher | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const keyring = new KeyringManager(context.extensionPath);
  const vault = new Vault(keyring);
  uiController = new UIController(vault);

  // Watcher automatically updates the status bar if auth changes externally
  watcher = new CredentialWatcher(() => {
    uiController?.update();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('charlier.switchProfile', async () => {
      await uiController?.showQuickPickMenu();
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
}
