import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getDaemonSearchDirs } from './constants';
import { QuotaSummary, QuotaGroup, QuotaBucket } from './types';

interface DaemonInfo {
  pid?: number;
  httpPort: number;
  csrfToken: string;
}

export class QuotaService {
  private cachedSummary: QuotaSummary | null = null;
  private cacheTtlMs = 15000;
  private inFlightPromise: Promise<QuotaSummary | null> | null = null;

  public invalidate(): void {
    this.cachedSummary = null;
  }

  public async getQuotaSummary(forceRefresh = false): Promise<QuotaSummary | null> {
    const now = Date.now();
    if (!forceRefresh && this.cachedSummary && now - this.cachedSummary.fetchedAt < this.cacheTtlMs) {
      return this.cachedSummary;
    }

    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = this.fetchFromDaemon(forceRefresh)
      .then((summary) => {
        this.cachedSummary = summary;
        return summary;
      })
      .catch((err) => {
        console.warn('[Charlier] Could not fetch quota from Antigravity daemon:', err);
        return this.cachedSummary;
      })
      .finally(() => {
        this.inFlightPromise = null;
      });

    return this.inFlightPromise;
  }

  private findActiveDaemon(): DaemonInfo | null {
    const dirs = getDaemonSearchDirs();
    const candidates: Array<{ mtime: number; pid?: number; httpPort: number; csrfToken: string }> = [];

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

    if (candidates.length === 0) {
      return null;
    }

    // Sort newest first
    candidates.sort((a, b) => b.mtime - a.mtime);

    // Prefer alive process
    for (const cand of candidates) {
      if (cand.pid) {
        try {
          process.kill(cand.pid, 0);
          return cand;
        } catch {}
      }
    }

    return candidates[0];
  }

  private async fetchFromDaemon(forceRefresh: boolean): Promise<QuotaSummary | null> {
    const daemon = this.findActiveDaemon();
    if (!daemon) {
      return null;
    }

    const jsonPayload = JSON.stringify({ force_refresh: forceRefresh });
    const payloadBuf = Buffer.from(jsonPayload, 'utf8');
    const frame = Buffer.alloc(5 + payloadBuf.length);
    frame.writeUInt8(0, 0); // 0 = gRPC-web data frame
    frame.writeUInt32BE(payloadBuf.length, 1);
    payloadBuf.copy(frame, 5);

    return new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: daemon.httpPort,
        path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
        method: 'POST',
        headers: {
          'Content-Type': 'application/grpc-web+json',
          'X-Grpc-Web': '1',
          'x-codeium-csrf-token': daemon.csrfToken,
          'Content-Length': frame.length
        },
        timeout: 2500
      }, (res) => {
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

          if (!rawJson) {
            resolve(null);
            return;
          }

          try {
            const parsed = JSON.parse(rawJson);
            const groups: QuotaGroup[] = parsed.response?.groups || [];
            const hasArgonGroup = groups.some(
              (g) =>
                (g.displayName && g.displayName.toLowerCase().includes('argon')) ||
                (g.description && g.description.toLowerCase().includes('argon'))
            );

            const tier: QuotaSummary['tier'] = groups.length === 0
              ? 'Standard'
              : hasArgonGroup
              ? 'Pro Plan'
              : 'Ultra Plan';

            resolve({
              tier,
              groups,
              hasArgonGroup,
              fetchedAt: Date.now()
            });
          } catch {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      req.write(frame);
      req.end();
    });
  }

  public renderProgressBar(fraction: number, length = 10): string {
    const clamped = Math.max(0, Math.min(1, fraction));
    const filled = Math.round(clamped * length);
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  public formatResetTime(isoStr?: string): string {
    if (!isoStr) return '';
    const diff = new Date(isoStr).getTime() - Date.now();
    if (diff <= 0) return 'refreshes now';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `resets in ${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return `resets in ${hours}h ${remMins}m`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `resets in ${days}d ${remHours}h`;
  }

  public getQuickSummaryLine(quota: QuotaSummary | null): string {
    if (!quota || quota.groups.length === 0) return '';
    const parts: string[] = [];

    for (const group of quota.groups) {
      const weeklyBucket = group.buckets.find((b) => b.window === 'weekly') || group.buckets[0];
      if (weeklyBucket) {
        const pct = Math.round((weeklyBucket.remainingFraction || 0) * 100);
        const name = group.displayName.includes('Gemini 4 Argon')
          ? 'Argon'
          : group.displayName.includes('Claude')
          ? 'Claude/GPT'
          : 'Gemini';
        parts.push(`${name}: ${pct}%`);
      }
    }

    return parts.join(' | ');
  }

  public buildMarkdownTooltip(
    profileName: string,
    email: string,
    isExpired: boolean,
    quota: QuotaSummary | null
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    md.appendMarkdown(`### Charlier Profile: ${profileName}\n\n`);
    md.appendMarkdown(`• **Account:** \`${email}\`\n`);
    md.appendMarkdown(`• **Status:** ${isExpired ? '⚠️ Token Expired' : '✅ Active'}\n`);

    if (quota && quota.groups.length > 0) {
      md.appendMarkdown(`• **Tier:** **${quota.tier}**\n\n`);
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`#### Model Quotas & Limits\n\n`);

      for (const group of quota.groups) {
        const isArgon = group.displayName.toLowerCase().includes('argon');
        const isClaudeGpt = group.displayName.toLowerCase().includes('claude') || group.displayName.toLowerCase().includes('gpt');
        
        let header = `**${group.displayName}**`;
        if (isArgon) {
          header += ` *(Dedicated Pro Weekly)*`;
        } else if (isClaudeGpt) {
          header += ` *(Opus, Sonnet, GPT-OSS)*`;
        } else {
          header += quota.hasArgonGroup ? ` *(Flash, Pro — Argon separate)*` : ` *(Argon included)*`;
        }

        md.appendMarkdown(`${header}\n`);

        for (const bucket of group.buckets) {
          const windowLabel = bucket.window === '5h' ? '5-Hour' : 'Weekly';
          if (bucket.disabled) {
            md.appendMarkdown(`• ${windowLabel}: *(Limit reached / Paused)*\n`);
          } else {
            const fraction = bucket.remainingFraction ?? 0;
            const pct = Math.round(fraction * 100);
            const bar = this.renderProgressBar(fraction, 10);
            const resetStr = this.formatResetTime(bucket.resetTime);
            md.appendMarkdown(`• ${windowLabel}: \`${bar}\` **${pct}%** *(${resetStr})*\n`);
          }
        }
        md.appendMarkdown(`\n`);
      }
    } else {
      md.appendMarkdown(`\n`);
    }

    md.appendMarkdown(`---\n\n*Click to switch or manage profiles*`);
    return md;
  }
}
