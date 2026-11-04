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

  public renderLinenMeter(fraction: number, length = 5): string {
    const clamped = Math.max(0, Math.min(1, fraction));
    const filled = Math.round(clamped * length);
    const empty = length - filled;
    return '▓'.repeat(filled) + '░'.repeat(empty);
  }

  public formatResetCompact(isoStr?: string): string {
    if (!isoStr) return '';
    const diff = new Date(isoStr).getTime() - Date.now();
    if (diff <= 0) return 'now';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return `${hours}h ${remMins}m`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d ${remHours}h`;
  }

  public parseMetrics(quota: QuotaSummary | null): CachedQuotaMetric {
    if (!quota || !quota.groups || quota.groups.length === 0) {
      return {
        plan: '—',
        gemini: '—',
        claudeGpt: '—',
        argon: '—',
        updatedAt: Date.now()
      };
    }

    const plan = quota.hasArgonGroup ? 'PRO' : 'ULTRA';
    let gemini = '—';
    let claudeGpt = '—';
    let argon = quota.hasArgonGroup ? '—' : 'incl.';

    for (const group of quota.groups) {
      const name = group.displayName.toLowerCase();
      if (name.includes('argon')) {
        const b = group.buckets[0];
        if (b) {
          const frac = b.remainingFraction ?? 0;
          const pct = Math.round(frac * 100);
          argon = `${this.renderLinenMeter(frac, 5)} ${pct}%`;
        }
      } else if (name.includes('claude') || name.includes('gpt')) {
        const weekly = group.buckets.find((b) => b.window === 'weekly') || group.buckets[0];
        if (weekly) {
          const frac = weekly.remainingFraction ?? 0;
          const pct = Math.round(frac * 100);
          claudeGpt = `${this.renderLinenMeter(frac, 5)} ${pct}%`;
        }
      } else if (name.includes('gemini')) {
        const b5h = group.buckets.find((b) => b.window === '5h');
        const bWeekly = group.buckets.find((b) => b.window === 'weekly') || group.buckets[0];
        const f5h = b5h?.remainingFraction ?? 1;
        const fWk = bWeekly?.remainingFraction ?? 1;
        const minFrac = Math.min(f5h, fWk);
        const pct = Math.round(minFrac * 100);
        gemini = `${this.renderLinenMeter(minFrac, 5)} ${pct}%`;
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
    const m = this.parseMetrics(quota);
    if (m.plan === '—') return '';
    const parts = [`Gemini: ${m.gemini}`, `Claude: ${m.claudeGpt}`];
    if (m.argon !== 'incl.' && m.argon !== '—') {
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
        'charlier.addAccount'
      ]
    };

    const activeProfile = activeProfileId
      ? profiles.find((p) => p.id === activeProfileId)
      : (liveEmail ? profiles.find((p) => p.email.toLowerCase() === liveEmail.toLowerCase()) : null);

    const displayName = activeProfile?.name || (liveEmail ? liveEmail.split('@')[0] : 'Ready for login');
    const emailDisplay = activeProfile?.email || liveEmail || 'No account active';
    const planBadge = liveQuota ? (liveQuota.hasArgonGroup ? 'PRO' : 'ULTRA') : (activeProfile?.cachedQuota?.plan || 'PRO');

    // 1. Hero Instrument Card
    md.appendMarkdown(`### Charlier · **${displayName}** &nbsp;\`${planBadge}\`\n\n`);
    md.appendMarkdown(`\`${emailDisplay}\` &nbsp;·&nbsp; ${liveQuota ? 'Active session' : 'Standby'}\n\n`);

    if (liveQuota && liveQuota.groups && liveQuota.groups.length > 0) {
      let geminiGroup: QuotaGroup | undefined;
      let claudeGroup: QuotaGroup | undefined;
      let argonGroup: QuotaGroup | undefined;

      for (const g of liveQuota.groups) {
        const n = g.displayName.toLowerCase();
        if (n.includes('argon')) {
          argonGroup = g;
        } else if (n.includes('claude') || n.includes('gpt')) {
          claudeGroup = g;
        } else if (n.includes('gemini')) {
          geminiGroup = g;
        }
      }

      // Gemini row
      if (geminiGroup) {
        const b5h = geminiGroup.buckets.find((b) => b.window === '5h');
        const bWk = geminiGroup.buckets.find((b) => b.window === 'weekly') || geminiGroup.buckets[0];
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
        detailParts.push(`5h: **${p5h}%**${r5h ? ` *(${r5h})*` : ''}`);
        detailParts.push(`7d: **${pWk}%**${rWk ? ` *(${rWk})*` : ''}`);

        md.appendMarkdown(
          `**Gemini** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; \`${meter} ${pMin}%\` &nbsp;·&nbsp; ${detailParts.join(' &nbsp;·&nbsp; ')}\n\n`
        );
      }

      // Claude & GPT row
      if (claudeGroup) {
        const b = claudeGroup.buckets.find((b) => b.window === 'weekly') || claudeGroup.buckets[0];
        const frac = b?.remainingFraction ?? 0;
        const meter = this.renderLinenMeter(frac, 5);
        const p = Math.round(frac * 100);
        const r = b?.resetTime ? this.formatResetCompact(b.resetTime) : '';
        const statusNote = frac === 0 ? 'Weekly limit reached' : 'Weekly reserve';

        md.appendMarkdown(
          `**Claude & GPT** &nbsp; \`${meter} ${p}%\` &nbsp;·&nbsp; ${statusNote}${r ? ` &nbsp;·&nbsp; resets in **${r}**` : ''}\n\n`
        );
      }

      // Argon row
      if (liveQuota.hasArgonGroup && argonGroup) {
        const b = argonGroup.buckets[0];
        const frac = b?.remainingFraction ?? 0;
        const meter = this.renderLinenMeter(frac, 5);
        const p = Math.round(frac * 100);
        const r = b?.resetTime ? this.formatResetCompact(b.resetTime) : '';
        const statusNote = frac === 0 ? 'Weekly allowance exhausted' : 'Pro weekly allowance';

        md.appendMarkdown(
          `**Argon** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; \`${meter} ${p}%\` &nbsp;·&nbsp; ${statusNote}${r ? ` &nbsp;·&nbsp; resets in **${r}**` : ''}\n\n`
        );
      } else if (!liveQuota.hasArgonGroup) {
        md.appendMarkdown(
          `**Argon** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; \`Included in Gemini pool\` &nbsp;·&nbsp; Ultra tier\n\n`
        );
      }
    } else if (!liveQuota && !liveEmail) {
      md.appendMarkdown(`*No active session detected.*\n\n[Sign in to Antigravity](command:charlier.addAccount)\n\n`);
    }

    // 2. Multi-Profile Rotation Matrix (Only if 2 or more profiles or inactive profiles exist)
    const hasMultipleProfiles = profiles.length > 1 || (profiles.length === 1 && !activeProfile);

    if (hasMultipleProfiles) {
      md.appendMarkdown(`---\n\n`);

      const headers = [
        this.padTableCell(''),
        this.padTableCell('Profile'),
        this.padTableCell('Plan'),
        this.padTableCell('Gemini'),
        this.padTableCell('Claude & GPT'),
        this.padTableCell('Argon')
      ];
      const separators = [':---:', ':---', ':---:', ':---:', ':---:', ':---:'];

      md.appendMarkdown(`| ${headers.join(' | ')} |\n`);
      md.appendMarkdown(`|${separators.join('|')}|\n`);

      const liveMetrics = this.parseMetrics(liveQuota);

      for (const p of profiles) {
        const isActive =
          p.id === activeProfileId ||
          (liveEmail && p.email.toLowerCase() === liveEmail.toLowerCase());

        const marker = isActive ? '●' : '○';
        const switchUri = `command:charlier.switchProfileDirect?${encodeURIComponent(JSON.stringify(p.id))}`;
        const linkTitle = p.email ? p.email.replace(/"/g, '\\"') : '';
        const linkedName = isActive
          ? `**${p.name}**`
          : `[${p.name}](${switchUri} "${linkTitle}")`;

        const metrics = isActive ? liveMetrics : p.cachedQuota || { plan: '—', gemini: '—', claudeGpt: '—', argon: '—' };

        const cells = [
          this.padTableCell(marker),
          this.padTableCell(linkedName),
          this.padTableCell(`\`${metrics.plan}\``),
          this.padTableCell(`\`${metrics.gemini}\``),
          this.padTableCell(`\`${metrics.claudeGpt}\``),
          this.padTableCell(`\`${metrics.argon}\``)
        ];

        md.appendMarkdown(`| ${cells.join(' | ')} |\n`);
      }
    }

    // 3. Footer Links
    md.appendMarkdown(`\n---\n\n`);
    md.appendMarkdown(
      `[Manage profiles](command:charlier.switchProfile) · [Refresh limits](command:charlier.refreshQuota) · [+ Add account](command:charlier.addAccount)\n`
    );

    return md;
  }
}
