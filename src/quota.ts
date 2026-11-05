import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getDaemonSearchDirs } from './constants';
import { QuotaSummary, QuotaGroup, CachedQuotaMetric, ProfileMetadata, UserPlanTier } from './types';

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

  public getCachedSummary(): QuotaSummary | null {
    return this.cachedSummary;
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
      if (!cand.pid) return cand;
      try {
        process.kill(cand.pid, 0);
        return cand;
      } catch {}
    }

    return null;
  }

  private queryDaemonRpc<T>(daemon: DaemonInfo, rpcPath: string, payload: any): Promise<T | null> {
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

  private async fetchFromDaemon(forceRefresh: boolean): Promise<QuotaSummary | null> {
    const daemon = this.findActiveDaemon();
    if (!daemon) return null;

    const [statusRes, quotaRes] = await Promise.all([
      this.queryDaemonRpc<any>(daemon, '/exa.language_server_pb.LanguageServerService/GetUserStatus', {}),
      this.queryDaemonRpc<any>(daemon, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', { force_refresh: forceRefresh })
    ]);

    if (!quotaRes && !statusRes) return null;

    const groups: QuotaGroup[] = quotaRes?.response?.groups || [];
    const hasArgonGroup = groups.some(
      (g) =>
        (g.displayName && g.displayName.toLowerCase().includes('argon')) ||
        (g.description && g.description.toLowerCase().includes('argon'))
    );

    // Canonical plan identification
    const planInfo = statusRes?.userStatus?.planStatus?.planInfo;
    const userTier = statusRes?.userStatus?.userTier;
    const rawPlanName = (planInfo?.planName || '').toLowerCase().trim();
    const teamsTier = (planInfo?.teamsTier || '').toUpperCase().trim();
    const userTierName = (userTier?.name || '').toLowerCase().trim();
    const userTierId = (userTier?.id || '').toLowerCase().trim();
    const userEmail = (statusRes?.userStatus?.email || '').trim();

    let planTier: UserPlanTier = 'FREE';

    // 1. Explicit Free checks take absolute precedence
    const isExplicitFree =
      rawPlanName === 'free' ||
      rawPlanName.includes('free') ||
      teamsTier === 'TEAMS_TIER_FREE' ||
      teamsTier.includes('FREE') ||
      userTierName === 'free' ||
      userTierId === 'free';

    if (isExplicitFree) {
      planTier = 'FREE';
    } else if (
      rawPlanName === 'ultra' ||
      rawPlanName.includes('ultra') ||
      teamsTier.includes('ULTRA') ||
      teamsTier.includes('ULTIMATE') ||
      userTierName === 'ultra' ||
      userTierId === 'ultra'
    ) {
      planTier = 'ULTRA';
    } else if (
      teamsTier.includes('ENTERPRISE') ||
      rawPlanName.includes('enterprise')
    ) {
      planTier = 'ENTERPRISE';
    } else if (
      rawPlanName === 'pro' ||
      teamsTier === 'TEAMS_TIER_PRO' ||
      userTierName === 'pro' ||
      userTierId === 'pro'
    ) {
      planTier = 'PRO';
    } else {
      planTier = 'FREE';
    }

    const tier: QuotaSummary['tier'] =
      planTier === 'ULTRA' ? 'Ultra Plan'
      : planTier === 'PRO' ? 'Pro Plan'
      : planTier === 'ENTERPRISE' ? 'Enterprise'
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

  public formatTimeAgo(timestamp?: number): string {
    if (!timestamp) return 'previously';
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

  public parseMetrics(quota: QuotaSummary | null): CachedQuotaMetric {
    if (!quota || !quota.groups || quota.groups.length === 0) {
      return {
        plan: quota?.planTier || '--',
        gemini: '--',
        claudeGpt: '--',
        argon: '--',
        updatedAt: Date.now()
      };
    }

    const plan = quota.planTier || 'FREE';
    let gemini = '--';
    let claudeGpt = '--';
    let argon = plan === 'ULTRA' ? 'incl.' : '--';

    for (const group of quota.groups) {
      const name = group.displayName.toLowerCase();
      if (name.includes('argon')) {
        const b = group.buckets[0];
        if (b) {
          const frac = b.remainingFraction ?? 0;
          const pct = Math.round(frac * 100);
          argon = `${pct}%`;
        }
      } else if (name.includes('claude') || name.includes('gpt')) {
        const weekly = group.buckets.find((b) => b.window === 'weekly') || group.buckets[0];
        if (weekly) {
          const frac = weekly.remainingFraction ?? 0;
          const pct = Math.round(frac * 100);
          claudeGpt = `${pct}%`;
        }
      } else if (name.includes('gemini')) {
        const b5h = group.buckets.find((b) => b.window === '5h');
        const bWeekly = group.buckets.find((b) => b.window === 'weekly') || group.buckets[0];
        const f5h = b5h?.remainingFraction ?? 1;
        const fWk = bWeekly?.remainingFraction ?? 1;
        const minFrac = Math.min(f5h, fWk);
        const pct = Math.round(minFrac * 100);
        gemini = `${pct}%`;
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
        'charlier.addAccount'
      ]
    };

    const activeProfile = liveEmail
      ? profiles.find((p) => p.email.toLowerCase() === liveEmail.toLowerCase()) || (activeProfileId ? profiles.find((p) => p.id === activeProfileId) : null)
      : (activeProfileId ? profiles.find((p) => p.id === activeProfileId) : null);

    const displayName = activeProfile?.name || (liveEmail ? liveEmail.split('@')[0] : 'Ready for login');
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
    const planBadge = effectiveLiveQuota ? effectiveLiveQuota.planTier : (activeProfile?.cachedQuota?.plan || 'FREE');

    // 1. Hero Instrument Card
    md.appendMarkdown(`### Charlier &nbsp;·&nbsp; **${displayName}** &nbsp;\`${planBadge}\` &nbsp;\`ACTIVE\`\n\n`);
    md.appendMarkdown(`\`${emailDisplay}\` &nbsp;·&nbsp; **● Active Session**\n\n`);

    if (effectiveLiveQuota && effectiveLiveQuota.groups && effectiveLiveQuota.groups.length > 0) {
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

      // Perfectly aligned Hero Model Table
      const heroHeaders = [
        this.padTableCell('Model Pool'),
        this.padTableCell('Gauge'),
        this.padTableCell('Capacity & Reset Window')
      ];
      const heroSeparators = [':---', ':---:', ':---'];

      md.appendMarkdown(`| ${heroHeaders.join(' | ')} |\n`);
      md.appendMarkdown(`|${heroSeparators.join('|')}|\n`);

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
        detailParts.push(`5h: **${p5h}%**${r5h && p5h < 100 ? ` *(${r5h})*` : ''}`);
        detailParts.push(`7d: **${pWk}%**${rWk && pWk < 100 ? ` *(${rWk})*` : ''}`);

        const row = [
          this.padTableCell('**Gemini** *(Flash, Pro)*'),
          this.padTableCell(`\`${meter} ${pMin}%\``),
          this.padTableCell(detailParts.join(' &nbsp;·&nbsp; '))
        ];
        md.appendMarkdown(`| ${row.join(' | ')} |\n`);
      }

      // Claude & GPT row (Gracefully omitted after Nov 18 if no longer reported by daemon)
      if (claudeGroup) {
        const b = claudeGroup.buckets.find((b) => b.window === 'weekly') || claudeGroup.buckets[0];
        const frac = b?.remainingFraction ?? 0;
        const meter = this.renderLinenMeter(frac, 5);
        const p = Math.round(frac * 100);
        const r = b?.resetTime ? this.formatResetCompact(b.resetTime) : '';
        const statusNote = frac === 0 ? '**Depleted**' : 'Active reserve';

        const row = [
          this.padTableCell('**Claude & GPT** *(Opus, Sonnet)*'),
          this.padTableCell(`\`${meter} ${p}%\``),
          this.padTableCell(`${statusNote}${r && frac < 1 ? ` &nbsp;·&nbsp; resets in **${r}**` : ''}`)
        ];
        md.appendMarkdown(`| ${row.join(' | ')} |\n`);
      }

      // Argon row
      if (effectiveLiveQuota.planTier === 'PRO' && argonGroup) {
        const b = argonGroup.buckets[0];
        const frac = b?.remainingFraction ?? 0;
        const meter = this.renderLinenMeter(frac, 5);
        const p = Math.round(frac * 100);
        const r = b?.resetTime ? this.formatResetCompact(b.resetTime) : '';
        const statusNote = frac === 0 ? '**Depleted**' : 'Pro allowance';

        const row = [
          this.padTableCell('**Argon** *(Gemini 4 Argon)*'),
          this.padTableCell(`\`${meter} ${p}%\``),
          this.padTableCell(`${statusNote}${r && frac < 1 ? ` &nbsp;·&nbsp; resets in **${r}**` : ''}`)
        ];
        md.appendMarkdown(`| ${row.join(' | ')} |\n`);
      } else if (effectiveLiveQuota.planTier === 'ULTRA') {
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
    } else if (!effectiveLiveQuota && !liveEmail) {
      md.appendMarkdown(`*No active session detected.*\n\n[Sign in to Antigravity](command:charlier.addAccount)\n\n`);
    }

    // 2. Multi-Profile Rotation Matrix (Only if 2 or more profiles or inactive profiles exist)
    const hasMultipleProfiles = profiles.length > 1 || (profiles.length === 1 && !activeProfile);

    if (hasMultipleProfiles) {
      md.appendMarkdown(`---\n\n`);

      // Detect whether Claude models exist across active session or any cached profiles
      const showClaudeColumn = Boolean(
        effectiveLiveQuota?.groups?.some(
          (g) => g.displayName.toLowerCase().includes('claude') || g.displayName.toLowerCase().includes('gpt')
        ) ||
        profiles.some(
          (p) => p.cachedQuota?.claudeGpt && p.cachedQuota.claudeGpt !== '--' && p.cachedQuota.claudeGpt !== '—'
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

      md.appendMarkdown(`| ${headers.join(' | ')} |\n`);
      md.appendMarkdown(`|${separators.join('|')}|\n`);

      const liveMetrics = effectiveLiveQuota ? this.parseMetrics(effectiveLiveQuota) : null;

      // Sort so active profile is pinned at top, followed by most recently active
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

      const maxHoverDisplay = 4;
      const displayProfiles = sortedProfiles.slice(0, maxHoverDisplay);
      const overflowCount = sortedProfiles.length - displayProfiles.length;

      for (const p of displayProfiles) {
        const isActive =
          (liveEmail && p.email.toLowerCase() === liveEmail.toLowerCase()) ||
          (!liveEmail && p.id === activeProfileId);

        const marker = isActive ? '$(check)' : '&nbsp;';
        const switchUri = `command:charlier.switchProfileDirect?${encodeURIComponent(JSON.stringify(p.id))}`;
        const linkTitle = p.email ? p.email.replace(/"/g, '\\"') : '';
        const linkedName = isActive
          ? `**${p.name}** &nbsp;\`ACTIVE\``
          : `[${p.name}](${switchUri} "${linkTitle}")`;

        const rawMetrics = (isActive && liveMetrics) ? liveMetrics : p.cachedQuota || { plan: '--', gemini: '--', claudeGpt: '--', argon: '--' };
        const sPlan = this.sanitizeMetric(rawMetrics.plan);
        const sGemini = this.sanitizeMetric(rawMetrics.gemini);
        const sClaude = this.sanitizeMetric(rawMetrics.claudeGpt);
        const sArgon = this.sanitizeMetric(rawMetrics.argon);

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

        md.appendMarkdown(`| ${cells.join(' | ')} |\n`);
      }

      if (overflowCount > 0) {
        md.appendMarkdown(
          `\n*+ ${overflowCount} more account${overflowCount > 1 ? 's' : ''} in vault* &nbsp;·&nbsp; [View all in menu](command:charlier.switchProfile)\n`
        );
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
