import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getDaemonSearchDirs } from './constants';
import { QuotaSummary, QuotaGroup, CachedQuotaMetric, ProfileMetadata } from './types';

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

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);

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
    if (!daemon) return null;

    const jsonPayload = JSON.stringify({ force_refresh: forceRefresh });
    const payloadBuf = Buffer.from(jsonPayload, 'utf8');
    const frame = Buffer.alloc(5 + payloadBuf.length);
    frame.writeUInt8(0, 0);
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

  public formatResetCompact(isoStr?: string, nbsp = false): string {
    if (!isoStr) return '';
    const diff = new Date(isoStr).getTime() - Date.now();
    if (diff <= 0) return 'now';
    const space = nbsp ? '&nbsp;' : ' ';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return `${hours}h${space}${remMins}m`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d${space}${remHours}h`;
  }

  public parseMetrics(quota: QuotaSummary | null, nbsp = false): CachedQuotaMetric {
    if (!quota || !quota.groups || quota.groups.length === 0) {
      return {
        plan: '—',
        gemini: '—',
        claudeGpt: '—',
        argon: '—',
        updatedAt: Date.now()
      };
    }

    const space = nbsp ? '&nbsp;' : ' ';
    const dot = nbsp ? '&nbsp;·&nbsp;' : ' · ';
    const plan = quota.hasArgonGroup ? 'Pro' : 'Ultra';
    let gemini = '—';
    let claudeGpt = '—';
    let argon = quota.hasArgonGroup ? '—' : 'included';

    for (const group of quota.groups) {
      const name = group.displayName.toLowerCase();
      if (name.includes('argon')) {
        const b = group.buckets[0];
        if (b) {
          const pct = Math.round((b.remainingFraction || 0) * 100);
          const r = this.formatResetCompact(b.resetTime, nbsp);
          argon = `${pct}%` + (r ? `${space}(${r})` : '');
        }
      } else if (name.includes('claude') || name.includes('gpt')) {
        const weekly = group.buckets.find((b) => b.window === 'weekly') || group.buckets[0];
        if (weekly) {
          const pct = Math.round((weekly.remainingFraction || 0) * 100);
          const r = this.formatResetCompact(weekly.resetTime, nbsp);
          claudeGpt = `${pct}%` + (r ? `${space}(${r})` : '');
        }
      } else if (name.includes('gemini')) {
        const b5h = group.buckets.find((b) => b.window === '5h');
        const bWeekly = group.buckets.find((b) => b.window === 'weekly');
        const p5h = b5h ? `${Math.round((b5h.remainingFraction || 0) * 100)}%` : null;
        const pWk = bWeekly ? `${Math.round((bWeekly.remainingFraction || 0) * 100)}%` : null;
        if (p5h && pWk) {
          gemini = `${p5h}${space}(5h)${dot}${pWk}${space}(7d)`;
        } else if (pWk) {
          gemini = `${pWk}${space}(7d)`;
        }
      }
    }

    return {
      plan,
      gemini,
      claudeGpt,
      argon,
      updatedAt: Date.now()
    };
  }

  public getQuickSummaryLine(quota: QuotaSummary | null): string {
    const m = this.parseMetrics(quota, false);
    if (m.plan === '—') return '';
    const parts = [`Gemini: ${m.gemini}`, `Claude/GPT: ${m.claudeGpt}`];
    if (m.argon !== 'included' && m.argon !== '—') {
      parts.push(`Argon: ${m.argon}`);
    }
    return parts.join(' | ');
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
        'charlier.addAccount'
      ]
    };

    md.appendMarkdown(`### Antigravity accounts\n\n`);

    if (profiles.length === 0 && !liveEmail) {
      md.appendMarkdown(`*No active account loaded.*\n\n`);
      md.appendMarkdown(`[Sign in to Antigravity](command:charlier.addAccount)`);
      return md;
    }

    // High-contrast clean table matching native VS Code layout
    const headers = [
      this.padTableCell(''),
      this.padTableCell('Profile'),
      this.padTableCell('Plan'),
      this.padTableCell('Gemini'),
      this.padTableCell('Claude/GPT'),
      this.padTableCell('Argon')
    ];
    const separators = [':---:', ':---', ':---:', ':---:', ':---:', ':---:'];

    md.appendMarkdown(`| ${headers.join(' | ')} |\n`);
    md.appendMarkdown(`|${separators.join('|')}|\n`);

    const liveMetrics = this.parseMetrics(liveQuota, true);

    // List all profiles
    for (const p of profiles) {
      const isActive =
        p.id === activeProfileId ||
        (liveEmail && p.email.toLowerCase() === liveEmail.toLowerCase());

      const status = isActive ? '$(check)' : '';
      const switchUri = `command:charlier.switchProfileDirect?${encodeURIComponent(JSON.stringify(p.id))}`;
      const linkTitle = p.email ? p.email.replace(/"/g, '\\"') : '';
      const linkedName = isActive
        ? `[**${p.name}**](${switchUri} "${linkTitle}")`
        : `[${p.name}](${switchUri} "${linkTitle}")`;

      const metrics = isActive ? liveMetrics : p.cachedQuota || { plan: '—', gemini: '—', claudeGpt: '—', argon: '—' };

      const cells = [
        this.padTableCell(status),
        this.padTableCell(linkedName),
        this.padTableCell(metrics.plan),
        this.padTableCell(metrics.gemini),
        this.padTableCell(metrics.claudeGpt),
        this.padTableCell(metrics.argon)
      ];

      md.appendMarkdown(`| ${cells.join(' | ')} |\n`);
    }

    // If live session is not yet saved as a profile
    if (liveEmail && !profiles.some((p) => p.email.toLowerCase() === liveEmail.toLowerCase())) {
      const short = liveEmail.split('@')[0];
      const status = '$(check)';
      const name = `*${short} (unsaved)*`;
      const cells = [
        this.padTableCell(status),
        this.padTableCell(name),
        this.padTableCell(liveMetrics.plan),
        this.padTableCell(liveMetrics.gemini),
        this.padTableCell(liveMetrics.claudeGpt),
        this.padTableCell(liveMetrics.argon)
      ];
      md.appendMarkdown(`| ${cells.join(' | ')} |\n`);
    }

    md.appendMarkdown(`\n---\n\n`);
    md.appendMarkdown(
      `[Manage profiles](command:charlier.switchProfile) · [Refresh limits](command:charlier.refreshQuota) · [+ Add account](command:charlier.addAccount)\n`
    );

    return md;
  }
}
