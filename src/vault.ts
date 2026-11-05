import * as fs from 'fs';
import * as path from 'path';
import {
  getActiveGoogleAccountsPath,
  getActiveOAuthCredsPath,
  getProfilesDir,
  getStateFilePath
} from './constants';
import { ProfileMetadata, CharlierState, LiveSessionInfo, CachedQuotaMetric } from './types';
import { KeyringManager } from './keyring';

export class Vault {
  private keyring: KeyringManager;
  private cachedLiveSession: LiveSessionInfo | null = null;
  private cachedLiveSessionTime = 0;

  constructor(keyring: KeyringManager) {
    this.keyring = keyring;
    this.ensureDirectories();
  }

  public invalidateLiveSessionCache(): void {
    this.cachedLiveSession = null;
    this.cachedLiveSessionTime = 0;
  }

  public ensureDirectories(): void {
    const profilesDir = getProfilesDir();
    if (!fs.existsSync(profilesDir)) {
      fs.mkdirSync(profilesDir, { recursive: true });
    }
  }

  public getLiveSessionInfo(force = false): LiveSessionInfo {
    const now = Date.now();
    if (!force && this.cachedLiveSession && now - this.cachedLiveSessionTime < 4000) {
      return this.cachedLiveSession;
    }

    let email: string | null = null;
    let tokenExpiryDate: number | null = null;
    let hasOAuthCreds = false;
    let hasRefreshToken = false;

    // Fast path: inspect google_accounts.json first (0.05ms)
    const accountsPath = getActiveGoogleAccountsPath();
    if (fs.existsSync(accountsPath)) {
      try {
        const raw = fs.readFileSync(accountsPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed?.active === 'string' && parsed.active.trim()) {
          email = parsed.active.trim();
        }
      } catch {}
    }

    // Fast path: inspect oauth_creds.json (0.05ms)
    const oauthPath = getActiveOAuthCredsPath();
    if (fs.existsSync(oauthPath)) {
      try {
        const raw = fs.readFileSync(oauthPath, 'utf8');
        const parsed = JSON.parse(raw);
        hasOAuthCreds = true;
        if (parsed?.refresh_token) {
          hasRefreshToken = true;
        }
        if (typeof parsed?.expiry_date === 'number') {
          tokenExpiryDate = parsed.expiry_date;
        }
      } catch {}
    }

    // Only if disk information is missing do we query OS Keyring fallback
    if (!email || !hasOAuthCreds) {
      const keyringRaw = this.keyring.read();
      if (keyringRaw) {
        try {
          const parsedKeyring = JSON.parse(keyringRaw);
          if (!email && typeof parsedKeyring.id_token_email === 'string' && parsedKeyring.id_token_email.trim()) {
            email = parsedKeyring.id_token_email.trim();
          }
          if (parsedKeyring.token) {
            hasOAuthCreds = true;
            if (parsedKeyring.token.refresh_token) {
              hasRefreshToken = true;
            }
            if (typeof parsedKeyring.token.expiry === 'string' && !tokenExpiryDate) {
              tokenExpiryDate = new Date(parsedKeyring.token.expiry).getTime();
            }
          }
        } catch {}
      }
    }

    const isExpired = hasOAuthCreds && !hasRefreshToken && tokenExpiryDate !== null && tokenExpiryDate <= now;

    this.cachedLiveSession = {
      email,
      hasOAuthCreds,
      tokenExpiryDate,
      isExpired
    };
    this.cachedLiveSessionTime = now;

    return this.cachedLiveSession;
  }

  public listProfiles(): ProfileMetadata[] {
    this.ensureDirectories();
    const profilesDir = getProfilesDir();
    const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
    const profiles: ProfileMetadata[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const metaPath = path.join(profilesDir, entry.name, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          try {
            const raw = fs.readFileSync(metaPath, 'utf8');
            const parsed = JSON.parse(raw) as ProfileMetadata;
            profiles.push(parsed);
          } catch {
            // Skip damaged metadata
          }
        }
      }
    }

    return profiles.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public getProfile(id: string): ProfileMetadata | null {
    const metaPath = path.join(getProfilesDir(), id, 'metadata.json');
    if (!fs.existsSync(metaPath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ProfileMetadata;
    } catch {
      return null;
    }
  }

  public getState(): CharlierState {
    const stateFile = getStateFilePath();
    if (fs.existsSync(stateFile)) {
      try {
        return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as CharlierState;
      } catch {
        // Fallback
      }
    }
    return { activeProfileId: null, lastUpdated: 0 };
  }

  public saveState(state: CharlierState): void {
    const stateFile = getStateFilePath();
    const dir = path.dirname(stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
  }

  public updateProfileCredentials(id: string, newName?: string): ProfileMetadata {
    const existing = this.getProfile(id);
    if (!existing) {
      throw new Error(`Profile "${id}" does not exist.`);
    }

    const live = this.getLiveSessionInfo();
    const accountsPath = getActiveGoogleAccountsPath();
    const oauthPath = getActiveOAuthCredsPath();
    const keyringSecret = this.keyring.read();

    const profileFolder = path.join(getProfilesDir(), id);
    if (!fs.existsSync(profileFolder)) {
      fs.mkdirSync(profileFolder, { recursive: true });
    }

    const targetAccounts = path.join(profileFolder, 'google_accounts.json');
    const targetOAuth = path.join(profileFolder, 'oauth_creds.json');
    const targetKeyring = path.join(profileFolder, 'keyring_credential.json');
    const targetMeta = path.join(profileFolder, 'metadata.json');

    if (fs.existsSync(accountsPath)) {
      fs.copyFileSync(accountsPath, targetAccounts);
    }
    if (fs.existsSync(oauthPath)) {
      fs.copyFileSync(oauthPath, targetOAuth);
    }
    if (keyringSecret) {
      fs.writeFileSync(targetKeyring, keyringSecret, 'utf8');
    }

    const now = Date.now();
    const metadata: ProfileMetadata = {
      id: existing.id,
      name: newName && newName.trim() ? newName.trim() : existing.name,
      email: live.email || existing.email,
      createdAt: existing.createdAt,
      updatedAt: now,
      tokenExpiryDate: live.tokenExpiryDate || existing.tokenExpiryDate
    };

    fs.writeFileSync(targetMeta, JSON.stringify(metadata, null, 2), 'utf8');
    this.saveState({ activeProfileId: id, lastUpdated: now });
    this.invalidateLiveSessionCache();

    return metadata;
  }

  public saveCurrentAsProfile(name: string): ProfileMetadata {
    const live = this.getLiveSessionInfo();
    const accountsPath = getActiveGoogleAccountsPath();
    const oauthPath = getActiveOAuthCredsPath();
    const keyringSecret = this.keyring.read();

    if (!fs.existsSync(accountsPath) && !fs.existsSync(oauthPath) && !keyringSecret) {
      throw new Error('No active Antigravity credentials found to save.');
    }

    // Smart hybrid merge: if profile with same email exists, merge tokens and update name
    if (live.email) {
      const existing = this.listProfiles().find(
        (p) => p.email.toLowerCase() === live.email!.toLowerCase()
      );
      if (existing) {
        return this.updateProfileCredentials(existing.id, name);
      }
    }

    const id = this.slugify(name);
    const profileFolder = path.join(getProfilesDir(), id);
    if (!fs.existsSync(profileFolder)) {
      fs.mkdirSync(profileFolder, { recursive: true });
    }

    const targetAccounts = path.join(profileFolder, 'google_accounts.json');
    const targetOAuth = path.join(profileFolder, 'oauth_creds.json');
    const targetKeyring = path.join(profileFolder, 'keyring_credential.json');
    const targetMeta = path.join(profileFolder, 'metadata.json');

    if (fs.existsSync(accountsPath)) {
      fs.copyFileSync(accountsPath, targetAccounts);
    }
    if (fs.existsSync(oauthPath)) {
      fs.copyFileSync(oauthPath, targetOAuth);
    }
    if (keyringSecret) {
      fs.writeFileSync(targetKeyring, keyringSecret, 'utf8');
    }

    const existing = this.getProfile(id);
    const now = Date.now();
    const metadata: ProfileMetadata = {
      id,
      name,
      email: live.email || 'Unknown',
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      tokenExpiryDate: live.tokenExpiryDate || undefined
    };

    fs.writeFileSync(targetMeta, JSON.stringify(metadata, null, 2), 'utf8');
    this.saveState({ activeProfileId: id, lastUpdated: now });
    this.invalidateLiveSessionCache();

    return metadata;
  }

  public async switchProfile(id: string): Promise<ProfileMetadata> {
    const profileFolder = path.join(getProfilesDir(), id);
    const sourceAccounts = path.join(profileFolder, 'google_accounts.json');
    const sourceOAuth = path.join(profileFolder, 'oauth_creds.json');
    const sourceKeyring = path.join(profileFolder, 'keyring_credential.json');
    const sourceMeta = path.join(profileFolder, 'metadata.json');

    if (!fs.existsSync(sourceMeta)) {
      throw new Error(`Profile "${id}" does not exist.`);
    }

    const meta = JSON.parse(fs.readFileSync(sourceMeta, 'utf8')) as ProfileMetadata;

    const accountsPath = getActiveGoogleAccountsPath();
    const oauthPath = getActiveOAuthCredsPath();

    // 1. Instantaneous atomic file replacement on disk stores (0.05ms)
    if (fs.existsSync(sourceAccounts)) {
      this.atomicWriteFile(accountsPath, fs.readFileSync(sourceAccounts));
    } else if (fs.existsSync(accountsPath)) {
      try {
        fs.unlinkSync(accountsPath);
      } catch {}
    }

    if (fs.existsSync(sourceOAuth)) {
      this.atomicWriteFile(oauthPath, fs.readFileSync(sourceOAuth));
    } else if (fs.existsSync(oauthPath)) {
      try {
        fs.unlinkSync(oauthPath);
      } catch {}
    }

    this.saveState({ activeProfileId: id, lastUpdated: Date.now() });
    this.invalidateLiveSessionCache();

    // 2. Non-blocking OS Keyring swap
    if (fs.existsSync(sourceKeyring)) {
      const secret = fs.readFileSync(sourceKeyring, 'utf8');
      await this.keyring.writeAsync(secret);
    } else {
      await this.keyring.deleteAsync();
    }

    return meta;
  }

  public deleteProfile(id: string): void {
    const profileFolder = path.join(getProfilesDir(), id);
    if (fs.existsSync(profileFolder)) {
      fs.rmSync(profileFolder, { recursive: true, force: true });
    }
    const state = this.getState();
    if (state.activeProfileId === id) {
      this.saveState({ activeProfileId: null, lastUpdated: Date.now() });
    }
    this.invalidateLiveSessionCache();
  }

  public renameProfile(id: string, newName: string): ProfileMetadata {
    const trimmed = newName.trim();
    if (!trimmed) {
      throw new Error('Profile name cannot be empty.');
    }
    const metaPath = path.join(getProfilesDir(), id, 'metadata.json');
    if (!fs.existsSync(metaPath)) {
      throw new Error(`Profile "${id}" does not exist.`);
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ProfileMetadata;
    meta.name = trimmed;
    meta.updatedAt = Date.now();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    return meta;
  }

  public updateProfileCachedQuota(id: string, cachedQuota: CachedQuotaMetric): void {
    const metaPath = path.join(getProfilesDir(), id, 'metadata.json');
    if (!fs.existsSync(metaPath)) return;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ProfileMetadata;
      if (
        meta.cachedQuota &&
        meta.cachedQuota.plan === cachedQuota.plan &&
        meta.cachedQuota.gemini === cachedQuota.gemini &&
        meta.cachedQuota.claudeGpt === cachedQuota.claudeGpt &&
        meta.cachedQuota.argon === cachedQuota.argon
      ) {
        return;
      }
      meta.cachedQuota = cachedQuota;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    } catch {}
  }

  public prepareNewLogin(): void {
    // 1. Back up current active if email present: smart merge into existing profile if known
    const live = this.getLiveSessionInfo();
    if (live.email) {
      const existing = this.listProfiles().find(
        (p) => p.email.toLowerCase() === live.email!.toLowerCase()
      );
      if (existing) {
        // Merge newest tokens while preserving user's custom profile name!
        this.updateProfileCredentials(existing.id);
      } else {
        const defaultName = live.email.includes('@') ? live.email.split('@')[0] : live.email;
        this.saveCurrentAsProfile(defaultName);
      }
    }

    // 2. Clear OS Keyring credential (this is what Antigravity checks!)
    this.keyring.delete();

    // 3. Clear disk credentials
    const accountsPath = getActiveGoogleAccountsPath();
    const oauthPath = getActiveOAuthCredsPath();

    if (fs.existsSync(oauthPath)) {
      fs.unlinkSync(oauthPath);
    }
    if (fs.existsSync(accountsPath)) {
      try {
        const raw = fs.readFileSync(accountsPath, 'utf8');
        const parsed = JSON.parse(raw);
        parsed.active = '';
        this.atomicWriteFile(accountsPath, Buffer.from(JSON.stringify(parsed, null, 2), 'utf8'));
      } catch {
        fs.unlinkSync(accountsPath);
      }
    }

    this.saveState({ activeProfileId: null, lastUpdated: Date.now() });
    this.invalidateLiveSessionCache();
  }

  private atomicWriteFile(targetPath: string, data: Buffer): void {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${targetPath}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, data);
    try {
      fs.renameSync(tmpPath, targetPath);
    } catch {
      // On Windows EPERM or file lock fallback to copyFileSync
      fs.copyFileSync(tmpPath, targetPath);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore tmp cleanup error
      }
    }
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || `profile-${Date.now()}`;
  }
}
