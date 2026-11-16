import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getActiveGoogleAccountsPath,
  getActiveOAuthCredsPath,
  getDaemonSearchDirs
} from './constants';
import { syncAntigravityCliHomeToVault } from './cli-isolation';
import {
  AuthHealthStatus,
  QuotaSummary,
  QuotaGroup,
  CachedQuotaMetric,
  ProfileMetadata,
  UserPlanTier
} from './types';
import { Vault } from './vault';
import {
  BestStandbyRecommendation,
  getHoverPalette,
  getHoverProviderIconHtml,
  isAntigravityHubProcess,
  percentFromFraction,
  percentFromText,
  renderHoverGaugeCell,
  renderHoverPct,
  renderHoverPill,
  resolveAntigravityPrimaryPools,
  resolveBestStandbyProfile,
  resolveEffectiveAuthStatus,
  sortProfilesForDisplay
} from './quota-values';

interface DaemonInfo {
  pid?: number;
  httpPort: number;
  csrfToken: string;
}

interface DaemonRpcResult<T = any> {
  status: number;
  data: T | null;
  grpcStatus?: string;
  grpcMessage?: string;
  rawErrorText?: string;
}

export interface GoogleValidationInfo {
  isValidationRequired: boolean;
  validationUrl?: string;
  message?: string;
  emailFromUrl?: string;
}

function unescapeJsonUrl(raw: string | undefined): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const cleaned = raw
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\&/g, '&')
    .replace(/\\\//g, '/')
    .trim();
  return cleaned.startsWith('http://') || cleaned.startsWith('https://') ? cleaned : undefined;
}

function extractEmailFromValidationUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = url.match(/[?&]Email=([^&#\s"']+)/i);
  if (!match || !match[1]) return undefined;
  try {
    const decoded = decodeURIComponent(match[1]).trim();
    return decoded.includes('@') ? decoded : undefined;
  } catch {
    return match[1].includes('@') ? match[1].trim() : undefined;
  }
}

export function extractGoogleValidationInfo(input: any): GoogleValidationInfo {
  if (!input) {
    return { isValidationRequired: false };
  }

  if (typeof input === 'string') {
    const hasMarker =
      input.includes('VALIDATION_REQUIRED') ||
      input.includes('ACCOUNT_VALIDATION_REQUIRED') ||
      /verify your account to continue/i.test(input) ||
      /failure_kind=ineligible/i.test(input);
    if (!hasMarker) {
      return { isValidationRequired: false };
    }
    const urlMatch =
      input.match(/"(?:validation_url|validationUrl|verification_url)"\s*:\s*"([^"]+)"/) ||
      input.match(/(https:\/\/accounts\.google\.com\/[^\s"'\\<>]+)/);
    const validationUrl = unescapeJsonUrl(urlMatch?.[1]);
    const msgMatch = input.match(
      /"(?:validation_error_message|validationErrorMessage|message)"\s*:\s*"([^"]+)"/
    );
    return {
      isValidationRequired: true,
      validationUrl,
      message: msgMatch?.[1] || 'Verify your account to continue.',
      emailFromUrl: extractEmailFromValidationUrl(validationUrl)
    };
  }

  if (typeof input === 'object') {
    // 1. Check loadCodeAssist ineligibleTiers[]
    const ineligibleTiers = Array.isArray(input.ineligibleTiers)
      ? input.ineligibleTiers
      : Array.isArray(input.userStatus?.ineligibleTiers)
        ? input.userStatus.ineligibleTiers
        : null;
    const hasEligibleTier =
      Boolean(input.currentTier || input.paidTier) ||
      (Array.isArray(input.allowedTiers) &&
        input.allowedTiers.some((t: any) => t && (t.id || t.tierId || typeof t === 'string')));
    if (ineligibleTiers && ineligibleTiers.length > 0 && !hasEligibleTier) {
      for (const tier of ineligibleTiers) {
        if (!tier || typeof tier !== 'object') continue;
        const code = String(tier.reasonCode ?? '');
        const msg = String(tier.validationErrorMessage || tier.reasonMessage || '');
        const rawUrl = tier.validationUrl || tier.validation_url || tier.verificationUrl;
        if (
          code === 'VALIDATION_REQUIRED' ||
          code === 'ACCOUNT_VALIDATION_REQUIRED' ||
          code === '10' ||
          /verify your account/i.test(msg) ||
          Boolean(rawUrl)
        ) {
          const validationUrl = unescapeJsonUrl(rawUrl);
          return {
            isValidationRequired: true,
            validationUrl,
            message: msg || 'Verify your account to continue.',
            emailFromUrl: extractEmailFromValidationUrl(validationUrl)
          };
        }
      }
    }

    // 2. Check Google RPC error envelope (HTTP 403 PERMISSION_DENIED + ErrorInfo details[])
    const errObj = input.error && typeof input.error === 'object' ? input.error : input;
    const details = Array.isArray(errObj.details)
      ? errObj.details
      : Array.isArray(input.details)
        ? input.details
        : [];
    let detailReason = '';
    let detailUrl: string | undefined;
    let detailMsg: string | undefined;
    for (const d of details) {
      if (!d || typeof d !== 'object') continue;
      if (typeof d.reason === 'string') {
        detailReason = d.reason;
      }
      const meta = d.metadata && typeof d.metadata === 'object' ? d.metadata : d;
      if (meta.validation_url || meta.validationUrl || meta.verification_url) {
        detailUrl = meta.validation_url || meta.validationUrl || meta.verification_url;
      }
      if (meta.validation_error_message || meta.validationErrorMessage) {
        detailMsg = meta.validation_error_message || meta.validationErrorMessage;
      }
      if (!detailUrl && Array.isArray(d.links) && d.links[0]?.url) {
        detailUrl = d.links[0].url;
      }
    }

    const topMsg = String(errObj.message || input.grpcMessage || input.ui_message || '');
    const isPermDeniedVerify =
      (errObj.status === 'PERMISSION_DENIED' || errObj.code === 403 || input.status === 403) &&
      /verify your account/i.test(topMsg);
    if (
      detailReason === 'VALIDATION_REQUIRED' ||
      detailReason === 'ACCOUNT_VALIDATION_REQUIRED' ||
      isPermDeniedVerify ||
      Boolean( input.verification_required || input.ineligible?.reason === 'VALIDATION_REQUIRED')
    ) {
      const validationUrl = unescapeJsonUrl(
        detailUrl ||
          input.verification_required?.verification_url ||
          input.ineligible?.verification_url
      );
      return {
        isValidationRequired: true,
        validationUrl,
        message: detailMsg || topMsg || 'Verify your account to continue.',
        emailFromUrl: extractEmailFromValidationUrl(validationUrl)
      };
    }

    // 3. Check raw string fields on DaemonRpcResult or serialized payload
    if (typeof input.grpcMessage === 'string' && input.grpcMessage) {
      const fromGrpc = extractGoogleValidationInfo(input.grpcMessage);
      if (fromGrpc.isValidationRequired) return fromGrpc;
    }
    if (typeof input.rawErrorText === 'string' && input.rawErrorText) {
      const fromRaw = extractGoogleValidationInfo(input.rawErrorText);
      if (fromRaw.isValidationRequired) return fromRaw;
    }
  }

  return { isValidationRequired: false };
}

const OAUTH_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const CLOUDCODE_HOST = 'daily-cloudcode-pa.googleapis.com';

type OAuthMintResult =
  | { ok: true; access_token: string; expires_in: number }
  | { ok: false; revoked: boolean; errorCode?: string; errorMessage?: string };

function isGoogleRevokedError(status: number, errorCode?: string, errorMsg?: string): boolean {
  const c = (errorCode || '').toLowerCase();
  const m = (errorMsg || '').toLowerCase();
  if (
    c === 'invalid_grant' ||
    c === 'unauthorized_client' ||
    c === 'token_revoked' ||
    m.includes('token has been expired or revoked') ||
    m.includes('invalid grant')
  ) {
    return true;
  }
  return status === 400 || status === 401;
}

export function renderCompactBar(percent: number, length = 5): string {
  const safePct = Number.isFinite(percent) ? percent : 0;
  const clamped = Math.max(0, Math.min(1, safePct / 100));
  const filled = Math.round(clamped * length);
  const empty = Math.max(0, length - filled);
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

export function formatTimeAgo(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return 'never';
  const diff = Date.now() - timestamp;
  if (diff < 60000) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export class QuotaService {
  private cachedSummary: QuotaSummary | null = null;
  private cacheTtlMs = 15000;
  private inFlightPromise: Promise<QuotaSummary | null> | null = null;
  private inFlightEpoch = -1;
  private inactiveRefreshInFlight = new Map<string, Promise<CachedQuotaMetric | null>>();
  private lastInactiveRefreshTime = new Map<string, number>();
  private cacheEpoch = 0;
  private loggingOutEmail: string | null = null;
  private loggingOutUntil = 0;
  private loggingOutStartedAt = 0;
  private surgicalRespawnTimestamps: number[] = [];
  private lastRespawnAt = 0;
  private respawnInFlight = false;
  private readonly RESPAWN_WINDOW_MS = 600_000;
  private readonly SAFE_MAX_SURGICAL_RESPAWNS = 2;
  private readonly RESPAWN_COOLDOWN_MS = 4500;
  private activeAuthHealth: {
    email: string;
    authStatus: AuthHealthStatus;
    authErrorCode?: string;
    authErrorMessage?: string;
    validationUrl?: string;
    checkedAt: number;
  } | null = null;

  public getActiveAuthHealth(email?: string | null): {
    authStatus: AuthHealthStatus;
    authErrorCode?: string;
    authErrorMessage?: string;
    validationUrl?: string;
    checkedAt: number;
  } | null {
    if (!this.activeAuthHealth) return null;
    if (email && this.activeAuthHealth.email.toLowerCase() !== email.toLowerCase()) {
      return null;
    }
    return this.activeAuthHealth;
  }

  public markLoggingOut(previousEmail?: string | null, durationMs = 10000): void {
    this.loggingOutEmail = previousEmail ? previousEmail.trim().toLowerCase() : '';
    this.loggingOutStartedAt = Date.now();
    this.loggingOutUntil = this.loggingOutStartedAt + durationMs;
    this.invalidate();
  }

  public clearLoggingOut(): void {
    this.loggingOutEmail = null;
    this.loggingOutUntil = 0;
    this.loggingOutStartedAt = 0;
  }

  public isLoggingOutPending(): boolean {
    return Date.now() < this.loggingOutUntil;
  }

  public invalidate(): void {
    this.cachedSummary = null;
    this.cacheEpoch++;
    this.inFlightPromise = null;
    this.activeAuthHealth = null;
  }

  public getCachedSummary(): QuotaSummary | null {
    return this.cachedSummary;
  }

  public async getQuotaSummary(forceRefresh = false): Promise<QuotaSummary | null> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.cachedSummary &&
      now - this.cachedSummary.fetchedAt < this.cacheTtlMs
    ) {
      return this.cachedSummary;
    }

    if (this.inFlightPromise && this.inFlightEpoch === this.cacheEpoch) {
      return this.inFlightPromise;
    }

    const epochAtStart = this.cacheEpoch;
    this.inFlightEpoch = epochAtStart;
    const promise = this.fetchFromDaemon(forceRefresh)
      .then((summary) => {
        // A switch or invalidate() happened mid-flight: this answer belongs to the previous account.
        if (epochAtStart !== this.cacheEpoch) {
          return null;
        }
        if (summary) {
          this.cachedSummary = summary;
          if (summary.email && summary.authStatus === 'unverified') {
            this.activeAuthHealth = {
              email: summary.email,
              authStatus: 'unverified',
              authErrorCode: summary.authErrorCode || 'VALIDATION_REQUIRED',
              authErrorMessage: summary.authErrorMessage,
              validationUrl: summary.validationUrl,
              checkedAt: Date.now()
            };
          } else if (summary.email && summary.groups.length > 0) {
            this.activeAuthHealth = {
              email: summary.email,
              authStatus: 'ok',
              checkedAt: Date.now()
            };
          }
        }
        return summary || this.cachedSummary;
      })
      .catch((err) => {
        console.warn('[Charlier] Could not query Antigravity daemon:', err);
        return this.cachedSummary;
      })
      .finally(() => {
        if (this.inFlightPromise === promise) {
          this.inFlightPromise = null;
        }
      });

    this.inFlightPromise = promise;
    return promise;
  }

  private findAllLiveDaemons(): Array<DaemonInfo & { mtime: number; filePath?: string }> {
    const dirs = getDaemonSearchDirs();
    const candidates: Array<DaemonInfo & { mtime: number; filePath: string }> = [];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.startsWith('hub_') && file.endsWith('.json')) {
            const fullPath = path.join(dir, file);
            try {
              const stat = fs.statSync(fullPath);
              const content = fs.readFileSync(fullPath, 'utf8');
              const parsed = JSON.parse(content);
              if (parsed.httpPort && parsed.csrfToken) {
                candidates.push({
                  filePath: fullPath,
                  mtime: stat.mtimeMs,
                  pid: parsed.pid,
                  httpPort: parsed.httpPort,
                  csrfToken: parsed.csrfToken
                });
              }
            } catch {}
          }
        }
      } catch {}
    }

    if (candidates.length === 0) return [];
    candidates.sort((a, b) => b.mtime - a.mtime);

    const live: Array<DaemonInfo & { mtime: number; filePath?: string }> = [];
    const seenPids = new Set<number>();
    for (const cand of candidates) {
      if (!cand.pid || typeof cand.pid !== 'number') {
        continue;
      }
      if (seenPids.has(cand.pid)) continue;
      try {
        process.kill(cand.pid, 0);
        seenPids.add(cand.pid);
        live.push(cand);
      } catch {
        // Purge stale hub_*.json files left by dead daemon processes so recycled PIDs cannot match
        if (cand.filePath && Date.now() - cand.mtime > 3000) {
          try {
            fs.unlinkSync(cand.filePath);
          } catch {}
        }
      }
    }

    return live;
  }

  private findActiveDaemon(): DaemonInfo | null {
    const live = this.findAllLiveDaemons();
    return live.length > 0 ? live[0] : null;
  }

  private findLocalHubPids(): Set<number> {
    const pids = new Set<number>();
    const getHandles = (process as any)._getActiveHandles;
    if (typeof getHandles !== 'function') return pids;
    try {
      const handles: any[] = getHandles.call(process) || [];
      for (const h of handles) {
        const pid = isAntigravityHubProcess(h);
        if (pid) pids.add(pid);
      }
    } catch {}
    return pids;
  }

  private resolveHostScopedDaemonDirs(): string[] {
    const allDirs = getDaemonSearchDirs();
    const isAntigravityIdeHost = (vscode.env?.appName || '')
      .toLowerCase()
      .includes('antigravity');
    const agConfig = vscode.workspace?.getConfiguration?.('antigravity');
    const agServerArgs = agConfig?.get<string[]>('serverArgs', []);
    const explicitIdeAppData =
      Boolean(agConfig?.get<boolean>('isAntigravityIde', false)) ||
      (Array.isArray(agServerArgs) &&
        agServerArgs.some((arg) => String(arg || '').includes('antigravity-ide')));
    if (isAntigravityIdeHost || explicitIdeAppData) {
      return allDirs;
    }
    return allDirs.filter(
      (dir) => path.basename(path.dirname(dir)).toLowerCase() !== 'antigravity-ide'
    );
  }

  /**
   * Surgical Provider-Isolated Antigravity Reload:
   * Terminates only the active window's `agy` language server PID when safe within
   * AntigravityServerManager's 3-restarts-per-10-min auto-recovery budget (`<=2` kills and
   * outside the 4.5s startup cooldown), avoiding the 9s backoff stall and permanent
   * `process_exit_nonzero` backend crash screen across Windows, macOS, and Linux.
   * Returns `'budget-exhausted'` before touching the daemon once the safe budget or cooldown
   * is reached so callers can route to a clean ~200ms Extension Host restart instead.
   */
  public async respawnActiveDaemon(
    onNewDaemonReady?: () => void
  ): Promise<'respawned' | 'not-running' | 'budget-exhausted' | 'failed'> {
    const liveDaemons = this.findAllLiveDaemons().filter(
      (d): d is DaemonInfo & { mtime: number; pid: number; filePath?: string } => Boolean(d.pid)
    );
    if (liveDaemons.length === 0) {
      this.invalidate();
      return 'not-running';
    }

    const targetDirs = new Set(
      this.resolveHostScopedDaemonDirs().map((dir) => path.resolve(dir).toLowerCase())
    );
    const localPids = this.findLocalHubPids();
    let targetDaemons =
      localPids.size > 0
        ? liveDaemons.filter((d) => localPids.has(d.pid))
        : [];
    if (targetDaemons.length === 0) {
      targetDaemons = liveDaemons.filter((d) =>
        d.filePath ? targetDirs.has(path.resolve(path.dirname(d.filePath)).toLowerCase()) : false
      );
    }
    if (targetDaemons.length === 0) {
      this.invalidate();
      return 'not-running';
    }

    const now = Date.now();
    this.surgicalRespawnTimestamps = this.surgicalRespawnTimestamps.filter(
      (t) => now - t < this.RESPAWN_WINDOW_MS
    );
    if (
      this.respawnInFlight ||
      now - this.lastRespawnAt < this.RESPAWN_COOLDOWN_MS ||
      this.surgicalRespawnTimestamps.length >= this.SAFE_MAX_SURGICAL_RESPAWNS
    ) {
      return 'budget-exhausted';
    }

    const oldPids = new Set<number>(targetDaemons.map((d) => d.pid));
    const hadLocalHandles = localPids.size > 0;
    this.surgicalRespawnTimestamps.push(now);
    this.lastRespawnAt = now;
    this.respawnInFlight = true;

    let killedAny = false;
    for (const d of targetDaemons) {
      if (d.pid === process.pid) continue;
      try {
        process.kill(d.pid, 'SIGTERM');
        killedAny = true;
        if (d.filePath) {
          try {
            fs.unlinkSync(d.filePath);
          } catch {}
        }
      } catch {}
    }

    if (!killedAny) {
      this.respawnInFlight = false;
      this.surgicalRespawnTimestamps.pop();
      return 'failed';
    }

    this.invalidate();

    // Poll in the background for up to 6.5s so as soon as AntigravityServerManager's
    // recovery backoff spawns the new `agy --hub` and binds its gRPC port, we pull live quota.
    (async () => {
      try {
        const start = Date.now();
        while (Date.now() - start < 6500) {
          await new Promise((r) => setTimeout(r, 220));
          const updatedLocalPids = hadLocalHandles ? this.findLocalHubPids() : new Set<number>();
          const candidates = this.findAllLiveDaemons().filter((d) => {
            if (!d.pid || oldPids.has(d.pid)) return false;
            if (hadLocalHandles) {
              return updatedLocalPids.has(d.pid);
            }
            return d.filePath
              ? targetDirs.has(path.resolve(path.dirname(d.filePath)).toLowerCase())
              : false;
          });
          if (candidates.length > 0) {
            this.invalidate();
            onNewDaemonReady?.();
            return;
          }
        }
        this.invalidate();
        onNewDaemonReady?.();
      } finally {
        this.respawnInFlight = false;
      }
    })().catch(() => {
      this.respawnInFlight = false;
    });

    return 'respawned';
  }

  private queryDaemonRpcWithMeta<T>(
    daemon: DaemonInfo,
    rpcPath: string,
    payload: any,
    timeoutMs = 2500
  ): Promise<DaemonRpcResult<T>> {
    const jsonPayload = JSON.stringify(payload);
    const payloadBuf = Buffer.from(jsonPayload, 'utf8');
    const frame = Buffer.alloc(5 + payloadBuf.length);
    frame.writeUInt8(0, 0);
    frame.writeUInt32BE(payloadBuf.length, 1);
    payloadBuf.copy(frame, 5);

    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: daemon.httpPort,
          path: rpcPath,
          method: 'POST',
          headers: {
            'Content-Type': 'application/grpc-web+json',
            'X-Grpc-Web': '1',
            'x-codeium-csrf-token': daemon.csrfToken,
            'Content-Length': frame.length
          },
          timeout: timeoutMs
        },
        (res) => {
          const status = res.statusCode || 0;
          const headerGrpcStatus =
            typeof res.headers['grpc-status'] === 'string'
              ? res.headers['grpc-status']
              : undefined;
          let headerGrpcMessage =
            typeof res.headers['grpc-message'] === 'string'
              ? res.headers['grpc-message']
              : undefined;
          if (headerGrpcMessage) {
            try {
              headerGrpcMessage = decodeURIComponent(headerGrpcMessage);
            } catch {}
          }

          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const full = Buffer.concat(chunks);
            let offset = 0;
            let rawJson = '';
            let trailerText = '';

            if (full.length > 0 && (full[0] === 0x7b || status !== 200)) {
              const asText = full.toString('utf8');
              if (status === 200 && full[0] === 0x7b) {
                rawJson = asText;
              } else {
                trailerText = asText;
              }
            } else {
              while (offset + 5 <= full.length) {
                const flags = full.readUInt8(offset);
                const len = full.readUInt32BE(offset + 1);
                offset += 5;
                if (offset + len > full.length) break;
                const data = full.subarray(offset, offset + len);
                offset += len;
                if (flags === 0) {
                  rawJson = data.toString('utf8');
                } else if ((flags & 0x80) !== 0) {
                  trailerText += data.toString('utf8') + '\n';
                }
              }
            }

            let grpcStatus = headerGrpcStatus;
            let grpcMessage = headerGrpcMessage;
            if (trailerText) {
              for (const line of trailerText.split(/\r?\n/)) {
                const lower = line.toLowerCase();
                if (lower.startsWith('grpc-status:')) {
                  grpcStatus = line.slice('grpc-status:'.length).trim();
                } else if (lower.startsWith('grpc-message:')) {
                  const rawMsg = line.slice('grpc-message:'.length).trim();
                  try {
                    grpcMessage = decodeURIComponent(rawMsg);
                  } catch {
                    grpcMessage = rawMsg;
                  }
                }
              }
            }

            if (status !== 200) {
              let parsedErr: any = null;
              try {
                parsedErr = JSON.parse(trailerText);
              } catch {}
              resolve({
                status,
                data: parsedErr,
                grpcStatus,
                grpcMessage: grpcMessage || trailerText,
                rawErrorText: trailerText
              });
              return;
            }

            if (!rawJson) {
              resolve({
                status,
                data: null,
                grpcStatus,
                grpcMessage,
                rawErrorText: trailerText || grpcMessage
              });
              return;
            }

            try {
              resolve({
                status,
                data: JSON.parse(rawJson),
                grpcStatus,
                grpcMessage,
                rawErrorText: trailerText || undefined
              });
            } catch {
              resolve({
                status,
                data: null,
                grpcStatus,
                grpcMessage,
                rawErrorText: rawJson
              });
            }
          });
        }
      );

      req.on('error', () => resolve({ status: 0, data: null }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 0, data: null });
      });

      req.write(frame);
      req.end();
    });
  }

  private async queryDaemonRpc<T>(
    daemon: DaemonInfo,
    rpcPath: string,
    payload: any
  ): Promise<T | null> {
    const res = await this.queryDaemonRpcWithMeta<T>(daemon, rpcPath, payload);
    return res.status === 200 ? res.data : null;
  }

  public resolvePlanTier(
    userTier: { id?: string; name?: string } | undefined,
    planInfo: { planName?: string; teamsTier?: string } | undefined,
    hasArgonGroup: boolean,
    planOverride?: UserPlanTier
  ): UserPlanTier {
    if (planOverride) {
      return planOverride;
    }

    const userTierId = (userTier?.id || '').toLowerCase().trim();
    const userTierName = (userTier?.name || '').toLowerCase().trim();
    const rawPlanName = (planInfo?.planName || '').toLowerCase().trim();
    const teamsTier = (planInfo?.teamsTier || '').toUpperCase().trim();

    // 1. Authoritative Google userTier / paidTier checks (from LoadCodeAssist)
    if (userTierId || userTierName) {
      if (
        userTierId === 'free-tier' ||
        userTierId.includes('free') ||
        userTierName.includes('starter') ||
        userTierName.includes('free')
      ) {
        return 'FREE';
      }
      if (
        userTierId.includes('ultra') ||
        userTierName.includes('ultra') ||
        teamsTier.includes('ULTRA') ||
        teamsTier.includes('ULTIMATE')
      ) {
        return 'ULTRA';
      }
      if (userTierId.includes('pro') || userTierName.includes('pro')) {
        return 'PRO';
      }
    }

    // 2. Explicit Free / Enterprise / Ultra checks on planInfo
    if (
      rawPlanName === 'free' ||
      rawPlanName.includes('free') ||
      teamsTier === 'TEAMS_TIER_FREE' ||
      teamsTier.includes('FREE')
    ) {
      return 'FREE';
    }

    if (
      rawPlanName.includes('ultra') ||
      teamsTier.includes('ULTRA') ||
      teamsTier.includes('ULTIMATE')
    ) {
      return 'ULTRA';
    }

    if (teamsTier.includes('ENTERPRISE') || rawPlanName.includes('enterprise')) {
      return 'ENTERPRISE';
    }

    // 3. Legacy planInfo.teamsTier === 'TEAMS_TIER_PRO' is set on all personal accounts (even Free).
    // Only trust it when userTier wasn't present AND the paid Argon quota bucket is actually provisioned.
    if (hasArgonGroup) {
      return 'PRO';
    }

    return 'FREE';
  }

  private inspectRecentDaemonLogForValidation(expectedEmail?: string): GoogleValidationInfo {
    const daemonDirs = getDaemonSearchDirs();
    const logDirCandidates = new Set<string>();
    for (const d of daemonDirs) {
      logDirCandidates.add(d);
      logDirCandidates.add(path.dirname(d));
      logDirCandidates.add(path.join(path.dirname(d), 'logs'));
    }

    let newestLogPath: string | null = null;
    let newestMtime = 0;
    const now = Date.now();

    for (const dir of logDirCandidates) {
      if (!fs.existsSync(dir)) continue;
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (!entry.endsWith('.log')) continue;
          const full = path.join(dir, entry);
          const st = fs.statSync(full);
          if (st.isFile() && now - st.mtimeMs < 15 * 60 * 1000 && st.mtimeMs > newestMtime) {
            newestMtime = st.mtimeMs;
            newestLogPath = full;
          }
        }
      } catch {}
    }

    if (!newestLogPath) {
      return { isValidationRequired: false };
    }

    try {
      const st = fs.statSync(newestLogPath);
      const readLen = Math.min(st.size, 24576);
      const fd = fs.openSync(newestLogPath, 'r');
      const buf = Buffer.alloc(readLen);
      try {
        fs.readSync(fd, buf, 0, readLen, Math.max(0, st.size - readLen));
      } finally {
        fs.closeSync(fd);
      }
      const tail = buf.toString('utf8');
      const info = extractGoogleValidationInfo(tail);
      if (!info.isValidationRequired) {
        return { isValidationRequired: false };
      }
      if (
        expectedEmail &&
        info.emailFromUrl &&
        info.emailFromUrl.toLowerCase() !== expectedEmail.toLowerCase()
      ) {
        return { isValidationRequired: false };
      }
      return info;
    } catch {
      return { isValidationRequired: false };
    }
  }

  public async peekDaemonIdentityAsync(): Promise<{
    email: string;
    authStatus?: AuthHealthStatus;
    validationUrl?: string;
  } | null> {
    const daemon = this.findActiveDaemon();
    if (!daemon) return null;
    const statusMeta = await this.queryDaemonRpcWithMeta<any>(
      daemon,
      '/exa.language_server_pb.LanguageServerService/GetUserStatus',
      {},
      600
    );
    const email = (statusMeta.data?.userStatus?.email || '').trim();
    if (!email) {
      if (this.isLoggingOutPending()) {
        this.clearLoggingOut();
      }
      return null;
    }
    if (this.isLoggingOutPending()) {
      const lower = email.toLowerCase();
      if (this.loggingOutEmail && lower === this.loggingOutEmail) {
        const oauthPath = getActiveOAuthCredsPath();
        const accountsPath = getActiveGoogleAccountsPath();
        let hasFreshDiskCreds = false;
        for (const p of [oauthPath, accountsPath]) {
          try {
            if (fs.existsSync(p) && fs.statSync(p).mtimeMs >= this.loggingOutStartedAt) {
              hasFreshDiskCreds = true;
              break;
            }
          } catch {}
        }
        if (!hasFreshDiskCreds) {
          return null;
        }
      }
      this.clearLoggingOut();
    }
    const valInfo = extractGoogleValidationInfo(statusMeta.data || statusMeta);
    return {
      email,
      ...(valInfo.isValidationRequired
        ? { authStatus: 'unverified', validationUrl: valInfo.validationUrl }
        : {})
    };
  }

  private async fetchFromDaemon(forceRefresh: boolean): Promise<QuotaSummary | null> {
    const daemon = this.findActiveDaemon();
    if (!daemon) return null;

    const [statusMeta, quotaMeta] = await Promise.all([
      this.queryDaemonRpcWithMeta<any>(
        daemon,
        '/exa.language_server_pb.LanguageServerService/GetUserStatus',
        {}
      ),
      this.queryDaemonRpcWithMeta<any>(
        daemon,
        '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
        { force_refresh: forceRefresh }
      )
    ]);

    const statusRes = statusMeta.data;
    const quotaRes = quotaMeta.data;

    const quotaValInfo = extractGoogleValidationInfo(quotaRes || quotaMeta);
    const statusValInfo = extractGoogleValidationInfo(statusRes || statusMeta);
    let validationInfo: GoogleValidationInfo = quotaValInfo.isValidationRequired
      ? quotaValInfo
      : statusValInfo;

    const rawUserEmail = (statusRes?.userStatus?.email || '').trim();
    if (!validationInfo.isValidationRequired && rawUserEmail && (!quotaRes || !quotaRes.response?.groups?.length)) {
      const logValInfo = this.inspectRecentDaemonLogForValidation(rawUserEmail);
      if (logValInfo.isValidationRequired) {
        validationInfo = logValInfo;
      }
    }

    const userEmail = (rawUserEmail || validationInfo.emailFromUrl || '').trim();

    if (this.isLoggingOutPending()) {
      if (!userEmail) {
        this.clearLoggingOut();
        return null;
      }
      const lower = userEmail.toLowerCase();
      if (this.loggingOutEmail && lower === this.loggingOutEmail) {
        const oauthPath = getActiveOAuthCredsPath();
        const accountsPath = getActiveGoogleAccountsPath();
        let hasFreshDiskCreds = false;
        for (const p of [oauthPath, accountsPath]) {
          try {
            if (fs.existsSync(p) && fs.statSync(p).mtimeMs >= this.loggingOutStartedAt) {
              hasFreshDiskCreds = true;
              break;
            }
          } catch {}
        }
        if (!hasFreshDiskCreds) {
          return null;
        }
      }
      this.clearLoggingOut();
    }

    if (!quotaRes && !statusRes && !validationInfo.isValidationRequired) return null;

    const groups: QuotaGroup[] = quotaRes?.response?.groups || [];
    const hasArgonGroup = groups.some(
      (g) =>
        (g.displayName && g.displayName.toLowerCase().includes('argon')) ||
        (g.description && g.description.toLowerCase().includes('argon'))
    );

    const planInfo = statusRes?.userStatus?.planStatus?.planInfo;
    const userTier = statusRes?.userStatus?.userTier;

    const planTier = this.resolvePlanTier(userTier, planInfo, hasArgonGroup);

    const tier: QuotaSummary['tier'] =
      planTier === 'ULTRA'
        ? 'Ultra Plan'
        : planTier === 'PRO'
          ? 'Pro Plan'
          : planTier === 'ENTERPRISE'
            ? 'Enterprise'
            : 'Free Tier';

    const isUnverified = validationInfo.isValidationRequired && groups.length === 0;
    if (isUnverified && userEmail) {
      this.activeAuthHealth = {
        email: userEmail,
        authStatus: 'unverified',
        authErrorCode: 'VALIDATION_REQUIRED',
        authErrorMessage: validationInfo.message || 'Verify your account to continue.',
        validationUrl: validationInfo.validationUrl,
        checkedAt: Date.now()
      };
    }

    return {
      email: userEmail,
      tier,
      planTier,
      groups,
      hasArgonGroup,
      ...(isUnverified
        ? {
            authStatus: 'unverified',
            authErrorCode: 'VALIDATION_REQUIRED',
            authErrorMessage: validationInfo.message || 'Verify your account to continue.',
            validationUrl: validationInfo.validationUrl
          }
        : {}),
      fetchedAt: Date.now()
    };
  }

  private mintAccessTokenFromRefresh(refreshToken: string): Promise<OAuthMintResult> {
    const postData = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }).toString();

    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: 'oauth2.googleapis.com',
          path: '/token',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: 5000
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            const status = res.statusCode || 0;
            if (status !== 200) {
              let errorCode: string | undefined;
              let errorMessage: string | undefined;
              try {
                const parsed = JSON.parse(data);
                errorCode = typeof parsed?.error === 'string' ? parsed.error : undefined;
                errorMessage =
                  typeof parsed?.error_description === 'string'
                    ? parsed.error_description
                    : undefined;
              } catch {}
              resolve({
                ok: false,
                revoked: isGoogleRevokedError(status, errorCode, errorMessage),
                errorCode: errorCode || (status ? `http_${status}` : undefined),
                errorMessage
              });
              return;
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed?.access_token) {
                resolve({
                  ok: true,
                  access_token: String(parsed.access_token),
                  expires_in: Number(parsed.expires_in) || 3599
                });
              } else {
                resolve({ ok: false, revoked: false });
              }
            } catch {
              resolve({ ok: false, revoked: false });
            }
          });
        }
      );

      req.on('error', () => resolve({ ok: false, revoked: false }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, revoked: false });
      });
      req.write(postData);
      req.end();
    });
  }

  private postCloudCodeJson<T>(
    accessToken: string,
    endpointPath: string,
    body: Record<string, any> = {}
  ): Promise<{ status: number; data: T | null }> {
    const payload = JSON.stringify(body);
    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: CLOUDCODE_HOST,
          path: endpointPath,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Antigravity/1.11.0',
            'Content-Length': Buffer.byteLength(payload)
          },
          timeout: 5000
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            const status = res.statusCode || 0;
            try {
              resolve({ status, data: JSON.parse(raw) as T });
            } catch {
              resolve({ status, data: null });
            }
          });
        }
      );

      req.on('error', () => resolve({ status: 0, data: null }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 0, data: null });
      });
      req.write(payload);
      req.end();
    });
  }

  private getAICodeJson<T>(
    accessToken: string,
    endpointPath: string
  ): Promise<{ status: number; data: T | null }> {
    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: 'aicode.googleapis.com',
          path: endpointPath,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Antigravity/1.11.0'
          },
          timeout: 5000
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            const status = res.statusCode || 0;
            try {
              resolve({ status, data: JSON.parse(raw) as T });
            } catch {
              resolve({ status, data: null });
            }
          });
        }
      );

      req.on('error', () => resolve({ status: 0, data: null }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 0, data: null });
      });
      req.end();
    });
  }

  private isResetExpired(isoStr?: string): boolean {
    if (!isoStr) return false;
    const resetMs = new Date(isoStr).getTime();
    return Number.isFinite(resetMs) && resetMs <= Date.now();
  }

  private getCloudCodeClientMetadata(): {
    ideType: string;
    platform: string;
    pluginType: string;
  } {
    const platform =
      process.platform === 'darwin'
        ? process.arch === 'arm64'
          ? 'DARWIN_ARM64'
          : 'DARWIN_AMD64'
        : process.platform === 'linux'
          ? process.arch === 'arm64'
            ? 'LINUX_ARM64'
            : 'LINUX_AMD64'
          : process.arch === 'arm64'
            ? 'WINDOWS_ARM64'
            : 'WINDOWS_AMD64';
    return {
      ideType: 'ANTIGRAVITY',
      platform,
      pluginType: 'GEMINI'
    };
  }

  /**
   * Refreshes an inactive profile's OAuth token and live quota directly against Google's
   * Cloud Code APIs in the background without touching active session files or the daemon.
   */
  public async refreshInactiveProfile(
    profile: ProfileMetadata,
    vault: Vault,
    force = false
  ): Promise<CachedQuotaMetric | null> {
    const now = Date.now();
    const lastTime = this.lastInactiveRefreshTime.get(profile.id) || 0;
    if (!force && now - lastTime < 45000 && profile.cachedQuota) {
      return profile.cachedQuota;
    }

    const existingPromise = this.inactiveRefreshInFlight.get(profile.id);
    if (existingPromise) {
      return existingPromise;
    }

    const task = (async (): Promise<CachedQuotaMetric | null> => {
      try {
        syncAntigravityCliHomeToVault(profile.id);
      } catch {}
      const refreshToken = vault.getProfileRefreshToken(profile.id);
      if (!refreshToken) {
        if (profile.authStatus === 'unverified') {
          return profile.cachedQuota || null;
        }
        if (profile.tokenExpiryDate && profile.tokenExpiryDate < Date.now()) {
          vault.updateProfileAuthHealth(profile.id, {
            authStatus: 'expired',
            authErrorCode: 'missing_refresh_token',
            authCheckedAt: Date.now()
          });
        }
        return profile.cachedQuota || null;
      }

      const tokenRes = await this.mintAccessTokenFromRefresh(refreshToken);
      if (!tokenRes.ok) {
        if (tokenRes.revoked) {
          vault.updateProfileAuthHealth(profile.id, {
            authStatus: 'revoked',
            authErrorCode: tokenRes.errorCode,
            authErrorMessage: tokenRes.errorMessage,
            authCheckedAt: Date.now()
          });
        }
        return profile.cachedQuota || null;
      }

      // Persist fresh access token inside the inactive profile's vault folder only
      vault.updateInactiveProfileToken(profile.id, tokenRes.access_token, tokenRes.expires_in);

      const clientMetadata = this.getCloudCodeClientMetadata();
      const [loadRes, licensesRes] = await Promise.all([
        this.postCloudCodeJson<any>(tokenRes.access_token, '/v1internal:loadCodeAssist', {
          metadata: clientMetadata
        }),
        this.getAICodeJson<any>(tokenRes.access_token, '/v1alpha:fetchLicenses')
      ]);

      if (loadRes.status === 401 || licensesRes.status === 401) {
        vault.updateProfileAuthHealth(profile.id, {
          authStatus: 'revoked',
          authErrorCode: 'http_401',
          authCheckedAt: Date.now()
        });
        return profile.cachedQuota || null;
      }

      const loadValInfo = extractGoogleValidationInfo(loadRes.data);
      if (loadValInfo.isValidationRequired) {
        vault.updateProfileAuthHealth(profile.id, {
          authStatus: 'unverified',
          authErrorCode: 'VALIDATION_REQUIRED',
          authErrorMessage: loadValInfo.message || 'Verify your account to continue.',
          validationUrl: loadValInfo.validationUrl || profile.validationUrl,
          authCheckedAt: Date.now()
        });
        this.lastInactiveRefreshTime.set(profile.id, Date.now());
        return profile.cachedQuota || null;
      }

      const resolvedProject =
        (typeof loadRes.data?.cloudaicompanionProject === 'string' &&
        loadRes.data.cloudaicompanionProject.trim()
          ? loadRes.data.cloudaicompanionProject.trim()
          : typeof loadRes.data?.cloudaicompanionProject?.id === 'string' &&
              loadRes.data.cloudaicompanionProject.id.trim()
            ? loadRes.data.cloudaicompanionProject.id.trim()
            : null) || 'aicode-consumers';

      const [modelsRes, quotaRes] = await Promise.all([
        this.postCloudCodeJson<any>(tokenRes.access_token, '/v1internal:fetchAvailableModels', {
          project: resolvedProject,
          metadata: clientMetadata
        }),
        this.postCloudCodeJson<any>(
          tokenRes.access_token,
          '/v1internal:retrieveUserQuotaSummary',
          {
            project: resolvedProject,
            metadata: clientMetadata
          }
        )
      ]);

      const quotaValInfo = extractGoogleValidationInfo(quotaRes.data);
      const modelsValInfo = extractGoogleValidationInfo(modelsRes.data);
      const downstreamValInfo = quotaValInfo.isValidationRequired ? quotaValInfo : modelsValInfo;
      if (downstreamValInfo.isValidationRequired) {
        vault.updateProfileAuthHealth(profile.id, {
          authStatus: 'unverified',
          authErrorCode: 'VALIDATION_REQUIRED',
          authErrorMessage: downstreamValInfo.message || 'Verify your account to continue.',
          validationUrl: downstreamValInfo.validationUrl || profile.validationUrl,
          authCheckedAt: Date.now()
        });
        this.lastInactiveRefreshTime.set(profile.id, Date.now());
        return profile.cachedQuota || null;
      }

      const licenseEntry = Array.isArray(licensesRes.data?.licenses)
        ? licensesRes.data.licenses[0]
        : null;
      const paidTier =
        loadRes.data?.paidTier ||
        loadRes.data?.currentTier ||
        (licenseEntry?.userTier
          ? { id: String(licenseEntry.userTier), name: String(licenseEntry.tierDisplayName || '') }
          : undefined);

      const planTier = this.resolvePlanTier(
        paidTier,
        undefined,
        false,
        profile.planOverride
      );

      // 1. Extract Gemini 5h pool from fetchAvailableModels & preserve/auto-heal 7d pool
      let gemini5h = profile.cachedQuota?.gemini5h || profile.cachedQuota?.gemini || '--';
      let gemini5hReset = profile.cachedQuota?.gemini5hReset || profile.cachedQuota?.geminiReset;

      const modelsDict = modelsRes.data?.models;
      if (modelsDict && typeof modelsDict === 'object') {
        const preferredKeys = [
          'gemini-3.8-flash-tiered',
          'gemini-3.8-flash',
          'gemini-3-flash',
          'gemini-2.5-pro',
          'gemini-2.5-flash'
        ];
        let foundQuota: any = null;
        for (const k of preferredKeys) {
          if (modelsDict[k]?.quotaInfo) {
            foundQuota = modelsDict[k].quotaInfo;
            break;
          }
        }
        if (!foundQuota) {
          for (const [k, v] of Object.entries<any>(modelsDict)) {
            const lowerKey = k.toLowerCase();
            if (
              lowerKey.includes('gemini') &&
              !lowerKey.includes('argon') &&
              !lowerKey.includes('carbon') &&
              v?.quotaInfo
            ) {
              foundQuota = v.quotaInfo;
              break;
            }
          }
        }
        const foundPct = foundQuota ? percentFromFraction(foundQuota.remainingFraction) : null;
        if (foundPct !== null) {
          const pct = foundPct;
          gemini5h = `${pct}%`;
          if (foundQuota.resetTime) {
            gemini5hReset = String(foundQuota.resetTime);
          } else {
            gemini5hReset = undefined;
          }
        }
      }

      let gemini7d = profile.cachedQuota?.gemini7d || gemini5h;
      let gemini7dReset = profile.cachedQuota?.gemini7dReset;
      if (this.isResetExpired(gemini7dReset)) {
        gemini7d = '100%';
        gemini7dReset = undefined;
      }

      // Summary Gemini metric uses the tighter of 5h vs 7d
      const p5h = parseInt(gemini5h, 10);
      const p7d = parseInt(gemini7d, 10);
      let gemini = gemini5h;
      let geminiReset = gemini5hReset || gemini7dReset;
      if (Number.isFinite(p5h) && Number.isFinite(p7d)) {
        if (p7d < p5h) {
          gemini = `${p7d}%`;
          geminiReset = gemini7dReset || gemini5hReset;
        } else if (p5h < p7d) {
          gemini = `${p5h}%`;
          geminiReset = gemini5hReset || gemini7dReset;
        } else {
          gemini = `${p5h}%`;
          geminiReset = gemini7dReset || gemini5hReset;
        }
      }

      // 2. Extract Claude & GPT 5h + 7d pools (and optional Argon/Carbon groups) from retrieveUserQuotaSummary
      let claude5h = profile.cachedQuota?.claude5h || '--';
      let claude5hReset = profile.cachedQuota?.claude5hReset;
      let claude7d = profile.cachedQuota?.claude7d || profile.cachedQuota?.claudeGpt || '--';
      let claude7dReset = profile.cachedQuota?.claude7dReset || profile.cachedQuota?.claudeReset;
      let claudeGpt = claude7d;
      let claudeReset = claude7dReset;
      let upstreamArgon: string | undefined;
      let upstreamArgonReset: string | undefined;
      let upstreamCarbon: string | undefined;
      let upstreamCarbonReset: string | undefined;

      let upstreamGemini5h: string | undefined;
      let upstreamGemini5hReset: string | undefined;
      let upstreamGemini7d: string | undefined;
      let upstreamGemini7dReset: string | undefined;

      if (planTier === 'FREE') {
        claude5h = '--';
        claude5hReset = undefined;
        claude7d = '--';
        claude7dReset = undefined;
        claudeGpt = '--';
        claudeReset = undefined;
      }

      if (quotaRes.status === 200 && Array.isArray(quotaRes.data?.groups)) {
        for (const g of quotaRes.data.groups) {
          const gName = String(g.displayName || '').toLowerCase();
          if (gName.includes('argon')) {
            const b = (g.buckets || [])[0];
            if (b && !b.disabled) {
              const pct = percentFromFraction(b.remainingFraction);
              if (pct !== null) {
                upstreamArgon = `${pct}%`;
                upstreamArgonReset = b.resetTime ? String(b.resetTime) : undefined;
              }
            }
          } else if (gName.includes('carbon')) {
            const buckets: any[] = g.buckets || [];
            const b5h = buckets.find((x: any) => x.window === '5h');
            const bWk = buckets.find((x: any) => x.window === 'weekly') || buckets[0];
            const p5 = b5h && !b5h.disabled ? percentFromFraction(b5h.remainingFraction) : null;
            const pW = bWk && !bWk.disabled ? percentFromFraction(bWk.remainingFraction) : null;
            const known = [p5, pW].filter((x): x is number => x !== null);
            if (known.length > 0) {
              upstreamCarbon = `${Math.min(...known)}%`;
              upstreamCarbonReset =
                p5 !== null && (pW === null || p5 < pW)
                  ? b5h?.resetTime
                  : bWk?.resetTime || b5h?.resetTime;
            }
          } else if (planTier !== 'FREE' && (gName.includes('claude') || gName.includes('gpt'))) {
            const buckets: any[] = g.buckets || [];
            const bWk = buckets.find((x: any) => x.window === 'weekly') || buckets[0];
            const b5h = buckets.find((x: any) => x.window === '5h');

            const pctWk = bWk && !bWk.disabled ? percentFromFraction(bWk.remainingFraction) : null;
            const pct5h = b5h && !b5h.disabled ? percentFromFraction(b5h.remainingFraction) : null;

            if (pctWk !== null) {
              claude7d = `${pctWk}%`;
              claude7dReset = bWk.resetTime ? String(bWk.resetTime) : undefined;
            }

            if (b5h) {
              if (b5h.disabled) {
                claude5h = '--';
                claude5hReset = undefined;
              } else if (pct5h !== null) {
                claude5h = `${pct5h}%`;
                claude5hReset = b5h.resetTime ? String(b5h.resetTime) : undefined;
              }
            } else if (claude7d !== '--') {
              claude5h = claude7d;
            }

            const knownClaude = [pct5h, pctWk].filter((x): x is number => x !== null);
            if (knownClaude.length > 0) {
              claudeGpt = `${Math.min(...knownClaude)}%`;
              claudeReset =
                pct5h !== null && (pctWk === null || pct5h < pctWk)
                  ? claude5hReset || claude7dReset
                  : claude7dReset || claude5hReset;
            }
          } else if (gName.includes('gemini')) {
            const buckets: any[] = g.buckets || [];
            const bWk = buckets.find((x: any) => x.window === 'weekly') || buckets[0];
            const b5h = buckets.find((x: any) => x.window === '5h');
            const pctWk = bWk && !bWk.disabled ? percentFromFraction(bWk.remainingFraction) : null;
            const pct5h = b5h && !b5h.disabled ? percentFromFraction(b5h.remainingFraction) : null;
            if (pct5h !== null) {
              upstreamGemini5h = `${pct5h}%`;
              upstreamGemini5hReset = b5h?.resetTime ? String(b5h.resetTime) : undefined;
            }
            if (pctWk !== null) {
              upstreamGemini7d = `${pctWk}%`;
              upstreamGemini7dReset = bWk?.resetTime ? String(bWk.resetTime) : undefined;
            }
          }
        }
      }

      if (upstreamGemini5h) {
        gemini5h = upstreamGemini5h;
        gemini5hReset = upstreamGemini5hReset;
      }
      if (upstreamGemini7d) {
        gemini7d = upstreamGemini7d;
        gemini7dReset = upstreamGemini7dReset;
      }
      const p5hFinal = parseInt(gemini5h, 10);
      const p7dFinal = parseInt(gemini7d, 10);
      if (Number.isFinite(p5hFinal) && Number.isFinite(p7dFinal)) {
        if (p7dFinal < p5hFinal) {
          gemini = `${p7dFinal}%`;
          geminiReset = gemini7dReset || gemini5hReset;
        } else if (p5hFinal < p7dFinal) {
          gemini = `${p5hFinal}%`;
          geminiReset = gemini5hReset || gemini7dReset;
        } else {
          gemini = `${p5hFinal}%`;
          geminiReset = gemini7dReset || gemini5hReset;
        }
      } else if (Number.isFinite(p5hFinal)) {
        gemini = `${p5hFinal}%`;
        geminiReset = gemini5hReset;
      } else if (Number.isFinite(p7dFinal)) {
        gemini = `${p7dFinal}%`;
        geminiReset = gemini7dReset;
      }

      // 3. Resolve Argon & Carbon representation & auto-heal expired weekly resets
      let argon = '--';
      let argonReset = profile.cachedQuota?.argonReset;
      if (planTier === 'ULTRA') {
        argon = 'incl.';
        argonReset = undefined;
      } else if (planTier === 'PRO') {
        if (upstreamArgon) {
          argon = upstreamArgon;
          argonReset = upstreamArgonReset;
        } else if (this.isResetExpired(argonReset)) {
          argon = '100%';
          argonReset = undefined;
        } else {
          const prevArgon = profile.cachedQuota?.argon;
          argon = prevArgon && prevArgon !== 'incl.' ? prevArgon : '--';
        }
      } else {
        argonReset = undefined;
      }

      let carbon: string | undefined = profile.cachedQuota?.carbon;
      let carbonReset: string | undefined = profile.cachedQuota?.carbonReset;
      if (planTier === 'ULTRA') {
        carbon = upstreamCarbon || 'incl.';
        carbonReset = upstreamCarbon ? upstreamCarbonReset : undefined;
      } else if (planTier === 'PRO') {
        if (upstreamCarbon) {
          carbon = upstreamCarbon;
          carbonReset = upstreamCarbonReset;
        } else if (carbon && carbon !== 'incl.') {
          if (this.isResetExpired(carbonReset)) {
            carbon = '100%';
            carbonReset = undefined;
          }
        } else {
          carbon = undefined;
          carbonReset = undefined;
        }
      } else {
        carbon = undefined;
        carbonReset = undefined;
      }

      const metric: CachedQuotaMetric = {
        plan: planTier,
        gemini,
        claudeGpt,
        argon,
        ...(carbon ? { carbon } : {}),
        ...(gemini5h && gemini5h !== '--' ? { gemini5h } : {}),
        ...(gemini5hReset ? { gemini5hReset } : {}),
        ...(gemini7d && gemini7d !== '--' ? { gemini7d } : {}),
        ...(gemini7dReset ? { gemini7dReset } : {}),
        ...(claude5h && claude5h !== '--' ? { claude5h } : {}),
        ...(claude5hReset ? { claude5hReset } : {}),
        ...(claude7d && claude7d !== '--' ? { claude7d } : {}),
        ...(claude7dReset ? { claude7dReset } : {}),
        ...(geminiReset ? { geminiReset } : {}),
        ...(claudeReset ? { claudeReset } : {}),
        ...(argonReset ? { argonReset } : {}),
        ...(carbonReset ? { carbonReset } : {}),
        updatedAt: Date.now()
      };

      if (quotaRes.status === 401 || modelsRes.status === 401) {
        vault.updateProfileAuthHealth(profile.id, {
          authStatus: 'revoked',
          authErrorCode: 'http_401',
          authCheckedAt: Date.now()
        });
        return profile.cachedQuota || null;
      }

      vault.updateProfileAuthHealth(profile.id, {
        authStatus: 'ok',
        authCheckedAt: Date.now()
      });
      vault.updateProfileCachedQuota(profile.id, metric);
      this.lastInactiveRefreshTime.set(profile.id, Date.now());
      return metric;
    })().finally(() => {
      this.inactiveRefreshInFlight.delete(profile.id);
    });

    this.inactiveRefreshInFlight.set(profile.id, task);
    return task;
  }

  public async probeAllAuthHealth(
    vault: Vault,
    activeEmail: string | null,
    activeProfileId: string | null
  ): Promise<boolean> {
    const now = Date.now();
    const profiles = vault.listProfiles();
    const activeProfile = activeEmail
      ? profiles.find((p) => p.email.toLowerCase() === activeEmail.toLowerCase()) || null
      : activeProfileId
        ? profiles.find((p) => p.id === activeProfileId) || null
        : null;

    const staleProfiles = profiles.filter((p) => {
      const recentCheck = Math.max(p.authCheckedAt || 0, p.cachedQuota?.updatedAt || 0);
      return now - recentCheck >= 30_000;
    });

    const tasks: Array<Promise<unknown>> = [
      this.refreshAllInactiveProfiles(staleProfiles, activeEmail, activeProfileId, vault, true)
    ];

    const activeRecentCheck = Math.max(
      this.activeAuthHealth?.checkedAt || 0,
      activeProfile?.authCheckedAt || 0
    );
    if ((activeProfile || activeEmail) && now - activeRecentCheck >= 30_000) {
      tasks.push(
        (async () => {
          const liveRt = await vault.getActiveSessionRefreshTokenAsync();
          const storedRt = activeProfile
            ? vault.getProfileRefreshToken(activeProfile.id)
            : null;
          const rt = liveRt || storedRt;
          const targetEmail = activeProfile?.email || activeEmail || '';
          if (!rt) {
            if (
              activeProfile?.authStatus === 'unverified' ||
              this.activeAuthHealth?.authStatus === 'unverified'
            ) {
              return;
            }
            if (activeProfile?.tokenExpiryDate && activeProfile.tokenExpiryDate < Date.now()) {
              vault.updateProfileAuthHealth(activeProfile.id, {
                authStatus: 'expired',
                authErrorCode: 'missing_refresh_token',
                authCheckedAt: Date.now()
              });
            }
            return;
          }
          const res = await this.mintAccessTokenFromRefresh(rt);
          if (res.ok) {
            const clientMetadata = this.getCloudCodeClientMetadata();
            const loadRes = await this.postCloudCodeJson<any>(
              res.access_token,
              '/v1internal:loadCodeAssist',
              { metadata: clientMetadata }
            );
            const loadValInfo = extractGoogleValidationInfo(loadRes.data);
            if (loadValInfo.isValidationRequired) {
              this.activeAuthHealth = {
                email: targetEmail,
                authStatus: 'unverified',
                authErrorCode: 'VALIDATION_REQUIRED',
                authErrorMessage: loadValInfo.message || 'Verify your account to continue.',
                validationUrl: loadValInfo.validationUrl || activeProfile?.validationUrl,
                checkedAt: Date.now()
              };
              if (activeProfile) {
                vault.updateProfileAuthHealth(activeProfile.id, {
                  authStatus: 'unverified',
                  authErrorCode: 'VALIDATION_REQUIRED',
                  authErrorMessage: loadValInfo.message || 'Verify your account to continue.',
                  validationUrl: loadValInfo.validationUrl || activeProfile.validationUrl,
                  authCheckedAt: Date.now()
                });
              }
              return;
            }

            if (activeProfile?.authStatus === 'unverified') {
              // Do not clear 'unverified' from loadCodeAssist alone; Google gates quota RPCs separately.
              this.activeAuthHealth = {
                email: targetEmail,
                authStatus: 'unverified',
                authErrorCode: activeProfile.authErrorCode || 'VALIDATION_REQUIRED',
                authErrorMessage:
                  activeProfile.authErrorMessage || 'Verify your account to continue.',
                validationUrl: activeProfile.validationUrl,
                checkedAt: Date.now()
              };
              return;
            }

            this.activeAuthHealth = {
              email: targetEmail,
              authStatus: 'ok',
              checkedAt: Date.now()
            };
            if (activeProfile) {
              const needsCredentialSync =
                (liveRt && liveRt !== storedRt) ||
                activeProfile.authStatus === 'revoked' ||
                activeProfile.authStatus === 'expired';
              if (needsCredentialSync && liveRt) {
                await vault.syncActiveCredentialsToProfileAsync(activeProfile.id);
              }
              vault.updateProfileAuthHealth(activeProfile.id, {
                authStatus: 'ok',
                authCheckedAt: Date.now()
              });
            }
          } else if (res.revoked) {
            this.activeAuthHealth = {
              email: targetEmail,
              authStatus: 'revoked',
              authErrorCode: res.errorCode,
              authErrorMessage: res.errorMessage,
              checkedAt: Date.now()
            };
            if (activeProfile) {
              vault.updateProfileAuthHealth(activeProfile.id, {
                authStatus: 'revoked',
                authErrorCode: res.errorCode,
                authErrorMessage: res.errorMessage,
                authCheckedAt: Date.now()
              });
            }
          }
        })()
      );
    }

    await Promise.allSettled(tasks);
    const updated = vault.listProfiles();
    const activeHealth = this.getActiveAuthHealth(activeEmail);
    return Boolean(
      updated.some((p) => p.authStatus === 'revoked' || p.authStatus === 'expired') ||
        activeHealth?.authStatus === 'revoked' ||
        activeHealth?.authStatus === 'expired'
    );
  }

  public async refreshAllInactiveProfiles(
    profiles: ProfileMetadata[],
    activeEmail: string | null,
    activeProfileId: string | null,
    vault: Vault,
    force = false
  ): Promise<void> {
    const inactive = profiles.filter((p) => {
      const isAct =
        (activeEmail && p.email.toLowerCase() === activeEmail.toLowerCase()) ||
        (!activeEmail && p.id === activeProfileId);
      return !isAct;
    });

    if (inactive.length === 0) return;
    await Promise.allSettled(
      inactive.map((p) => this.refreshInactiveProfile(p, vault, force))
    );
  }

  public renderLinenMeter(fraction: number, length = 5): string {
    const safeFrac = Number.isFinite(fraction) ? fraction : 0;
    const clamped = Math.max(0, Math.min(1, safeFrac));
    const filled = Math.round(clamped * length);
    const empty = Math.max(0, length - filled);
    return '▓'.repeat(filled) + '░'.repeat(empty);
  }

  public formatResetCompact(isoStr?: string): string {
    if (!isoStr) return '';
    const diff = new Date(isoStr).getTime() - Date.now();
    if (!Number.isFinite(diff) || diff <= 0) return 'now';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return `${hours}h ${remMins}m`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d ${remHours}h`;
  }

  public formatTimeAgo(timestamp?: number): string {
    if (!timestamp || !Number.isFinite(timestamp)) return 'never';
    const diff = Date.now() - timestamp;
    if (diff < 60000) return 'just now';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  public sanitizeMetric(val: string | undefined): string {
    if (
      !val ||
      val === '—' ||
      val === 'â€”' ||
      val === '--' ||
      val === '-' ||
      val.includes('NaN') ||
      val.includes('null') ||
      val.includes('undefined')
    ) {
      return '--';
    }
    return val;
  }

  public parseMetrics(
    quota: QuotaSummary | null,
    planOverride?: UserPlanTier
  ): CachedQuotaMetric {
    if (!quota || !quota.groups || quota.groups.length === 0) {
      return {
        plan: planOverride || quota?.planTier || '--',
        gemini: '--',
        claudeGpt: '--',
        argon: '--',
        updatedAt: Date.now()
      };
    }

    const plan = planOverride || quota.planTier || 'FREE';
    let gemini = '--';
    let claudeGpt = '--';
    let argon = plan === 'ULTRA' ? 'incl.' : '--';
    let carbon: string | undefined = plan === 'ULTRA' ? 'incl.' : undefined;
    let gemini5h: string | undefined;
    let gemini5hReset: string | undefined;
    let gemini7d: string | undefined;
    let gemini7dReset: string | undefined;
    let claude5h: string | undefined;
    let claude5hReset: string | undefined;
    let claude7d: string | undefined;
    let claude7dReset: string | undefined;
    let geminiReset: string | undefined;
    let claudeReset: string | undefined;
    let argonReset: string | undefined;
    let carbonReset: string | undefined;

    for (const group of quota.groups) {
      const name = group.displayName.toLowerCase();
      if (name.includes('argon')) {
        const b = group.buckets[0];
        if (b) {
          const pct = b.disabled ? null : percentFromFraction(b.remainingFraction);
          if (pct !== null) {
            argon = plan === 'FREE' ? '--' : `${pct}%`;
            if (b.resetTime) argonReset = b.resetTime;
          }
        }
      } else if (name.includes('carbon')) {
        const b5h = group.buckets.find((b) => b.window === '5h');
        const bWk =
          group.buckets.find((b) => b.window === 'weekly') || group.buckets[0];
        const p5 = b5h && !b5h.disabled ? percentFromFraction(b5h.remainingFraction) : null;
        const pW = bWk && !bWk.disabled ? percentFromFraction(bWk.remainingFraction) : null;
        const knownCarbon = [p5, pW].filter((p): p is number => p !== null);
        if (knownCarbon.length > 0) {
          carbon = plan === 'FREE' ? '--' : `${Math.min(...knownCarbon)}%`;
          carbonReset =
            p5 !== null && (pW === null || p5 < pW)
              ? b5h?.resetTime || bWk?.resetTime
              : bWk?.resetTime || b5h?.resetTime;
        }
      } else if (name.includes('claude') || name.includes('gpt')) {
        if (plan === 'FREE') {
          claudeGpt = '--';
          claude5h = undefined;
          claude7d = undefined;
          claudeReset = undefined;
        } else {
          const b5h = group.buckets.find((b) => b.window === '5h');
          const weekly =
            group.buckets.find((b) => b.window === 'weekly') || group.buckets[0];
          const pctWk = weekly && !weekly.disabled ? percentFromFraction(weekly.remainingFraction) : null;
          const pct5h = b5h && !b5h.disabled ? percentFromFraction(b5h.remainingFraction) : null;

          if (pctWk !== null) {
            claude7d = `${pctWk}%`;
            if (weekly?.resetTime) {
              claude7dReset = weekly.resetTime;
            }
          }
          if (b5h) {
            if (b5h.disabled) {
              claude5h = '--';
              claude5hReset = undefined;
            } else if (pct5h !== null) {
              claude5h = `${pct5h}%`;
              if (b5h.resetTime) claude5hReset = b5h.resetTime;
            }
          } else if (claude7d) {
            claude5h = claude7d;
          }

          const knownClaude = [pct5h, pctWk].filter((p): p is number => p !== null);
          if (knownClaude.length > 0) {
            claudeGpt = `${Math.min(...knownClaude)}%`;
            claudeReset =
              pct5h !== null && (pctWk === null || pct5h < pctWk)
                ? claude5hReset || claude7dReset
                : claude7dReset || claude5hReset;
          }
        }
      } else if (name.includes('gemini')) {
        const b5h = group.buckets.find((b) => b.window === '5h');
        const bWeekly =
          group.buckets.find((b) => b.window === 'weekly') || group.buckets[0];
        const p5h = b5h && !b5h.disabled ? percentFromFraction(b5h.remainingFraction) : null;
        const pWk = bWeekly && !bWeekly.disabled ? percentFromFraction(bWeekly.remainingFraction) : null;

        if (b5h) {
          if (p5h !== null) gemini5h = `${p5h}%`;
          if (b5h.resetTime) gemini5hReset = b5h.resetTime;
        }
        if (bWeekly) {
          if (pWk !== null) gemini7d = `${pWk}%`;
          if (bWeekly.resetTime) gemini7dReset = bWeekly.resetTime;
        }

        const known = [p5h, pWk].filter((p): p is number => p !== null);
        if (known.length > 0) {
          gemini = `${Math.min(...known)}%`;
          geminiReset = p5h !== null && (pWk === null || p5h < pWk)
            ? b5h?.resetTime || bWeekly?.resetTime
            : bWeekly?.resetTime || b5h?.resetTime;
        }
      }
    }

    return {
      plan,
      gemini,
      claudeGpt,
      argon,
      ...(carbon ? { carbon } : {}),
      ...(gemini5h ? { gemini5h } : {}),
      ...(gemini5hReset ? { gemini5hReset } : {}),
      ...(gemini7d ? { gemini7d } : {}),
      ...(gemini7dReset ? { gemini7dReset } : {}),
      ...(claude5h ? { claude5h } : {}),
      ...(claude5hReset ? { claude5hReset } : {}),
      ...(claude7d ? { claude7d } : {}),
      ...(claude7dReset ? { claude7dReset } : {}),
      ...(geminiReset ? { geminiReset } : {}),
      ...(claudeReset ? { claudeReset } : {}),
      ...(argonReset ? { argonReset } : {}),
      ...(carbonReset ? { carbonReset } : {}),
      updatedAt: Date.now()
    };
  }

  public getQuickSummaryLine(quota: QuotaSummary | null): string {
    const m = this.parseMetrics(quota);
    if (m.plan === '--') return '';
    const parts = [`Gemini: ${m.gemini}`, `Claude: ${m.claudeGpt}`];
    if (m.argon !== 'incl.' && m.argon !== '--') {
      parts.push(`Argon: ${m.argon}`);
    }
    if (m.carbon && m.carbon !== 'incl.' && m.carbon !== '--') {
      parts.push(`Carbon: ${m.carbon}`);
    }
    return parts.join(' · ');
  }

  private padTableCell(content: string): string {
    return `&nbsp;${content}&nbsp;`;
  }

  private escapeMarkdownLabel(text: string): string {
    return text.replace(/([\\[\]|<>`*_])/g, '\\$1').replace(/ /g, '&nbsp;');
  }

  public buildAccountsHoverTooltip(
    profiles: ProfileMetadata[],
    activeProfileId: string | null,
    liveEmail: string | null,
    liveQuota: QuotaSummary | null,
    claimedProfileIds?: ReadonlySet<string> | readonly string[]
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.supportHtml = true;
    md.isTrusted = {
      enabledCommands: [
        'charlier.switchProfileDirect',
        'charlier.switchProfile',
        'charlier.refreshQuota',
        'charlier.addAccount',
        'charlier.saveProfile',
        'charlier.verifyAccount',
        'charlier.openCockpit',
        'charlier.switchProvider'
      ]
    };
    const claimedSet =
      claimedProfileIds instanceof Set
        ? claimedProfileIds
        : new Set(claimedProfileIds || []);

    const matchedByEmail = liveEmail
      ? profiles.find((p) => p.email.toLowerCase() === liveEmail.toLowerCase()) || null
      : null;

    const activeProfile = matchedByEmail
      ? matchedByEmail
      : !liveEmail && activeProfileId
        ? profiles.find((p) => p.id === activeProfileId) || null
        : null;

    const isUnsavedActive = Boolean(liveEmail && !matchedByEmail);

    const displayName = activeProfile?.name
      ? activeProfile.name
      : liveEmail
        ? liveEmail.split('@')[0]
        : 'Ready for login';
    const safeDisplayName = this.escapeMarkdownLabel(displayName);
    const emailDisplay = activeProfile?.email || liveEmail || 'No account active';

    // Strict account isolation: only treat liveQuota as valid if its email matches the active session
    const quotaMatchesActive = Boolean(
      liveQuota &&
        liveQuota.email &&
        emailDisplay &&
        emailDisplay !== 'No account active' &&
        liveQuota.email.toLowerCase() === emailDisplay.toLowerCase()
    );
    const effectiveLiveQuota = quotaMatchesActive ? liveQuota : null;
    const planBadge = (
      activeProfile?.planOverride ||
      (effectiveLiveQuota
        ? effectiveLiveQuota.planTier
        : activeProfile?.cachedQuota?.plan || 'FREE')
    ).toUpperCase();

    const themeKind = (vscode.window as any)?.activeColorTheme?.kind;
    const isLight = themeKind === 1 || themeKind === 4;
    const pal = getHoverPalette(isLight);

    const activeAuthStatus = resolveEffectiveAuthStatus(
      activeProfile?.authStatus,
      effectiveLiveQuota?.authStatus,
      this.getActiveAuthHealth(liveEmail)?.authStatus
    );
    const activeValidationUrl =
      activeProfile?.validationUrl ||
      effectiveLiveQuota?.validationUrl ||
      this.getActiveAuthHealth(liveEmail)?.validationUrl;
    const activeNeedsReauth =
      activeAuthStatus === 'revoked' || activeAuthStatus === 'expired';
    const activeNeedsVerify = activeAuthStatus === 'unverified';
    const activeStaleAgo = activeProfile?.cachedQuota?.updatedAt
      ? ` (${this.formatTimeAgo(activeProfile.cachedQuota.updatedAt)})`
      : '';
    const reauthPills = `${renderHoverPill('RE-AUTH', 'danger', isLight)} &nbsp;${renderHoverPill('STALE', 'danger', isLight)}`;
    const verifyPill = renderHoverPill('VERIFY NEEDED', 'warn', isLight);
    const verifyActionLink = activeValidationUrl
      ? `[$(shield)&nbsp;Verify&nbsp;Account](command:charlier.verifyAccount "Open Google verification for this account")`
      : `[$(shield)&nbsp;Verify&nbsp;in&nbsp;Antigravity](command:charlier.verifyAccount "Complete Google verification in Antigravity")`;

    const activeCliPill =
      activeProfile && claimedSet.has(activeProfile.id)
        ? ` &nbsp;${renderHoverPill('CLI', 'warn', isLight)}`
        : '';
    const headerIcon = getHoverProviderIconHtml('antigravity', isLight);

    // 1. Hero Instrument Card
    if (isUnsavedActive) {
      md.appendMarkdown(
        `### ${headerIcon} Charlier &nbsp;·&nbsp; **${safeDisplayName}** &nbsp;${renderHoverPill(planBadge, 'plan', isLight)} &nbsp;${activeNeedsReauth ? reauthPills : activeNeedsVerify ? `${verifyPill} &nbsp;${renderHoverPill('UNSAVED', 'warn', isLight)}` : renderHoverPill('ACTIVE · UNSAVED', 'warn', isLight)}\n\n`
      );
      if (activeNeedsReauth) {
        md.appendMarkdown(
          `\`${emailDisplay}\` &nbsp;·&nbsp; <span style="color:${pal.crimson};">**$(warning) Stale snapshot${this.escapeMarkdownLabel(activeStaleAgo)} · Session revoked / signed out**</span> · [$(key)&nbsp;Re-Login](command:charlier.addAccount "Back up vault & sign in again")\n\n`
        );
      } else if (activeNeedsVerify) {
        md.appendMarkdown(
          `\`${emailDisplay}\` &nbsp;·&nbsp; <span style="color:${pal.amber};">**$(shield) Verification needed · Complete Google check to unlock quota**</span> · ${verifyActionLink} · [$(add)&nbsp;Save&nbsp;to&nbsp;Vault](command:charlier.saveProfile "Save this active account as a named profile in your vault")\n\n`
        );
      } else {
        md.appendMarkdown(
          `\`${emailDisplay}\` &nbsp;·&nbsp; [$(add)&nbsp;Save&nbsp;to&nbsp;Vault](command:charlier.saveProfile "Save this active account as a named profile in your vault")\n\n`
        );
      }
    } else if (activeProfile || liveEmail) {
      md.appendMarkdown(
        `### ${headerIcon} Charlier &nbsp;·&nbsp; **${safeDisplayName}** &nbsp;${renderHoverPill(planBadge, 'plan', isLight)} &nbsp;${activeNeedsReauth ? reauthPills : activeNeedsVerify ? verifyPill : renderHoverPill('ACTIVE', 'active', isLight)}${activeCliPill}\n\n`
      );
      if (activeNeedsReauth) {
        md.appendMarkdown(
          `\`${emailDisplay}\` &nbsp;·&nbsp; <span style="color:${pal.crimson};">**$(warning) Stale snapshot${this.escapeMarkdownLabel(activeStaleAgo)} · Session revoked / signed out**</span> · [$(key)&nbsp;Re-Login](command:charlier.addAccount "Back up vault & sign in again")\n\n`
        );
      } else if (activeNeedsVerify) {
        md.appendMarkdown(
          `\`${emailDisplay}\` &nbsp;·&nbsp; <span style="color:${pal.amber};">**$(shield) Verification needed · Complete Google check to unlock quota**</span> · ${verifyActionLink}\n\n`
        );
      } else {
        md.appendMarkdown(
          `\`${emailDisplay}\` &nbsp;·&nbsp; <span style="color:${pal.emerald};">**● Active Session**</span>\n\n`
        );
      }
    } else {
      md.appendMarkdown(`### ${headerIcon} Charlier &nbsp;·&nbsp; **Ready for Login**\n\n`);
      md.appendMarkdown(
        `*No active session loaded.* &nbsp;·&nbsp; [Sign in to Antigravity](command:charlier.addAccount)\n\n`
      );
    }

    if (
      effectiveLiveQuota &&
      effectiveLiveQuota.groups &&
      effectiveLiveQuota.groups.length > 0
    ) {
      let geminiGroup: QuotaGroup | undefined;
      let claudeGroup: QuotaGroup | undefined;
      let argonGroup: QuotaGroup | undefined;
      let carbonGroup: QuotaGroup | undefined;

      for (const g of effectiveLiveQuota.groups) {
        const n = g.displayName.toLowerCase();
        if (n.includes('argon')) {
          argonGroup = g;
        } else if (n.includes('carbon')) {
          carbonGroup = g;
        } else if (n.includes('claude') || n.includes('gpt')) {
          claudeGroup = g;
        } else if (n.includes('gemini')) {
          geminiGroup = g;
        }
      }

      const heroHeaders = [
        this.padTableCell('Model Pool'),
        this.padTableCell('Gauge'),
        this.padTableCell('Capacity & Reset Window')
      ];
      const heroSeparators = [':---', ':---:', ':---'];

      md.appendMarkdown(`| ${heroHeaders.join(' | ')} |\n`);
      md.appendMarkdown(`|${heroSeparators.join('|')}|\n`);

      if (geminiGroup) {
        const b5h = geminiGroup.buckets.find((b) => b.window === '5h');
        const bWk =
          geminiGroup.buckets.find((b) => b.window === 'weekly') ||
          geminiGroup.buckets[0];
        const p5h = b5h && !b5h.disabled ? percentFromFraction(b5h.remainingFraction) : null;
        const pWk = bWk && !bWk.disabled ? percentFromFraction(bWk.remainingFraction) : null;
        const known = [p5h, pWk].filter((p): p is number => p !== null);
        const pMin = known.length ? Math.min(...known) : null;
        const r5h = b5h?.resetTime ? this.formatResetCompact(b5h.resetTime) : '';
        const rWk = bWk?.resetTime ? this.formatResetCompact(bWk.resetTime) : '';

        const detailParts: string[] = [];
        detailParts.push(
          `5h: ${renderHoverPct(p5h, true, isLight, activeNeedsReauth)}${r5h && p5h !== null && p5h < 100 ? ` *(${r5h})*` : ''}`
        );
        detailParts.push(
          `7d: ${renderHoverPct(pWk, true, isLight, activeNeedsReauth)}${rWk && pWk !== null && pWk < 100 ? ` *(${rWk})*` : ''}`
        );

        const geminiSub =
          planBadge === 'ULTRA' ? '*(Flash, Pro, Carbon)*' : '*(Flash, Pro)*';
        const row = [
          this.padTableCell(`**Gemini** ${geminiSub}`),
          this.padTableCell(renderHoverGaugeCell(pMin, true, isLight, activeNeedsReauth)),
          this.padTableCell(detailParts.join(' &nbsp;·&nbsp; '))
        ];
        md.appendMarkdown(`| ${row.join(' | ')} |\n`);
      }

      if (claudeGroup && planBadge !== 'FREE') {
        const b5h = claudeGroup.buckets.find((b) => b.window === '5h');
        const bWk =
          claudeGroup.buckets.find((b) => b.window === 'weekly') ||
          claudeGroup.buckets[0];
        const p5h = b5h && !b5h.disabled ? percentFromFraction(b5h.remainingFraction) : null;
        const pWk = bWk && !bWk.disabled ? percentFromFraction(bWk.remainingFraction) : null;
        const known = [p5h, pWk].filter((p): p is number => p !== null);
        const p = known.length ? Math.min(...known) : null;
        const r5h = b5h?.resetTime ? this.formatResetCompact(b5h.resetTime) : '';
        const rWk = bWk?.resetTime ? this.formatResetCompact(bWk.resetTime) : '';

        let detailCell: string;
        if (p5h !== null && pWk !== null && p5h < 100) {
          detailCell = `5h: ${renderHoverPct(p5h, true, isLight, activeNeedsReauth)}${r5h ? ` *(${r5h})*` : ''} &nbsp;·&nbsp; 7d: ${renderHoverPct(pWk, true, isLight, activeNeedsReauth)}${rWk && pWk < 100 ? ` *(${rWk})*` : ''}`;
        } else {
          const r =
            p5h !== null && (pWk === null || p5h < pWk)
              ? r5h || rWk
              : rWk || r5h;
          const statusNote =
            p === null
              ? 'Usage unavailable'
              : p === 0
                ? `<span style="color:${pal.crimson};">**Depleted**</span>`
                : 'Active reserve';
          detailCell = `${statusNote}${r && p !== null && p < 100 ? ` &nbsp;·&nbsp; resets in **${r}**` : ''}`;
        }

        const row = [
          this.padTableCell('**Claude & GPT** *(Opus, Sonnet)*'),
          this.padTableCell(renderHoverGaugeCell(p, true, isLight, activeNeedsReauth)),
          this.padTableCell(detailCell)
        ];
        md.appendMarkdown(`| ${row.join(' | ')} |\n`);
      } else {
        const row = [
          this.padTableCell('**Claude & GPT** *(Opus, Sonnet)*'),
          this.padTableCell(
            planBadge === 'FREE' ? '`--`' : renderHoverGaugeCell(null, true, isLight, activeNeedsReauth)
          ),
          this.padTableCell(
            planBadge === 'FREE' ? 'Not included in Free tier' : 'Usage unavailable'
          )
        ];
        md.appendMarkdown(`| ${row.join(' | ')} |\n`);
      }

      if (planBadge === 'PRO' && argonGroup) {
        const b = argonGroup.buckets[0];
        const p = b && !b.disabled ? percentFromFraction(b.remainingFraction) : null;
        const r = b?.resetTime ? this.formatResetCompact(b.resetTime) : '';
        const statusNote =
          p === null
            ? 'Usage unavailable'
            : p === 0
              ? `<span style="color:${pal.crimson};">**Depleted**</span>`
              : 'Pro allowance';

        const row = [
          this.padTableCell('**Argon** *(Gemini 4 Argon)*'),
          this.padTableCell(renderHoverGaugeCell(p, true, isLight, activeNeedsReauth)),
          this.padTableCell(
            `${statusNote}${r && p !== null && p < 100 ? ` &nbsp;·&nbsp; resets in **${r}**` : ''}`
          )
        ];
        md.appendMarkdown(`| ${row.join(' | ')} |\n`);
      } else if (planBadge === 'ULTRA') {
        const row = [
          this.padTableCell('**Argon & Carbon** *(Gemini 4)*'),
          this.padTableCell(renderHoverPill('Included', 'plan', isLight)),
          this.padTableCell('Bundled inside Gemini pool &nbsp;·&nbsp; Ultra tier')
        ];
        md.appendMarkdown(`| ${row.join(' | ')} |\n`);
      } else {
        const row = [
          this.padTableCell('**Argon** *(Gemini 4 Argon)*'),
          this.padTableCell('`--`'),
          this.padTableCell('Not included in Free tier')
        ];
        md.appendMarkdown(`| ${row.join(' | ')} |\n`);
      }

      // Smart auto-adaptive Carbon row: if Google provisions an independent Carbon quota group on Pro/Ultra
      if (carbonGroup && planBadge !== 'FREE') {
        const b5h = carbonGroup.buckets.find((b) => b.window === '5h');
        const bWk =
          carbonGroup.buckets.find((b) => b.window === 'weekly') ||
          carbonGroup.buckets[0];
        const p5 = b5h && !b5h.disabled ? percentFromFraction(b5h.remainingFraction) : null;
        const pW = bWk && !bWk.disabled ? percentFromFraction(bWk.remainingFraction) : null;
        const known = [p5, pW].filter((x): x is number => x !== null);
        const p = known.length ? Math.min(...known) : null;
        const r =
          p5 !== null && (pW === null || p5 < pW)
            ? b5h?.resetTime
              ? this.formatResetCompact(b5h.resetTime)
              : ''
            : bWk?.resetTime
              ? this.formatResetCompact(bWk.resetTime)
              : '';
        if (p !== null) {
          const statusNote =
            p === 0
              ? `<span style="color:${pal.crimson};">**Depleted**</span>`
              : `${planBadge === 'ULTRA' ? 'Ultra' : 'Pro'} allowance`;
          const row = [
            this.padTableCell('**Carbon** *(Gemini 4 Carbon)*'),
            this.padTableCell(renderHoverGaugeCell(p, true, isLight, activeNeedsReauth)),
            this.padTableCell(
              `${statusNote}${r && p < 100 ? ` &nbsp;·&nbsp; resets in **${r}**` : ''}`
            )
          ];
          md.appendMarkdown(`| ${row.join(' | ')} |\n`);
        }
      }
      md.appendMarkdown(`\n`);
    } else if (activeProfile?.cachedQuota) {
      const cq = activeProfile.cachedQuota;
      const g5h = percentFromText(cq.gemini5h || cq.gemini);
      const gWk = percentFromText(cq.gemini7d || cq.gemini);
      const gMin = percentFromText(cq.gemini);
      const r5h = cq.gemini5hReset ? this.formatResetCompact(cq.gemini5hReset) : '';
      const rWk = (cq.gemini7dReset || cq.geminiReset)
        ? this.formatResetCompact(cq.gemini7dReset || cq.geminiReset)
        : '';

      const heroHeaders = [
        this.padTableCell('Model Pool'),
        this.padTableCell('Gauge'),
        this.padTableCell('Capacity & Reset Window')
      ];
      md.appendMarkdown(`| ${heroHeaders.join(' | ')} |\n`);
      md.appendMarkdown(`|:---|:---:|:---|\n`);

      const geminiSub =
        planBadge === 'ULTRA' ? '*(Flash, Pro, Carbon)*' : '*(Flash, Pro)*';
      const gParts = [
        `5h: ${renderHoverPct(g5h, true, isLight, activeNeedsReauth)}${r5h && g5h !== null && g5h < 100 ? ` *(${r5h})*` : ''}`,
        `7d: ${renderHoverPct(gWk, true, isLight, activeNeedsReauth)}${rWk && gWk !== null && gWk < 100 ? ` *(${rWk})*` : ''}`
      ];
      md.appendMarkdown(
        `| ${this.padTableCell(`**Gemini** ${geminiSub}`)} | ${this.padTableCell(renderHoverGaugeCell(gMin, true, isLight, activeNeedsReauth))} | ${this.padTableCell(gParts.join(' &nbsp;·&nbsp; '))} |\n`
      );

      if (planBadge !== 'FREE') {
        const cPct = percentFromText(cq.claudeGpt);
        const cRst = (cq.claude7dReset || cq.claudeReset)
          ? this.formatResetCompact(cq.claude7dReset || cq.claudeReset)
          : '';
        const cNote =
          cPct === null
            ? 'Usage unavailable'
            : cPct === 0
              ? `<span style="color:${pal.crimson};">**Depleted**</span>`
              : 'Active reserve';
        md.appendMarkdown(
          `| ${this.padTableCell('**Claude & GPT** *(Opus, Sonnet)*')} | ${this.padTableCell(renderHoverGaugeCell(cPct, true, isLight, activeNeedsReauth))} | ${this.padTableCell(`${cNote}${cRst && cPct !== null && cPct < 100 ? ` &nbsp;·&nbsp; resets in **${cRst}**` : ''}`)} |\n`
        );
      } else {
        md.appendMarkdown(
          `| ${this.padTableCell('**Claude & GPT** *(Opus, Sonnet)*')} | ${this.padTableCell('`--`')} | ${this.padTableCell('Not included in Free tier')} |\n`
        );
      }

      if (planBadge === 'PRO') {
        const aPct = percentFromText(cq.argon);
        const aRst = cq.argonReset ? this.formatResetCompact(cq.argonReset) : '';
        const aNote =
          aPct === null
            ? 'Usage unavailable'
            : aPct === 0
              ? `<span style="color:${pal.crimson};">**Depleted**</span>`
              : 'Pro allowance';
        md.appendMarkdown(
          `| ${this.padTableCell('**Argon** *(Gemini 4 Argon)*')} | ${this.padTableCell(renderHoverGaugeCell(aPct, true, isLight, activeNeedsReauth))} | ${this.padTableCell(`${aNote}${aRst && aPct !== null && aPct < 100 ? ` &nbsp;·&nbsp; resets in **${aRst}**` : ''}`)} |\n`
        );
        const cbPct = percentFromText(cq.carbon);
        if (cbPct !== null) {
          const cbRst = cq.carbonReset ? this.formatResetCompact(cq.carbonReset) : '';
          const cbNote =
            cbPct === 0
              ? `<span style="color:${pal.crimson};">**Depleted**</span>`
              : 'Pro allowance';
          md.appendMarkdown(
            `| ${this.padTableCell('**Carbon** *(Gemini 4 Carbon)*')} | ${this.padTableCell(renderHoverGaugeCell(cbPct, true, isLight, activeNeedsReauth))} | ${this.padTableCell(`${cbNote}${cbRst && cbPct < 100 ? ` &nbsp;·&nbsp; resets in **${cbRst}**` : ''}`)} |\n`
          );
        }
      } else if (planBadge === 'ULTRA') {
        md.appendMarkdown(
          `| ${this.padTableCell('**Argon & Carbon** *(Gemini 4)*')} | ${this.padTableCell(renderHoverPill('Included', 'plan', isLight))} | ${this.padTableCell('Bundled inside Gemini pool &nbsp;·&nbsp; Ultra tier')} |\n`
        );
      } else {
        md.appendMarkdown(
          `| ${this.padTableCell('**Argon** *(Gemini 4 Argon)*')} | ${this.padTableCell('`--`')} | ${this.padTableCell('Not included in Free tier')} |\n`
        );
      }
      md.appendMarkdown(`\n`);
    }

    // 2. Multi-Profile Rotation Matrix
    const showMatrix =
      profiles.length > 0 || isUnsavedActive;

    if (showMatrix) {
      md.appendMarkdown(`---\n\n`);

      const showClaudeColumn = Boolean(
        effectiveLiveQuota?.groups?.some(
          (g) =>
            g.displayName.toLowerCase().includes('claude') ||
            g.displayName.toLowerCase().includes('gpt')
        ) ||
          profiles.some(
            (p) =>
              p.cachedQuota?.claudeGpt &&
              p.cachedQuota.claudeGpt !== '--' &&
              p.cachedQuota.claudeGpt !== '—'
          )
      );

      const liveMetrics = effectiveLiveQuota
        ? this.parseMetrics(effectiveLiveQuota, activeProfile?.planOverride)
        : null;

      const headers = [
        this.padTableCell(''),
        this.padTableCell('Profile'),
        this.padTableCell('Plan'),
        this.padTableCell('Gemini')
      ];
      const separators = [':---:', ':---', ':---:', ':---:'];

      if (showClaudeColumn) {
        headers.push(this.padTableCell('Claude'));
        separators.push(':---:');
      }

      headers.push(this.padTableCell('Argon'));
      separators.push(':---:');

      headers.push(this.padTableCell('Carbon'));
      separators.push(':---:');

      headers.push(this.padTableCell('Snap'));
      separators.push(':---:');

      md.appendMarkdown(`| ${headers.join(' | ')} |\n`);
      md.appendMarkdown(`|${separators.join('|')}|\n`);

      // If an unsaved account is currently active, pin it as row 0 in the matrix
      if (isUnsavedActive && liveEmail) {
        const uPlan = liveMetrics?.plan && liveMetrics.plan !== '--' ? liveMetrics.plan : 'FREE';
        const uGemini = this.sanitizeMetric(liveMetrics?.gemini);
        const uClaude = this.sanitizeMetric(liveMetrics?.claudeGpt);
        const uArgon = this.sanitizeMetric(liveMetrics?.argon);
        const uCarbon = this.sanitizeMetric(liveMetrics?.carbon);

        const safeSaveTitle = `Save ${(liveEmail || '').replace(/"/g, '\\"')} to vault`;
        const uCells = [
          this.padTableCell(`<span style="color:${pal.warnFg};">$(sparkle)</span>`),
          this.padTableCell(
            `**${safeDisplayName}** &nbsp;${activeNeedsReauth ? reauthPills : activeNeedsVerify ? `${verifyPill} &nbsp;${renderHoverPill('UNSAVED', 'warn', isLight)}` : renderHoverPill('UNSAVED', 'warn', isLight)} · [Save](command:charlier.saveProfile "${safeSaveTitle}")`
          ),
          this.padTableCell(renderHoverPill(uPlan, 'plan', isLight)),
          this.padTableCell(renderHoverPct(uGemini, true, isLight, activeNeedsReauth || activeNeedsVerify))
        ];
        if (showClaudeColumn) {
          uCells.push(
            this.padTableCell(renderHoverPct(uClaude, true, isLight, activeNeedsReauth || activeNeedsVerify))
          );
        }
        uCells.push(this.padTableCell(renderHoverPct(uArgon, true, isLight, activeNeedsReauth || activeNeedsVerify)));
        uCells.push(this.padTableCell(renderHoverPct(uCarbon, true, isLight, activeNeedsReauth || activeNeedsVerify)));
        uCells.push(
          this.padTableCell(
            activeNeedsReauth
              ? `<span style="color:${pal.crimson};">*stale*</span>`
              : activeNeedsVerify
                ? `<span style="color:${pal.amber};">*verify needed*</span>`
                : '*live*'
          )
        );
        md.appendMarkdown(`| ${uCells.join(' | ')} |\n`);
      }

      const sortedProfiles = sortProfilesForDisplay(
        profiles,
        activeProfileId,
        claimedSet,
        liveEmail
      );

      const activePools = resolveAntigravityPrimaryPools(
        activeProfile,
        liveMetrics,
        effectiveLiveQuota,
        liveEmail
      );
      const bestStandby: BestStandbyRecommendation | null = resolveBestStandbyProfile({
        provider: 'antigravity',
        profiles,
        activeProfileId,
        activeMinPct: activePools.avgPct,
        activeNeedsAction:
          activeNeedsReauth || activeNeedsVerify || (!activeProfile && !liveEmail),
        activePrimaryPools: { gemini: activePools.gPct, claude: activePools.cPct },
        claimedProfileIds: claimedSet
      });

      const maxHoverDisplay = isUnsavedActive ? 3 : 4;
      const displayProfiles = sortedProfiles.slice(0, maxHoverDisplay);
      const hiddenProfiles = sortedProfiles.slice(maxHoverDisplay);
      const overflowCount = hiddenProfiles.length;
      const hiddenClaimedCount = hiddenProfiles.filter((p) =>
        claimedSet.has(p.id)
      ).length;

      for (const p of displayProfiles) {
        const isActive =
          (liveEmail && p.email.toLowerCase() === liveEmail.toLowerCase()) ||
          (!liveEmail && p.id === activeProfileId);
        const isClaimed = claimedSet.has(p.id);
        const isNextUp = Boolean(bestStandby && bestStandby.profile.id === p.id);

        const marker = isActive
          ? `<span style="color:${pal.accent};">$(check)</span>`
          : isClaimed
            ? `<span style="color:${pal.warnFg};">$(terminal)</span>`
            : isNextUp
              ? `<span style="color:${pal.emerald};">$(zap)</span>`
              : '&nbsp;';
        const switchUri = `command:charlier.switchProfileDirect?${encodeURIComponent(
          JSON.stringify(p.id)
        )}`;
        const linkTitle = p.email
          ? isClaimed
            ? `CLI claimed (${p.email.replace(/"/g, '\\"')}) - Click to focus terminal or switch IDE`
            : `Switch to ${p.email.replace(/"/g, '\\"')}`
          : '';
        const safeName = this.escapeMarkdownLabel(p.name);
        const pNeedsReauth =
          p.authStatus === 'revoked' ||
          p.authStatus === 'expired' ||
          (isActive && activeNeedsReauth);
        const pNeedsVerify =
          !pNeedsReauth &&
          (p.authStatus === 'unverified' || (isActive && activeNeedsVerify));
        const cliPill = isClaimed ? ` &nbsp;${renderHoverPill('CLI', 'warn', isLight)}` : '';
        const nextPill = isNextUp ? ` &nbsp;${renderHoverPill('NEXT', 'active', isLight)}` : '';
        const statusPillSuffix = pNeedsReauth
          ? ` &nbsp;${reauthPills}${cliPill}`
          : pNeedsVerify
            ? ` &nbsp;${verifyPill}${cliPill}`
            : `${cliPill}${nextPill}`;
        const linkedName = isActive
          ? `**${safeName}** &nbsp;${pNeedsReauth ? reauthPills : pNeedsVerify ? verifyPill : renderHoverPill('ACTIVE', 'active', isLight)}${cliPill}`
          : `[${safeName}](${switchUri} "${linkTitle}")${statusPillSuffix}`;

        const rawMetrics =
          isActive && liveMetrics
            ? liveMetrics
            : p.cachedQuota || {
                plan: p.planOverride || 'FREE',
                gemini: '--',
                claudeGpt: '--',
                argon: '--',
                updatedAt: 0
              };

        const sPlan = String(p.planOverride || this.sanitizeMetric(rawMetrics.plan) || 'FREE').toUpperCase();
        const sGemini = this.sanitizeMetric(rawMetrics.gemini);
        const rawClaude = this.sanitizeMetric(rawMetrics.claudeGpt);
        const sClaude = sPlan === 'FREE' ? '--' : rawClaude;
        const rawArgon = this.sanitizeMetric(rawMetrics.argon);
        const sArgon =
          sPlan === 'FREE'
            ? '--'
            : sPlan === 'ULTRA'
              ? 'incl.'
              : rawArgon !== '--'
                ? rawArgon
                : '--';
        const rawCarbon = this.sanitizeMetric(rawMetrics.carbon);
        const sCarbon =
          sPlan === 'FREE'
            ? '--'
            : sPlan === 'ULTRA' && rawCarbon === '--'
              ? 'incl.'
              : rawCarbon;
        const snapText = pNeedsReauth
          ? `<span style="color:${pal.crimson};">*${rawMetrics.updatedAt ? `stale · ${this.formatTimeAgo(rawMetrics.updatedAt)}` : 'stale'}*</span>`
          : pNeedsVerify
            ? `<span style="color:${pal.amber};">*verify needed*</span>`
            : isActive
              ? `<span style="color:${pal.emerald};">*live*</span>`
              : rawMetrics.updatedAt
                ? `*${this.formatTimeAgo(rawMetrics.updatedAt)}*`
                : '*--*';

        const planText = renderHoverPill(sPlan, 'plan', isLight);
        const rowMuted = pNeedsReauth || pNeedsVerify;
        const geminiText = renderHoverPct(sGemini, isActive, isLight, rowMuted);
        const claudeText = renderHoverPct(sClaude, isActive, isLight, rowMuted);
        const argonText = renderHoverPct(sArgon, isActive, isLight, rowMuted);
        const carbonText = renderHoverPct(sCarbon, isActive, isLight, rowMuted);

        const cells = [
          this.padTableCell(marker),
          this.padTableCell(linkedName),
          this.padTableCell(planText),
          this.padTableCell(geminiText)
        ];

        if (showClaudeColumn) {
          cells.push(this.padTableCell(claudeText));
        }

        cells.push(this.padTableCell(argonText));
        cells.push(this.padTableCell(carbonText));
        cells.push(this.padTableCell(snapText));

        md.appendMarkdown(`| ${cells.join(' | ')} |\n`);
      }

      if (bestStandby) {
        const bestName = this.escapeMarkdownLabel(bestStandby.profile.name);
        const bestArg = encodeURIComponent(JSON.stringify(bestStandby.profile.id));
        md.appendMarkdown(
          `\n<span style="color:${pal.emerald};">$(zap)</span> **Best Standby:** [${bestName}](command:charlier.switchProfileDirect?${bestArg} "Switch Antigravity immediately to ${bestStandby.profile.name.replace(/"/g, '\\"')} (${bestStandby.scorePct}%)") &nbsp;*(${bestStandby.scorePct}% headroom)*\n`
        );
      }

      if (overflowCount > 0) {
        const claimedNote =
          hiddenClaimedCount > 0 ? ` (${hiddenClaimedCount} CLI claimed)` : '';
        md.appendMarkdown(
          `\n*+ ${overflowCount} more account${
            overflowCount > 1 ? 's' : ''
          }${claimedNote} in Cockpit* &nbsp;·&nbsp; [Open Cockpit](command:charlier.openCockpit) &nbsp;·&nbsp; [View all in menu](command:charlier.switchProfile)\n`
        );
      }
    }

    // 3. Footer Links with Provider Switcheroo at the extreme right of Add Account
    md.appendMarkdown(`\n---\n\n`);
    const nbsp = (t: string): string => t.replace(/ /g, '&nbsp;');
    md.appendMarkdown(
      `[$(layout-sidebar-left) ${nbsp('Cockpit')}](command:charlier.openCockpit "Open Charlier Sidebar Cockpit") &nbsp;·&nbsp; ` +
        `[$(arrow-swap) ${nbsp('Switch')}](command:charlier.switchProfile "Open QuickPick switcher") &nbsp;·&nbsp; ` +
        `[$(sync) ${nbsp('Refresh')}](command:charlier.refreshQuota "Refresh all Antigravity accounts") &nbsp;·&nbsp; ` +
        `[$(add) ${nbsp('Add Account')}](command:charlier.addAccount "Add another Antigravity account") &nbsp;&nbsp;│&nbsp;&nbsp; ` +
        `[◀](command:charlier.switchProvider "Flip deck to OpenAI Codex") <span style="color:${pal.accent};">$(charlier-antigravity-star)&nbsp;**Antigravity**</span> &nbsp;·&nbsp; [$(charlier-codex-prompt)&nbsp;${nbsp('Codex')}&nbsp;▶](command:charlier.switchProvider "Flip deck to OpenAI Codex (view only - does not restart extensions)")\n`
    );

    return md;
  }
}
