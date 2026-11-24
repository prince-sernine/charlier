import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { execFile, spawn } from 'child_process';
import {
  getActiveCodexAuthPath,
  getActiveCodexConfigPath,
  getCodexHomeDir,
  getCodexProfilesDir
} from './constants';
import {
  getProfileCliHomeDir,
  readCodexCliHomeAuthReadOnly,
  syncCodexCliHomeToVault
} from './cli-isolation';
import { hasLinuxDbusSession } from './keyring';
import {
  ActiveProviderId,
  AuthHealthStatus,
  CachedQuotaMetric,
  LiveSessionInfo,
  PrepareNewLoginResult,
  ProfileMetadata,
  QuotaGroup,
  QuotaSummary,
  UserPlanTier
} from './types';
import { formatTimeAgo, renderCompactBar } from './quota';
import {
  BestStandbyRecommendation,
  codexMetricForDisplay,
  getHoverPalette,
  getHoverProviderIconHtml,
  isCodexAppServerProcess,
  percentFromText,
  remainingFromUsedPercent,
  renderHoverGaugeCell,
  renderHoverPct,
  renderHoverPill,
  resolveBestStandbyProfile,
  resolveEffectiveAuthStatus,
  sortProfilesForDisplay
} from './quota-values';

const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function parseCodexErrorBody(raw: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(raw);
    const code =
      parsed?.error?.code ||
      parsed?.error_code ||
      (typeof parsed?.error === 'string' ? parsed.error : undefined) ||
      parsed?.code;
    const message =
      parsed?.error?.message ||
      parsed?.error_description ||
      parsed?.message;
    return {
      code: typeof code === 'string' && code.trim() ? code.trim() : undefined,
      message: typeof message === 'string' && message.trim() ? message.trim() : undefined
    };
  } catch {
    return {};
  }
}

function isTerminalCodexError(statusCode?: number, code?: string, message?: string): boolean {
  const c = (code || '').toLowerCase();
  const m = (message || '').toLowerCase();
  if (
    c === 'token_revoked' ||
    c === 'token_invalidated' ||
    c === 'invalid_grant' ||
    c === 'refresh_token_reused' ||
    c === 'account_deactivated' ||
    c === 'workspace_deactivated' ||
    c === 'signed_out' ||
    c === 'unauthorized'
  ) {
    return true;
  }
  if (
    m.includes('invalidated oauth token') ||
    m.includes('token has been revoked') ||
    (m.includes('refresh token') && m.includes('invalid'))
  ) {
    return true;
  }
  return statusCode === 401 && c !== 'rate_limit_exceeded';
}

function classifyCodexAuthFailure(
  whamErr: any,
  refreshErr: any,
  skipPlain401Revoke = false
): { authStatus: AuthHealthStatus; code?: string; message?: string } | null {
  const refreshStatus = refreshErr?.statusCode as number | undefined;
  const refreshCode = refreshErr?.code as string | undefined;
  const refreshMsg = (refreshErr?.detailMessage || refreshErr?.message) as string | undefined;

  if (
    refreshStatus === 400 ||
    refreshStatus === 401 ||
    isTerminalCodexError(refreshStatus, refreshCode, refreshMsg)
  ) {
    return {
      authStatus: 'revoked',
      code: refreshCode || whamErr?.code || `http_${refreshStatus || 401}`,
      message: refreshMsg || whamErr?.detailMessage || whamErr?.message
    };
  }

  const whamStatus = whamErr?.statusCode as number | undefined;
  const whamCode = whamErr?.code as string | undefined;
  const whamMsg = (whamErr?.detailMessage || whamErr?.message) as string | undefined;
  const whamCodeLower = (whamCode || '').toLowerCase();
  if (
    whamCodeLower === 'token_revoked' ||
    whamCodeLower === 'token_invalidated' ||
    whamCodeLower === 'account_deactivated' ||
    whamCodeLower === 'workspace_deactivated' ||
    whamCodeLower === 'signed_out' ||
    (!skipPlain401Revoke && whamStatus === 401 && !refreshErr)
  ) {
    return {
      authStatus: 'revoked',
      code: whamCode || 'http_401',
      message: whamMsg
    };
  }

  return null;
}

export interface DecodedCodexAuth {
  authMode: 'chatgpt' | 'apikey';
  email: string | null;
  name: string | null;
  accountId: string | null;
  organizationId: string | null;
  userId: string | null;
  planTier: UserPlanTier;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  tokenExpiryDate: number | null;
  isExpired: boolean;
  rawAuthJson: any;
}

function decodeJwtPayload(jwtStr: string | undefined | null): any | null {
  if (!jwtStr || typeof jwtStr !== 'string') return null;
  const parts = jwtStr.split('.');
  if (parts.length < 2) return null;
  try {
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
      base64 += '=';
    }
    const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

export function normalizeCodexPlanTier(rawPlan: string | undefined | null, authMode?: string): UserPlanTier {
  if (authMode === 'apikey') return 'API_KEY';
  const p = String(rawPlan || '').toLowerCase().trim();
  if (!p || p === 'free' || p === 'go') return 'FREE';
  if (p === 'plus' || p === 'edu_plus' || p === 'sci_plus') return 'PLUS';
  if (
    p === 'pro' ||
    p === 'prolite' ||
    p === 'promax' ||
    p === 'self_serve_business_prolite' ||
    p === 'edu_pro'
  ) {
    return 'PRO';
  }
  if (p === 'team' || p === 'business' || p === 'self_serve_business_usage_based') {
    return 'TEAM';
  }
  if (
    p === 'enterprise' ||
    p === 'hc' ||
    p === 'ent26' ||
    p.startsWith('enterprise_')
  ) {
    return 'ENTERPRISE';
  }
  if (p === 'edu' || p === 'education' || p === 'sci') {
    return 'EDU';
  }
  return 'PLUS';
}

export function formatCodexTierLabel(planTier: UserPlanTier): QuotaSummary['tier'] {
  switch (planTier) {
    case 'FREE':
      return 'Free Tier';
    case 'PLUS':
      return 'Plus Plan';
    case 'PRO':
      return 'Pro Plan';
    case 'TEAM':
      return 'Team Plan';
    case 'ENTERPRISE':
      return 'Enterprise';
    case 'EDU':
      return 'Edu Plan';
    case 'API_KEY':
      return 'API Key';
    default:
      return 'Plus Plan';
  }
}

export function parseCodexAuthObject(raw: any): DecodedCodexAuth | null {
  if (!raw || typeof raw !== 'object') return null;

  const authMode: 'chatgpt' | 'apikey' =
    raw.auth_mode === 'apikey' || (!raw.tokens && typeof raw.OPENAI_API_KEY === 'string')
      ? 'apikey'
      : 'chatgpt';

  if (authMode === 'apikey') {
    const keyPreview = typeof raw.OPENAI_API_KEY === 'string' && raw.OPENAI_API_KEY.length > 8
      ? `${raw.OPENAI_API_KEY.slice(0, 7)}...${raw.OPENAI_API_KEY.slice(-4)}`
      : 'apikey@openai.com';
    return {
      authMode: 'apikey',
      email: keyPreview,
      name: 'OpenAI API Key',
      accountId: null,
      organizationId: null,
      userId: null,
      planTier: 'API_KEY',
      accessToken: raw.OPENAI_API_KEY || null,
      refreshToken: null,
      idToken: null,
      tokenExpiryDate: null,
      isExpired: false,
      rawAuthJson: raw
    };
  }

  const tokens = raw.tokens;
  if (!tokens || typeof tokens !== 'object') return null;

  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : null;
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null;
  const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : null;

  const accessClaims = decodeJwtPayload(accessToken);
  const idClaims = decodeJwtPayload(idToken);

  const accessAuth = accessClaims?.['https://api.openai.com/auth'] || {};
  const accessProfile = accessClaims?.['https://api.openai.com/profile'] || {};
  const idAuth = idClaims?.['https://api.openai.com/auth'] || {};

  const email =
    accessProfile.email ||
    idClaims?.email ||
    accessClaims?.email ||
    null;

  const name =
    accessProfile.name ||
    idClaims?.name ||
    null;

  const accountId =
    tokens.account_id ||
    accessAuth.chatgpt_account_id ||
    idAuth.chatgpt_account_id ||
    null;

  const organizationId =
    accessAuth.poid ||
    idAuth.poid ||
    null;

  const userId =
    accessAuth.chatgpt_user_id ||
    idAuth.chatgpt_user_id ||
    accessAuth.user_id ||
    idAuth.user_id ||
    null;

  const rawPlanType =
    accessAuth.chatgpt_plan_type ||
    idAuth.chatgpt_plan_type ||
    'plus';

  const planTier = normalizeCodexPlanTier(rawPlanType, authMode);

  const expSeconds = typeof accessClaims?.exp === 'number' ? accessClaims.exp : null;
  const tokenExpiryDate = expSeconds ? expSeconds * 1000 : null;
  const hasRefreshToken = Boolean(refreshToken && refreshToken.trim().length > 0);
  const isExpired = !hasRefreshToken && tokenExpiryDate !== null && tokenExpiryDate < Date.now();

  return {
    authMode,
    email,
    name,
    accountId,
    organizationId,
    userId,
    planTier,
    accessToken,
    refreshToken,
    idToken,
    tokenExpiryDate,
    isExpired,
    rawAuthJson: raw
  };
}

export function formatSecondsCountdown(seconds: number | undefined | null): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return '';
  }
  const totalMins = Math.max(1, Math.floor(seconds / 60));
  const days = Math.floor(totalMins / (60 * 24));
  const hours = Math.floor((totalMins % (60 * 24)) / 60);
  const mins = totalMins % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

export function healExpiredCodexMetric(metric: CachedQuotaMetric | undefined): CachedQuotaMetric | undefined {
  if (!metric) return undefined;
  const now = Date.now();
  const healed = { ...metric };

  if (typeof healed.codex5hResetAtMs === 'number' && healed.codex5hResetAtMs > 0) {
    if (healed.codex5hResetAtMs <= now) {
      healed.codex5h = '100%';
      healed.codex5hReset = undefined;
    } else if (percentFromText(healed.codex5h) === 100) {
      healed.codex5hReset = undefined;
    } else {
      healed.codex5hReset = formatSecondsCountdown((healed.codex5hResetAtMs - now) / 1000);
    }
  }

  if (typeof healed.codex7dResetAtMs === 'number' && healed.codex7dResetAtMs > 0) {
    if (healed.codex7dResetAtMs <= now) {
      healed.codex7d = '100%';
      healed.codex7dReset = undefined;
    } else if (percentFromText(healed.codex7d) === 100) {
      healed.codex7dReset = undefined;
    } else {
      healed.codex7dReset = formatSecondsCountdown((healed.codex7dResetAtMs - now) / 1000);
    }
  }

  if (typeof healed.codexCodeReviewResetAtMs === 'number' && healed.codexCodeReviewResetAtMs > 0) {
    if (healed.codexCodeReviewResetAtMs <= now) {
      healed.codexCodeReview = '100%';
      healed.codexCodeReviewReset = undefined;
    } else if (percentFromText(healed.codexCodeReview) === 100) {
      healed.codexCodeReviewReset = undefined;
    } else {
      healed.codexCodeReviewReset = formatSecondsCountdown(
        (healed.codexCodeReviewResetAtMs - now) / 1000
      );
    }
  }

  return healed;
}

export class CodexVault {
  private liveSessionCache: {
    info: LiveSessionInfo;
    decoded: DecodedCodexAuth | null;
    timestamp: number;
    statKey: string;
  } | null = null;
  private readonly CACHE_TTL_MS = 4000;

  constructor() {
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    const profilesDir = getCodexProfilesDir();
    if (!fs.existsSync(profilesDir)) {
      fs.mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
    }
  }

  public invalidateLiveSessionCache(): void {
    this.liveSessionCache = null;
  }

  private getActiveAuthStatKey(): string {
    const authPath = getActiveCodexAuthPath();
    try {
      const st = fs.statSync(authPath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return 'missing';
    }
  }

  private writeFileAtomic(targetPath: string, content: string | Buffer): void {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const unique = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
    const tmpPath = `${targetPath}.${unique}.tmp`;
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
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

  public readDecodedActiveAuth(): DecodedCodexAuth | null {
    const authPath = getActiveCodexAuthPath();
    if (!fs.existsSync(authPath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      return parseCodexAuthObject(raw);
    } catch {
      return null;
    }
  }

  public getLiveSessionInfo(forceRefresh = false): LiveSessionInfo {
    const statKey = this.getActiveAuthStatKey();
    if (
      !forceRefresh &&
      this.liveSessionCache &&
      this.liveSessionCache.statKey === statKey &&
      Date.now() - this.liveSessionCache.timestamp < this.CACHE_TTL_MS
    ) {
      return this.liveSessionCache.info;
    }

    const decoded = this.readDecodedActiveAuth();
    const info: LiveSessionInfo = decoded
      ? {
          email: decoded.email,
          accountId: decoded.accountId,
          organizationId: decoded.organizationId,
          userId: decoded.userId,
          planTier: decoded.planTier,
          authMode: decoded.authMode,
          hasOAuthCreds: Boolean(decoded.accessToken),
          tokenExpiryDate: decoded.tokenExpiryDate,
          isExpired: decoded.isExpired
        }
      : {
          email: null,
          accountId: null,
          organizationId: null,
          userId: null,
          planTier: undefined,
          authMode: undefined,
          hasOAuthCreds: false,
          tokenExpiryDate: null,
          isExpired: false
        };

    this.liveSessionCache = { info, decoded, timestamp: Date.now(), statKey };
    return info;
  }

  public listProfiles(): ProfileMetadata[] {
    this.ensureDirectories();
    const profilesDir = getCodexProfilesDir();
    const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
    const profiles: ProfileMetadata[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folderPath = path.join(profilesDir, entry.name);
      const metaPath = path.join(folderPath, 'metadata.json');
      const authPath = path.join(folderPath, 'auth.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ProfileMetadata;
        const emailNorm = (meta.email || '').trim();
        if ((!emailNorm || emailNorm === 'Unknown') && !fs.existsSync(authPath)) {
          try {
            fs.rmSync(folderPath, { recursive: true, force: true });
          } catch {}
          continue;
        }
        meta.provider = 'codex';
        if (meta.cachedQuota) {
          meta.cachedQuota = healExpiredCodexMetric(meta.cachedQuota);
        }
        profiles.push(meta);
      } catch {}
    }

    const hasAuthCredentials = (profId: string): boolean => {
      try {
        const authFile = path.join(profilesDir, profId, 'auth.json');
        if (!fs.existsSync(authFile)) return false;
        const parsed = JSON.parse(fs.readFileSync(authFile, 'utf8'));
        return Boolean(
          parsed?.tokens?.refresh_token ||
            parsed?.tokens?.access_token ||
            (typeof parsed?.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.trim())
        );
      } catch {
        return false;
      }
    };

    profiles.sort((a, b) => {
      const aCred = hasAuthCredentials(a.id) ? 1 : 0;
      const bCred = hasAuthCredentials(b.id) ? 1 : 0;
      if (bCred !== aCred) return bCred - aCred;
      return b.updatedAt - a.updatedAt;
    });

    const seenKeys = new Set<string>();
    const deduped: ProfileMetadata[] = [];
    for (const p of profiles) {
      const key = p.accountId
        ? `acc:${p.accountId}`
        : `email:${(p.email || '').trim().toLowerCase()}`;
      if (key === 'email:' || key === 'email:unknown') {
        deduped.push(p);
        continue;
      }
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        deduped.push(p);
      } else if (!fs.existsSync(getProfileCliHomeDir('codex', p.id))) {
        try {
          fs.rmSync(path.join(profilesDir, p.id), { recursive: true, force: true });
        } catch {}
      }
    }

    return deduped;
  }

  /**
   * Disambiguates multi-workspace Codex sessions by matching `accountId` first,
   * falling back to canonical email when `accountId` is absent.
   */
  public findMatchingProfile(session: { accountId?: string | null; email?: string | null }): ProfileMetadata | null {
    const profiles = this.listProfiles();
    if (session.accountId) {
      const byAcc = profiles.find(p => p.accountId && p.accountId === session.accountId);
      if (byAcc) return byAcc;
    }
    if (session.email) {
      const targetEmail = session.email.toLowerCase().trim();
      // Only match by email if neither has a conflicting accountId
      const byEmail = profiles.find(
        p =>
          p.email.toLowerCase().trim() === targetEmail &&
          (!session.accountId || !p.accountId || p.accountId === session.accountId)
      );
      if (byEmail) return byEmail;
    }
    return null;
  }

  private slugify(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return base || `codex-${Date.now()}`;
  }

  public saveAuthObjectAsProfile(
    rawAuthJson: any,
    customLabel?: string,
    existingId?: string,
    preservedQuota?: CachedQuotaMetric
  ): ProfileMetadata {
    this.ensureDirectories();
    const decoded = parseCodexAuthObject(rawAuthJson);
    if (!decoded || !decoded.email) {
      throw new Error('No active OpenAI Codex session found in ~/.codex/auth.json.');
    }

    const existing = existingId
      ? this.listProfiles().find(p => p.id === existingId) || null
      : this.findMatchingProfile({ accountId: decoded.accountId, email: decoded.email });

    const now = Date.now();
    const id = existing ? existing.id : this.generateUniqueId(customLabel || decoded.email.split('@')[0]);
    const name = customLabel?.trim() || existing?.name || decoded.email.split('@')[0];

    const profileDir = path.join(getCodexProfilesDir(), id);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    }

    const authFilePath = path.join(profileDir, 'auth.json');
    let sameStoredTokens = false;
    if (existing && fs.existsSync(authFilePath)) {
      try {
        const prevRaw = JSON.parse(fs.readFileSync(authFilePath, 'utf8'));
        const prevKey =
          typeof prevRaw?.OPENAI_API_KEY === 'string' ? prevRaw.OPENAI_API_KEY.trim() : '';
        const nextKey =
          typeof rawAuthJson?.OPENAI_API_KEY === 'string' ? rawAuthJson.OPENAI_API_KEY.trim() : '';
        sameStoredTokens = Boolean(
          (prevRaw?.tokens?.access_token &&
            prevRaw.tokens.access_token === rawAuthJson?.tokens?.access_token &&
            prevRaw?.tokens?.refresh_token === rawAuthJson?.tokens?.refresh_token) ||
            (prevKey && prevKey === nextKey)
        );
      } catch {}
    }

    this.writeFileAtomic(authFilePath, JSON.stringify(rawAuthJson, null, 2));

    const defaultQuota: CachedQuotaMetric = preservedQuota ||
      existing?.cachedQuota || {
        plan: decoded.planTier,
        gemini: '--',
        claudeGpt: '--',
        argon: '--',
        codex5h: '--',
        codex7d: '--',
        updatedAt: 0
      };

    const preservedAuthStatus =
      sameStoredTokens && existing?.authStatus ? existing.authStatus : 'ok';

    const metadata: ProfileMetadata = {
      id,
      provider: 'codex',
      name,
      email: decoded.email,
      accountId: decoded.accountId || undefined,
      organizationId: decoded.organizationId || undefined,
      userId: decoded.userId || undefined,
      authMode: decoded.authMode,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      tokenExpiryDate: decoded.tokenExpiryDate || undefined,
      planOverride: existing?.planOverride,
      cachedQuota: defaultQuota,
      authStatus: preservedAuthStatus,
      authCheckedAt: sameStoredTokens ? existing?.authCheckedAt || now : now,
      ...(sameStoredTokens && existing?.authErrorCode
        ? { authErrorCode: existing.authErrorCode }
        : {}),
      ...(sameStoredTokens && existing?.authErrorMessage
        ? { authErrorMessage: existing.authErrorMessage }
        : {})
    };

    this.writeFileAtomic(path.join(profileDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    this.invalidateLiveSessionCache();
    return metadata;
  }

  private generateUniqueId(baseLabel: string): string {
    const baseSlug = this.slugify(baseLabel);
    let candidate = baseSlug;
    let counter = 2;
    while (fs.existsSync(path.join(getCodexProfilesDir(), candidate))) {
      candidate = `${baseSlug}-${counter}`;
      counter++;
    }
    return candidate;
  }

  public saveCurrentAsProfile(
    customLabel?: string,
    liveMetric?: CachedQuotaMetric | null
  ): ProfileMetadata {
    const authPath = getActiveCodexAuthPath();
    if (!fs.existsSync(authPath)) {
      throw new Error('No active Codex session found at ~/.codex/auth.json. Please sign in to Codex first.');
    }
    const rawAuthJson = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    return this.saveAuthObjectAsProfile(
      rawAuthJson,
      customLabel,
      undefined,
      liveMetric || undefined
    );
  }

  /**
   * Automatically saves the active `~/.codex/auth.json` into the vault when it belongs to an
   * account not yet tracked in the vault (so Switch / CLI Only never clobbers an unsaved session).
   * If it matches an existing vault profile, syncs fresh active tokens into it instead and returns null.
   */
  public autoSaveUnsavedActiveSession(
    liveMetric?: CachedQuotaMetric | null
  ): ProfileMetadata | null {
    const currentDecoded = this.readDecodedActiveAuth();
    if (!currentDecoded || (!currentDecoded.email && !currentDecoded.accountId)) {
      return null;
    }
    const existing = this.findMatchingProfile({
      accountId: currentDecoded.accountId,
      email: currentDecoded.email
    });
    if (existing) {
      this.syncActiveCredentialsToProfile(existing.id, currentDecoded.rawAuthJson, currentDecoded);
      if (liveMetric && liveMetric.updatedAt > (existing.cachedQuota?.updatedAt || 0)) {
        this.updateProfileCachedQuota(existing.id, liveMetric);
      }
      return null;
    }
    if (!currentDecoded.email) {
      return null;
    }
    return this.saveAuthObjectAsProfile(
      currentDecoded.rawAuthJson,
      undefined,
      undefined,
      liveMetric || undefined
    );
  }

  public updateProfileCachedQuota(profileId: string, quota: CachedQuotaMetric): void {
    const profileDir = path.join(getCodexProfilesDir(), profileId);
    const metaPath = path.join(profileDir, 'metadata.json');
    if (!fs.existsSync(metaPath)) return;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ProfileMetadata;
      meta.cachedQuota = quota;
      this.writeFileAtomic(metaPath, JSON.stringify(meta, null, 2));
    } catch {}
  }

  public updateProfileAuthHealth(
    profileId: string,
    health: {
      authStatus: AuthHealthStatus;
      authErrorCode?: string;
      authErrorMessage?: string;
      authCheckedAt?: number;
    }
  ): boolean {
    const profileDir = path.join(getCodexProfilesDir(), profileId);
    const metaPath = path.join(profileDir, 'metadata.json');
    if (!fs.existsSync(metaPath)) return false;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ProfileMetadata;
      const nextCode = health.authStatus === 'ok' ? undefined : health.authErrorCode;
      const nextMsg = health.authStatus === 'ok' ? undefined : health.authErrorMessage;
      const changed =
        meta.authStatus !== health.authStatus ||
        meta.authErrorCode !== nextCode ||
        meta.authErrorMessage !== nextMsg;

      meta.authStatus = health.authStatus;
      meta.authCheckedAt = health.authCheckedAt || Date.now();
      if (nextCode) meta.authErrorCode = nextCode;
      else delete meta.authErrorCode;
      if (nextMsg) meta.authErrorMessage = nextMsg;
      else delete meta.authErrorMessage;

      this.writeFileAtomic(metaPath, JSON.stringify(meta, null, 2));
      return changed;
    } catch {
      return false;
    }
  }

  public syncActiveCredentialsToProfile(
    profileId: string,
    rawAuthJson: any,
    decoded: DecodedCodexAuth
  ): boolean {
    const profileDir = path.join(getCodexProfilesDir(), profileId);
    const metaPath = path.join(profileDir, 'metadata.json');
    const authPath = path.join(profileDir, 'auth.json');
    if (!fs.existsSync(metaPath)) return false;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ProfileMetadata;
      if (
        meta.accountId &&
        decoded.accountId &&
        meta.accountId !== decoded.accountId
      ) {
        return false;
      }
      if (
        !meta.accountId &&
        meta.email &&
        decoded.email &&
        meta.email.toLowerCase().trim() !== decoded.email.toLowerCase().trim()
      ) {
        return false;
      }

      let sameStoredTokens = false;
      if (fs.existsSync(authPath)) {
        try {
          const prevRaw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
          sameStoredTokens =
            prevRaw?.tokens?.access_token === rawAuthJson?.tokens?.access_token &&
            prevRaw?.tokens?.refresh_token === rawAuthJson?.tokens?.refresh_token &&
            prevRaw?.OPENAI_API_KEY === rawAuthJson?.OPENAI_API_KEY;
        } catch {}
      }

      if (!sameStoredTokens && rawAuthJson) {
        this.writeFileAtomic(authPath, JSON.stringify(rawAuthJson, null, 2));
      }

      if (!sameStoredTokens) {
        meta.updatedAt = Date.now();
        if (decoded.tokenExpiryDate) meta.tokenExpiryDate = decoded.tokenExpiryDate;
        meta.authStatus = 'ok';
        meta.authCheckedAt = Date.now();
        delete meta.authErrorCode;
        delete meta.authErrorMessage;
        this.writeFileAtomic(metaPath, JSON.stringify(meta, null, 2));
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  public renameProfile(profileId: string, newName: string): ProfileMetadata {
    const profileDir = path.join(getCodexProfilesDir(), profileId);
    const metaPath = path.join(profileDir, 'metadata.json');
    if (!fs.existsSync(metaPath)) {
      throw new Error(`Codex profile "${profileId}" not found.`);
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ProfileMetadata;
    meta.name = newName.trim();
    meta.updatedAt = Date.now();
    this.writeFileAtomic(metaPath, JSON.stringify(meta, null, 2));
    return meta;
  }

  public deleteProfile(profileId: string): void {
    const profileDir = path.join(getCodexProfilesDir(), profileId);
    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }

  /**
   * Checks if ~/.codex/config.toml explicitly configures `cli_auth_credentials_store = "keyring"` or `"auto"`.
   * If so, clears any stale OS keyring entry so Codex reads the freshly written `~/.codex/auth.json`.
   */
  private async clearOptionalCodexKeyringIfConfigured(): Promise<void> {
    const configPath = getActiveCodexConfigPath();
    if (!fs.existsSync(configPath)) return;
    try {
      const configText = fs.readFileSync(configPath, 'utf8');
      if (!/^\s*cli_auth_credentials_store\s*=\s*["'](keyring|auto)["']/mi.test(configText)) {
        return;
      }
      const codexHome = getCodexHomeDir();
      const canonical = fs.existsSync(codexHome) ? fs.realpathSync(codexHome) : codexHome;
      const candidatePaths = new Set<string>([canonical]);
      if (process.platform === 'win32' && !canonical.startsWith('\\\\?\\')) {
        // Rust `std::fs::canonicalize()` in `codex.exe` prefixes `\\?\` before hashing `sha256`
        candidatePaths.add(`\\\\?\\${canonical}`);
      }
      const hashes = Array.from(candidatePaths).map((p) =>
        crypto.createHash('sha256').update(p, 'utf8').digest('hex').slice(0, 16)
      );
      const directAccount = `cli|${hashes[0]}`;
      const secretsAccount = `secrets|${hashes[0]}`;

      if (process.platform === 'win32') {
        const tasks: Array<Promise<void>> = [];
        for (const h16 of hashes) {
          tasks.push(
            new Promise<void>((resolve) => {
              execFile(
                'cmdkey.exe',
                [`/delete:Codex Auth:cli|${h16}`],
                { timeout: 2500, windowsHide: true },
                () => resolve()
              );
            }),
            new Promise<void>((resolve) => {
              execFile(
                'cmdkey.exe',
                [`/delete:codex:secrets|${h16}`],
                { timeout: 2500, windowsHide: true },
                () => resolve()
              );
            })
          );
        }
        await Promise.all(tasks);
      } else if (process.platform === 'darwin') {
        await Promise.all([
          new Promise<void>(resolve => {
            execFile(
              '/usr/bin/security',
              ['delete-generic-password', '-s', 'Codex Auth', '-a', directAccount],
              { timeout: 2500 },
              () => resolve()
            );
          }),
          new Promise<void>(resolve => {
            execFile(
              '/usr/bin/security',
              ['delete-generic-password', '-s', 'codex', '-a', secretsAccount],
              { timeout: 2500 },
              () => resolve()
            );
          })
        ]);
      } else if (process.platform === 'linux') {
        if (!hasLinuxDbusSession()) return;
        const tasks: Array<Promise<void>> = [];
        for (const [service, acct] of [
          ['Codex Auth', directAccount],
          ['codex', secretsAccount]
        ]) {
          for (const attr of ['username', 'account']) {
            tasks.push(
              new Promise<void>(resolve => {
                execFile(
                  'secret-tool',
                  ['clear', 'service', service, attr, acct],
                  { timeout: 2500 },
                  () => resolve()
                );
              })
            );
          }
        }
        await Promise.all(tasks);
      }
    } catch {}
  }

  /**
   * Atomically switches `~/.codex/auth.json` to the target profile's credentials.
   * Before overwriting, snapshots the outgoing active session's tokens into its vault profile.
   */
  public async switchProfile(
    profileId: string,
    outgoingLiveMetric?: CachedQuotaMetric | null
  ): Promise<ProfileMetadata> {
    try {
      syncCodexCliHomeToVault(profileId);
    } catch {}
    const profileDir = path.join(getCodexProfilesDir(), profileId);
    const metaPath = path.join(profileDir, 'metadata.json');
    const sourceAuthPath = path.join(profileDir, 'auth.json');

    if (!fs.existsSync(metaPath) || !fs.existsSync(sourceAuthPath)) {
      throw new Error(`Codex profile "${profileId}" is missing its credential store.`);
    }

    // Back up outgoing active session if it matches an existing profile in the vault
    try {
      const currentDecoded = this.readDecodedActiveAuth();
      if (currentDecoded && currentDecoded.email) {
        const outgoingMatch = this.findMatchingProfile({
          accountId: currentDecoded.accountId,
          email: currentDecoded.email
        });
        if (outgoingMatch && outgoingMatch.id !== profileId) {
          const outgoingQuota =
            outgoingLiveMetric &&
            outgoingLiveMetric.updatedAt >= (outgoingMatch.cachedQuota?.updatedAt || 0)
              ? outgoingLiveMetric
              : outgoingMatch.cachedQuota;
          this.saveAuthObjectAsProfile(
            currentDecoded.rawAuthJson,
            outgoingMatch.name,
            outgoingMatch.id,
            outgoingQuota
          );
        }
      }
    } catch {}

    const targetRawAuth = fs.readFileSync(sourceAuthPath, 'utf8');
    const activeAuthPath = getActiveCodexAuthPath();
    this.writeFileAtomic(activeAuthPath, targetRawAuth);
    await this.clearOptionalCodexKeyringIfConfigured();

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ProfileMetadata;
    meta.updatedAt = Date.now();
    this.writeFileAtomic(metaPath, JSON.stringify(meta, null, 2));

    this.invalidateLiveSessionCache();
    return meta;
  }

  /**
   * Backs up the active `~/.codex/auth.json` into the vault and clears the active login slot
   * so the user can sign into a new ChatGPT/Codex account cleanly without server-side token revocation.
   */
  public async prepareNewLoginAsync(options?: {
    deferFileUnlink?: boolean;
    liveMetric?: CachedQuotaMetric | null;
  }): Promise<PrepareNewLoginResult> {
    let backedUpProfile: ProfileMetadata | null = null;
    let wasExisting = false;

    const currentDecoded = this.readDecodedActiveAuth();
    if (currentDecoded && currentDecoded.email) {
      const existing = this.findMatchingProfile({
        accountId: currentDecoded.accountId,
        email: currentDecoded.email
      });
      wasExisting = Boolean(existing);
      const quotaToPreserve =
        options?.liveMetric &&
        (!existing?.cachedQuota ||
          options.liveMetric.updatedAt >= (existing.cachedQuota.updatedAt || 0))
          ? options.liveMetric
          : existing?.cachedQuota;
      backedUpProfile = this.saveAuthObjectAsProfile(
        currentDecoded.rawAuthJson,
        existing?.name,
        existing?.id,
        quotaToPreserve
      );
    }

    if (!options?.deferFileUnlink) {
      this.unlinkActiveAuthFileIfPresent();
    }
    await this.clearOptionalCodexKeyringIfConfigured();
    this.invalidateLiveSessionCache();

    return { backedUpProfile, wasExisting };
  }

  public unlinkActiveAuthFileIfPresent(): void {
    const activeAuthPath = getActiveCodexAuthPath();
    if (fs.existsSync(activeAuthPath)) {
      try {
        fs.unlinkSync(activeAuthPath);
      } catch {}
    }
    this.invalidateLiveSessionCache();
  }
}

export class CodexQuotaService {
  private cachedSummary: QuotaSummary | null = null;
  private cachedMetric: CachedQuotaMetric | null = null;
  private lastFetchTime = 0;
  private readonly CACHE_TTL_MS = 15000;
  private inFlightActiveFetch: Promise<{
    summary: QuotaSummary | null;
    metric: CachedQuotaMetric | null;
  }> | null = null;
  private inFlightActiveFetchKey: string | null = null;
  private graftedRootProc: any = null;
  private graftedCurrentChild: any = null;
  private graftedParser: any = null;
  private lastSyncedAccountKey: string | null = null;
  private lastNativeLoginAt = 0;
  private isHotSwapping = false;
  private pendingHotSwapMode: 'chatgpt' | 'apikey' | null | undefined = undefined;
  private observedStdoutProcs = new WeakSet<object>();
  private observedStdinProcs = new WeakSet<object>();
  private exitedProcs = new WeakSet<object>();
  private inFlightProfileRefresh = new Map<string, Promise<CachedQuotaMetric | null>>();
  private inFlightOAuthRefresh = new Map<string, Promise<DecodedCodexAuth | null>>();
  private activityListeners = new Set<(event: string) => void>();
  private rateLimitsUpdateListeners = new Set<(rateLimits: any) => void>();
  private processExitListeners = new Set<() => void>();
  private claimedProfileIdsProvider: (() => ReadonlySet<string>) | null = null;
  private activeAuthHealth: {
    accountKey: string;
    authStatus: AuthHealthStatus;
    authErrorCode?: string;
    authErrorMessage?: string;
    checkedAt: number;
  } | null = null;

  public setClaimedProfileIdsProvider(
    provider: (() => ReadonlySet<string>) | null
  ): void {
    this.claimedProfileIdsProvider = provider;
  }

  public onActivity(listener: (event: string) => void): () => void {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  public onRateLimitsUpdated(listener: (rateLimits: any) => void): () => void {
    this.rateLimitsUpdateListeners.add(listener);
    return () => {
      this.rateLimitsUpdateListeners.delete(listener);
    };
  }

  public onProcessExited(listener: () => void): () => void {
    this.processExitListeners.add(listener);
    return () => {
      this.processExitListeners.delete(listener);
    };
  }

  public dispose(): void {
    this.activityListeners.clear();
    this.rateLimitsUpdateListeners.clear();
    this.processExitListeners.clear();
  }

  public getLastFetchTime(): number {
    return this.lastFetchTime;
  }

  public getActiveAuthHealth(
    session?: { accountId?: string | null; email?: string | null } | null
  ): {
    authStatus: AuthHealthStatus;
    authErrorCode?: string;
    authErrorMessage?: string;
    checkedAt: number;
  } | null {
    if (!this.activeAuthHealth) return null;
    if (session) {
      const key = session.accountId || session.email?.toLowerCase() || '';
      if (key && this.activeAuthHealth.accountKey !== key) {
        return null;
      }
    }
    return this.activeAuthHealth;
  }

  public getCachedSummary(): QuotaSummary | null {
    return this.cachedSummary;
  }

  public getCachedMetric(): CachedQuotaMetric | null {
    return this.cachedMetric;
  }

  public isCacheFresh(): boolean {
    return this.lastFetchTime > 0 && Date.now() - this.lastFetchTime < this.CACHE_TTL_MS;
  }

  public invalidateCache(): void {
    this.lastFetchTime = 0;
    this.activeAuthHealth = null;
  }

  private computeAuthFingerprint(decoded: DecodedCodexAuth | null): string {
    if (!decoded) return 'none';
    const identity = decoded.accountId || decoded.email?.toLowerCase() || '';
    const tokenTail = decoded.accessToken
      ? decoded.accessToken.slice(-12)
      : typeof decoded.rawAuthJson?.OPENAI_API_KEY === 'string'
        ? decoded.rawAuthJson.OPENAI_API_KEY.slice(-8)
        : '';
    return `${decoded.authMode}:${identity}:${tokenTail}`;
  }

  private extractIdentityFromFingerprint(fingerprint: string | null): string {
    if (!fingerprint || fingerprint === 'none') return 'none';
    return fingerprint.split(':').slice(0, 2).join(':');
  }

  public primeActiveAccountKey(codexVault: CodexVault): void {
    const decoded = codexVault.readDecodedActiveAuth();
    this.lastSyncedAccountKey = this.computeAuthFingerprint(decoded);
  }

  public markLoggingOut(): void {
    this.lastSyncedAccountKey = 'none';
    this.activeAuthHealth = null;
    this.cachedSummary = null;
    this.cachedMetric = null;
    this.lastFetchTime = 0;
  }

  private attachStdoutObserver(proc: any): void {
    if (!proc || typeof proc !== 'object' || !proc.stdout) return;
    const attachedAt = Date.now();
    if (!this.observedStdoutProcs.has(proc)) {
      this.observedStdoutProcs.add(proc);
      try {
        let exited = false;
        const markExited = () => {
          if (exited) return;
          exited = true;
          this.exitedProcs.add(proc);
          for (const cb of this.processExitListeners) {
            try { cb(); } catch {}
          }
        };
        proc.once?.('exit', markExited);
        proc.once?.('close', markExited);
        let partialLine = '';
        proc.stdout.on('data', (chunk: Buffer | string) => {
          const text =
            partialLine +
            (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
          const lines = text.split('\n');
          partialLine = lines.pop() ?? '';
          if (partialLine.length > 65536) {
            partialLine = partialLine.slice(-4096);
          }
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            if (line.includes('"account/login/completed"')) {
              this.lastNativeLoginAt = Date.now();
              for (const listener of this.activityListeners) {
                try { listener('account/login/completed'); } catch {}
              }
            }
            if (line.includes('"account/rateLimits/updated"')) {
              try {
                const parsed = JSON.parse(line);
                if (parsed?.method === 'account/rateLimits/updated' && parsed?.params) {
                  const rl = parsed.params.rateLimits ?? parsed.params;
                  if (rl && typeof rl === 'object') {
                    for (const rlListener of this.rateLimitsUpdateListeners) {
                      try { rlListener(rl); } catch {}
                    }
                  }
                }
              } catch {}
              for (const listener of this.activityListeners) {
                try { listener('rateLimits/updated'); } catch {}
              }
            }
            if (
              !line.includes('"id":"charlier-') &&
              line.includes('"method":"turn/completed"')
            ) {
              for (const listener of this.activityListeners) {
                try { listener('turn/completed'); } catch {}
              }
            }
            if (
              !line.includes('"id":"charlier-') &&
              (line.includes('"method":"turn/started"') ||
                line.includes('"method":"thread/started"') ||
                line.includes('"method":"thread/resumed"'))
            ) {
              for (const listener of this.activityListeners) {
                try { listener('turn/started'); } catch {}
              }
            }
          }
        });
      } catch {}
    }

    if (proc.stdin && typeof proc.stdin.write === 'function' && !this.observedStdinProcs.has(proc)) {
      this.observedStdinProcs.add(proc);
      try {
        const origWrite = proc.stdin.write.bind(proc.stdin);
        let partialOut = '';
        proc.stdin.write = (chunk: any, ...rest: any[]) => {
          try {
            const rawStr =
              typeof chunk === 'string'
                ? chunk
                : Buffer.isBuffer(chunk)
                  ? chunk.toString('utf8')
                  : '';
            if (rawStr) {
              const combined = partialOut + rawStr;
              const lines = combined.split('\n');
              partialOut = lines.pop() ?? '';
              if (partialOut.length > 65536) {
                partialOut = partialOut.slice(-4096);
              }
              const pastWarmup = Date.now() - attachedAt > 1200;
              for (const line of lines) {
                if (
                  !line.includes('"id":"charlier-') &&
                  (line.includes('"method":"turn/start"') ||
                    line.includes('"method":"turn/steer"') ||
                    line.includes('"method":"turn/interrupt"') ||
                    line.includes('"method":"turn/addUserMessage"') ||
                    line.includes('"method":"thread/resume"') ||
                    line.includes('"method":"thread/start"') ||
                    line.includes('"method":"thread/approveGuardianDeniedAction"') ||
                    line.includes('"method":"thread/readState/update"') ||
                    line.includes('"method":"review/start"') ||
                    (pastWarmup && line.includes('"method":"thread/read"')))
                ) {
                  for (const listener of this.activityListeners) {
                    try { listener('turn/started'); } catch {}
                  }
                }
              }
            }
          } catch {}
          return origWrite(chunk, ...rest);
        };
      } catch {}
    }
  }

  private hasLiveCodexChild(): boolean {
    if (this.isProcAlive(this.graftedCurrentChild)) {
      return true;
    }
    const getHandles = (process as any)._getActiveHandles;
    if (typeof getHandles !== 'function') return false;
    try {
      const handles: any[] = getHandles.call(process) || [];
      return handles.some((h) => h && this.isProcAlive(h) && isCodexAppServerProcess(h, false));
    } catch {
      return false;
    }
  }

  /**
   * Applies a live `account/rateLimits/updated` JSON-RPC push straight from `codex app-server`
   * into the active cache and matching vault profile with zero extra HTTPS requests.
   */
  public applyLiveRateLimitsPush(
    codexVault: CodexVault,
    rateLimits: any
  ): CachedQuotaMetric | null {
    if (!rateLimits || typeof rateLimits !== 'object') return null;
    const primary = rateLimits.primary || rateLimits.primary_window;
    const secondary = rateLimits.secondary || rateLimits.secondary_window;
    const primaryUsed = primary?.usedPercent ?? primary?.used_percent;
    const secondaryUsed = secondary?.usedPercent ?? secondary?.used_percent;
    const primaryRemPct = remainingFromUsedPercent(primaryUsed);
    const secondaryRemPct = remainingFromUsedPercent(secondaryUsed);
    if (primaryRemPct === null && secondaryRemPct === null) {
      return null;
    }

    const decoded = codexVault.readDecodedActiveAuth();
    if (!decoded || decoded.authMode === 'apikey') return null;

    const toResetMs = (w: any): number | undefined => {
      const raw = w?.resetsAt ?? w?.reset_at;
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
      return raw > 1e12 ? raw : raw * 1000;
    };
    const toWindowMins = (w: any, fallback: number): number => {
      if (typeof w?.windowDurationMins === 'number' && Number.isFinite(w.windowDurationMins)) {
        return Math.round(w.windowDurationMins);
      }
      if (typeof w?.limit_window_seconds === 'number' && Number.isFinite(w.limit_window_seconds)) {
        return Math.round(w.limit_window_seconds / 60);
      }
      return fallback;
    };

    const now = Date.now();
    const activeProfile = codexVault.findMatchingProfile({
      accountId: decoded.accountId,
      email: decoded.email
    });
    const prev = this.cachedMetric || activeProfile?.cachedQuota || null;
    const planTier = normalizeCodexPlanTier(
      rateLimits.planType || rateLimits.plan_type || prev?.plan || decoded.planTier,
      decoded.authMode
    );

    const primaryResetAtMs = toResetMs(primary) ?? prev?.codex5hResetAtMs;
    const secondaryResetAtMs = toResetMs(secondary) ?? prev?.codex7dResetAtMs;
    const primaryResetStr =
      primaryRemPct !== null && primaryRemPct < 100 && primaryResetAtMs
        ? formatSecondsCountdown((primaryResetAtMs - now) / 1000)
        : '';
    const secondaryResetStr =
      secondaryRemPct !== null && secondaryRemPct < 100 && secondaryResetAtMs
        ? formatSecondsCountdown((secondaryResetAtMs - now) / 1000)
        : '';

    const next5h = primaryRemPct !== null ? `${primaryRemPct}%` : prev?.codex5h || '--';
    const next7d = secondaryRemPct !== null ? `${secondaryRemPct}%` : prev?.codex7d || '--';
    const explicitCreditsField = rateLimits.credits && typeof rateLimits.credits === 'object';
    const creditsBalance = explicitCreditsField
      ? rateLimits.credits.hasCredits && rateLimits.credits.balance
        ? `$${rateLimits.credits.balance}`
        : undefined
      : prev?.codexCreditsBalance;
    const rawPushResetCredits =
      rateLimits.rateLimitResetCredits?.availableCount ??
      rateLimits.rate_limit_reset_credits?.available_count;
    const nextResetCredits =
      typeof rawPushResetCredits === 'number' && Number.isFinite(rawPushResetCredits)
        ? Math.max(0, Math.round(rawPushResetCredits))
        : prev?.codexResetCredits;

    const prev5hPct = percentFromText(prev?.codex5h);
    const possibleCreditSpent = Boolean(
      typeof rawPushResetCredits !== 'number' &&
        prev5hPct !== null &&
        primaryRemPct !== null &&
        prev5hPct < 50 &&
        primaryRemPct >= prev5hPct + 40 &&
        typeof prev?.codexResetCredits === 'number' &&
        prev.codexResetCredits > 0
    );

    const metric: CachedQuotaMetric = {
      ...(prev || {}),
      plan: planTier,
      gemini: next5h,
      claudeGpt: next7d,
      argon: '--',
      codex5h: next5h,
      codex5hReset: primaryResetStr || undefined,
      codex5hResetAtMs: primaryResetAtMs,
      codex5hWindowMins: toWindowMins(primary, prev?.codex5hWindowMins || 300),
      codex7d: next7d,
      codex7dReset: secondaryResetStr || undefined,
      codex7dResetAtMs: secondaryResetAtMs,
      codex7dWindowMins: toWindowMins(secondary, prev?.codex7dWindowMins || 10080),
      codexCreditsBalance: creditsBalance,
      ...(typeof nextResetCredits === 'number' ? { codexResetCredits: nextResetCredits } : {}),
      updatedAt: now
    };
    if (!metric.codexCreditsBalance) {
      delete metric.codexCreditsBalance;
    }

    const accountKey = decoded.accountId || decoded.email?.toLowerCase() || '';
    this.cachedMetric = metric;
    this.lastFetchTime = possibleCreditSpent ? 0 : now;
    this.activeAuthHealth = {
      accountKey,
      authStatus: 'ok',
      checkedAt: now
    };
    if (this.cachedSummary) {
      this.cachedSummary = {
        ...this.cachedSummary,
        email: decoded.email || this.cachedSummary.email,
        accountId: decoded.accountId || this.cachedSummary.accountId,
        planTier,
        tier: formatCodexTierLabel(planTier),
        fetchedAt: now
      };
    }

    if (activeProfile) {
      codexVault.updateProfileCachedQuota(activeProfile.id, metric);
      if (activeProfile.authStatus === 'revoked' || activeProfile.authStatus === 'expired') {
        codexVault.updateProfileAuthHealth(activeProfile.id, {
          authStatus: 'ok',
          authCheckedAt: now
        });
      }
    }
    return metric;
  }

  private isProcAlive(proc: any): boolean {
    if (!proc || typeof proc !== 'object') return false;
    if (this.exitedProcs.has(proc)) return false;
    return proc.exitCode === null && proc.signalCode === null && !proc.killed;
  }

  public ensureStdoutObserver(): boolean {
    if (this.isProcAlive(this.graftedCurrentChild)) {
      this.attachStdoutObserver(this.graftedCurrentChild);
      return true;
    }
    const getHandles = (process as any)._getActiveHandles;
    if (typeof getHandles !== 'function') {
      return false;
    }
    try {
      const handles: any[] = getHandles.call(process) || [];
      const foundProc = handles.find(
        (h) =>
          h &&
          this.isProcAlive(h) &&
          isCodexAppServerProcess(h, false) &&
          h.stdout &&
          h.stdin
      );
      if (foundProc) {
        this.attachStdoutObserver(foundProc);
        return true;
      }
    } catch {}
    return false;
  }

  private ensureGraftedHandles(): boolean {
    const getHandles = (process as any)._getActiveHandles;
    if (typeof getHandles !== 'function') {
      return Boolean(this.graftedRootProc && this.graftedParser);
    }
    const handles: any[] = getHandles.call(process) || [];
    // If `openai.chatgpt` respawned a fresh `codex app-server` handle mid-session, re-bind
    // onto the live extension handle instead of grafting onto an orphaned previous rootProc.
    const externalFreshProc = handles.find(
      (h) =>
        h &&
        h !== this.graftedRootProc &&
        h !== this.graftedCurrentChild &&
        this.isProcAlive(h) &&
        isCodexAppServerProcess(h, false) &&
        h.stdout &&
        h.stdin
    );
    if (!externalFreshProc && this.graftedRootProc && this.graftedParser) {
      return true;
    }
    const foundProc =
      externalFreshProc ||
      handles.find(
        (h) =>
          h &&
          isCodexAppServerProcess(h, true) &&
          h.stdout &&
          h.stdin
      );
    if (!foundProc) {
      return Boolean(this.graftedRootProc && this.graftedParser);
    }
    const pipes = foundProc.stdout?._readableState?.pipes;
    const parser = Array.isArray(pipes) ? pipes[0] : pipes;
    if (!parser || typeof parser.write !== 'function') {
      return false;
    }

    this.graftedRootProc = foundProc;
    this.graftedCurrentChild = foundProc;
    this.graftedParser = parser;
    this.attachStdoutObserver(foundProc);

    // Lock liveness properties on the root ChildProcess wrapper referenced by H1.proc
    Object.defineProperty(this.graftedRootProc, 'exitCode', {
      get: () => null,
      set: () => {},
      configurable: true
    });
    Object.defineProperty(this.graftedRootProc, 'signalCode', {
      get: () => null,
      set: () => {},
      configurable: true
    });
    Object.defineProperty(this.graftedRootProc, 'killed', {
      get: () => false,
      set: () => {},
      configurable: true
    });
    return true;
  }

  /**
   * @deprecated Sending JSON-RPC `account/logout` to `codex app-server` causes OpenAI server-side
   * OAuth token revocation (`POST /oauth/revoke`), invalidating backed-up vault refresh tokens.
   * Retained only as a compatibility wrapper that delegates to revoke-free `hotSwapCodexAppServer(null)`.
   */
  public async logoutCodexAppServer(): Promise<'logged-out' | 'not-running' | 'failed'> {
    const res = await this.hotSwapCodexAppServer(null);
    return res === 'swapped' ? 'logged-out' : res;
  }

  /**
   * Called by CredentialWatcher when `~/.codex/auth.json` changes on disk (e.g. switched
   * from another VS Code / Antigravity window or external `codex login`). If the active account
   * changed (or a broken session received fresh tokens), hot-swaps this window's `codex app-server`
   * child process automatically without ever revoking tokens server-side.
   */
  public async syncExternalAuthChange(codexVault: CodexVault): Promise<void> {
    if (this.isHotSwapping) return;
    const decoded = codexVault.readDecodedActiveAuth();
    const currentKey = this.computeAuthFingerprint(decoded);
    if (this.lastSyncedAccountKey !== null && this.lastSyncedAccountKey === currentKey) {
      return;
    }

    const prevKey = this.lastSyncedAccountKey;
    const prevIdentity = this.extractIdentityFromFingerprint(prevKey);
    const currIdentity = this.extractIdentityFromFingerprint(currentKey);
    this.lastSyncedAccountKey = currentKey;

    // If this window's own codex app-server just completed an interactive OAuth login,
    // it already holds the fresh credentials in memory and is navigating the webview natively.
    if (decoded && Date.now() - this.lastNativeLoginAt < 6000) {
      return;
    }

    // If the account identity stayed the same and the active session was NOT previously
    // marked broken ('revoked'/'expired'), this is routine in-place OAuth RTR by codex.exe.
    // Do not interrupt a healthy running app-server turn.
    if (prevKey !== null && prevIdentity === currIdentity) {
      const matched = decoded
        ? codexVault.findMatchingProfile({
            accountId: decoded.accountId,
            email: decoded.email
          })
        : null;
      const wasBroken =
        this.activeAuthHealth?.authStatus === 'revoked' ||
        this.activeAuthHealth?.authStatus === 'expired' ||
        matched?.authStatus === 'revoked' ||
        matched?.authStatus === 'expired';
      if (!wasBroken) {
        return;
      }
    }

    const targetMode: 'chatgpt' | 'apikey' | null = decoded ? decoded.authMode : null;
    await this.hotSwapCodexAppServer(targetMode);
  }

  /**
   * Performs a surgical in-memory ChildProcess stdio hot-swap (graft) inside the shared
   * Node.js Extension Host process across Windows, macOS, Linux, and WSL:
   * 1. Locates the `codex app-server` ChildProcess (`oldProc`) held by `openai.chatgpt` (`H1.proc`)
   *    via `process._getActiveHandles()` and captures its `jk` JSONL Writable parser stream.
   * 2. Detaches exit/close/end listeners and locks `exitCode=null, signalCode=null, killed=false`
   *    on the root wrapper so `H1.finishProcessExitIfReady()` never tears down the connection.
   * 3. Terminates the old OS process, spawns a fresh `codex app-server` child process that reads
   *    the current `~/.codex/auth.json` state (or logged-out state when `authMode === null`),
   *    completes the MCP `initialize` handshake, and grafts `newProc.stdin`/`stdout`.
   * 4. Pulses `account/updated` (`prime -> null`) to remount the router cleanly; when
   *    `authMode !== null`, completes Step 3 (`account/login/completed` + target `authMode`).
   *    When `authMode === null`, stops after the null pulse so `/login` mounts cleanly with zero
   *    `account/logout` server-side token revocation.
   */
  public async hotSwapCodexAppServer(
    authMode: 'chatgpt' | 'apikey' | null = 'chatgpt'
  ): Promise<'swapped' | 'not-running' | 'failed'> {
    if (this.isHotSwapping) {
      this.pendingHotSwapMode = authMode;
      return 'swapped';
    }
    this.isHotSwapping = true;
    let failBufferedStdin: ((err: Error) => void) | null = null;
    let pulsePromise: Promise<void> | null = null;
    try {
      // Update lastSyncedAccountKey from disk so CredentialWatcher does not double-fire
      const authPath = getActiveCodexAuthPath();
      if (fs.existsSync(authPath)) {
        try {
          const decoded = parseCodexAuthObject(JSON.parse(fs.readFileSync(authPath, 'utf8')));
          this.lastSyncedAccountKey = this.computeAuthFingerprint(decoded);
        } catch {}
      } else {
        this.lastSyncedAccountKey = 'none';
      }

      if (!this.ensureGraftedHandles()) {
        const getHandles = (process as any)._getActiveHandles;
        if (typeof getHandles !== 'function') {
          return 'failed';
        }
        return 'not-running';
      }

      const rootProc = this.graftedRootProc;
      const currentChild = this.graftedCurrentChild || rootProc;
      const parser = this.graftedParser;
      const prevStdin = rootProc.stdin;

      // Install a lightweight FIFO stdin buffer on rootProc immediately so we can pulse the
      // React remount at t=0ms (instant visual transition alongside Cockpit) without dropping
      // any JSON-RPC requests (`getAuthStatus`, `account/read`, `config/read`) sent while the
      // replacement `codex app-server` spawns and finishes `initialize`.
      const queuedWrites: Array<{
        chunk: any;
        encoding?: BufferEncoding;
        cb?: (err?: Error | null) => void;
      }> = [];
      let stdinBuffered = true;
      const bufferedStdin: any = {
        writable: true,
        destroyed: false,
        writableEnded: false,
        write(
          chunk: any,
          encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
          cb?: (err?: Error | null) => void
        ): boolean {
          const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
          const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
          if (!stdinBuffered && rootProc.stdin && rootProc.stdin !== bufferedStdin) {
            return encoding
              ? rootProc.stdin.write(chunk, encoding, callback)
              : rootProc.stdin.write(chunk, callback);
          }
          queuedWrites.push({ chunk, encoding, cb: callback });
          return true;
        },
        end(cb?: () => void) {
          cb?.();
          return bufferedStdin;
        },
        on() {
          return bufferedStdin;
        },
        once() {
          return bufferedStdin;
        },
        removeListener() {
          return bufferedStdin;
        },
        removeAllListeners() {
          return bufferedStdin;
        }
      };

      failBufferedStdin = (err: Error) => {
        stdinBuffered = false;
        if (rootProc.stdin === bufferedStdin) {
          rootProc.stdin = prevStdin;
        }
        while (queuedWrites.length > 0) {
          const item = queuedWrites.shift()!;
          try {
            item.cb?.(err);
          } catch {}
        }
      };

      rootProc.stdin = bufferedStdin;

      // Detach currentChild streams & listeners before killing its OS PID
      try {
        currentChild.removeAllListeners?.('exit');
        currentChild.removeAllListeners?.('close');
        currentChild.removeAllListeners?.('error');
        currentChild.stdout?.unpipe?.(parser);
        currentChild.stdout?.removeAllListeners?.();
        currentChild.stdin?.removeAllListeners?.();
        currentChild.stderr?.removeAllListeners?.();
      } catch {}

      // Fire the 3-stage `account/updated` remount pulse IMMEDIATELY (concurrently with process
      // respawn) so the Codex sidebar starts transitioning at ~15ms right alongside Cockpit
      // instead of sitting frozen while `codex app-server` boots.
      pulsePromise = (async () => {
        const primeMode: 'chatgpt' | 'apikey' = authMode ?? 'chatgpt';
        parser.write(
          JSON.stringify({
            method: 'account/updated',
            params: { authMode: primeMode, planType: null }
          }) + '\n'
        );

        await new Promise((r) => setTimeout(r, 15));

        parser.write(
          JSON.stringify({
            method: 'account/updated',
            params: { authMode: null, planType: null }
          }) + '\n'
        );

        if (authMode === null) {
          return;
        }

        await new Promise((r) => setTimeout(r, 35));

        parser.write(
          JSON.stringify({
            method: 'account/login/completed',
            params: { loginId: null, success: true, error: null }
          }) + '\n'
        );
        parser.write(
          JSON.stringify({
            method: 'account/updated',
            params: { authMode, planType: null }
          }) + '\n'
        );
      })();

      const oldPid = currentChild.pid;
      if (typeof oldPid === 'number' && oldPid > 0) {
        try {
          process.kill(oldPid, 'SIGTERM');
        } catch {}

        // Wait up to 180ms across Windows, macOS, and Linux (tight 5ms poll) for the old codex
        // process to exit so SQLite locks on ~/.codex/state_*.sqlite and .coordination.lock release cleanly.
        const waitStart = Date.now();
        let alive = true;
        while (Date.now() - waitStart < 180) {
          try {
            process.kill(oldPid, 0);
            await new Promise((r) => setTimeout(r, 5));
          } catch {
            alive = false;
            break;
          }
        }
        if (alive) {
          try {
            process.kill(oldPid, 'SIGKILL');
            await new Promise((r) => setTimeout(r, 15));
          } catch {}
        }
      }

      const spawnFile: string = rootProc.spawnfile;
      const defaultSpawnArgs =
        process.platform === 'win32'
          ? [
              '-c',
              'features.code_mode_host=true',
              '-c',
              'features.windows_sandbox_service=true',
              'app-server',
              '--analytics-default-enabled'
            ]
          : [
              '-c',
              'features.code_mode_host=true',
              'app-server',
              '--analytics-default-enabled'
            ];
      const spawnArgs: string[] = Array.isArray(rootProc.spawnargs)
        ? rootProc.spawnargs.slice(1)
        : defaultSpawnArgs;

      const isWslSpawn = spawnFile.toLowerCase().includes('wsl');
      const pathSep = process.platform === 'win32' ? ';' : ':';
      const binDir = path.dirname(spawnFile);
      const pathKey =
        Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
      const existingPath = process.env[pathKey] || process.env.PATH || '';
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        [pathKey]: existingPath ? `${existingPath}${pathSep}${binDir}` : binDir,
        RUST_LOG: 'warn',
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_vscode',
        ...(isWslSpawn ? {} : { CODEX_HOME: getCodexHomeDir() })
      };

      const newProc = spawn(spawnFile, spawnArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        windowsHide: true,
        shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(spawnFile)
      });

      // Attach error listeners immediately before checking `pid` so async `ENOENT`/`EACCES`
      // emissions on the next tick never throw an unhandled error event in the Extension Host.
      newProc.on('error', () => {});
      newProc.stdin?.on('error', () => {});
      newProc.stderr?.on('data', () => {});

      if (!newProc.pid || !newProc.stdout || !newProc.stdin) {
        failBufferedStdin(new Error('Failed to spawn replacement codex app-server'));
        await pulsePromise.catch(() => {});
        return 'failed';
      }

      // Complete MCP initialize handshake with newProc and capture any trailing lines
      let trailingLines: string[];
      try {
        trailingLines = await new Promise<string[]>((resolve, reject) => {
          let buf = '';
          const timer = setTimeout(() => {
            newProc.stdout?.removeListener('data', onData);
            reject(new Error('Codex app-server initialize handshake timed out'));
          }, 5000);

          const onData = (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            const lines = buf.split('\n');
            // Keep the last partial line in buf
            buf = lines.pop() ?? '';

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line.includes('"init-graft"')) {
                clearTimeout(timer);
                newProc.stdout?.removeListener('data', onData);
                const remaining = lines.slice(i + 1).filter((l) => l.trim().length > 0);
                if (buf.trim().length > 0) {
                  remaining.push(buf);
                }
                resolve(remaining);
                return;
              }
            }
          };

          newProc.stdout.on('data', onData);

          const initReq = {
            id: 'init-graft',
            method: 'initialize',
            params: {
              clientInfo: {
                name: 'codex_vscode',
                title: 'Codex Extension',
                version: '26.1120.41243'
              },
              capabilities: {
                experimentalApi: true,
                mcpServerOpenaiFormElicitation: true,
                requestAttestation: false,
                extensions: {
                  'openai/elicitation': { form: {} }
                }
              }
            }
          };
          newProc.stdin.write(JSON.stringify(initReq) + '\n');
        });
      } catch (initErr: any) {
        try {
          newProc.kill('SIGKILL');
        } catch {}
        failBufferedStdin(initErr instanceof Error ? initErr : new Error(String(initErr)));
        await pulsePromise.catch(() => {});
        throw initErr;
      }

      try {
        newProc.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      } catch {}

      // Ensure the immediate visual remount pulse completed before flushing stdout/stdin
      await pulsePromise.catch(() => {});

      // Graft newProc onto rootProc and parser, then flush all buffered JSON-RPC requests in FIFO order
      for (const remLine of trailingLines) {
        parser.write(remLine.endsWith('\n') ? remLine : remLine + '\n');
      }
      newProc.stdout.pipe(parser, { end: false });
      this.attachStdoutObserver(newProc);
      stdinBuffered = false;
      rootProc.stdin = newProc.stdin;
      rootProc.pid = newProc.pid;
      rootProc.kill = (signal?: NodeJS.Signals | number) => {
        try {
          return newProc.kill(signal as any);
        } catch {
          return false;
        }
      };
      this.graftedCurrentChild = newProc;

      while (queuedWrites.length > 0) {
        const item = queuedWrites.shift()!;
        try {
          if (item.encoding) {
            newProc.stdin.write(item.chunk, item.encoding, item.cb);
          } else {
            newProc.stdin.write(item.chunk, item.cb);
          }
        } catch (writeErr: any) {
          try {
            item.cb?.(writeErr instanceof Error ? writeErr : new Error(String(writeErr)));
          } catch {}
        }
      }

      return 'swapped';
    } catch (swapErr: any) {
      failBufferedStdin?.(
        swapErr instanceof Error ? swapErr : new Error(String(swapErr || 'Codex hot-swap failed'))
      );
      if (pulsePromise) {
        await pulsePromise.catch(() => {});
      }
      return 'failed';
    } finally {
      this.isHotSwapping = false;
      if (this.pendingHotSwapMode !== undefined) {
        const nextMode = this.pendingHotSwapMode;
        this.pendingHotSwapMode = undefined;
        void this.hotSwapCodexAppServer(nextMode).catch(() => {});
      }
    }
  }

  /**
   * Refreshes a Codex profile's OAuth token via `POST https://auth.openai.com/oauth/token`
   * respecting OpenAI's Single-Use Refresh Token Rotation (RTR), serialized per account
   * across concurrent active/profile refresh callers.
   */
  private async refreshCodexOAuthToken(
    rawAuthJson: any,
    profileDir?: string,
    isActiveOnDisk?: boolean
  ): Promise<DecodedCodexAuth | null> {
    const refreshToken = rawAuthJson?.tokens?.refresh_token;
    if (!refreshToken || typeof refreshToken !== 'string') {
      return null;
    }

    const decodedInput = parseCodexAuthObject(rawAuthJson);
    const lockKey =
      decodedInput?.accountId ||
      decodedInput?.email?.toLowerCase() ||
      profileDir ||
      refreshToken;
    const inFlight = this.inFlightOAuthRefresh.get(lockKey);
    if (inFlight) {
      return inFlight;
    }

    const run = this.executeCodexOAuthTokenRefresh(rawAuthJson, profileDir, isActiveOnDisk);
    this.inFlightOAuthRefresh.set(lockKey, run);
    try {
      return await run;
    } finally {
      if (this.inFlightOAuthRefresh.get(lockKey) === run) {
        this.inFlightOAuthRefresh.delete(lockKey);
      }
    }
  }

  private async executeCodexOAuthTokenRefresh(
    rawAuthJson: any,
    profileDir?: string,
    isActiveOnDisk?: boolean
  ): Promise<DecodedCodexAuth | null> {
    const refreshToken = rawAuthJson?.tokens?.refresh_token;
    if (!refreshToken || typeof refreshToken !== 'string') {
      return null;
    }

    // Before consuming a single-use RTR refresh token, check if codex app-server already
    // rotated ~/.codex/auth.json on disk for this exact account.
    if (isActiveOnDisk) {
      try {
        const livePath = getActiveCodexAuthPath();
        const targetDecoded = parseCodexAuthObject(rawAuthJson);
        if (targetDecoded && fs.existsSync(livePath)) {
          const liveNow = parseCodexAuthObject(JSON.parse(fs.readFileSync(livePath, 'utf8')));
          const sameAccount = Boolean(
            liveNow &&
              ((targetDecoded.accountId && liveNow.accountId === targetDecoded.accountId) ||
                (!targetDecoded.accountId &&
                  targetDecoded.email &&
                  liveNow.email?.toLowerCase() === targetDecoded.email.toLowerCase()))
          );
          if (
            sameAccount &&
            liveNow?.accessToken &&
            liveNow.accessToken !== targetDecoded.accessToken
          ) {
            return liveNow;
          }
        }
      } catch {}
    }

    const postBody = JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });

    const responseJson = await new Promise<any>((resolve, reject) => {
      const url = new URL(CODEX_OAUTH_TOKEN_URL);
      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postBody),
            Accept: 'application/json'
          },
          timeout: 8000
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          );
          res.on('end', () => {
            const data = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(e);
              }
            } else {
              const parsedErr = parseCodexErrorBody(data);
              const err: any = new Error(
                parsedErr.message || `OAuth token refresh returned HTTP ${res.statusCode}`
              );
              err.statusCode = res.statusCode;
              err.code = parsedErr.code;
              err.detailMessage = parsedErr.message;
              err.isTerminalAuth =
                res.statusCode === 400 ||
                res.statusCode === 401 ||
                isTerminalCodexError(res.statusCode, parsedErr.code, parsedErr.message);
              reject(err);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('OAuth token refresh timed out'));
      });
      req.write(postBody);
      req.end();
    });

    if (!responseJson || !responseJson.access_token) {
      return null;
    }

    const updatedAuth = {
      ...rawAuthJson,
      tokens: {
        ...(rawAuthJson.tokens || {}),
        access_token: responseJson.access_token,
        refresh_token: responseJson.refresh_token || refreshToken,
        id_token: responseJson.id_token || rawAuthJson.tokens?.id_token
      },
      last_refresh: new Date().toISOString()
    };

    const writeAtomic = (filePath: string, content: string) => {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const unique = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
      const tmp = `${filePath}.${unique}.tmp`;
      fs.writeFileSync(tmp, content, { mode: 0o600 });
      const retryable = new Set(['EBUSY', 'EPERM', 'EACCES']);
      try {
        let renamed = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            fs.renameSync(tmp, filePath);
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
            if (fs.lstatSync(filePath).isSymbolicLink()) fs.unlinkSync(filePath);
          } catch {}
          fs.copyFileSync(tmp, filePath);
        }
        try {
          fs.chmodSync(filePath, 0o600);
        } catch {}
      } finally {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {}
      }
    };

    const serialized = JSON.stringify(updatedAuth, null, 2);
    if (profileDir) {
      writeAtomic(path.join(profileDir, 'auth.json'), serialized);
    }
    if (isActiveOnDisk) {
      const targetDecoded = parseCodexAuthObject(rawAuthJson);
      let stillActiveOnDisk = false;
      try {
        const livePath = getActiveCodexAuthPath();
        if (fs.existsSync(livePath)) {
          const liveNow = parseCodexAuthObject(JSON.parse(fs.readFileSync(livePath, 'utf8')));
          if (liveNow && targetDecoded) {
            stillActiveOnDisk = Boolean(
              (targetDecoded.accountId && liveNow.accountId === targetDecoded.accountId) ||
                (!targetDecoded.accountId &&
                  targetDecoded.email &&
                  liveNow.email?.toLowerCase() === targetDecoded.email.toLowerCase())
            );
          }
        }
      } catch {}
      if (stillActiveOnDisk) {
        writeAtomic(getActiveCodexAuthPath(), serialized);
      }
    }

    return parseCodexAuthObject(updatedAuth);
  }

  /**
   * Calls `GET https://chatgpt.com/backend-api/wham/usage` directly over HTTPS in ~120ms.
   * Zero child processes spawned, zero model quota consumed.
   */
  private async fetchWhamUsage(accessToken: string, accountId?: string | null): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(CODEX_WHAM_USAGE_URL);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        'OAI-App-Brand': 'codex',
        originator: 'codex_vscode',
        'x-openai-codex-pricing-chooser': '1',
        'User-Agent': 'codex_vscode/26.1120.41243',
        Accept: 'application/json'
      };
      if (accountId) {
        headers['ChatGPT-Account-Id'] = accountId;
      }

      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname,
          method: 'GET',
          headers,
          timeout: 8000
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          );
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(e);
              }
            } else {
              const parsedErr = parseCodexErrorBody(body);
              const err: any = new Error(
                parsedErr.message || `wham/usage HTTP ${res.statusCode}`
              );
              err.statusCode = res.statusCode;
              err.code = parsedErr.code;
              err.detailMessage = parsedErr.message;
              err.isTerminalAuth = isTerminalCodexError(
                res.statusCode,
                parsedErr.code,
                parsedErr.message
              );
              reject(err);
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('wham/usage timed out'));
      });
      req.end();
    });
  }

  /**
   * Parses OpenAI's `/backend-api/wham/usage` payload into both a rich `QuotaSummary`
   * and a persisted `CachedQuotaMetric` (converting `used_percent` -> `100 - used_percent` remaining).
   */
  public parseWhamUsagePayload(
    payload: any,
    fallbackDecoded: DecodedCodexAuth
  ): { summary: QuotaSummary; metric: CachedQuotaMetric } {
    const planTier = normalizeCodexPlanTier(
      payload?.plan_type || fallbackDecoded.planTier,
      fallbackDecoded.authMode
    );
    const tierLabel = formatCodexTierLabel(planTier);

    const primary = payload?.rate_limit?.primary_window;
    const secondary = payload?.rate_limit?.secondary_window;

    const primaryRemPct = remainingFromUsedPercent(primary?.used_percent);
    const secondaryRemPct = remainingFromUsedPercent(secondary?.used_percent);

    const primaryResetAtMs =
      typeof primary?.reset_at === 'number' ? primary.reset_at * 1000 : undefined;
    const secondaryResetAtMs =
      typeof secondary?.reset_at === 'number' ? secondary.reset_at * 1000 : undefined;

    const primaryResetStr =
      primaryRemPct !== null && primaryRemPct < 100
        ? formatSecondsCountdown(
            primary?.reset_after_seconds ??
              (primaryResetAtMs ? (primaryResetAtMs - Date.now()) / 1000 : undefined)
          )
        : '';

    const secondaryResetStr =
      secondaryRemPct !== null && secondaryRemPct < 100
        ? formatSecondsCountdown(
            secondary?.reset_after_seconds ??
              (secondaryResetAtMs ? (secondaryResetAtMs - Date.now()) / 1000 : undefined)
          )
        : '';

    const primaryWindowMins =
      typeof primary?.limit_window_seconds === 'number'
        ? Math.round(primary.limit_window_seconds / 60)
        : 300;
    const secondaryWindowMins =
      typeof secondary?.limit_window_seconds === 'number'
        ? Math.round(secondary.limit_window_seconds / 60)
        : 10080;

    // Check optional code review rate limit
    let codeReviewPct: number | null = null;
    let codeReviewResetStr = '';
    let codeReviewResetAtMs: number | undefined;
    let codeReviewResetIso: string | undefined;

    const crLimit =
      payload?.code_review_rate_limit?.primary_window ||
      (Array.isArray(payload?.additional_rate_limits)
        ? payload.additional_rate_limits.find((r: any) =>
            String(r?.limit_name || '').includes('code_review')
          )?.rate_limit?.primary_window
        : null);

    if (crLimit) {
      codeReviewPct = remainingFromUsedPercent(crLimit.used_percent);
    }
    if (codeReviewPct !== null) {
      codeReviewResetAtMs =
        typeof crLimit.reset_at === 'number' ? crLimit.reset_at * 1000 : undefined;
      if (codeReviewResetAtMs) {
        codeReviewResetIso = new Date(codeReviewResetAtMs).toISOString();
      }
      if (codeReviewPct < 100) {
        codeReviewResetStr = formatSecondsCountdown(crLimit.reset_after_seconds);
      }
    }

    const resetCredits =
      typeof payload?.rate_limit_reset_credits?.available_count === 'number'
        ? payload.rate_limit_reset_credits.available_count
        : undefined;

    const creditsBalance =
      payload?.credits?.has_credits && payload?.credits?.balance
        ? `$${payload.credits.balance}`
        : undefined;

    const groups: QuotaGroup[] = [
      {
        displayName: 'OpenAI Codex (5h & Weekly Pools)',
        description: 'Primary 5-hour fast window and 7-day rolling weekly allowance',
        buckets: [
          {
            bucketId: 'codex_5h',
            displayName: '5-Hour Fast Pool',
            description: 'Rolling 5-hour active coding allowance',
            window: '5h',
            remainingFraction: (primaryRemPct ?? 0) / 100,
            disabled: primaryRemPct === null,
            resetTime: primaryResetAtMs ? new Date(primaryResetAtMs).toISOString() : undefined
          },
          {
            bucketId: 'codex_7d',
            displayName: '7-Day Weekly Pool',
            description: 'Rolling 7-day weekly reserve',
            window: 'weekly',
            remainingFraction: (secondaryRemPct ?? 0) / 100,
            disabled: secondaryRemPct === null,
            resetTime: secondaryResetAtMs ? new Date(secondaryResetAtMs).toISOString() : undefined
          }
        ]
      }
    ];

    if (codeReviewPct !== null) {
      groups.push({
        displayName: 'Codex Code Review',
        description: 'Dedicated automated PR & repository review allowance',
        buckets: [
          {
            bucketId: 'codex_code_review',
            displayName: 'Code Review Pool',
            description: 'Daily/Rolling code review allowance',
            window: 'daily',
            remainingFraction: codeReviewPct / 100,
            resetTime: codeReviewResetIso
          }
        ]
      });
    }

    const now = Date.now();
    const metric: CachedQuotaMetric = {
      plan: planTier,
      gemini: primaryRemPct === null ? '--' : `${primaryRemPct}%`,
      claudeGpt: secondaryRemPct === null ? '--' : `${secondaryRemPct}%`,
      argon: codeReviewPct !== null ? `${codeReviewPct}%` : '--',
      codex5h: primaryRemPct === null ? '--' : `${primaryRemPct}%`,
      codex5hReset: primaryResetStr || undefined,
      codex5hResetAtMs: primaryResetAtMs,
      codex5hWindowMins: primaryWindowMins,
      codex7d: secondaryRemPct === null ? '--' : `${secondaryRemPct}%`,
      codex7dReset: secondaryResetStr || undefined,
      codex7dResetAtMs: secondaryResetAtMs,
      codex7dWindowMins: secondaryWindowMins,
      codexCodeReview: codeReviewPct !== null ? `${codeReviewPct}%` : undefined,
      codexCodeReviewReset: codeReviewResetStr || undefined,
      codexCodeReviewResetAtMs: codeReviewResetAtMs,
      codexResetCredits: resetCredits,
      codexCreditsBalance: creditsBalance,
      updatedAt: now
    };

    const summary: QuotaSummary = {
      email: payload?.email || fallbackDecoded.email || undefined,
      accountId: payload?.account_id || fallbackDecoded.accountId || undefined,
      tier: tierLabel,
      planTier,
      groups,
      hasArgonGroup: codeReviewPct !== null,
      resetCredits,
      creditsBalance,
      fetchedAt: now
    };

    return { summary, metric };
  }

  public async getActiveQuotaSummary(
    codexVault: CodexVault,
    forceRefresh = false
  ): Promise<{ summary: QuotaSummary | null; metric: CachedQuotaMetric | null }> {
    const decodedInitial = codexVault.readDecodedActiveAuth();
    if (!decodedInitial || decodedInitial.authMode === 'apikey' || !decodedInitial.accessToken) {
      if (!decodedInitial) {
        this.cachedSummary = null;
        this.cachedMetric = null;
        this.lastFetchTime = 0;
      }
      return { summary: null, metric: null };
    }

    const matchesCachedIdentity =
      this.cachedSummary &&
      ((decodedInitial.accountId && this.cachedSummary.accountId === decodedInitial.accountId) ||
        (!decodedInitial.accountId &&
          decodedInitial.email &&
          this.cachedSummary.email?.toLowerCase() === decodedInitial.email.toLowerCase()));

    if (
      !forceRefresh &&
      matchesCachedIdentity &&
      this.cachedMetric &&
      this.isCacheFresh()
    ) {
      return { summary: this.cachedSummary, metric: this.cachedMetric };
    }

    const accountKey = decodedInitial.accountId || decodedInitial.email?.toLowerCase() || '';
    if (this.inFlightActiveFetch && this.inFlightActiveFetchKey === accountKey) {
      return this.inFlightActiveFetch;
    }

    const fetchPromise = (async (): Promise<{
      summary: QuotaSummary | null;
      metric: CachedQuotaMetric | null;
    }> => {
      let decoded: DecodedCodexAuth | null = decodedInitial;

      const activeProfile = codexVault.findMatchingProfile({
        accountId: decoded.accountId,
        email: decoded.email
      });
      const profileDir = activeProfile
        ? path.join(getCodexProfilesDir(), activeProfile.id)
        : undefined;
      const isClaimed = Boolean(
        activeProfile && this.claimedProfileIdsProvider?.().has(activeProfile.id)
      );

      try {
        // Proactive 5-minute expiry check before hitting wham/usage (skip when claimed or
        // when a live codex app-server owns active token rotation on disk).
        if (
          !isClaimed &&
          !this.hasLiveCodexChild() &&
          decoded.tokenExpiryDate &&
          decoded.tokenExpiryDate <= Date.now() + 300_000 &&
          decoded.refreshToken
        ) {
          try {
            const refreshed = await this.refreshCodexOAuthToken(decoded.rawAuthJson, profileDir, true);
            if (refreshed) {
              decoded = refreshed;
              this.primeActiveAccountKey(codexVault);
            }
          } catch (refreshErr: any) {
            const failure = classifyCodexAuthFailure(null, refreshErr);
            if (failure) {
              this.activeAuthHealth = {
                accountKey,
                authStatus: failure.authStatus,
                authErrorCode: failure.code,
                authErrorMessage: failure.message,
                checkedAt: Date.now()
              };
              if (activeProfile) {
                codexVault.updateProfileAuthHealth(activeProfile.id, {
                  authStatus: failure.authStatus,
                  authErrorCode: failure.code,
                  authErrorMessage: failure.message,
                  authCheckedAt: Date.now()
                });
              }
              throw refreshErr;
            }
          }
        }

        let payload: any;
        try {
          payload = await this.fetchWhamUsage(decoded.accessToken!, decoded.accountId);
        } catch (whamErr: any) {
          if (!isClaimed && whamErr?.statusCode === 401 && decoded.refreshToken) {
            let refreshErr: any = null;
            let refreshed: DecodedCodexAuth | null = null;
            try {
              refreshed = await this.refreshCodexOAuthToken(decoded.rawAuthJson, profileDir, true);
            } catch (rErr: any) {
              refreshErr = rErr;
            }
            if (refreshed && refreshed.accessToken) {
              decoded = refreshed;
              this.primeActiveAccountKey(codexVault);
              payload = await this.fetchWhamUsage(refreshed.accessToken, refreshed.accountId);
            } else {
              const wrapped: any = new Error(whamErr.message || 'wham/usage HTTP 401');
              wrapped.whamErr = whamErr;
              wrapped.refreshErr = refreshErr;
              throw wrapped;
            }
          } else {
            const wrapped: any = new Error(whamErr?.message || 'wham/usage failed');
            wrapped.whamErr = whamErr;
            throw wrapped;
          }
        }

        const { summary, metric } = this.parseWhamUsagePayload(payload, decoded);
        this.cachedSummary = summary;
        this.cachedMetric = metric;
        this.lastFetchTime = Date.now();
        this.activeAuthHealth = {
          accountKey,
          authStatus: 'ok',
          checkedAt: Date.now()
        };

        if (activeProfile) {
          codexVault.syncActiveCredentialsToProfile(
            activeProfile.id,
            decoded.rawAuthJson,
            decoded
          );
          codexVault.updateProfileCachedQuota(activeProfile.id, metric);
          codexVault.updateProfileAuthHealth(activeProfile.id, {
            authStatus: 'ok',
            authCheckedAt: Date.now()
          });
        }

        return { summary, metric };
      } catch (err: any) {
        const failure = classifyCodexAuthFailure(err?.whamErr || err, err?.refreshErr, isClaimed);
        if (failure) {
          this.activeAuthHealth = {
            accountKey,
            authStatus: failure.authStatus,
            authErrorCode: failure.code,
            authErrorMessage: failure.message,
            checkedAt: Date.now()
          };
          if (activeProfile) {
            codexVault.updateProfileAuthHealth(activeProfile.id, {
              authStatus: failure.authStatus,
              authErrorCode: failure.code,
              authErrorMessage: failure.message,
              authCheckedAt: Date.now()
            });
          }
        }
        return {
          summary: matchesCachedIdentity ? this.cachedSummary : null,
          metric: matchesCachedIdentity ? this.cachedMetric : null
        };
      }
    })();

    this.inFlightActiveFetch = fetchPromise;
    this.inFlightActiveFetchKey = accountKey;
    try {
      return await fetchPromise;
    } finally {
      if (this.inFlightActiveFetch === fetchPromise) {
        this.inFlightActiveFetch = null;
        this.inFlightActiveFetchKey = null;
      }
    }
  }

  /**
   * Refreshes an inactive (or active) Codex profile directly over HTTPS without spawning `codex.exe`.
   */
  public async refreshProfileQuota(
    profileId: string,
    codexVault: CodexVault,
    allowActiveCacheUpdate = true
  ): Promise<CachedQuotaMetric | null> {
    const existing = this.inFlightProfileRefresh.get(profileId);
    if (existing) {
      return existing;
    }
    const runPromise = (async (): Promise<CachedQuotaMetric | null> => {
      const profileDir = path.join(getCodexProfilesDir(), profileId);
      const authPath = path.join(profileDir, 'auth.json');
      if (!fs.existsSync(authPath)) return null;

      let isActiveOnDisk = false;
      let accountKey = '';

      const isClaimed = Boolean(this.claimedProfileIdsProvider?.().has(profileId));

      try {
        if (!isClaimed) {
          try {
            syncCodexCliHomeToVault(profileId);
          } catch {}
        }
        // If this profile matches the currently active ~/.codex/auth.json, sync from ~/.codex/auth.json first
        // so we always use the latest rotated token if codex.exe refreshed it during a session.
        const activeDecoded = codexVault.readDecodedActiveAuth();
        let rawAuth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        let decoded = parseCodexAuthObject(rawAuth);
        if (isClaimed) {
          // Read isolated CLI home auth.json strictly read-only so live CLI-rotated access tokens
          // power wham/usage queries without writing or colliding with single-use RTR.
          const cliRo = readCodexCliHomeAuthReadOnly(profileId);
          if (cliRo?.rawAuthJson) {
            const cliDecoded = parseCodexAuthObject(cliRo.rawAuthJson);
            const vaultFreshness =
              typeof rawAuth?.last_refresh === 'string'
                ? Date.parse(rawAuth.last_refresh) || 0
                : decoded?.tokenExpiryDate || 0;
            if (cliDecoded?.accessToken && (!decoded || cliRo.freshnessMs >= vaultFreshness)) {
              rawAuth = cliRo.rawAuthJson;
              decoded = cliDecoded;
            }
          }
        }
        if (!decoded || decoded.authMode === 'apikey' || !decoded.accessToken) {
          return null;
        }

        accountKey = decoded.accountId || decoded.email?.toLowerCase() || '';
        isActiveOnDisk = Boolean(
          activeDecoded &&
            ((decoded.accountId && activeDecoded.accountId === decoded.accountId) ||
              (!decoded.accountId &&
                decoded.email &&
                activeDecoded.email?.toLowerCase() === decoded.email.toLowerCase()))
        );

        if (isActiveOnDisk && activeDecoded) {
          rawAuth = activeDecoded.rawAuthJson;
          decoded = activeDecoded;
        }

        if (
          !isClaimed &&
          !(isActiveOnDisk && this.hasLiveCodexChild()) &&
          decoded.tokenExpiryDate &&
          decoded.tokenExpiryDate <= Date.now() + 300_000 &&
          decoded.refreshToken
        ) {
          try {
            const refreshed = await this.refreshCodexOAuthToken(rawAuth, profileDir, isActiveOnDisk);
            if (refreshed) {
              decoded = refreshed;
              rawAuth = refreshed.rawAuthJson;
              if (isActiveOnDisk) {
                this.primeActiveAccountKey(codexVault);
              }
            }
          } catch (refreshErr: any) {
            const failure = classifyCodexAuthFailure(null, refreshErr);
            if (failure) {
              codexVault.updateProfileAuthHealth(profileId, {
                authStatus: failure.authStatus,
                authErrorCode: failure.code,
                authErrorMessage: failure.message,
                authCheckedAt: Date.now()
              });
              if (isActiveOnDisk) {
                this.activeAuthHealth = {
                  accountKey,
                  authStatus: failure.authStatus,
                  authErrorCode: failure.code,
                  authErrorMessage: failure.message,
                  checkedAt: Date.now()
                };
              }
              return null;
            }
          }
        }

        let payload: any;
        try {
          payload = await this.fetchWhamUsage(decoded.accessToken!, decoded.accountId);
        } catch (whamErr: any) {
          if (!isClaimed && whamErr?.statusCode === 401 && decoded.refreshToken) {
            let refreshErr: any = null;
            let refreshed: DecodedCodexAuth | null = null;
            try {
              refreshed = await this.refreshCodexOAuthToken(rawAuth, profileDir, isActiveOnDisk);
            } catch (rErr: any) {
              refreshErr = rErr;
            }
            if (refreshed && refreshed.accessToken) {
              decoded = refreshed;
              rawAuth = refreshed.rawAuthJson;
              if (isActiveOnDisk) {
                this.primeActiveAccountKey(codexVault);
              }
              payload = await this.fetchWhamUsage(refreshed.accessToken, refreshed.accountId);
            } else {
              const wrapped: any = new Error(whamErr?.message || 'wham/usage HTTP 401');
              wrapped.whamErr = whamErr;
              wrapped.refreshErr = refreshErr;
              throw wrapped;
            }
          } else {
            const wrapped: any = new Error(whamErr?.message || 'wham/usage failed');
            wrapped.whamErr = whamErr;
            throw wrapped;
          }
        }

        const { summary, metric } = this.parseWhamUsagePayload(payload, decoded);
        const latestActiveDecoded = codexVault.readDecodedActiveAuth();
        const stillActiveOnDisk = Boolean(
          isActiveOnDisk &&
            latestActiveDecoded &&
            ((decoded.accountId && latestActiveDecoded.accountId === decoded.accountId) ||
              (!decoded.accountId &&
                decoded.email &&
                latestActiveDecoded.email?.toLowerCase() === decoded.email.toLowerCase()))
        );
        if (stillActiveOnDisk) {
          codexVault.syncActiveCredentialsToProfile(profileId, decoded.rawAuthJson, decoded);
        }
        codexVault.updateProfileCachedQuota(profileId, metric);
        codexVault.updateProfileAuthHealth(profileId, {
          authStatus: 'ok',
          authCheckedAt: Date.now()
        });
        if (stillActiveOnDisk && allowActiveCacheUpdate) {
          this.cachedSummary = summary;
          this.cachedMetric = metric;
          this.lastFetchTime = Date.now();
          this.activeAuthHealth = {
            accountKey,
            authStatus: 'ok',
            checkedAt: Date.now()
          };
        }
        return metric;
      } catch (err: any) {
        const failure = classifyCodexAuthFailure(err?.whamErr || err, err?.refreshErr, isClaimed);
        if (failure) {
          codexVault.updateProfileAuthHealth(profileId, {
            authStatus: failure.authStatus,
            authErrorCode: failure.code,
            authErrorMessage: failure.message,
            authCheckedAt: Date.now()
          });
          if (isActiveOnDisk && allowActiveCacheUpdate) {
            this.activeAuthHealth = {
              accountKey,
              authStatus: failure.authStatus,
              authErrorCode: failure.code,
              authErrorMessage: failure.message,
              checkedAt: Date.now()
            };
          }
        }
        return null;
      }
    })();

    this.inFlightProfileRefresh.set(profileId, runPromise);
    try {
      return await runPromise;
    } finally {
      if (this.inFlightProfileRefresh.get(profileId) === runPromise) {
        this.inFlightProfileRefresh.delete(profileId);
      }
    }
  }

  public async probeAllAuthHealth(codexVault: CodexVault): Promise<boolean> {
    const now = Date.now();
    const profiles = codexVault.listProfiles();
    const activeLive = codexVault.getLiveSessionInfo(true);
    const activeMatched = codexVault.findMatchingProfile(activeLive);
    const tasks: Array<Promise<unknown>> = profiles
      .filter((p) => {
        if (p.authMode === 'apikey') return false;
        const recentCheck = Math.max(p.authCheckedAt || 0, p.cachedQuota?.updatedAt || 0);
        return now - recentCheck >= 30_000;
      })
      .map((p) => this.refreshProfileQuota(p.id, codexVault));
    if (
      !activeMatched &&
      (activeLive.email || activeLive.accountId) &&
      activeLive.authMode !== 'apikey' &&
      (!this.activeAuthHealth || now - this.activeAuthHealth.checkedAt >= 30_000)
    ) {
      tasks.push(this.getActiveQuotaSummary(codexVault, true));
    }
    await Promise.allSettled(tasks);
    const updatedProfiles = codexVault.listProfiles();
    const activeHealth = this.getActiveAuthHealth(activeLive);
    return Boolean(
      updatedProfiles.some((p) => p.authStatus === 'revoked' || p.authStatus === 'expired') ||
        activeHealth?.authStatus === 'revoked' ||
        activeHealth?.authStatus === 'expired'
    );
  }

  public async refreshProfileIds(
    profileIds: ReadonlySet<string>,
    codexVault: CodexVault
  ): Promise<number> {
    if (!profileIds.size) return 0;
    const profiles = codexVault
      .listProfiles()
      .filter((p) => profileIds.has(p.id) && p.authMode !== 'apikey');
    if (profiles.length === 0) return 0;
    const results = await Promise.allSettled(
      profiles.map((p) => this.refreshProfileQuota(p.id, codexVault))
    );
    return results.filter((r) => r.status === 'fulfilled' && r.value).length;
  }

  public async refreshAllProfiles(codexVault: CodexVault): Promise<number> {
    const profiles = codexVault.listProfiles();
    const activeLive = codexVault.getLiveSessionInfo();
    const activeMatched = codexVault.findMatchingProfile(activeLive);
    const tasks: Array<Promise<CachedQuotaMetric | null>> = profiles
      .filter(p => p.authMode !== 'apikey')
      .map(p => this.refreshProfileQuota(p.id, codexVault));
    if (!activeMatched && (activeLive.email || activeLive.accountId) && activeLive.authMode !== 'apikey') {
      tasks.push(
        this.getActiveQuotaSummary(codexVault, true).then(res => res.metric)
      );
    }
    const results = await Promise.all(tasks);
    return results.filter(Boolean).length;
  }

  /**
   * Builds the bespoke Markdown hover tooltip for the OpenAI Codex deck,
   * including the Hero Instrument Card, Multi-Account Rotation Matrix, and the
   * extreme-right Footer Switcheroo (`◀ Antigravity | Codex ▶`).
   */
  public buildCodexHoverTooltip(
    profiles: ProfileMetadata[],
    activeProfileId: string | null,
    liveMetric: CachedQuotaMetric | null,
    liveSession?: LiveSessionInfo,
    claimedProfileIds?: ReadonlySet<string> | readonly string[]
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = {
      enabledCommands: [
        'charlier.switchProfileDirect', 'charlier.switchProfile',
        'charlier.refreshQuota', 'charlier.addAccount', 'charlier.saveProfile',
        'charlier.openCockpit', 'charlier.switchProvider'
      ]
    };
    md.supportThemeIcons = true;
    md.supportHtml = true;
    const claimedSet =
      claimedProfileIds instanceof Set
        ? claimedProfileIds
        : new Set(claimedProfileIds || []);

    const nbsp = (text: string): string => text.replace(/ /g, '&nbsp;');
    const escapeLabel = (text: string): string =>
      text.replace(/([\\[\]|<>`*_])/g, '\\$1').replace(/ /g, '&nbsp;');
    const padCell = (content: string): string => `&nbsp;${content}&nbsp;`;

    const themeKind = (vscode.window as any)?.activeColorTheme?.kind;
    const isLight = themeKind === 1 || themeKind === 4;
    const pal = getHoverPalette(isLight);
    const headerIcon = getHoverProviderIconHtml('codex', isLight);

    const activeProfile = profiles.find(p => p.id === activeProfileId) || null;
    const isUnsavedActive = Boolean(!activeProfile && liveSession?.email);
    const activeAuthStatus = resolveEffectiveAuthStatus(
      activeProfile?.authStatus,
      liveSession?.authStatus,
      this.getActiveAuthHealth(liveSession)?.authStatus
    );
    const needsReauth =
      activeAuthStatus === 'revoked' || activeAuthStatus === 'expired';
    const rawLiveMetric = liveMetric || activeProfile?.cachedQuota || undefined;
    const liveDisplayMetric = codexMetricForDisplay(
      needsReauth ? rawLiveMetric : healExpiredCodexMetric(rawLiveMetric),
      activeProfile?.authMode || liveSession?.authMode
    );

    if (activeProfile || isUnsavedActive) {
      const m = liveDisplayMetric;
      const planTier = (
        activeProfile?.planOverride ||
        m?.plan ||
        liveSession?.planTier ||
        'PLUS'
      ).toUpperCase();

      const displayName = activeProfile
        ? activeProfile.name
        : (liveSession?.email || 'active').split('@')[0];
      const safeDisplayName = escapeLabel(displayName);
      const displayEmail = activeProfile
        ? activeProfile.email
        : liveSession?.email || 'No account active';

      const activeCliPill =
        activeProfile && claimedSet.has(activeProfile.id)
          ? ` &nbsp;${renderHoverPill('CLI', 'warn', isLight)}`
          : '';
      const statusPills = needsReauth
        ? `${renderHoverPill('RE-AUTH', 'danger', isLight)} &nbsp;${renderHoverPill('STALE', 'danger', isLight)}${activeCliPill}`
        : isUnsavedActive
          ? renderHoverPill('ACTIVE · UNSAVED', 'warn', isLight)
          : `${renderHoverPill('ACTIVE', 'active', isLight)}${activeCliPill}`;

      // 1. Hero Header + Subheader (matching Antigravity's exact top hierarchy)
      md.appendMarkdown(
        `### ${headerIcon} Charlier &nbsp;·&nbsp; **${safeDisplayName}** &nbsp;${renderHoverPill(planTier, 'plan', isLight)} &nbsp;${statusPills}\n\n`
      );

      const subParts: string[] = [`\`${displayEmail}\``];
      if (needsReauth) {
        const staleAgo = m?.updatedAt ? ` (${formatTimeAgo(m.updatedAt)})` : '';
        subParts.push(
          `<span style="color:${pal.crimson};">**$(warning) Stale snapshot${escapeLabel(staleAgo)} · Signed out / revoked**</span> · [$(key)&nbsp;${nbsp('Re-Login')}](command:charlier.addAccount "Back up vault & sign in again")`
        );
      } else if (isUnsavedActive) {
        subParts.push(
          `[$(add)&nbsp;${nbsp('Save to Vault')}](command:charlier.saveProfile "Save this active Codex account into your Charlier vault")`
        );
      } else {
        subParts.push(`<span style="color:${pal.emerald};">**● Active Session**</span>`);
      }
      if (m && typeof m.codexResetCredits === 'number' && m.codexResetCredits > 0) {
        subParts.push(
          `<span style="color:${pal.warnFg};">$(zap)&nbsp;**${m.codexResetCredits}&nbsp;Reset&nbsp;Credit${m.codexResetCredits > 1 ? 's' : ''}**</span>`
        );
      }
      if (m?.codexCreditsBalance) {
        subParts.push(
          `<span style="color:${pal.emerald};">$(credit-card)&nbsp;**${nbsp(m.codexCreditsBalance)}**</span>`
        );
      }
      md.appendMarkdown(`${subParts.join(' &nbsp;·&nbsp; ')}\n\n`);

      if (planTier === 'API_KEY') {
        md.appendMarkdown('Usage windows are unavailable for API key sessions.\n\n');
      } else {
        const c5hPct = percentFromText(m?.codex5h);
        const c7dPct = percentFromText(m?.codex7d);

        const note5h =
          c5hPct === null
            ? 'Usage unavailable'
            : c5hPct === 0
              ? `<span style="color:${pal.crimson};">**Depleted**</span>`
              : 'Primary window';
        const note7d =
          c7dPct === null
            ? planTier === 'FREE' && c5hPct !== null
              ? 'Not separated on Free tier'
              : 'Usage unavailable'
            : c7dPct === 0
              ? `<span style="color:${pal.crimson};">**Depleted**</span>`
              : 'Weekly reserve';

        const rst5h =
          m?.codex5hReset && c5hPct !== null
            ? ` &nbsp;·&nbsp; resets in **${nbsp(m.codex5hReset)}**`
            : '';
        const rst7d =
          m?.codex7dReset && c7dPct !== null
            ? ` &nbsp;·&nbsp; resets in **${nbsp(m.codex7dReset)}**`
            : '';

        md.appendMarkdown(
          `| ${padCell('Model Pool')} | ${padCell('Gauge')} | ${padCell('Capacity & Reset Window')} |\n`
        );
        md.appendMarkdown(`|:---|:---:|:---|\n`);
        md.appendMarkdown(
          `| ${padCell('**5-Hour Fast Pool** *(Primary)*')} | ${padCell(renderHoverGaugeCell(c5hPct, true, isLight, needsReauth))} | ${padCell(`${note5h}${rst5h}`)} |\n`
        );
        md.appendMarkdown(
          `| ${padCell('**7-Day Weekly Pool** *(Rolling)*')} | ${padCell(planTier === 'FREE' && c7dPct === null && c5hPct !== null ? '`--`' : renderHoverGaugeCell(c7dPct, true, isLight, needsReauth))} | ${padCell(`${note7d}${rst7d}`)} |\n`
        );

        const crPct = percentFromText(m?.codexCodeReview);
        if (crPct !== null) {
          const noteCr =
            crPct === 0
              ? `<span style="color:${pal.crimson};">**Depleted**</span>`
              : 'Review allowance';
          const rstCr = m?.codexCodeReviewReset
            ? ` &nbsp;·&nbsp; resets in **${nbsp(m.codexCodeReviewReset)}**`
            : '';
          md.appendMarkdown(
            `| ${padCell('**Code Review Pool** *(PRs)*')} | ${padCell(renderHoverGaugeCell(crPct, true, isLight, needsReauth))} | ${padCell(`${noteCr}${rstCr}`)} |\n`
          );
        } else if (planTier === 'FREE') {
          md.appendMarkdown(
            `| ${padCell('**Code Review Pool** *(PRs)*')} | ${padCell('`--`')} | ${padCell('Not included in Free tier')} |\n`
          );
        } else if (c5hPct === null && c7dPct === null) {
          md.appendMarkdown(
            `| ${padCell('**Code Review Pool** *(PRs)*')} | ${padCell(renderHoverGaugeCell(null, true, isLight, needsReauth))} | ${padCell('Usage unavailable')} |\n`
          );
        } else {
          md.appendMarkdown(
            `| ${padCell('**Code Review Pool** *(PRs)*')} | ${padCell(renderHoverPill('Included', 'plan', isLight))} | ${padCell('PR review allowance &nbsp;·&nbsp; On demand')} |\n`
          );
        }
        md.appendMarkdown('\n');
      }
    } else {
      md.appendMarkdown(`### ${headerIcon} Charlier &nbsp;·&nbsp; **Ready for Login**\n\n`);
      md.appendMarkdown(
        `*No active session in \`~/.codex/auth.json\`.* &nbsp;·&nbsp; [Sign in to Codex](command:charlier.addAccount)\n\n`
      );
    }

    // 2. Multi-Account Rotation Matrix (7 columns matching Antigravity for full-width symmetry)
    const showMatrix =
      profiles.length > 0 || isUnsavedActive;

    if (showMatrix) {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(
        `| ${padCell('')} | ${padCell('Profile')} | ${padCell('Plan')} | ${padCell('5h Pool')} | ${padCell('7d Pool')} | ${padCell('Review')} | ${padCell('Snap')} |\n`
      );
      md.appendMarkdown(`|:---:|:---|:---:|:---:|:---:|:---:|:---:|\n`);

      const c5Pct = percentFromText(liveDisplayMetric?.codex5h);
      const c7Pct = percentFromText(liveDisplayMetric?.codex7d);
      const activeKnown = [c5Pct, c7Pct].filter((n): n is number => n !== null);
      const activeMinPct = activeKnown.length > 0 ? Math.min(...activeKnown) : null;
      const bestStandby: BestStandbyRecommendation | null = resolveBestStandbyProfile({
        provider: 'codex',
        profiles,
        activeProfileId,
        activeMinPct,
        activeNeedsAction: needsReauth || (!activeProfile && !isUnsavedActive),
        claimedProfileIds: claimedSet,
        normalizeCodexMetric: (m, authMode) =>
          codexMetricForDisplay(healExpiredCodexMetric(m), authMode)
      });

      if (isUnsavedActive && liveSession?.email) {
        const uName = escapeLabel((liveSession.email || 'active').split('@')[0]);
        const safeSaveTitle = `Save ${liveSession.email.replace(/"/g, '\\"')} to vault`;
        const uPlan = (
          liveDisplayMetric?.plan ||
          liveSession.planTier ||
          (liveSession.authMode === 'apikey' ? 'API_KEY' : 'PLUS')
        ).toUpperCase();
        const u5h = liveDisplayMetric?.codex5h || '--';
        const u7d = liveDisplayMetric?.codex7d || '--';
        const uRev =
          liveDisplayMetric?.codexCodeReview &&
          liveDisplayMetric.codexCodeReview !== '--'
            ? liveDisplayMetric.codexCodeReview
            : uPlan !== 'FREE' &&
                uPlan !== 'API_KEY' &&
                (u5h !== '--' || u7d !== '--')
              ? 'incl.'
              : '--';
        const uCreditsPill =
          uPlan !== 'API_KEY' &&
          typeof liveDisplayMetric?.codexResetCredits === 'number' &&
          liveDisplayMetric.codexResetCredits > 0
            ? ` &nbsp;${renderHoverPill(`$(zap) ${liveDisplayMetric.codexResetCredits}`, 'warn', isLight)}`
            : '';
        const uBadge = needsReauth
          ? `${renderHoverPill('RE-AUTH', 'danger', isLight)} &nbsp;${renderHoverPill('UNSAVED', 'warn', isLight)}`
          : renderHoverPill('UNSAVED', 'warn', isLight);
        const uSnap = needsReauth
          ? `<span style="color:${pal.crimson};">*stale*</span>`
          : '*live*';
        md.appendMarkdown(
          `| ${padCell(`<span style="color:${pal.warnFg};">$(sparkle)</span>`)} | ${padCell(`**${uName}** &nbsp;${uBadge}${uCreditsPill} · [Save](command:charlier.saveProfile "${safeSaveTitle}")`)} | ${padCell(renderHoverPill(uPlan, 'plan', isLight))} | ${padCell(renderHoverPct(u5h, true, isLight, needsReauth))} | ${padCell(renderHoverPct(u7d, true, isLight, needsReauth))} | ${padCell(renderHoverPct(uRev, true, isLight, needsReauth))} | ${padCell(uSnap)} |\n`
        );
      }

      const sorted = sortProfilesForDisplay(profiles, activeProfileId, claimedSet);

      const MAX_VISIBLE = isUnsavedActive ? 3 : 4;
      const visible = sorted.slice(0, MAX_VISIBLE);
      const hidden = sorted.slice(MAX_VISIBLE);
      const hiddenClaimedCount = hidden.filter((p) => claimedSet.has(p.id)).length;

      for (const p of visible) {
        const isCurrent = p.id === activeProfileId;
        const isClaimed = claimedSet.has(p.id);
        const isNextUp = Boolean(bestStandby && bestStandby.profile.id === p.id);
        const pNeedsReauth =
          p.authStatus === 'revoked' ||
          p.authStatus === 'expired' ||
          (isCurrent && needsReauth);
        const rawMetric = isCurrent && liveMetric ? liveMetric : p.cachedQuota;
        const m = codexMetricForDisplay(
          pNeedsReauth ? rawMetric : healExpiredCodexMetric(rawMetric),
          p.authMode
        );
        const plan = (
          p.planOverride ||
          m?.plan ||
          (p.authMode === 'apikey' ? 'API_KEY' : 'PLUS')
        ).toUpperCase();
        const c5h = m?.codex5h || '--';
        const c7d = m?.codex7d || '--';
        const cRev =
          m?.codexCodeReview && m.codexCodeReview !== '--'
            ? m.codexCodeReview
            : plan !== 'FREE' &&
                plan !== 'API_KEY' &&
                (c5h !== '--' || c7d !== '--')
              ? 'incl.'
              : '--';
        const snapLabel = m?.updatedAt ? `stale · ${formatTimeAgo(m.updatedAt)}` : 'stale';
        const snap = pNeedsReauth
          ? `<span style="color:${pal.crimson};">*${nbsp(snapLabel)}*</span>`
          : isCurrent
            ? `<span style="color:${pal.emerald};">*live*</span>`
            : `*${nbsp(formatTimeAgo(m?.updatedAt))}*`;

        const marker = isCurrent
          ? `<span style="color:${pal.accent};">$(check)</span>`
          : isClaimed
            ? `<span style="color:${pal.warnFg};">$(terminal)</span>`
            : isNextUp
              ? `<span style="color:${pal.emerald};">$(zap)</span>`
              : '&nbsp;';
        const safeName = escapeLabel(p.name);
        const switchArg = encodeURIComponent(JSON.stringify(p.id));
        const linkTitle = p.email
          ? isClaimed
            ? `CLI claimed (${p.email.replace(/"/g, '\\"')}) - Click to focus terminal or switch IDE`
            : `Switch Codex to ${p.email.replace(/"/g, '\\"')}`
          : '';
        const cliPill = isClaimed ? ` &nbsp;${renderHoverPill('CLI', 'warn', isLight)}` : '';
        const nextPill = isNextUp ? ` &nbsp;${renderHoverPill('NEXT', 'active', isLight)}` : '';
        const creditsPill =
          plan !== 'API_KEY' &&
          typeof m?.codexResetCredits === 'number' &&
          m.codexResetCredits > 0
            ? ` &nbsp;${renderHoverPill(`$(zap) ${m.codexResetCredits}`, 'warn', isLight)}`
            : '';
        const reauthPill = pNeedsReauth
          ? ` &nbsp;${renderHoverPill('RE-AUTH', 'danger', isLight)} &nbsp;${renderHoverPill('STALE', 'danger', isLight)}`
          : '';
        const accountCell = isCurrent
          ? `**${safeName}** &nbsp;${pNeedsReauth ? `${renderHoverPill('RE-AUTH', 'danger', isLight)} &nbsp;${renderHoverPill('STALE', 'danger', isLight)}` : renderHoverPill('ACTIVE', 'active', isLight)}${cliPill}${creditsPill}`
          : `[${safeName}](command:charlier.switchProfileDirect?${switchArg} "${linkTitle}")${reauthPill}${cliPill}${nextPill}${creditsPill}`;

        md.appendMarkdown(
          `| ${padCell(marker)} | ${padCell(accountCell)} | ${padCell(renderHoverPill(plan, 'plan', isLight))} | ${padCell(renderHoverPct(c5h, isCurrent, isLight, pNeedsReauth))} | ${padCell(renderHoverPct(c7d, isCurrent, isLight, pNeedsReauth))} | ${padCell(renderHoverPct(cRev, isCurrent, isLight, pNeedsReauth))} | ${padCell(snap)} |\n`
        );
      }

      if (bestStandby) {
        const bestName = escapeLabel(bestStandby.profile.name);
        const bestArg = encodeURIComponent(JSON.stringify(bestStandby.profile.id));
        md.appendMarkdown(
          `\n<span style="color:${pal.emerald};">$(zap)</span> **Best Standby:** [${bestName}](command:charlier.switchProfileDirect?${bestArg} "Switch Codex immediately to ${bestStandby.profile.name.replace(/"/g, '\\"')} (${bestStandby.scorePct}%)") &nbsp;*(${bestStandby.scorePct}% headroom)*\n`
        );
      }

      if (hidden.length > 0) {
        const extra = hidden.length;
        const claimedNote =
          hiddenClaimedCount > 0 ? ` (${hiddenClaimedCount} CLI claimed)` : '';
        md.appendMarkdown(
          `\n*+ ${extra} more account${extra > 1 ? 's' : ''}${claimedNote} in Cockpit* &nbsp;·&nbsp; [Open Cockpit](command:charlier.openCockpit) &nbsp;·&nbsp; [View all in menu](command:charlier.switchProfile)\n`
        );
      }
    }

    // 3. Footer action bar with Provider Switcheroo at the extreme right of Add Account
    md.appendMarkdown(`\n---\n\n`);
    md.appendMarkdown(
      `[$(layout-sidebar-left) ${nbsp('Cockpit')}](command:charlier.openCockpit "Open Charlier Sidebar Cockpit") &nbsp;·&nbsp; ` +
        `[$(arrow-swap) ${nbsp('Switch')}](command:charlier.switchProfile "Open QuickPick switcher") &nbsp;·&nbsp; ` +
        `[$(sync) ${nbsp('Refresh')}](command:charlier.refreshQuota "Refresh all Codex accounts") &nbsp;·&nbsp; ` +
        `[$(add) ${nbsp('Add Account')}](command:charlier.addAccount "Add another Codex account") &nbsp;&nbsp;│&nbsp;&nbsp; ` +
        `[◀&nbsp;$(charlier-antigravity-star)&nbsp;${nbsp('Antigravity')}](command:charlier.switchProvider "Flip deck to Google Antigravity (view only - does not restart extensions)") &nbsp;·&nbsp; <span style="color:${pal.accent};">$(charlier-codex-prompt)&nbsp;**Codex**</span> [▶](command:charlier.switchProvider "Flip deck to Google Antigravity")\n`
    );

    return md;
  }
}
