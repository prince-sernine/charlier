import * as fs from 'fs';
import * as path from 'path';
import { getGeminiHomeDir, getProfilesDir } from './constants';

export class CredentialWatcher {
  private watcher: fs.FSWatcher | null = null;
  private profilesWatcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly onChangeCallback: () => void;

  constructor(onChange: () => void) {
    this.onChangeCallback = onChange;
    this.start();
  }

  public start(): void {
    const dir = getGeminiHomeDir();
    if (fs.existsSync(dir)) {
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

    const profilesDir = getProfilesDir();
    if (fs.existsSync(profilesDir)) {
      try {
        this.profilesWatcher = fs.watch(profilesDir, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          const name = filename.toString();
          // Never trigger on internal cached quota updates or temporary files
          if (name.endsWith('metadata.json') || name.endsWith('.tmp')) {
            return;
          }
          this.triggerDebounced();
        });
      } catch (err) {
        console.warn('[Charlier] Could not attach fs.watch to profiles directory:', err);
      }
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
    if (this.profilesWatcher) {
      this.profilesWatcher.close();
      this.profilesWatcher = null;
    }
  }
}

