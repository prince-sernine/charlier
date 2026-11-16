import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  getActiveGoogleAccountsPath,
  getActiveOAuthCredsPath,
  getProfilesDir,
  getStateFilePath
} from './constants';
import { syncAntigravityCliHomeToVault } from './cli-isolation';
import {
  ProfileMetadata,
  CharlierState,
  LiveSessionInfo,
  CachedQuotaMetric,
  PrepareNewLoginResult,
  ActiveProviderId,
  AuthHealthStatus
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
        // Self-heal missing/mismatched oauth_creds.json on disk if keyring holds a valid token
        const oauthPath = getActiveOAuthCredsPath();
        let shouldWriteOAuth = !fs.existsSync(oauthPath) && Boolean(parsedKeyring.token.access_token);
        if (!shouldWriteOAuth && fs.existsSync(oauthPath) && parsedKeyring.token.refresh_token) {
          try {
            const diskOAuth = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));
            if (
              diskOAuth?.refresh_token &&
              diskOAuth.refresh_token !== parsedKeyring.token.refresh_token &&
              parsedKeyring.token.access_token
            ) {
              // Keyring belongs to a newer account while oauth_creds.json wasn't rotated yet
              shouldWriteOAuth = true;
            }
          } catch {}
        }
        if (shouldWriteOAuth && parsedKeyring.token.access_token) {
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
        const folderPath = path.join(profilesDir, entry.name);
        const metaPath = path.join(folderPath, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          try {
            const raw = fs.readFileSync(metaPath, 'utf8');
            const parsed = JSON.parse(raw) as ProfileMetadata;
            const hasCreds =
              fs.existsSync(path.join(folderPath, 'oauth_creds.json')) ||
              fs.existsSync(path.join(folderPath, 'keyring_credential.json'));
            const emailNorm = (parsed.email || '').trim();
            if ((!emailNorm || emailNorm === 'Unknown') && !hasCreds) {
              try {
                fs.rmSync(folderPath, { recursive: true, force: true });
              } catch {}
              continue;
            }
            profiles.push(parsed);
          } catch {
            // Skip damaged metadata
          }
        }
      }
    }

    profiles.sort((a, b) => b.updatedAt - a.updatedAt);

    // Deduplicate any profiles sharing the same non-Unknown email (keeping the newest/credentialed entry)
    const seenEmails = new Map<string, ProfileMetadata>();
    const deduped: ProfileMetadata[] = [];
    for (const p of profiles) {
      const emailKey = (p.email || '').trim().toLowerCase();
      if (!emailKey || emailKey === 'unknown') {
        deduped.push(p);
        continue;
      }
      const prev = seenEmails.get(emailKey);
      if (!prev) {
        seenEmails.set(emailKey, p);
        deduped.push(p);
      } else {
        const prevHasRt = Boolean(this.getProfileRefreshToken(prev.id));
        const currHasRt = Boolean(this.getProfileRefreshToken(p.id));
        if (!prevHasRt && currHasRt) {
          // Promote the entry that actually has a refresh token
          const idx = deduped.indexOf(prev);
          if (idx >= 0) deduped[idx] = p;
          seenEmails.set(emailKey, p);
          try {
            fs.rmSync(path.join(profilesDir, prev.id), { recursive: true, force: true });
          } catch {}
        } else {
          try {
            fs.rmSync(path.join(profilesDir, p.id), { recursive: true, force: true });
          } catch {}
        }
      }
    }

    return deduped;
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
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as CharlierState;
        return {
          ...parsed,
          selectedProviderByHost: parsed.selectedProviderByHost ?? {}
        };
      } catch {
        // Fallback
      }
    }
    return { activeProfileId: null, selectedProviderByHost: {}, lastUpdated: 0 };
  }

  public saveState(state: Partial<CharlierState>): void {
    const stateFile = getStateFilePath();
    const dir = path.dirname(stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const lockPath = `${stateFile}.lock`;
    let lockFd: number | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        lockFd = fs.openSync(lockPath, 'wx', 0o600);
        break;
      } catch (err: any) {
        if (err?.code === 'EEXIST') {
          try {
            const st = fs.statSync(lockPath);
            if (Date.now() - st.mtimeMs > 5000) {
              fs.unlinkSync(lockPath);
              continue;
            }
          } catch {}
          // Tight cross-process spin wait (~2ms) before re-acquiring
          const until = Date.now() + 3;
          while (Date.now() < until) {}
          continue;
        }
        break;
      }
    }
    try {
      const current = this.getState();
      const mergedHostMap =
        state.selectedProviderByHost || current.selectedProviderByHost
          ? {
              ...(current.selectedProviderByHost || {}),
              ...(state.selectedProviderByHost || {})
            }
          : undefined;
      const merged: CharlierState = {
        ...current,
        ...state,
        ...(mergedHostMap ? { selectedProviderByHost: mergedHostMap } : {}),
        lastUpdated: state.lastUpdated ?? Date.now()
      };
      this.atomicWriteFile(stateFile, Buffer.from(JSON.stringify(merged, null, 2), 'utf8'));
    } finally {
      if (lockFd !== null) {
        try {
          fs.closeSync(lockFd);
        } catch {}
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      }
    }
  }

  public setSelectedProvider(provider: ActiveProviderId): void {
    this.saveState({ selectedProvider: provider, lastUpdated: Date.now() });
  }

  public setSelectedProviderForHost(
    host: 'antigravity' | 'vscode',
    provider: ActiveProviderId
  ): void {
    this.saveState({
      ...(host === 'vscode' ? { selectedProvider: provider } : {}),
      selectedProviderByHost: { [host]: provider },
      lastUpdated: Date.now()
    });
  }

  public setActiveCodexProfileId(id: string | null): void {
    this.saveState({ activeCodexProfileId: id, lastUpdated: Date.now() });
  }

  private persistProfileFiles(
    id: string,
    name: string,
    resolvedEmail: string,
    live: LiveSessionInfo,
    keyringSecret: string | null,
    existing: ProfileMetadata | null,
    liveMetric?: CachedQuotaMetric | null
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
    this.atomicWriteFile(targetAccounts, Buffer.from(cleanAccountsPayload, 'utf8'));

    // Also ensure active google_accounts.json is healed if it matches
    if (validEmail) {
      try {
        this.atomicWriteFile(accountsPath, Buffer.from(cleanAccountsPayload, 'utf8'));
      } catch {}
    }

    if (fs.existsSync(oauthPath)) {
      this.atomicWriteFile(targetOAuth, fs.readFileSync(oauthPath));
    } else if (keyringSecret) {
      try {
        const parsedKr = JSON.parse(keyringSecret);
        const synthesized = this.synthesizeOAuthCredsFromKeyring(parsedKr);
        if (synthesized) {
          this.atomicWriteFile(targetOAuth, Buffer.from(JSON.stringify(synthesized, null, 2), 'utf8'));
        }
      } catch {}
    }

    if (keyringSecret) {
      this.atomicWriteFile(targetKeyring, Buffer.from(keyringSecret, 'utf8'));
    }

    const now = Date.now();
    const prevRt = existing ? this.getProfileRefreshToken(id) : null;
    let nextRt: string | null = null;
    if (keyringSecret) {
      try {
        const parsedKr = JSON.parse(keyringSecret);
        if (parsedKr?.token?.refresh_token) {
          nextRt = String(parsedKr.token.refresh_token);
        }
      } catch {}
    }
    if (!nextRt && fs.existsSync(targetOAuth)) {
      try {
        const parsedOAuth = JSON.parse(fs.readFileSync(targetOAuth, 'utf8'));
        if (parsedOAuth?.refresh_token) {
          nextRt = String(parsedOAuth.refresh_token);
        }
      } catch {}
    }
    const isUnverifiedLive = live.authStatus === 'unverified';
    const preserveUnverifiedExisting = Boolean(
      !isUnverifiedLive &&
        existing?.authStatus === 'unverified' &&
        live.authStatus !== 'ok' &&
        !liveMetric
    );
    const preserveRevokedStatus = Boolean(
      !isUnverifiedLive &&
        existing &&
        (existing.authStatus === 'revoked' || existing.authStatus === 'expired') &&
        ((!prevRt && !nextRt) || (Boolean(prevRt) && nextRt === prevRt))
    );
    const resolvedAuthStatus: AuthHealthStatus = isUnverifiedLive
      ? 'unverified'
      : preserveUnverifiedExisting
        ? 'unverified'
        : preserveRevokedStatus
          ? existing!.authStatus!
          : 'ok';
    const resolvedErrorCode = isUnverifiedLive
      ? live.authErrorCode || 'VALIDATION_REQUIRED'
      : preserveUnverifiedExisting || preserveRevokedStatus
        ? existing?.authErrorCode
        : undefined;
    const resolvedErrorMessage = isUnverifiedLive
      ? live.authErrorMessage || 'Verify your account to continue.'
      : preserveUnverifiedExisting || preserveRevokedStatus
        ? existing?.authErrorMessage
        : undefined;
    const resolvedValidationUrl = isUnverifiedLive
      ? live.validationUrl || existing?.validationUrl
      : preserveUnverifiedExisting
        ? existing?.validationUrl
        : undefined;

    const cachedQuotaToKeep =
      liveMetric &&
      (!existing?.cachedQuota ||
        liveMetric.updatedAt >= (existing.cachedQuota.updatedAt || 0))
        ? liveMetric
        : existing?.cachedQuota;

    const metadata: ProfileMetadata = {
      id,
      name: name.trim(),
      email: validEmail || 'Unknown',
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      tokenExpiryDate: live.tokenExpiryDate || existing?.tokenExpiryDate,
      authStatus: resolvedAuthStatus,
      authCheckedAt:
        preserveRevokedStatus || preserveUnverifiedExisting
          ? existing!.authCheckedAt || now
          : now,
      ...(resolvedErrorCode ? { authErrorCode: resolvedErrorCode } : {}),
      ...(resolvedErrorMessage ? { authErrorMessage: resolvedErrorMessage } : {}),
      ...(resolvedValidationUrl ? { validationUrl: resolvedValidationUrl } : {}),
      ...(existing?.planOverride ? { planOverride: existing.planOverride } : {}),
      ...(cachedQuotaToKeep ? { cachedQuota: cachedQuotaToKeep } : {})
    };

    this.atomicWriteFile(targetMeta, Buffer.from(JSON.stringify(metadata, null, 2), 'utf8'));
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

  public async updateProfileCredentialsAsync(
    id: string,
    newName?: string,
    liveMetric?: CachedQuotaMetric | null,
    sessionHint?: Partial<LiveSessionInfo>
  ): Promise<ProfileMetadata> {
    const existing = this.getProfile(id);
    if (!existing) {
      throw new Error(`Profile "${id}" does not exist.`);
    }

    const baseLive = await this.getLiveSessionInfoAsync();
    const live: LiveSessionInfo = {
      ...baseLive,
      ...(sessionHint?.email ? { email: sessionHint.email } : {}),
      ...(sessionHint?.authStatus ? { authStatus: sessionHint.authStatus } : {}),
      ...(sessionHint?.authErrorCode ? { authErrorCode: sessionHint.authErrorCode } : {}),
      ...(sessionHint?.authErrorMessage ? { authErrorMessage: sessionHint.authErrorMessage } : {}),
      ...(sessionHint?.validationUrl ? { validationUrl: sessionHint.validationUrl } : {})
    };
    const keyringSecret = await this.keyring.readAsync();
    const targetName = newName && newName.trim() ? newName.trim() : existing.name;
    const resolvedEmail = live.email || existing.email;

    return this.persistProfileFiles(
      id,
      targetName,
      resolvedEmail,
      live,
      keyringSecret,
      existing,
      liveMetric
    );
  }

  private hasValidOAuthFile(oauthPath: string): boolean {
    if (!fs.existsSync(oauthPath)) return false;
    try {
      const parsed = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));
      return Boolean(parsed?.refresh_token || parsed?.access_token);
    } catch {
      return false;
    }
  }

  public saveCurrentAsProfile(
    name: string,
    sessionHint?: Partial<LiveSessionInfo>
  ): ProfileMetadata {
    const baseLive = this.getLiveSessionInfo();
    const live: LiveSessionInfo = {
      ...baseLive,
      ...(sessionHint?.email ? { email: sessionHint.email } : {}),
      ...(sessionHint?.authStatus ? { authStatus: sessionHint.authStatus } : {}),
      ...(sessionHint?.authErrorCode ? { authErrorCode: sessionHint.authErrorCode } : {}),
      ...(sessionHint?.authErrorMessage ? { authErrorMessage: sessionHint.authErrorMessage } : {}),
      ...(sessionHint?.validationUrl ? { validationUrl: sessionHint.validationUrl } : {})
    };
    const oauthPath = getActiveOAuthCredsPath();
    const keyringSecret = this.keyring.read();
    const hasCreds = this.hasValidOAuthFile(oauthPath) || Boolean(keyringSecret);
    const resolvedEmail = (live.email || '').trim();

    if (!hasCreds && (!resolvedEmail || resolvedEmail === 'Unknown')) {
      throw new Error('No active Antigravity credentials found to save.');
    }
    if (!resolvedEmail || resolvedEmail === 'Unknown') {
      throw new Error(
        'Cannot save profile: active Antigravity account email is unavailable.'
      );
    }

    const profiles = this.listProfiles();
    const existingByEmail = profiles.find(
      (p) => p.email.toLowerCase() === resolvedEmail.toLowerCase()
    );
    if (existingByEmail) {
      return this.persistProfileFiles(
        existingByEmail.id,
        name,
        resolvedEmail,
        live,
        keyringSecret,
        existingByEmail
      );
    }

    let id = this.slugify(name);
    let existingById = this.getProfile(id);
    if (
      existingById &&
      existingById.email.toLowerCase() !== resolvedEmail.toLowerCase()
    ) {
      let suffix = 2;
      while (this.getProfile(`${id}-${suffix}`)) {
        suffix++;
      }
      id = `${id}-${suffix}`;
      existingById = null;
    }
    return this.persistProfileFiles(
      id,
      name,
      resolvedEmail,
      live,
      keyringSecret,
      existingById
    );
  }

  public async saveCurrentAsProfileAsync(
    name: string,
    liveMetric?: CachedQuotaMetric | null,
    sessionHint?: Partial<LiveSessionInfo>
  ): Promise<ProfileMetadata> {
    const baseLive = await this.getLiveSessionInfoAsync();
    const live: LiveSessionInfo = {
      ...baseLive,
      ...(sessionHint?.email ? { email: sessionHint.email } : {}),
      ...(sessionHint?.authStatus ? { authStatus: sessionHint.authStatus } : {}),
      ...(sessionHint?.authErrorCode ? { authErrorCode: sessionHint.authErrorCode } : {}),
      ...(sessionHint?.authErrorMessage ? { authErrorMessage: sessionHint.authErrorMessage } : {}),
      ...(sessionHint?.validationUrl ? { validationUrl: sessionHint.validationUrl } : {})
    };
    const oauthPath = getActiveOAuthCredsPath();
    const keyringSecret = await this.keyring.readAsync();
    const hasCreds = this.hasValidOAuthFile(oauthPath) || Boolean(keyringSecret);
    const resolvedEmail = (live.email || '').trim();

    if (!hasCreds && (!resolvedEmail || resolvedEmail === 'Unknown')) {
      throw new Error('No active Antigravity credentials found to save.');
    }
    if (!resolvedEmail || resolvedEmail === 'Unknown') {
      throw new Error(
        'Cannot save profile: active Antigravity account email is unavailable.'
      );
    }

    const profiles = this.listProfiles();
    let existingMatch = profiles.find(
      (p) => p.email.toLowerCase() === resolvedEmail.toLowerCase()
    );
    if (!existingMatch) {
      const activeRt = await this.getActiveSessionRefreshTokenAsync();
      if (activeRt) {
        existingMatch = profiles.find(
          (p) => this.getProfileRefreshToken(p.id) === activeRt
        );
      }
    }
    if (existingMatch) {
      return this.persistProfileFiles(
        existingMatch.id,
        name,
        resolvedEmail,
        live,
        keyringSecret,
        existingMatch,
        liveMetric
      );
    }

    let id = this.slugify(name);
    let existingById = this.getProfile(id);
    if (
      existingById &&
      existingById.email.toLowerCase() !== resolvedEmail.toLowerCase()
    ) {
      let suffix = 2;
      while (this.getProfile(`${id}-${suffix}`)) {
        suffix++;
      }
      id = `${id}-${suffix}`;
      existingById = null;
    }
    return this.persistProfileFiles(
      id,
      name,
      resolvedEmail,
      live,
      keyringSecret,
      existingById,
      liveMetric
    );
  }

  /**
   * Automatically saves an active Antigravity session into the vault when its email is not
   * yet stored, preventing Switch / CLI Only from losing an unsaved sign-in.
   * When the active email already exists in the vault, syncs fresh active tokens instead and returns null.
   */
  public async autoSaveUnsavedActiveSessionAsync(
    liveMetric?: CachedQuotaMetric | null,
    sessionHint?: Partial<LiveSessionInfo>
  ): Promise<ProfileMetadata | null> {
    const baseLive = await this.getLiveSessionInfoAsync(true);
    const email = (baseLive.email || sessionHint?.email || '').trim();
    if (!email || email === 'Unknown') {
      return null;
    }
    const existing = this.listProfiles().find(
      (p) => p.email.toLowerCase() === email.toLowerCase()
    );
    if (existing) {
      await this.syncActiveCredentialsToProfileAsync(existing.id, baseLive);
      if (liveMetric && liveMetric.updatedAt > (existing.cachedQuota?.updatedAt || 0)) {
        const metaPath = path.join(getProfilesDir(), existing.id, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ProfileMetadata;
            meta.cachedQuota = liveMetric;
            this.atomicWriteFile(metaPath, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
          } catch {}
        }
      }
      return null;
    }
    const defaultName = email.includes('@') ? email.split('@')[0] : email;
    return this.saveCurrentAsProfileAsync(defaultName, liveMetric, {
      ...sessionHint,
      email
    });
  }

  public async switchProfile(id: string): Promise<ProfileMetadata> {
    try {
      syncAntigravityCliHomeToVault(id);
    } catch {}
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
      this.atomicWriteFile(sourceAccounts, cleanAccountsPayload);
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
          this.atomicWriteFile(sourceOAuth, buf);
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

  public renameProfile(
    id: string,
    newName: string,
    planOverride?: import('./types').UserPlanTier | null
  ): ProfileMetadata {
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
    if (planOverride !== undefined) {
      if (planOverride === null) {
        delete meta.planOverride;
      } else {
        meta.planOverride = planOverride;
        if (meta.cachedQuota) {
          meta.cachedQuota.plan = planOverride;
          if (planOverride === 'FREE') {
            meta.cachedQuota.claudeGpt = '--';
            meta.cachedQuota.claude5h = '--';
            meta.cachedQuota.claude7d = '--';
            meta.cachedQuota.argon = '--';
            meta.cachedQuota.carbon = undefined;
          } else if (planOverride === 'ULTRA') {
            meta.cachedQuota.argon = 'incl.';
          }
        }
      }
    }
    meta.updatedAt = Date.now();
    this.atomicWriteFile(metaPath, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
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
      this.atomicWriteFile(metaPath, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
    } catch {}
  }

  public updateProfileAuthHealth(
    id: string,
    health: {
      authStatus: AuthHealthStatus;
      authErrorCode?: string;
      authErrorMessage?: string;
      validationUrl?: string;
      authCheckedAt?: number;
    }
  ): boolean {
    const metaPath = path.join(getProfilesDir(), id, 'metadata.json');
    if (!fs.existsSync(metaPath)) return false;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ProfileMetadata;
      const nextCode = health.authStatus === 'ok' ? undefined : health.authErrorCode;
      const nextMsg = health.authStatus === 'ok' ? undefined : health.authErrorMessage;
      const nextUrl =
        health.authStatus === 'unverified'
          ? health.validationUrl || meta.validationUrl
          : undefined;
      const changed =
        meta.authStatus !== health.authStatus ||
        meta.authErrorCode !== nextCode ||
        meta.authErrorMessage !== nextMsg ||
        meta.validationUrl !== nextUrl;

      meta.authStatus = health.authStatus;
      meta.authCheckedAt = health.authCheckedAt || Date.now();
      if (nextCode) meta.authErrorCode = nextCode;
      else delete meta.authErrorCode;
      if (nextMsg) meta.authErrorMessage = nextMsg;
      else delete meta.authErrorMessage;
      if (nextUrl) meta.validationUrl = nextUrl;
      else delete meta.validationUrl;

      this.atomicWriteFile(metaPath, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
      return changed;
    } catch {
      return false;
    }
  }

  public async getActiveSessionRefreshTokenAsync(): Promise<string | null> {
    const oauthPath = getActiveOAuthCredsPath();
    if (fs.existsSync(oauthPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));
        if (parsed?.refresh_token) {
          return String(parsed.refresh_token);
        }
      } catch {}
    }

    const keyringRaw = await this.keyring.readAsync();
    if (keyringRaw) {
      try {
        const parsed = JSON.parse(keyringRaw);
        if (parsed?.token?.refresh_token) {
          return String(parsed.token.refresh_token);
        }
      } catch {}
    }
    return null;
  }

  public async syncActiveCredentialsToProfileAsync(
    id: string,
    preloadedLive?: LiveSessionInfo
  ): Promise<boolean> {
    const existing = this.getProfile(id);
    if (!existing) return false;
    const live = preloadedLive ?? (await this.getLiveSessionInfoAsync(true));
    if (
      live.email &&
      existing.email &&
      existing.email !== 'Unknown' &&
      live.email.toLowerCase() !== existing.email.toLowerCase()
    ) {
      return false;
    }

    const oauthPath = getActiveOAuthCredsPath();
    const hasDiskOAuth = fs.existsSync(oauthPath);
    let diskHasRt = false;
    if (hasDiskOAuth) {
      try {
        const parsedDisk = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));
        diskHasRt = Boolean(parsedDisk?.refresh_token);
      } catch {}
    }
    const keyringSecret =
      process.platform !== 'win32' && diskHasRt
        ? null
        : await this.keyring.readAsync();
    if (!hasDiskOAuth && !keyringSecret) {
      return false;
    }

    const profileFolder = path.join(getProfilesDir(), id);
    if (!fs.existsSync(profileFolder)) return false;

    const targetOAuth = path.join(profileFolder, 'oauth_creds.json');
    const targetKeyring = path.join(profileFolder, 'keyring_credential.json');
    const prevRt = this.getProfileRefreshToken(id);
    let prevAt: string | null = null;
    if (fs.existsSync(targetOAuth)) {
      try {
        prevAt = JSON.parse(fs.readFileSync(targetOAuth, 'utf8'))?.access_token || null;
      } catch {}
    }

    let nextRt: string | null = null;
    let nextAt: string | null = null;
    if (fs.existsSync(oauthPath)) {
      const oauthBuf = fs.readFileSync(oauthPath);
      try {
        const parsedO = JSON.parse(oauthBuf.toString('utf8'));
        nextRt = parsedO?.refresh_token ? String(parsedO.refresh_token) : null;
        nextAt = parsedO?.access_token ? String(parsedO.access_token) : null;
      } catch {}
      this.atomicWriteFile(targetOAuth, oauthBuf);
    } else if (keyringSecret) {
      try {
        const parsedKr = JSON.parse(keyringSecret);
        nextRt = parsedKr?.token?.refresh_token ? String(parsedKr.token.refresh_token) : null;
        nextAt = parsedKr?.token?.access_token ? String(parsedKr.token.access_token) : null;
        const synthesized = this.synthesizeOAuthCredsFromKeyring(parsedKr);
        if (synthesized) {
          this.atomicWriteFile(targetOAuth, Buffer.from(JSON.stringify(synthesized, null, 2), 'utf8'));
        }
      } catch {}
    }
    if (keyringSecret) {
      if (!nextRt) {
        try {
          const parsedKr = JSON.parse(keyringSecret);
          nextRt = parsedKr?.token?.refresh_token ? String(parsedKr.token.refresh_token) : null;
          nextAt = nextAt || (parsedKr?.token?.access_token ? String(parsedKr.token.access_token) : null);
        } catch {}
      }
      this.atomicWriteFile(targetKeyring, Buffer.from(keyringSecret, 'utf8'));
    }

    const tokensRotated = Boolean(
      (nextRt && nextRt !== prevRt) || (nextAt && nextAt !== prevAt)
    );
    const metaPath = path.join(profileFolder, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ProfileMetadata;
        meta.updatedAt = Date.now();
        if (live.tokenExpiryDate) meta.tokenExpiryDate = live.tokenExpiryDate;
        const wasBroken = meta.authStatus === 'revoked' || meta.authStatus === 'expired';
        if (meta.authStatus !== 'unverified' && (!wasBroken || (tokensRotated && !live.isExpired))) {
          meta.authStatus = 'ok';
          meta.authCheckedAt = Date.now();
          delete meta.authErrorCode;
          delete meta.authErrorMessage;
          delete meta.validationUrl;
        }
        this.atomicWriteFile(metaPath, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
      } catch {}
    }
    return true;
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
          this.atomicWriteFile(sourceKeyring, Buffer.from(JSON.stringify(parsed), 'utf8'));
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
          this.atomicWriteFile(sourceOAuth, Buffer.from(JSON.stringify(parsed, null, 2), 'utf8'));
        }
      } catch {}
    }

    const sourceMeta = path.join(profileFolder, 'metadata.json');
    if (fs.existsSync(sourceMeta)) {
      try {
        const meta = JSON.parse(fs.readFileSync(sourceMeta, 'utf8')) as ProfileMetadata;
        meta.tokenExpiryDate = expiryMs;
        if (meta.authStatus !== 'unverified') {
          meta.authStatus = 'ok';
          meta.authCheckedAt = Date.now();
          delete meta.authErrorCode;
          delete meta.authErrorMessage;
          delete meta.validationUrl;
        }
        this.atomicWriteFile(sourceMeta, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
      } catch {}
    }
  }

  public async prepareNewLoginAsync(options?: {
    liveMetric?: CachedQuotaMetric | null;
    sessionHint?: Partial<LiveSessionInfo>;
  }): Promise<PrepareNewLoginResult> {
    let backedUpProfile: ProfileMetadata | null = null;
    let wasExisting = false;

    // 1. Back up current active session non-blockingly
    const live = await this.getLiveSessionInfoAsync(true);
    const resolvedEmail = (live.email || options?.sessionHint?.email || '').trim();
    if (resolvedEmail && resolvedEmail !== 'Unknown') {
      const existing = this.listProfiles().find(
        (p) => p.email.toLowerCase() === resolvedEmail.toLowerCase()
      );
      if (existing) {
        wasExisting = true;
        backedUpProfile = await this.updateProfileCredentialsAsync(
          existing.id,
          undefined,
          options?.liveMetric,
          { ...options?.sessionHint, email: resolvedEmail }
        );
      } else {
        wasExisting = false;
        const defaultName = resolvedEmail.includes('@')
          ? resolvedEmail.split('@')[0]
          : resolvedEmail;
        backedUpProfile = await this.saveCurrentAsProfileAsync(
          defaultName,
          options?.liveMetric,
          { ...options?.sessionHint, email: resolvedEmail }
        );
      }
    }

    // 2. Clear OS Keyring credential non-blockingly
    await this.keyring.deleteAsync();

    // 3. Clear disk credentials cleanly (unlink both files so no empty 31-byte google_accounts.json stub remains)
    const accountsPath = getActiveGoogleAccountsPath();
    const oauthPath = getActiveOAuthCredsPath();

    for (const target of [oauthPath, accountsPath]) {
      if (!fs.existsSync(target)) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.unlinkSync(target);
          break;
        } catch (err: any) {
          if (err?.code === 'ENOENT') break;
          if (attempt < 2 && (err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES')) {
            await new Promise((r) => setTimeout(r, 30));
          } else {
            break;
          }
        }
      }
    }

    this.saveState({ activeProfileId: null, lastUpdated: Date.now() });
    this.invalidateLiveSessionCache();

    return { backedUpProfile, wasExisting };
  }

  private atomicWriteFile(targetPath: string, data: Buffer): void {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const unique = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
    const tmpPath = `${targetPath}.${unique}.tmp`;
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    const retryable = new Set(['EBUSY', 'EPERM', 'EACCES']);
    try {
      let renamed = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          fs.renameSync(tmpPath, targetPath);
          renamed = true;
          break;
        } catch (err: any) {
          if (!retryable.has(err?.code) || attempt === 3) {
            if (!retryable.has(err?.code)) throw err;
            break;
          }
        }
      }
      if (!renamed) {
        try {
          if (fs.lstatSync(targetPath).isSymbolicLink()) fs.unlinkSync(targetPath);
        } catch {}
        fs.copyFileSync(tmpPath, targetPath);
      }
      try {
        fs.chmodSync(targetPath, 0o600);
      } catch {}
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
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
