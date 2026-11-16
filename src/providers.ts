import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ActiveProviderId, ProviderId } from './types';
import { getActiveCodexAuthPath, getActiveGoogleAccountsPath, getDaemonSearchDirs } from './constants';
import { isCodexAppServerProcess } from './quota-values';

export interface ProviderRuntimeDescriptor {
  id: ProviderId;
  displayName: string;
  shortLabel: string;
  extensionIds: string[];
  isRunningOrActive: () => boolean;
}

let cachedDaemonAlive: { value: boolean; checkedAt: number } | null = null;
const DAEMON_ALIVE_TTL_MS = 3000;

function hasAliveAntigravityDaemon(): boolean {
  const now = Date.now();
  if (cachedDaemonAlive && now - cachedDaemonAlive.checkedAt < DAEMON_ALIVE_TTL_MS) {
    return cachedDaemonAlive.value;
  }
  const dirs = getDaemonSearchDirs();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => (f.startsWith('hub_') || f.startsWith('ls_')) && f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
          if (typeof data.pid === 'number' && data.pid > 0) {
            process.kill(data.pid, 0);
            cachedDaemonAlive = { value: true, checkedAt: now };
            return true;
          }
        } catch {}
      }
    } catch {}
  }
  cachedDaemonAlive = { value: false, checkedAt: now };
  return false;
}

function hasLiveCodexAppServer(): boolean {
  const getHandles = (process as any)._getActiveHandles;
  if (typeof getHandles !== 'function') return false;
  try {
    const handles: any[] = getHandles.call(process) || [];
    return handles.some((h) => isCodexAppServerProcess(h, false));
  } catch {
    return false;
  }
}

/**
 * Expandable Provider Runtime Registry.
 * Plugging in Claude Code or Kimi in v0.3.0 only requires adding entries or enabling their deck here.
 */
export const PROVIDER_RUNTIME_REGISTRY: Record<ProviderId, ProviderRuntimeDescriptor> = {
  antigravity: {
    id: 'antigravity',
    displayName: 'Google Antigravity',
    shortLabel: 'Antigravity',
    extensionIds: ['google.google-antigravity', 'google.antigravity'],
    isRunningOrActive: (): boolean => {
      const appName = (vscode.env?.appName || '').toLowerCase();
      if (appName.includes('antigravity')) return true;
      for (const extId of ['google.google-antigravity', 'google.antigravity']) {
        const ext = vscode.extensions?.getExtension?.(extId);
        if (ext) return true;
      }
      return hasAliveAntigravityDaemon();
    }
  },
  codex: {
    id: 'codex',
    displayName: 'OpenAI Codex',
    shortLabel: 'Codex',
    extensionIds: ['openai.chatgpt'],
    isRunningOrActive: (): boolean => {
      for (const extId of ['openai.chatgpt']) {
        const ext = vscode.extensions?.getExtension?.(extId);
        if (ext) return true;
      }
      return hasLiveCodexAppServer();
    }
  },
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    shortLabel: 'Claude',
    extensionIds: ['anthropic.claude-code'],
    isRunningOrActive: (): boolean => {
      const ext = vscode.extensions?.getExtension?.('anthropic.claude-code');
      return Boolean(ext);
    }
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi Code',
    shortLabel: 'Kimi',
    extensionIds: ['moonshot-ai.kimi-code', 'kimi.kimi-code'],
    isRunningOrActive: (): boolean => {
      for (const extId of ['moonshot-ai.kimi-code', 'kimi.kimi-code']) {
        if (vscode.extensions?.getExtension?.(extId)) return true;
      }
      return false;
    }
  }
};

/**
 * Determines which provider deck should be selected by default on initial launch:
 * - Inside Antigravity IDE (or if Antigravity daemon is running), defaults to 'antigravity'.
 * - Otherwise, if OpenAI Codex extension or ~/.codex/auth.json exists, defaults to 'codex'.
 */
export function detectDefaultProvider(): ActiveProviderId {
  const appName = (vscode.env.appName || '').toLowerCase();
  if (appName.includes('antigravity')) {
    return 'antigravity';
  }
  if (PROVIDER_RUNTIME_REGISTRY.antigravity.isRunningOrActive()) {
    return 'antigravity';
  }
  if (
    PROVIDER_RUNTIME_REGISTRY.codex.isRunningOrActive() ||
    fs.existsSync(getActiveCodexAuthPath())
  ) {
    return 'codex';
  }
  if (fs.existsSync(getActiveGoogleAccountsPath())) {
    return 'antigravity';
  }
  return 'antigravity';
}

/**
 * Returns all OTHER providers that are currently installed/active in this editor window.
 */
export function getCoRunningProviders(excludeProviderId?: ProviderId): ProviderRuntimeDescriptor[] {
  const active: ProviderRuntimeDescriptor[] = [];
  for (const descriptor of Object.values(PROVIDER_RUNTIME_REGISTRY)) {
    if (excludeProviderId && descriptor.id === excludeProviderId) {
      continue;
    }
    if (descriptor.isRunningOrActive()) {
      active.push(descriptor);
    }
  }
  return active;
}

/**
 * Returns all providers currently running/installed in this editor window.
 */
export function getAllRunningProviders(): ProviderRuntimeDescriptor[] {
  return getCoRunningProviders(undefined);
}

/**
 * Formats a human-readable list of provider names (e.g. "Codex", "Antigravity and Claude Code").
 */
export function formatProviderList(providers: ProviderRuntimeDescriptor[]): string {
  const names = providers.map(p => p.shortLabel);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/**
 * Smart Co-Running Provider Restart Guard:
 * Called after credentials have already been swapped on disk when an Extension Host restart
 * is needed (either because Codex sidebar needs a reload, or because Antigravity surgical
 * daemon respawn was unavailable/disabled).
 *
 * - If another provider (e.g. Antigravity while switching Codex, or Codex while switching Antigravity)
 *   is active in the same window, explicitly warns the user that restarting the Extension Host
 *   will also restart that co-running provider, offering "Reload Now" vs "Keep CLI Only (No Reload)".
 * - If no other provider is running, either soft-restarts or shows a clean generic heads-up.
 */
export async function confirmAndReloadForProviderSwitch(
  targetProvider: ProviderId,
  profileName: string,
  options: { isFallbackFromSurgical?: boolean; isBudgetGuard?: boolean } = {}
): Promise<boolean> {
  const targetDesc = PROVIDER_RUNTIME_REGISTRY[targetProvider];
  const targetRunningInIde = targetDesc.isRunningOrActive();

  // If switching Codex and the Codex VS Code extension isn't even installed in this IDE,
  // disk credentials are already swapped for `codex` CLI - no Extension Host reload is needed.
  if (targetProvider === 'codex' && !targetRunningInIde) {
    vscode.window.setStatusBarMessage(
      `$(check) Charlier: Switched Codex CLI to "${profileName}" (no extension reload needed)`,
      4500
    );
    return false;
  }

  const coRunning = getCoRunningProviders(targetProvider);
  const autoRestart = vscode.workspace
    .getConfiguration('charlier')
    .get<boolean>('autoRestartExtensionHost', true);

  if (coRunning.length > 0) {
    const coNames = formatProviderList(coRunning);
    const message = options.isBudgetGuard
      ? `Charlier swapped ${targetDesc.shortLabel} to "${profileName}" on disk. Antigravity reached its safe 10-minute backend restart limit (re-killing would crash the view). Reload Extension Host (~200ms) to reset cleanly and apply now (restarts ${coNames})?`
      : options.isFallbackFromSurgical
        ? `Charlier swapped ${targetDesc.shortLabel} to "${profileName}" on disk. Surgical daemon reload was unavailable; restarting the Extension Host will also restart ${coNames}. Restart now?`
        : `Charlier swapped ${targetDesc.shortLabel} to "${profileName}" (CLI ready immediately). Reloading the Extension Host to update the ${targetDesc.shortLabel} sidebar will also restart ${coNames}. Reload now?`;

    const choice = await vscode.window.showInformationMessage(
      message,
      'Reload Extension Host',
      'Keep CLI Only (No Reload)'
    );

    if (choice === 'Reload Extension Host') {
      await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
      return true;
    }

    vscode.window.setStatusBarMessage(
      `$(check) Charlier: "${profileName}" active on disk for CLI (Extension Host kept running)`,
      4500
    );
    return false;
  }

  // No other provider is running in this window
  if (autoRestart && (!options.isFallbackFromSurgical || options.isBudgetGuard)) {
    await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
    return true;
  }

  const genericChoice = await vscode.window.showInformationMessage(
    `Charlier switched ${targetDesc.shortLabel} to "${profileName}". Restart the Extension Host now to apply inside the editor?`,
    'Restart Extension Host',
    'Later'
  );
  if (genericChoice === 'Restart Extension Host') {
    await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
    return true;
  }
  return false;
}

/**
 * General Extension Host Restart Guard (used when clicking manual Restart Extension Host).
 * Names all active providers in the window so the user knows what will reconnect.
 */
export async function confirmGeneralExtensionHostRestart(): Promise<boolean> {
  const running = getAllRunningProviders();
  const promptText =
    running.length > 0
      ? `Restart the VS Code Extension Host? Active providers (${formatProviderList(running)}) will reconnect in ~150ms.`
      : 'Restart the VS Code Extension Host? All active extensions will reconnect in ~150ms.';

  const choice = await vscode.window.showInformationMessage(
    promptText,
    'Restart Extension Host',
    'Cancel'
  );
  if (choice === 'Restart Extension Host') {
    await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
    return true;
  }
  return false;
}
