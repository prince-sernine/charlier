import * as fs from 'fs';
import * as path from 'path';
import {
  getCodexHomeDir,
  getCodexProfilesDir,
  getGeminiHomeDir,
  getIdeGlobalStorageDirs,
  getProfilesDir
} from './constants';

export interface AntigravityActivityInfo {
  dirKind: 'conversations' | 'annotations';
  appDataDir?: 'antigravity' | 'antigravity-ide';
  conversationIds: string[];
}

function extractConversationIdFromFilename(filename: string): string | null {
  const base = path.basename(filename || '').trim();
  if (!base || base.startsWith('.')) return null;
  const cleaned = base.replace(
    /(?:\.db-wal|\.db-journal|\.db-shm|\.db|\.pbtxt|\.pb|\.jsonl|\.json)$/i,
    ''
  );
  return cleaned && cleaned !== base ? cleaned : null;
}

export class CredentialWatcher {
  private watchers: fs.FSWatcher[] = [];
  private codexDirWatcher: fs.FSWatcher | null = null;
  private homeCodexParentWatcher: fs.FSWatcher | null = null;
  private watchedProfileSubdirs = new Map<string, fs.FSWatcher>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private unmuteTimer: NodeJS.Timeout | null = null;
  private activityDebounceTimer: NodeJS.Timeout | null = null;
  private pendingActivityDirKind: 'conversations' | 'annotations' | null = null;
  private pendingActivityAppDataDir: 'antigravity' | 'antigravity-ide' | undefined;
  private pendingActivityConvIds = new Set<string>();
  private pendingMutedEvent = false;
  private mutedUntil = 0;
  private disposed = false;
  private started = false;
  private lastWatchedStateActiveKey: string | null = null;
  private readonly startedAt = Date.now();
  private readonly onChangeCallback: () => void;
  private readonly shouldWatchIdeStorage?: () => boolean;
  private readonly onAntigravityActivity?: (info: AntigravityActivityInfo) => void;
  private readonly antigravityActivitySubdirs: Set<string>;

  constructor(
    onChange: () => void,
    options?: {
      shouldWatchIdeStorage?: () => boolean;
      onAntigravityActivity?: (info: AntigravityActivityInfo) => void;
      antigravityActivitySubdirs?: string[];
    }
  ) {
    this.onChangeCallback = onChange;
    this.shouldWatchIdeStorage = options?.shouldWatchIdeStorage;
    this.onAntigravityActivity = options?.onAntigravityActivity;
    this.antigravityActivitySubdirs = new Set(
      options?.antigravityActivitySubdirs && options.antigravityActivitySubdirs.length > 0
        ? options.antigravityActivitySubdirs
        : ['antigravity', 'antigravity-ide']
    );
    this.start();
  }

  public muteFor(durationMs: number): void {
    this.mutedUntil = Math.max(this.mutedUntil, Date.now() + durationMs);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.scheduleUnmuteCheck();
  }

  public shortenMute(maxRemainingMs = 250): void {
    const cap = Date.now() + Math.max(0, maxRemainingMs);
    if (this.mutedUntil > cap) {
      this.mutedUntil = cap;
      this.scheduleUnmuteCheck();
    }
  }

  private scheduleUnmuteCheck(): void {
    if (this.unmuteTimer) {
      clearTimeout(this.unmuteTimer);
      this.unmuteTimer = null;
    }
    const remaining = this.mutedUntil - Date.now();
    if (remaining <= 0) return;
    this.unmuteTimer = setTimeout(() => {
      this.unmuteTimer = null;
      if (this.pendingMutedEvent && Date.now() >= this.mutedUntil) {
        this.pendingMutedEvent = false;
        this.triggerDebounced();
      }
    }, remaining + 60);
  }

  private trackWatcher(w: fs.FSWatcher, onError?: () => void): void {
    try {
      w.on('error', () => {
        try {
          w.close();
        } catch {}
        const idx = this.watchers.indexOf(w);
        if (idx >= 0) this.watchers.splice(idx, 1);
        if (!this.disposed) {
          try {
            onError?.();
          } catch {}
        }
      });
    } catch {}
    this.watchers.push(w);
  }

  private attachCodexWatcher(codexDir: string): boolean {
    if (this.codexDirWatcher) return true;
    if (!fs.existsSync(codexDir)) return false;
    try {
      const w = fs.watch(codexDir, (_eventType, filename) => {
        const name = filename ? filename.toString().toLowerCase() : '';
        if (
          !name ||
          name === 'auth.json' ||
          (name.includes('auth.json') && !name.endsWith('.tmp'))
        ) {
          this.triggerDebounced();
        }
      });
      this.codexDirWatcher = w;
      this.trackWatcher(w, () => {
        if (this.codexDirWatcher === w) {
          this.codexDirWatcher = null;
        }
        this.watchWhenCreated(codexDir, () => {
          if (this.attachCodexWatcher(codexDir) && fs.existsSync(path.join(codexDir, 'auth.json'))) {
            this.triggerDebounced();
          }
        });
      });
      return true;
    } catch (err) {
      console.warn('[Charlier] Could not attach fs.watch to .codex directory:', err);
      return false;
    }
  }

  private watchWhenCreated(targetDir: string, onExists: () => void): void {
    if (this.disposed) return;
    if (fs.existsSync(targetDir)) {
      onExists();
      return;
    }

    let ancestor = path.dirname(targetDir);
    while (ancestor && !fs.existsSync(ancestor)) {
      const next = path.dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
    if (!ancestor || !fs.existsSync(ancestor)) return;

    // Step down one path segment at a time so nested parent creation (for example
    // .gemini -> antigravity -> daemon) is never missed while watching an ancestor.
    const rel = path.relative(ancestor, targetDir);
    const firstMissingSegment = rel.split(path.sep).find(Boolean);
    const nextTarget = firstMissingSegment
      ? path.join(ancestor, firstMissingSegment)
      : targetDir;

    try {
      let handled = false;
      const pw = fs.watch(ancestor, () => {
        if (handled || this.disposed) {
          try {
            pw.close();
          } catch {}
          return;
        }
        if (fs.existsSync(targetDir)) {
          handled = true;
          try {
            pw.close();
          } catch {}
          onExists();
          return;
        }
        if (nextTarget !== targetDir && fs.existsSync(nextTarget)) {
          handled = true;
          try {
            pw.close();
          } catch {}
          this.watchWhenCreated(targetDir, onExists);
        }
      });
      this.trackWatcher(pw);
    } catch {}
  }

  public start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const geminiDir = getGeminiHomeDir();
    const attachGeminiAndSubdirs = () => {
      if (fs.existsSync(geminiDir)) {
        try {
          const w = fs.watch(geminiDir, (_eventType, filename) => {
            const name = filename ? filename.toString().toLowerCase() : '';
            if (
              !name ||
              name === 'google_accounts.json' ||
              name === 'oauth_creds.json' ||
              name === 'jetski-standalone-oauth-token'
            ) {
              this.triggerDebounced();
            }
          });
          this.trackWatcher(w);
        } catch (err) {
          console.warn('[Charlier] Could not attach fs.watch to .gemini directory:', err);
        }
      }

      for (const subName of ['antigravity', 'antigravity-ide'] as const) {
        const antigravityDir = path.join(geminiDir, subName);
        const attachAntigravitySubdir = () => {
          if (this.disposed || !fs.existsSync(antigravityDir)) return;
          try {
            const w = fs.watch(antigravityDir, (_eventType, filename) => {
              const name = filename ? filename.toString().toLowerCase() : '';
              if (
                !name ||
                name === 'google_accounts.json' ||
                name === 'oauth_creds.json' ||
                name === 'antigravity_state.pbtxt'
              ) {
                this.triggerDebounced();
              }
            });
            this.trackWatcher(w);
          } catch {}

          const daemonDir = path.join(antigravityDir, 'daemon');
          const attachDaemonDir = () => {
            if (this.disposed || !fs.existsSync(daemonDir)) return;
            try {
              const dw = fs.watch(daemonDir, (_eventType, filename) => {
                const name = filename ? filename.toString().toLowerCase() : '';
                if (!name || (name.startsWith('hub_') && name.endsWith('.json'))) {
                  this.triggerDebounced();
                }
              });
              this.trackWatcher(dw);
            } catch {}
          };

          if (fs.existsSync(daemonDir)) {
            attachDaemonDir();
          } else {
            this.watchWhenCreated(daemonDir, () => {
              attachDaemonDir();
              this.triggerDebounced();
            });
          }

          if (this.onAntigravityActivity && this.antigravityActivitySubdirs.has(subName)) {
            for (const activitySub of ['conversations', 'annotations'] as const) {
              const actDir = path.join(antigravityDir, activitySub);
              const attachActivityDir = () => {
                if (this.disposed || !fs.existsSync(actDir)) return;
                try {
                  const aw = fs.watch(actDir, (_eventType, filename) => {
                    const name = filename ? filename.toString() : '';
                    const lowerName = name.toLowerCase();
                    if (
                      lowerName.endsWith('.tmp') ||
                      lowerName.endsWith('.lock') ||
                      lowerName.endsWith('.done') ||
                      lowerName.endsWith('-shm') ||
                      lowerName.endsWith('.shm')
                    ) {
                      return;
                    }
                    const convId = name ? extractConversationIdFromFilename(name) : null;
                    this.triggerActivityDebounced(activitySub, subName, convId);
                  });
                  this.trackWatcher(aw);
                } catch {}
              };
              if (fs.existsSync(actDir)) {
                attachActivityDir();
              } else {
                this.watchWhenCreated(actDir, attachActivityDir);
              }
            }
          }
        };

        if (fs.existsSync(antigravityDir)) {
          attachAntigravitySubdir();
        } else {
          this.watchWhenCreated(antigravityDir, () => {
            attachAntigravitySubdir();
            this.triggerDebounced();
          });
        }
      }
    };

    if (fs.existsSync(geminiDir)) {
      attachGeminiAndSubdirs();
    } else {
      this.watchWhenCreated(geminiDir, () => {
        attachGeminiAndSubdirs();
        this.triggerDebounced();
      });
    }

    for (const storageDir of getIdeGlobalStorageDirs()) {
      if (fs.existsSync(storageDir)) {
        try {
          const sw = fs.watch(storageDir, (_eventType, filename) => {
            if (!this.shouldWatchIdeStorage?.()) {
              return;
            }
            const name = filename ? filename.toString().toLowerCase() : '';
            if (name === 'state.vscdb' || name === 'state.vscdb-wal') {
              this.triggerDebounced();
            }
          });
          this.trackWatcher(sw);
        } catch {}
      }
    }

    const codexDir = getCodexHomeDir();
    if (!this.attachCodexWatcher(codexDir)) {
      this.watchWhenCreated(codexDir, () => {
        if (this.attachCodexWatcher(codexDir)) {
          if (fs.existsSync(path.join(codexDir, 'auth.json'))) {
            this.triggerDebounced();
          }
        }
      });
    }

    for (const profilesDir of [getProfilesDir(), getCodexProfilesDir()]) {
      if (fs.existsSync(profilesDir)) {
        this.watchProfilesDirectory(profilesDir);
      } else {
        this.watchWhenCreated(profilesDir, () => {
          this.watchProfilesDirectory(profilesDir);
          this.triggerDebounced();
        });
      }
    }

    const charlierDir = path.dirname(getProfilesDir());
    const readStateActiveKey = (): string => {
      try {
        const statePath = path.join(charlierDir, 'state.json');
        if (!fs.existsSync(statePath)) return '|';
        const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        return `${s?.activeProfileId || ''}|${s?.activeCodexProfileId || ''}`;
      } catch {
        return '|';
      }
    };
    this.lastWatchedStateActiveKey = readStateActiveKey();
    const attachStateWatcher = () => {
      if (this.disposed || !fs.existsSync(charlierDir)) return;
      try {
        const sw = fs.watch(charlierDir, (_eventType, filename) => {
          const name = filename ? filename.toString().toLowerCase() : '';
          if (!name || name === 'state.json') {
            const nextKey = readStateActiveKey();
            if (nextKey !== this.lastWatchedStateActiveKey) {
              this.lastWatchedStateActiveKey = nextKey;
              this.triggerDebounced();
            }
          }
        });
        this.trackWatcher(sw);
      } catch {}
    };
    if (fs.existsSync(charlierDir)) {
      attachStateWatcher();
    } else {
      this.watchWhenCreated(charlierDir, () => {
        attachStateWatcher();
      });
    }
  }

  private watchProfilesDirectory(profilesDir: string): void {
    const filterAndTrigger = (_eventType: string, filename: string | Buffer | null) => {
      if (!filename) return;
      const name = filename.toString();
      if (
        name.endsWith('metadata.json') ||
        name.endsWith('auth.json') ||
        name.endsWith('oauth_creds.json') ||
        name.endsWith('keyring_credential.json') ||
        name.endsWith('google_accounts.json') ||
        name.endsWith('.tmp')
      ) {
        return;
      }
      this.triggerDebounced();
    };

    // macOS (FSEvents) and Windows support recursive fs.watch natively.
    // On Linux, inotify throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM for { recursive: true },
    // so we attach a parent directory watcher plus per-profile subdirectory watchers.
    if (process.platform === 'win32' || process.platform === 'darwin') {
      try {
        const w = fs.watch(profilesDir, { recursive: true }, filterAndTrigger);
        this.trackWatcher(w);
        return;
      } catch {}
    }

    try {
      const parentWatcher = fs.watch(profilesDir, (eventType, filename) => {
        this.syncProfileSubdirWatchers(profilesDir, filterAndTrigger);
        filterAndTrigger(eventType, filename);
      });
      this.trackWatcher(parentWatcher);
      this.syncProfileSubdirWatchers(profilesDir, filterAndTrigger);
    } catch (err) {
      console.warn('[Charlier] Could not attach fs.watch to profiles directory:', err);
    }
  }

  private syncProfileSubdirWatchers(
    profilesDir: string,
    handler: (eventType: string, filename: string | Buffer | null) => void
  ): void {
    try {
      const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
      const activeSubPaths = new Set<string>();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const subPath = path.join(profilesDir, entry.name);
        activeSubPaths.add(subPath);
        if (this.watchedProfileSubdirs.has(subPath)) continue;
        try {
          const subWatcher = fs.watch(subPath, handler);
          subWatcher.on('error', () => {
            try {
              subWatcher.close();
            } catch {}
            if (this.watchedProfileSubdirs.get(subPath) === subWatcher) {
              this.watchedProfileSubdirs.delete(subPath);
            }
          });
          this.watchedProfileSubdirs.set(subPath, subWatcher);
        } catch {}
      }

      for (const [watchedPath, subWatcher] of this.watchedProfileSubdirs.entries()) {
        if (
          (watchedPath === profilesDir || watchedPath.startsWith(profilesDir + path.sep)) &&
          !activeSubPaths.has(watchedPath)
        ) {
          try {
            subWatcher.close();
          } catch {}
          this.watchedProfileSubdirs.delete(watchedPath);
        }
      }
    } catch {}
  }

  private triggerActivityDebounced(
    dirKind: 'conversations' | 'annotations',
    appDataDir: 'antigravity' | 'antigravity-ide',
    conversationId: string | null
  ): void {
    if (this.disposed || !this.onAntigravityActivity) return;
    if (Date.now() - this.startedAt < 2000) return;
    if (dirKind === 'conversations' || !this.pendingActivityDirKind) {
      this.pendingActivityDirKind = dirKind;
      this.pendingActivityAppDataDir = appDataDir;
    } else if (!this.pendingActivityAppDataDir) {
      this.pendingActivityAppDataDir = appDataDir;
    }
    if (conversationId) {
      this.pendingActivityConvIds.add(conversationId);
    }
    if (this.activityDebounceTimer) {
      clearTimeout(this.activityDebounceTimer);
    }
    this.activityDebounceTimer = setTimeout(() => {
      this.activityDebounceTimer = null;
      const batchKind = this.pendingActivityDirKind || dirKind;
      const batchAppDataDir = this.pendingActivityAppDataDir || appDataDir;
      const batchIds = Array.from(this.pendingActivityConvIds);
      this.pendingActivityDirKind = null;
      this.pendingActivityAppDataDir = undefined;
      this.pendingActivityConvIds.clear();
      if (this.disposed) return;
      this.onAntigravityActivity?.({
        dirKind: batchKind,
        appDataDir: batchAppDataDir,
        conversationIds: batchIds
      });
    }, 35);
    (this.activityDebounceTimer as any)?.unref?.();
  }

  private triggerDebounced(): void {
    if (this.disposed) return;
    if (Date.now() < this.mutedUntil) {
      this.pendingMutedEvent = true;
      this.scheduleUnmuteCheck();
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    const delayMs = this.shouldWatchIdeStorage?.() ? 45 : 150;
    this.debounceTimer = setTimeout(() => {
      if (this.disposed) return;
      if (Date.now() < this.mutedUntil) {
        this.pendingMutedEvent = true;
        this.scheduleUnmuteCheck();
        return;
      }
      this.pendingMutedEvent = false;
      this.onChangeCallback();
    }, delayMs);
  }

  public dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.unmuteTimer) {
      clearTimeout(this.unmuteTimer);
      this.unmuteTimer = null;
    }
    if (this.activityDebounceTimer) {
      clearTimeout(this.activityDebounceTimer);
      this.activityDebounceTimer = null;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {}
    }
    for (const w of this.watchedProfileSubdirs.values()) {
      try {
        w.close();
      } catch {}
    }
    this.watchers = [];
    this.codexDirWatcher = null;
    this.homeCodexParentWatcher = null;
    this.watchedProfileSubdirs.clear();
  }
}
