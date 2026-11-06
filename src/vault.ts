import * as fs from 'fs';
import * as path from 'path';
import {
  getActiveGoogleAccountsPath,
  getActiveOAuthCredsPath,
  getProfilesDir,
  getStateFilePath
} from './constants';
import {
  ProfileMetadata,
  CharlierState,
  LiveSessionInfo,
  CachedQuotaMetric,
  PrepareNewLoginResult
} from './types';
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

  private parseDiskSessionState(): {
    email: string | null;
    tokenExpiryDate: number | null;
    hasOAuthCreds: boolean;
    hasRefreshToken: boolean;
  } {
    let email: string | null = null;
    let tokenExpiryDate: number | null = null;
    let hasOAuthCreds = false;
    let hasRefreshToken = false;

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

    return { email, tokenExpiryDate, hasOAuthCreds, hasRefreshToken };
  }

  private applyKeyringFallback(
    keyringRaw: string | null,
    state: {
      email: string | null;
      tokenExpiryDate: number | null;
      hasOAuthCreds: boolean;
      hasRefreshToken: boolean;
    }
  ): void {
    if (!keyringRaw) return;
    try {
      const parsedKeyring = JSON.parse(keyringRaw);
      const keyringEmail =
        typeof parsedKeyring?.id_token_email === 'string' && parsedKeyring.id_token_email.trim()
          ? parsedKeyring.id_token_email.trim()
          : null;

      if (!state.email && keyringEmail) {
        state.email = keyringEmail;
        // Self-heal google_accounts.json on disk so future calls resolve in 0.05ms without touching PowerShell
        try {
          const accountsPath = getActiveGoogleAccountsPath();
          this.atomicWriteFile(
            accountsPath,
            Buffer.from(JSON.stringify({ active: keyringEmail, old: [] }, null, 2), 'utf8')
          );
        } catch {}
      }

      if (parsedKeyring?.token) {
        state.hasOAuthCreds = true;
        if (parsedKeyring.token.refresh_token) {
          state.hasRefreshToken = true;
        }
        if (typeof parsedKeyring.token.expiry === 'string' && !state.tokenExpiryDate) {
          const parsedTime = new Date(parsedKeyring.token.expiry).getTime();
          if (Number.isFinite(parsedTime)) {
            state.tokenExpiryDate = parsedTime;
          }
        }
        // Self-heal missing oauth_creds.json on disk if keyring holds valid token
        const oauthPath = getActiveOAuthCredsPath();
        if (!fs.existsSync(oauthPath) && parsedKeyring.token.access_token) {
          try {
            const synthesized = this.synthesizeOAuthCredsFromKeyring(parsedKeyring);
            if (synthesized) {
              this.atomicWriteFile(oauthPath, Buffer.from(JSON.stringify(synthesized, null, 2), 'utf8'));
            }
          } catch {}
        }
      }
    } catch {}
  }

  private synthesizeOAuthCredsFromKeyring(parsedKeyring: any): Record<string, any> | null {
    const tok = parsedKeyring?.token;
    if (!tok || (!tok.access_token && !tok.refresh_token)) return null;
    const expiryMs =
      typeof tok.expiry === 'string' && Number.isFinite(new Date(tok.expiry).getTime())
        ? new Date(tok.expiry).getTime()
        : Date.now() + 3600 * 1000;
    return {
      access_token: tok.access_token || '',
      refresh_token: tok.refresh_token || '',
      token_type: tok.token_type || 'Bearer',
      expiry_date: expiryMs
    };
  }

  public getLiveSessionInfo(force = false): LiveSessionInfo {
    const now = Date.now();
    if (!force && this.cachedLiveSession && now - this.cachedLiveSessionTime < 4000) {
      return this.cachedLiveSession;
    }

    const disk = this.parseDiskSessionState();

    // Only if disk information is missing do we query OS Keyring fallback
    if (!disk.email || !disk.hasOAuthCreds) {
      const keyringRaw = this.keyring.read();
      this.applyKeyringFallback(keyringRaw, disk);
    }

    const isExpired =
      disk.hasOAuthCreds &&
      !disk.hasRefreshToken &&
      disk.tokenExpiryDate !== null &&
      disk.tokenExpiryDate <= now;

    this.cachedLiveSession = {
      email: disk.email,
      hasOAuthCreds: disk.hasOAuthCreds,
      tokenExpiryDate: disk.tokenExpiryDate,
      isExpired
    };
    this.cachedLiveSessionTime = now;

    return this.cachedLiveSession;
  }

  public async getLiveSessionInfoAsync(force = false): Promise<LiveSessionInfo> {
    const now = Date.now();
    if (!force && this.cachedLiveSession && now - this.cachedLiveSessionTime < 4000) {
      return this.cachedLiveSession;
    }

    const disk = this.parseDiskSessionState();

    if (!disk.email || !disk.hasOAuthCreds) {
      const keyringRaw = await this.keyring.readAsync();
      this.applyKeyringFallback(keyringRaw, disk);
    }

    const isExpired =
      disk.hasOAuthCreds &&
      !disk.hasRefreshToken &&
      disk.tokenExpiryDate !== null &&
      disk.tokenExpiryDate <= now;

    this.cachedLiveSession = {
      email: disk.email,
      hasOAuthCreds: disk.hasOAuthCreds,
      tokenExpiryDate: disk.tokenExpiryDate,
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

  private persistProfileFiles(
    id: string,
    name: string,
    resolvedEmail: string,
    live: LiveSessionInfo,
    keyringSecret: string | null,
    existing: ProfileMetadata | null
  ): ProfileMetadata {
    const accountsPath = getActiveGoogleAccountsPath();
    const oauthPath = getActiveOAuthCredsPath();

    const profileFolder = path.join(getProfilesDir(), id);
    if (!fs.existsSync(profileFolder)) {
      fs.mkdirSync(profileFolder, { recursive: true });
    }

    const targetAccounts = path.join(profileFolder, 'google_accounts.json');
    const targetOAuth = path.join(profileFolder, 'oauth_creds.json');
    const targetKeyring = path.join(profileFolder, 'keyring_credential.json');
    const targetMeta = path.join(profileFolder, 'metadata.json');

    // Never store an empty active email in google_accounts.json
    const validEmail = resolvedEmail && resolvedEmail !== 'Unknown' ? resolvedEmail : existing?.email || '';
    const cleanAccountsPayload = JSON.stringify({ active: validEmail, old: [] }, null, 2);
    fs.writeFileSync(targetAccounts, cleanAccountsPayload, 'utf8');

    // Also ensure active google_accounts.json is healed if it matches
    if (validEmail) {
      try {
        this.atomicWriteFile(accountsPath, Buffer.from(cleanAccountsPayload, 'utf8'));
      } catch {}
    }

    if (fs.existsSync(oauthPath)) {
      fs.copyFileSync(oauthPath, targetOAuth);
    } else if (keyringSecret) {
      try {
        const parsedKr = JSON.parse(keyringSecret);
        const synthesized = this.synthesizeOAuthCredsFromKeyring(parsedKr);
        if (synthesized) {
          fs.writeFileSync(targetOAuth, JSON.stringify(synthesized, null, 2), 'utf8');
        }
      } catch {}
    }

    if (keyringSecret) {
      fs.writeFileSync(targetKeyring, keyringSecret, 'utf8');
    }

    const now = Date.now();
    const metadata: ProfileMetadata = {
      id,
      name: name.trim(),
      email: validEmail || 'Unknown',
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      tokenExpiryDate: live.tokenExpiryDate || existing?.tokenExpiryDate,
      ...(existing?.planOverride ? { planOverride: existing.planOverride } : {}),
      ...(existing?.cachedQuota ? { cachedQuota: existing.cachedQuota } : {})
    };

    fs.writeFileSync(targetMeta, JSON.stringify(metadata, null, 2), 'utf8');
    this.saveState({ activeProfileId: id, lastUpdated: now });
    this.invalidateLiveSessionCache();

    return metadata;
  }

  public updateProfileCredentials(id: string, newName?: string): ProfileMetadata {
    const existing = this.getProfile(id);
    if (!existing) {
      throw new Error(`Profile "${id}" does not exist.`);
    }

    const live = this.getLiveSessionInfo();
    const keyringSecret = this.keyring.read();
    const targetName = newName && newName.trim() ? newName.trim() : existing.name;
    const resolvedEmail = live.email || existing.email;

    return this.persistProfileFiles(id, targetName, resolvedEmail, live, keyringSecret, existing);
  }

  public async updateProfileCredentialsAsync(id: string, newName?: string): Promise<ProfileMetadata> {
    const existing = this.getProfile(id);
    if (!existing) {
      throw new Error(`Profile "${id}" does not exist.`);
    }

    const live = await this.getLiveSessionInfoAsync();
    const keyringSecret = await this.keyring.readAsync();
    const targetName = newName && newName.trim() ? newName.trim() : existing.name;
    const resolvedEmail = live.email || existing.email;

    return this.persistProfileFiles(id, targetName, resolvedEmail, live, keyringSecret, existing);
  }

  public saveCurrentAsProfile(name: string): ProfileMetadata {
    const live = this.getLiveSessionInfo();
    const accountsPath = getActiveGoogleAccountsPath();
    const oauthPath = getActiveOAuthCredsPath();
    const keyringSecret = this.keyring.read();

    if (!fs.existsSync(accountsPath) && !fs.existsSync(oauthPath) && !keyringSecret) {
      throw new Error('No active Antigravity credentials found to save.');
    }

    if (live.email) {
      const existingByEmail = this.listProfiles().find(
        (p) => p.email.toLowerCase() === live.email!.toLowerCase()
      );
      if (existingByEmail) {
        return this.persistProfileFiles(
          existingByEmail.id,
          name,
          live.email,
          live,
          keyringSecret,
          existingByEmail
        );
      }
    }

    const id = this.slugify(name);
    const existingById = this.getProfile(id);
    return this.persistProfileFiles(
      id,
      name,
      live.email || existingById?.email || 'Unknown',
      live,
      keyringSecret,
      existingById
    );
  }

  public async saveCurrentAsProfileAsync(name: string): Promise<ProfileMetadata> {
    const live = await this.getLiveSessionInfoAsync();
    const accountsPath = getActiveGoogleAccountsPath();
    const oauthPath = getActiveOAuthCredsPath();
    const keyringSecret = await this.keyring.readAsync();

    if (!fs.existsSync(accountsPath) && !fs.existsSync(oauthPath) && !keyringSecret) {
      throw new Error('No active Antigravity credentials found to save.');
    }

    if (live.email) {
      const existingByEmail = this.listProfiles().find(
        (p) => p.email.toLowerCase() === live.email!.toLowerCase()
      );
      if (existingByEmail) {
        return this.persistProfileFiles(
          existingByEmail.id,
          name,
          live.email,
          live,
          keyringSecret,
          existingByEmail
        );
      }
    }

    const id = this.slugify(name);
    const existingById = this.getProfile(id);
    return this.persistProfileFiles(
      id,
      name,
      live.email || existingById?.email || 'Unknown',
      live,
      keyringSecret,
      existingById
    );
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

    // 1. Always write an authoritative, non-empty google_accounts.json on switch
    const cleanAccountsPayload = Buffer.from(
      JSON.stringify({ active: meta.email || '', old: [] }, null, 2),
      'utf8'
    );
    this.atomicWriteFile(accountsPath, cleanAccountsPayload);

    // Auto-heal the profile's stored google_accounts.json if it was empty
    try {
      fs.writeFileSync(sourceAccounts, cleanAccountsPayload);
    } catch {}

    // 2. Restore or synthesize oauth_creds.json so disk fast-path is always populated
    if (fs.existsSync(sourceOAuth)) {
      this.atomicWriteFile(oauthPath, fs.readFileSync(sourceOAuth));
    } else if (fs.existsSync(sourceKeyring)) {
      try {
        const parsedKr = JSON.parse(fs.readFileSync(sourceKeyring, 'utf8'));
        const synthesized = this.synthesizeOAuthCredsFromKeyring(parsedKr);
        if (synthesized) {
          const buf = Buffer.from(JSON.stringify(synthesized, null, 2), 'utf8');
          fs.writeFileSync(sourceOAuth, buf);
          this.atomicWriteFile(oauthPath, buf);
        }
      } catch {}
    } else if (fs.existsSync(oauthPath)) {
      try {
        fs.unlinkSync(oauthPath);
      } catch {}
    }

    this.saveState({ activeProfileId: id, lastUpdated: Date.now() });
    this.invalidateLiveSessionCache();

    // 3. Non-blocking OS Keyring swap
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
      const effectivePlan = meta.planOverride || cachedQuota.plan;
      const nextQuota: CachedQuotaMetric = {
        ...cachedQuota,
        plan: effectivePlan
      };
      meta.cachedQuota = nextQuota;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    } catch {}
  }

  public getProfileRefreshToken(id: string): string | null {
    const profileFolder = path.join(getProfilesDir(), id);
    const sourceKeyring = path.join(profileFolder, 'keyring_credential.json');
    const sourceOAuth = path.join(profileFolder, 'oauth_creds.json');

    if (fs.existsSync(sourceKeyring)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(sourceKeyring, 'utf8'));
        if (parsed?.token?.refresh_token) {
          return String(parsed.token.refresh_token);
        }
      } catch {}
    }

    if (fs.existsSync(sourceOAuth)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(sourceOAuth, 'utf8'));
        if (parsed?.refresh_token) {
          return String(parsed.refresh_token);
        }
      } catch {}
    }

    return null;
  }

  public updateInactiveProfileToken(id: string, accessToken: string, expiresInSec: number): void {
    const profileFolder = path.join(getProfilesDir(), id);
    if (!fs.existsSync(profileFolder)) return;

    const expiryMs = Date.now() + expiresInSec * 1000;
    const expiryIso = new Date(expiryMs).toISOString();

    const sourceKeyring = path.join(profileFolder, 'keyring_credential.json');
    if (fs.existsSync(sourceKeyring)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(sourceKeyring, 'utf8'));
        if (parsed && parsed.token) {
          parsed.token.access_token = accessToken;
          parsed.token.expiry = expiryIso;
          parsed.token.expires_in = expiresInSec;
          fs.writeFileSync(sourceKeyring, JSON.stringify(parsed), 'utf8');
        }
      } catch {}
    }

    const sourceOAuth = path.join(profileFolder, 'oauth_creds.json');
    if (fs.existsSync(sourceOAuth)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(sourceOAuth, 'utf8'));
        if (parsed) {
          parsed.access_token = accessToken;
          parsed.expiry_date = expiryMs;
          fs.writeFileSync(sourceOAuth, JSON.stringify(parsed, null, 2), 'utf8');
        }
      } catch {}
    }

    const sourceMeta = path.join(profileFolder, 'metadata.json');
    if (fs.existsSync(sourceMeta)) {
      try {
        const meta = JSON.parse(fs.readFileSync(sourceMeta, 'utf8')) as ProfileMetadata;
        meta.tokenExpiryDate = expiryMs;
        fs.writeFileSync(sourceMeta, JSON.stringify(meta, null, 2), 'utf8');
      } catch {}
    }
  }

  public async prepareNewLoginAsync(): Promise<PrepareNewLoginResult> {
    let backedUpProfile: ProfileMetadata | null = null;
    let wasExisting = false;

    // 1. Back up current active session non-blockingly
    const live = await this.getLiveSessionInfoAsync(true);
    if (live.email) {
      const existing = this.listProfiles().find(
        (p) => p.email.toLowerCase() === live.email!.toLowerCase()
      );
      if (existing) {
        wasExisting = true;
        backedUpProfile = await this.updateProfileCredentialsAsync(existing.id);
      } else {
        wasExisting = false;
        const defaultName = live.email.includes('@') ? live.email.split('@')[0] : live.email;
        backedUpProfile = await this.saveCurrentAsProfileAsync(defaultName);
      }
    }

    // 2. Clear OS Keyring credential non-blockingly
    await this.keyring.deleteAsync();

    // 3. Clear disk credentials
    const accountsPath = getActiveGoogleAccountsPath();
    const oauthPath = getActiveOAuthCredsPath();

    if (fs.existsSync(oauthPath)) {
      try {
        fs.unlinkSync(oauthPath);
      } catch {}
    }
    if (fs.existsSync(accountsPath)) {
      try {
        this.atomicWriteFile(
          accountsPath,
          Buffer.from(JSON.stringify({ active: '', old: [] }, null, 2), 'utf8')
        );
      } catch {
        try {
          fs.unlinkSync(accountsPath);
        } catch {}
      }
    }

    this.saveState({ activeProfileId: null, lastUpdated: Date.now() });
    this.invalidateLiveSessionCache();

    return { backedUpProfile, wasExisting };
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
      fs.copyFileSync(tmpPath, targetPath);
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
  }

  private slugify(text: string): string {
    return (
      text
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || `profile-${Date.now()}`
    );
  }
}
