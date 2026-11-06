import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getDaemonSearchDirs } from './constants';
import {
  QuotaSummary,
  QuotaGroup,
  CachedQuotaMetric,
  ProfileMetadata,
  UserPlanTier
} from './types';
import { Vault } from './vault';

interface DaemonInfo {
  pid?: number;
  httpPort: number;
  csrfToken: string;
}

const OAUTH_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const CLOUDCODE_HOST = 'daily-cloudcode-pa.googleapis.com';

export class QuotaService {
  private cachedSummary: QuotaSummary | null = null;
  private cacheTtlMs = 15000;
  private inFlightPromise: Promise<QuotaSummary | null> | null = null;
  private inactiveRefreshInFlight = new Map<string, Promise<CachedQuotaMetric | null>>();
  private lastInactiveRefreshTime = new Map<string, number>();

  public invalidate(): void {
    this.cachedSummary = null;
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

    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = this.fetchFromDaemon(forceRefresh)
      .then((summary) => {
        if (summary) {
          this.cachedSummary = summary;
        }
        return summary || this.cachedSummary;
      })
      .catch((err) => {
        console.warn('[Charlier] Could not query Antigravity daemon:', err);
        return this.cachedSummary;
      })
      .finally(() => {
        this.inFlightPromise = null;
      });

    return this.inFlightPromise;
  }

  private findActiveDaemon(): DaemonInfo | null {
    const dirs = getDaemonSearchDirs();
    const candidates: Array<{
      mtime: number;
      pid?: number;
      httpPort: number;
      csrfToken: string;
    }> = [];

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

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);

    for (const cand of candidates) {
      if (!cand.pid) return cand;
      try {
        process.kill(cand.pid, 0);
        return cand;
      } catch {}
    }

    return null;
  }

  private queryDaemonRpc<T>(
    daemon: DaemonInfo,
    rpcPath: string,
    payload: any
  ): Promise<T | null> {
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
          timeout: 2500
        },
        (res) => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }

          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const full = Buffer.concat(chunks);
            let offset = 0;
            let rawJson = '';

            if (full.length > 0 && full[0] === 0x7b) {
              rawJson = full.toString('utf8');
            } else {
              while (offset + 5 <= full.length) {
                const flags = full.readUInt8(offset);
                const len = full.readUInt32BE(offset + 1);
                offset += 5;
                const data = full.subarray(offset, offset + len);
                offset += len;
                if (flags === 0) {
                  rawJson = data.toString('utf8');
                }
              }
            }

            if (!rawJson) {
              resolve(null);
              return;
            }

            try {
              resolve(JSON.parse(rawJson));
            } catch {
              resolve(null);
            }
          });
        }
      );

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      req.write(frame);
      req.end();
    });
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

  private async fetchFromDaemon(forceRefresh: boolean): Promise<QuotaSummary | null> {
    const daemon = this.findActiveDaemon();
    if (!daemon) return null;

    const [statusRes, quotaRes] = await Promise.all([
      this.queryDaemonRpc<any>(
        daemon,
        '/exa.language_server_pb.LanguageServerService/GetUserStatus',
        {}
      ),
      this.queryDaemonRpc<any>(
        daemon,
        '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
        { force_refresh: forceRefresh }
      )
    ]);

    if (!quotaRes && !statusRes) return null;

    const groups: QuotaGroup[] = quotaRes?.response?.groups || [];
    const hasArgonGroup = groups.some(
      (g) =>
        (g.displayName && g.displayName.toLowerCase().includes('argon')) ||
        (g.description && g.description.toLowerCase().includes('argon'))
    );

    const planInfo = statusRes?.userStatus?.planStatus?.planInfo;
    const userTier = statusRes?.userStatus?.userTier;
    const userEmail = (statusRes?.userStatus?.email || '').trim();

    const planTier = this.resolvePlanTier(userTier, planInfo, hasArgonGroup);

    const tier: QuotaSummary['tier'] =
      planTier === 'ULTRA'
        ? 'Ultra Plan'
        : planTier === 'PRO'
          ? 'Pro Plan'
          : planTier === 'ENTERPRISE'
            ? 'Enterprise'
            : 'Free Tier';

    return {
      email: userEmail,
      tier,
      planTier,
      groups,
      hasArgonGroup,
      fetchedAt: Date.now()
    };
  }

  private mintAccessTokenFromRefresh(
    refreshToken: string
  ): Promise<{ access_token: string; expires_in: number } | null> {
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
            if (res.statusCode !== 200) {
              resolve(null);
              return;
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed?.access_token) {
                resolve({
                  access_token: String(parsed.access_token),
                  expires_in: Number(parsed.expires_in) || 3599
                });
              } else {
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          });
        }
      );

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
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
      const refreshToken = vault.getProfileRefreshToken(profile.id);
      if (!refreshToken) return profile.cachedQuota || null;

      const tokenRes = await this.mintAccessTokenFromRefresh(refreshToken);
      if (!tokenRes) return profile.cachedQuota || null;

      // Persist fresh access token inside the inactive profile's vault folder only
      vault.updateInactiveProfileToken(profile.id, tokenRes.access_token, tokenRes.expires_in);

      const [loadRes, licensesRes, modelsRes, quotaRes] = await Promise.all([
        this.postCloudCodeJson<any>(tokenRes.access_token, '/v1internal:loadCodeAssist', {}),
        this.getAICodeJson<any>(tokenRes.access_token, '/v1alpha:fetchLicenses'),
        this.postCloudCodeJson<any>(tokenRes.access_token, '/v1internal:fetchAvailableModels', {}),
        this.postCloudCodeJson<any>(
          tokenRes.access_token,
          '/v1internal:retrieveUserQuotaSummary',
          {}
        )
      ]);

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
            if (k.toLowerCase().includes('gemini') && v?.quotaInfo) {
              foundQuota = v.quotaInfo;
              break;
            }
          }
        }
        if (foundQuota && typeof foundQuota.remainingFraction === 'number') {
          const pct = Math.round(
            Math.max(0, Math.min(1, foundQuota.remainingFraction)) * 100
          );
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

      // 2. Extract Claude & GPT 5h + 7d pools from retrieveUserQuotaSummary
      let claude5h = profile.cachedQuota?.claude5h || '--';
      let claude5hReset = profile.cachedQuota?.claude5hReset;
      let claude7d = profile.cachedQuota?.claude7d || profile.cachedQuota?.claudeGpt || '--';
      let claude7dReset = profile.cachedQuota?.claude7dReset || profile.cachedQuota?.claudeReset;
      let claudeGpt = claude7d;
      let claudeReset = claude7dReset;

      if (planTier === 'FREE') {
        claude5h = '--';
        claude5hReset = undefined;
        claude7d = '--';
        claude7dReset = undefined;
        claudeGpt = '--';
        claudeReset = undefined;
      } else if (quotaRes.status === 200 && Array.isArray(quotaRes.data?.groups)) {
        for (const g of quotaRes.data.groups) {
          const gName = String(g.displayName || '').toLowerCase();
          if (gName.includes('claude') || gName.includes('gpt')) {
            const buckets: any[] = g.buckets || [];
            const bWk = buckets.find((x: any) => x.window === 'weekly') || buckets[0];
            const b5h = buckets.find((x: any) => x.window === '5h');

            if (bWk) {
              const fracWk =
                typeof bWk.remainingFraction === 'number' ? bWk.remainingFraction : 0;
              claude7d = `${Math.round(Math.max(0, Math.min(1, fracWk)) * 100)}%`;
              claude7dReset = bWk.resetTime ? String(bWk.resetTime) : undefined;
              claudeGpt = claude7d;
              claudeReset = claude7dReset;
            }

            if (b5h) {
              if (b5h.disabled) {
                claude5h = claude7d !== '--' ? claude7d : '100%';
                claude5hReset = undefined;
              } else {
                const frac5h =
                  typeof b5h.remainingFraction === 'number' ? b5h.remainingFraction : 0;
                claude5h = `${Math.round(Math.max(0, Math.min(1, frac5h)) * 100)}%`;
                claude5hReset = b5h.resetTime ? String(b5h.resetTime) : undefined;
              }
            } else if (claude7d !== '--') {
              claude5h = claude7d;
            }
          }
        }
      }

      // 3. Resolve Argon representation & auto-heal expired weekly reset
      let argon = '--';
      let argonReset = profile.cachedQuota?.argonReset;
      if (planTier === 'ULTRA') {
        argon = 'incl.';
        argonReset = undefined;
      } else if (planTier === 'PRO') {
        if (this.isResetExpired(argonReset)) {
          argon = '100%';
          argonReset = undefined;
        } else {
          const prevArgon = profile.cachedQuota?.argon;
          argon = prevArgon && prevArgon !== 'incl.' ? prevArgon : '--';
        }
      } else {
        argonReset = undefined;
      }

      const metric: CachedQuotaMetric = {
        plan: planTier,
        gemini,
        claudeGpt,
        argon,
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
        updatedAt: Date.now()
      };

      vault.updateProfileCachedQuota(profile.id, metric);
      this.lastInactiveRefreshTime.set(profile.id, Date.now());
      return metric;
    })().finally(() => {
      this.inactiveRefreshInFlight.delete(profile.id);
    });

    this.inactiveRefreshInFlight.set(profile.id, task);
    return task;
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
    if (!val || val === '—' || val === 'â€”' || val === '--' || val === '-') return '--';
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

    for (const group of quota.groups) {
      const name = group.displayName.toLowerCase();
      if (name.includes('argon')) {
        const b = group.buckets[0];
        if (b) {
          const frac = b.remainingFraction ?? 0;
          const pct = Math.round(frac * 100);
          argon = plan === 'FREE' ? '--' : `${pct}%`;
          if (b.resetTime) argonReset = b.resetTime;
        }
      } else if (name.includes('claude') || name.includes('gpt')) {
        const b5h = group.buckets.find((b) => b.window === '5h');
        const weekly =
          group.buckets.find((b) => b.window === 'weekly') || group.buckets[0];
        if (weekly) {
          const frac = weekly.remainingFraction ?? 0;
          const pct = Math.round(frac * 100);
          claude7d = `${pct}%`;
          claudeGpt = claude7d;
          if (weekly.resetTime) {
            claude7dReset = weekly.resetTime;
            claudeReset = weekly.resetTime;
          }
        }
        if (b5h) {
          if (b5h.disabled) {
            claude5h = claude7d || '100%';
          } else {
            const frac5h = b5h.remainingFraction ?? 0;
            claude5h = `${Math.round(frac5h * 100)}%`;
            if (b5h.resetTime) claude5hReset = b5h.resetTime;
          }
        } else if (claude7d) {
          claude5h = claude7d;
        }
      } else if (name.includes('gemini')) {
        const b5h = group.buckets.find((b) => b.window === '5h');
        const bWeekly =
          group.buckets.find((b) => b.window === 'weekly') || group.buckets[0];
        const f5h = b5h?.remainingFraction ?? 1;
        const fWk = bWeekly?.remainingFraction ?? 1;

        if (b5h) {
          gemini5h = `${Math.round(f5h * 100)}%`;
          if (b5h.resetTime) gemini5hReset = b5h.resetTime;
        }
        if (bWeekly) {
          gemini7d = `${Math.round(fWk * 100)}%`;
          if (bWeekly.resetTime) gemini7dReset = bWeekly.resetTime;
        }

        const minFrac = Math.min(f5h, fWk);
        const pct = Math.round(minFrac * 100);
        gemini = `${pct}%`;
        if (f5h < fWk) {
          geminiReset = b5h?.resetTime || bWeekly?.resetTime;
        } else {
          geminiReset = bWeekly?.resetTime || b5h?.resetTime;
        }
      }
    }

    return {
      plan,
      gemini,
      claudeGpt,
      argon,
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
    return parts.join(' · ');
  }

  private padTableCell(content: string): string {
    return `&nbsp;${content}&nbsp;`;
  }

  public buildAccountsHoverTooltip(
    profiles: ProfileMetadata[],
    activeProfileId: string | null,
    liveEmail: string | null,
    liveQuota: QuotaSummary | null
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
        'charlier.saveProfile'
      ]
    };

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
    const planBadge =
      activeProfile?.planOverride ||
      (effectiveLiveQuota
        ? effectiveLiveQuota.planTier
        : activeProfile?.cachedQuota?.plan || 'FREE');

    // 1. Hero Instrument Card
    if (isUnsavedActive) {
      md.appendMarkdown(
        `### Charlier &nbsp;·&nbsp; **${displayName}** &nbsp;\`${planBadge}\` &nbsp;\`ACTIVE · UNSAVED\`\n\n`
      );
      md.appendMarkdown(
        `\`${emailDisplay}\` &nbsp;·&nbsp; **$(sparkle) New Unsaved Session** &nbsp;·&nbsp; [$(save) Save to Vault](command:charlier.saveProfile "Save this active account as a named profile in your vault")\n\n`
      );
    } else if (activeProfile || liveEmail) {
      md.appendMarkdown(
        `### Charlier &nbsp;·&nbsp; **${displayName}** &nbsp;\`${planBadge}\` &nbsp;\`ACTIVE\`\n\n`
      );
      md.appendMarkdown(`\`${emailDisplay}\` &nbsp;·&nbsp; **● Active Session**\n\n`);
    } else {
      md.appendMarkdown(`### Charlier &nbsp;·&nbsp; **Ready for Login**\n\n`);
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

      for (const g of effectiveLiveQuota.groups) {
        const n = g.displayName.toLowerCase();
        if (n.includes('argon')) {
          argonGroup = g;
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
        const f5h = b5h?.remainingFraction ?? 1;
        const fWk = bWk?.remainingFraction ?? 1;
        const minFrac = Math.min(f5h, fWk);
        const meter = this.renderLinenMeter(minFrac, 5);
        const pMin = Math.round(minFrac * 100);
        const p5h = Math.round(f5h * 100);
        const pWk = Math.round(fWk * 100);
        const r5h = b5h?.resetTime ? this.formatResetCompact(b5h.resetTime) : '';
        const rWk = bWk?.resetTime ? this.formatResetCompact(bWk.resetTime) : '';

        const detailParts: string[] = [];
        detailParts.push(`5h: **${p5h}%**${r5h && p5h < 100 ? ` *(${r5h})*` : ''}`);
        detailParts.push(`7d: **${pWk}%**${rWk && pWk < 100 ? ` *(${rWk})*` : ''}`);

        const row = [
          this.padTableCell('**Gemini** *(Flash, Pro)*'),
          this.padTableCell(`\`${meter} ${pMin}%\``),
          this.padTableCell(detailParts.join(' &nbsp;·&nbsp; '))
        ];
        md.appendMarkdown(`| ${row.join(' | ')} |\n`);
      }

      if (claudeGroup && planBadge !== 'FREE') {
        const b =
          claudeGroup.buckets.find((b) => b.window === 'weekly') ||
          claudeGroup.buckets[0];
        const frac = b?.remainingFraction ?? 0;
        const meter = this.renderLinenMeter(frac, 5);
        const p = Math.round(frac * 100);
        const r = b?.resetTime ? this.formatResetCompact(b.resetTime) : '';
        const statusNote = frac === 0 ? '**Depleted**' : 'Active reserve';

        const row = [
          this.padTableCell('**Claude & GPT** *(Opus, Sonnet)*'),
          this.padTableCell(`\`${meter} ${p}%\``),
          this.padTableCell(
            `${statusNote}${r && frac < 1 ? ` &nbsp;·&nbsp; resets in **${r}**` : ''}`
          )
        ];
        md.appendMarkdown(`| ${row.join(' | ')} |\n`);
      }

      if (planBadge === 'PRO' && argonGroup) {
        const b = argonGroup.buckets[0];
        const frac = b?.remainingFraction ?? 0;
        const meter = this.renderLinenMeter(frac, 5);
        const p = Math.round(frac * 100);
        const r = b?.resetTime ? this.formatResetCompact(b.resetTime) : '';
        const statusNote = frac === 0 ? '**Depleted**' : 'Pro allowance';

        const row = [
          this.padTableCell('**Argon** *(Gemini 4 Argon)*'),
          this.padTableCell(`\`${meter} ${p}%\``),
          this.padTableCell(
            `${statusNote}${r && frac < 1 ? ` &nbsp;·&nbsp; resets in **${r}**` : ''}`
          )
        ];
        md.appendMarkdown(`| ${row.join(' | ')} |\n`);
      } else if (planBadge === 'ULTRA') {
        const row = [
          this.padTableCell('**Argon** *(Gemini 4 Argon)*'),
          this.padTableCell('`Included`'),
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
      md.appendMarkdown(`\n`);
    }

    // 2. Multi-Profile Rotation Matrix
    const showMatrix =
      profiles.length > 1 || (profiles.length === 1 && (isUnsavedActive || !activeProfile));

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

      headers.push(this.padTableCell('Snap'));
      separators.push(':---:');

      md.appendMarkdown(`| ${headers.join(' | ')} |\n`);
      md.appendMarkdown(`|${separators.join('|')}|\n`);

      const liveMetrics = effectiveLiveQuota
        ? this.parseMetrics(effectiveLiveQuota, activeProfile?.planOverride)
        : null;

      // If an unsaved account is currently active, pin it as row 0 in the matrix
      if (isUnsavedActive && liveEmail) {
        const uPlan = liveMetrics?.plan && liveMetrics.plan !== '--' ? liveMetrics.plan : 'FREE';
        const uGemini = this.sanitizeMetric(liveMetrics?.gemini);
        const uClaude = this.sanitizeMetric(liveMetrics?.claudeGpt);
        const uArgon = this.sanitizeMetric(liveMetrics?.argon);

        const uCells = [
          this.padTableCell('$(sparkle)'),
          this.padTableCell(
            `**${displayName}** &nbsp;\`UNSAVED\` · [Save](command:charlier.saveProfile "Save ${liveEmail} to vault")`
          ),
          this.padTableCell(`**\`${uPlan}\`**`),
          this.padTableCell(`**${uGemini}**`)
        ];
        if (showClaudeColumn) {
          uCells.push(this.padTableCell(`**${uClaude}**`));
        }
        uCells.push(this.padTableCell(`**${uArgon}**`));
        uCells.push(this.padTableCell('*live*'));
        md.appendMarkdown(`| ${uCells.join(' | ')} |\n`);
      }

      const sortedProfiles = [...profiles].sort((a, b) => {
        const aActive =
          (liveEmail && a.email.toLowerCase() === liveEmail.toLowerCase()) ||
          (!liveEmail && a.id === activeProfileId);
        const bActive =
          (liveEmail && b.email.toLowerCase() === liveEmail.toLowerCase()) ||
          (!liveEmail && b.id === activeProfileId);
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });

      const maxHoverDisplay = isUnsavedActive ? 3 : 4;
      const displayProfiles = sortedProfiles.slice(0, maxHoverDisplay);
      const overflowCount = sortedProfiles.length - displayProfiles.length;

      for (const p of displayProfiles) {
        const isActive =
          (liveEmail && p.email.toLowerCase() === liveEmail.toLowerCase()) ||
          (!liveEmail && p.id === activeProfileId);

        const marker = isActive ? '$(check)' : '&nbsp;';
        const switchUri = `command:charlier.switchProfileDirect?${encodeURIComponent(
          JSON.stringify(p.id)
        )}`;
        const linkTitle = p.email ? `Switch to ${p.email.replace(/"/g, '\\"')}` : '';
        const linkedName = isActive
          ? `**${p.name}** &nbsp;\`ACTIVE\``
          : `[${p.name}](${switchUri} "${linkTitle}")`;

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

        const sPlan = p.planOverride || this.sanitizeMetric(rawMetrics.plan);
        const sGemini = this.sanitizeMetric(rawMetrics.gemini);
        const sClaude = this.sanitizeMetric(rawMetrics.claudeGpt);
        const rawArgon = this.sanitizeMetric(rawMetrics.argon);
        const sArgon =
          sPlan === 'FREE'
            ? '--'
            : sPlan === 'ULTRA'
              ? 'incl.'
              : rawArgon !== '--'
                ? rawArgon
                : 'Pro';
        const snapText = isActive
          ? '*live*'
          : rawMetrics.updatedAt
            ? `*${this.formatTimeAgo(rawMetrics.updatedAt)}*`
            : '*--*';

        const planText = isActive ? `**\`${sPlan}\`**` : `\`${sPlan}\``;
        const geminiText = isActive ? `**${sGemini}**` : sGemini;
        const claudeText = isActive ? `**${sClaude}**` : sClaude;
        const argonText = isActive ? `**${sArgon}**` : sArgon;

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
        cells.push(this.padTableCell(snapText));

        md.appendMarkdown(`| ${cells.join(' | ')} |\n`);
      }

      if (overflowCount > 0) {
        md.appendMarkdown(
          `\n*+ ${overflowCount} more account${
            overflowCount > 1 ? 's' : ''
          } in vault* &nbsp;·&nbsp; [View all in menu](command:charlier.switchProfile)\n`
        );
      }
    }

    // 3. Footer Links
    md.appendMarkdown(`\n---\n\n`);
    if (isUnsavedActive) {
      md.appendMarkdown(
        `[$(save) Save active profile](command:charlier.saveProfile) · [Manage profiles](command:charlier.switchProfile) · [Refresh limits](command:charlier.refreshQuota) · [+ Add account](command:charlier.addAccount)\n`
      );
    } else {
      md.appendMarkdown(
        `[Manage profiles](command:charlier.switchProfile) · [Refresh limits](command:charlier.refreshQuota) · [+ Add account](command:charlier.addAccount)\n`
      );
    }

    return md;
  }
}
