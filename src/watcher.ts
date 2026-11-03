import * as fs from 'fs';
import * as path from 'path';
import { getGeminiHomeDir } from './constants';

export class CredentialWatcher {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly onChangeCallback: () => void;

  constructor(onChange: () => void) {
    this.onChangeCallback = onChange;
    this.start();
  }

  public start(): void {
    const dir = getGeminiHomeDir();
    if (!fs.existsSync(dir)) {
      return;
    }

    try {
      this.watcher = fs.watch(dir, (eventType, filename) => {
        if (!filename) return;
        const name = filename.toString();
        if (name === 'google_accounts.json' || name === 'oauth_creds.json') {
          this.triggerDebounced();
        }
      });
    } catch (err) {
      console.warn('[Charlier] Could not attach fs.watch to .gemini directory:', err);
    }
  }

  private triggerDebounced(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.onChangeCallback();
    }, 150);
  }

  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

