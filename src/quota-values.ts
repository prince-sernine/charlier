import * as fs from 'fs';
import * as path from 'path';
import type {
  ActiveProviderId,
  AuthHealthStatus,
  CachedQuotaMetric,
  LiveSessionInfo,
  ProfileMetadata,
  QuotaGroup,
  QuotaSummary
} from './types';

export function resolveEffectiveAuthStatus(
  ...statuses: Array<AuthHealthStatus | undefined | null>
): AuthHealthStatus | undefined {
  let seenOk = false;
  let seenError = false;
  let seenUnverified = false;
  let seenExpired = false;
  for (const s of statuses) {
    if (!s) continue;
    if (s === 'revoked') return 'revoked';
    if (s === 'expired') seenExpired = true;
    else if (s === 'unverified') seenUnverified = true;
    else if (s === 'error') seenError = true;
    else if (s === 'ok') seenOk = true;
  }
  if (seenExpired) return 'expired';
  if (seenUnverified) return 'unverified';
  if (seenError) return 'error';
  return seenOk ? 'ok' : undefined;
}

export function percentFromFraction(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

export function remainingFromUsedPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(100 - Math.max(0, Math.min(100, value)));
}

export function percentFromText(value: string | undefined): number | null {
  const match = /^([0-9]{1,3})%$/.exec(value?.trim() || '');
  return match ? Math.max(0, Math.min(100, Number(match[1]))) : null;
}

export function lowestRemainingPercent(groups: QuotaGroup[], freeGeminiOnly: boolean): number | null {
  const values: number[] = [];
  for (const group of groups) {
    if (freeGeminiOnly) {
      const lower = group.displayName.toLowerCase();
      if (!lower.includes('gemini') || lower.includes('argon') || lower.includes('carbon')) {
        continue;
      }
    }
    for (const bucket of group.buckets) {
      const percent = bucket.disabled ? null : percentFromFraction(bucket.remainingFraction);
      if (percent !== null) values.push(percent);
    }
  }
  return values.length ? Math.min(...values) : null;
}

export function quotaMatchesIdentity(
  quotaEmail: string | undefined | null,
  activeEmail: string | undefined | null
): boolean {
  return Boolean(
    quotaEmail &&
      activeEmail &&
      quotaEmail.toLowerCase() === activeEmail.toLowerCase()
  );
}

export function isSyntheticCodexQuota(metric: CachedQuotaMetric | undefined): boolean {
  const legacyKeys = new Set(['plan', 'gemini', 'claudeGpt', 'argon', 'codex5h', 'codex7d', 'updatedAt']);
  return Boolean(metric &&
    Object.keys(metric).every(key => legacyKeys.has(key)) &&
    metric.codex5h === '100%' && metric.codex7d === '100%' &&
    !metric.codex5hWindowMins && !metric.codex7dWindowMins &&
    !metric.codex5hResetAtMs && !metric.codex7dResetAtMs &&
    metric.gemini === '--' && metric.claudeGpt === '--' && metric.argon === '--');
}

export function codexMetricForDisplay(
  metric: CachedQuotaMetric | undefined | null,
  authMode?: 'chatgpt' | 'apikey'
): CachedQuotaMetric | undefined {
  if (!metric) return undefined;
  if (authMode === 'apikey' || metric.plan === 'API_KEY' || isSyntheticCodexQuota(metric)) {
    return {
      ...metric,
      codex5h: '--',
      codex7d: '--',
      codexCodeReview: undefined,
      updatedAt: 0
    };
  }
  return metric;
}

export interface HoverPalette {
  accent: string;
  accentBg: string;
  activeBg: string;
  ultraFg: string;
  ultraBg: string;
  freeFg: string;
  freeBg: string;
  warnFg: string;
  warnBg: string;
  dangerFg: string;
  dangerBg: string;
  emerald: string;
  amber: string;
  crimson: string;
  muted: string;
  trackBg: string;
}

export function getHoverPalette(isLight = false): HoverPalette {
  if (isLight) {
    return {
      accent: '#137751',
      accentBg: '#E2EFEA',
      activeBg: '#D8EDE5',
      ultraFg: '#0F6A5B',
      ultraBg: '#DDF0EC',
      freeFg: '#5C6B73',
      freeBg: '#E8ECEF',
      warnFg: '#9A6316',
      warnBg: '#F6EBD8',
      dangerFg: '#AD3D3D',
      dangerBg: '#F7E2E2',
      emerald: '#127A58',
      amber: '#9A6316',
      crimson: '#AD3D3D',
      muted: '#607078',
      trackBg: '#DCE3DD'
    };
  }
  return {
    accent: '#86F65C',
    accentBg: '#182630',
    activeBg: '#203C32',
    ultraFg: '#7FD8BE',
    ultraBg: '#152C29',
    freeFg: '#9BA8AE',
    freeBg: '#1B242C',
    warnFg: '#F2C677',
    warnBg: '#2C2416',
    dangerFg: '#F08C8C',
    dangerBg: '#351B1E',
    emerald: '#19B995',
    amber: '#DDA64D',
    crimson: '#D97271',
    muted: '#7E909B',
    trackBg: '#182630'
  };
}

/**
 * Formats a DOMPurify-compliant `<span style="color:#...;background-color:#...;border-radius:3px;">`
 * pill badge for VS Code MarkdownString hover tooltips.
 * Must strictly match `/^(color\:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(background-color\:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(border-radius:[0-9]+px;)?$/`
 */
export function renderHoverPill(
  label: string,
  variant: 'plan' | 'active' | 'warn' | 'danger' | 'muted' = 'plan',
  isLight = false
): string {
  const pal = getHoverPalette(isLight);
  const upper = label.toUpperCase();
  let fg = pal.accent;
  let bg = pal.accentBg;

  if (variant === 'active') {
    fg = pal.accent;
    bg = pal.activeBg;
  } else if (variant === 'warn') {
    fg = pal.warnFg;
    bg = pal.warnBg;
  } else if (variant === 'danger') {
    fg = pal.dangerFg;
    bg = pal.dangerBg;
  } else if (variant === 'muted' || upper.includes('FREE') || upper.includes('API')) {
    fg = pal.freeFg;
    bg = pal.freeBg;
  } else if (upper.includes('ULTRA')) {
    fg = pal.ultraFg;
    bg = pal.ultraBg;
  }

  const safeLabel = label.replace(/ /g, '&nbsp;');
  return `<span style="color:${fg};background-color:${bg};border-radius:3px;">&nbsp;**${safeLabel}**&nbsp;</span>`;
}

export function getPoolHexColor(pct: number | null, isLight = false): string {
  const pal = getHoverPalette(isLight);
  if (pct === null || !Number.isFinite(pct)) return pal.muted;
  if (pct < 15) return pal.crimson;
  if (pct < 50) return pal.amber;
  return pal.emerald;
}

export function renderHoverPct(
  textOrPct: string | number | null | undefined,
  bold = false,
  isLight = false,
  isStale = false
): string {
  const pal = getHoverPalette(isLight);
  const raw = typeof textOrPct === 'number' ? `${textOrPct}%` : (textOrPct || '--');
  const pct = typeof textOrPct === 'number' ? textOrPct : percentFromText(raw);
  if (pct === null) {
    if (raw === 'incl.' || raw === 'Included') {
      const inner = bold ? `**${raw}**` : raw;
      return `<span style="color:${isStale ? pal.muted : pal.ultraFg};">${inner}</span>`;
    }
    return bold ? `**${raw}**` : raw;
  }
  const color = isStale ? pal.muted : getPoolHexColor(pct, isLight);
  const inner = bold ? `**${pct}%**` : `${pct}%`;
  return `<span style="color:${color};">${inner}</span>`;
}

/**
 * Generates an inline Base64 5-segment Night Cut SVG progress bar + colored percentage
 * for VS Code MarkdownString hover tables.
 */
export function renderHoverGaugeCell(
  pct: number | null,
  includePctText = true,
  isLight = false,
  isStale = false
): string {
  const pal = getHoverPalette(isLight);
  const activeColor = isStale ? pal.muted : getPoolHexColor(pct, isLight);
  const segments = 5;
  const segWidth = 10;
  const gap = 2;
  const height = 10;
  const totalWidth = segments * segWidth + (segments - 1) * gap;

  const filledExact = pct === null ? 0 : (Math.max(0, Math.min(100, pct)) / 100) * segments;
  const rects: string[] = [];

  for (let i = 0; i < segments; i++) {
    const x = i * (segWidth + gap);
    const segFill = Math.max(0, Math.min(1, filledExact - i));
    rects.push(
      `<rect x="${x}" y="0" width="${segWidth}" height="${height}" rx="2" fill="${pal.trackBg}"/>`
    );
    if (segFill > 0.02) {
      const w = Math.max(2, Math.round(segFill * segWidth * 10) / 10);
      rects.push(
        `<rect x="${x}" y="0" width="${w}" height="${height}" rx="2" fill="${activeColor}"/>`
      );
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" viewBox="0 0 ${totalWidth} ${height}">${rects.join('')}</svg>`;
  const b64 = Buffer.from(svg, 'utf8').toString('base64');
  const img = `<img src="data:image/svg+xml;base64,${b64}" width="${totalWidth}" height="${height}" />`;

  if (!includePctText) {
    return img;
  }
  const pctStr = pct === null ? '**--**' : renderHoverPct(pct, true, isLight, isStale);
  return `${img}&nbsp;&nbsp;${pctStr}`;
}

export function resolveQuotaTone(
  minPct: number | null,
  provider: ActiveProviderId,
  needsReauth = false,
  needsVerification = false
): { colorId?: string; bgId?: string } {
  if (needsReauth || minPct === 0) {
    return { bgId: 'statusBarItem.errorBackground' };
  }
  if (needsVerification) {
    return { bgId: 'statusBarItem.warningBackground' };
  }
  if (minPct !== null && minPct < 15) {
    return { colorId: 'charlier.quotaCritical' };
  }
  if (minPct !== null && minPct < 50) {
    return { colorId: 'charlier.quotaWarn' };
  }
  return {
    colorId:
      provider === 'codex'
        ? 'charlier.codexAccent'
        : 'charlier.antigravityAccent'
  };
}

export function formatAntigravityStatusBarSummary(options: {
  activeProfile: ProfileMetadata | null;
  liveEmail: string | null;
  quota: QuotaSummary | null;
  liveMetrics: CachedQuotaMetric | null;
}): { quotaText: string; minPct: number | null } {
  const { activeProfile, liveEmail, quota, liveMetrics } = options;
  const targetEmail = activeProfile?.email || liveEmail;
  const validQuota =
    quota && (!quota.email || !targetEmail || quotaMatchesIdentity(quota.email, targetEmail))
      ? quota
      : null;

  const stale = activeProfile?.cachedQuota || null;
  const effectiveTier = (
    activeProfile?.planOverride ||
    validQuota?.planTier ||
    liveMetrics?.plan ||
    stale?.plan ||
    'FREE'
  ).toUpperCase();
  const isFree = effectiveTier === 'FREE';
  const isUltra = effectiveTier === 'ULTRA';

  let gPct: number | null = null;
  let cPct: number | null = null;
  let aPct: number | null = null;
  let cbPct: number | null = null;
  let minPct: number | null = null;

  if (validQuota && validQuota.groups.length > 0) {
    const groupFractions = (predicate: (lowerName: string) => boolean): number[] =>
      validQuota.groups
        .filter((g) => predicate((g.displayName || '').toLowerCase()))
        .flatMap((g) => g.buckets || [])
        .filter((b) => !b.disabled)
        .map((b) => percentFromFraction(b.remainingFraction))
        .filter((n): n is number => n !== null);

    gPct = liveMetrics ? percentFromText(liveMetrics.gemini) : null;
    if (gPct === null) {
      const gemFracs = groupFractions(
        (lower) =>
          lower.includes('gemini') &&
          !lower.includes('argon') &&
          !lower.includes('carbon')
      );
      if (gemFracs.length > 0) gPct = Math.min(...gemFracs);
    }

    if (!isFree) {
      cPct = liveMetrics ? percentFromText(liveMetrics.claudeGpt) : null;
      if (cPct === null) {
        const claudeFracs = groupFractions(
          (lower) => lower.includes('claude') || lower.includes('gpt')
        );
        if (claudeFracs.length > 0) cPct = Math.min(...claudeFracs);
      }

      if (!isUltra) {
        aPct = liveMetrics ? percentFromText(liveMetrics.argon) : null;
        if (aPct === null) {
          const argonFracs = groupFractions((lower) => lower.includes('argon'));
          if (argonFracs.length > 0) aPct = Math.min(...argonFracs);
        }
      }

      cbPct = liveMetrics ? percentFromText(liveMetrics.carbon) : null;
      if (cbPct === null) {
        const carbonFracs = groupFractions((lower) => lower.includes('carbon'));
        if (carbonFracs.length > 0) cbPct = Math.min(...carbonFracs);
      }
    }

    const candidates = [
      gPct,
      ...(!isFree ? [cPct, aPct, cbPct] : [])
    ].filter((n): n is number => n !== null);
    minPct =
      candidates.length > 0
        ? Math.round(candidates.reduce((sum, n) => sum + n, 0) / candidates.length)
        : lowestRemainingPercent(validQuota.groups, isFree);
  } else if (liveMetrics || stale) {
    const src = (liveMetrics || stale)!;
    gPct = percentFromText(src.gemini);
    cPct = !isFree ? percentFromText(src.claudeGpt) : null;
    aPct = !isFree && !isUltra ? percentFromText(src.argon) : null;
    cbPct = !isFree ? percentFromText(src.carbon) : null;
    const candidates = [
      gPct,
      ...(!isFree ? [cPct, aPct, cbPct] : [])
    ].filter((n): n is number => n !== null);
    if (candidates.length > 0) {
      minPct = Math.round(
        candidates.reduce((sum, n) => sum + n, 0) / candidates.length
      );
    }
  }

  const parts: string[] = [];
  if (gPct !== null) parts.push(`G ${gPct}%`);
  if (!isFree && cPct !== null) parts.push(`C ${cPct}%`);
  if (!isFree && aPct !== null) parts.push(`A ${aPct}%`);
  if (!isFree && cbPct !== null) parts.push(`Cb ${cbPct}%`);
  if (parts.length === 0 && minPct !== null) {
    parts.push(`${minPct}%`);
  }

  return { quotaText: parts.join(' · '), minPct };
}

export function getPlanTierRank(plan: string | undefined | null): number {
  const normalized = (plan || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'ULTRA':
      return 70;
    case 'ENTERPRISE':
      return 60;
    case 'PRO':
      return 50;
    case 'TEAM':
    case 'TEAMS':
    case 'BUSINESS':
      return 40;
    case 'EDU':
    case 'EDUCATION':
      return 30;
    case 'PLUS':
      return 20;
    case 'API_KEY':
    case 'API':
      return 15;
    case 'FREE':
      return 10;
    default:
      return 5;
  }
}

export function compareProfilesByTier(
  a: {
    planOverride?: string;
    cachedQuota?: { plan?: string };
    updatedAt?: number;
  },
  b: {
    planOverride?: string;
    cachedQuota?: { plan?: string };
    updatedAt?: number;
  }
): number {
  const rankA = getPlanTierRank(a.planOverride || a.cachedQuota?.plan);
  const rankB = getPlanTierRank(b.planOverride || b.cachedQuota?.plan);
  if (rankA !== rankB) {
    return rankB - rankA;
  }
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}

/**
 * Orders accounts consistently across Hover Matrix, Cockpit, and QuickPick:
 * 1. Active IDE profile first (matched by liveEmail when present, else activeProfileId)
 * 2. CLI CLAIMED profiles next (sorted by tier/recency within claimed)
 * 3. Remaining standby profiles (sorted by tier/recency)
 */
export function sortProfilesForDisplay(
  profiles: ProfileMetadata[],
  activeProfileId: string | null,
  claimedProfileIds?: ReadonlySet<string> | readonly string[] | null,
  activeEmail?: string | null
): ProfileMetadata[] {
  const claimedSet =
    claimedProfileIds instanceof Set
      ? claimedProfileIds
      : new Set(claimedProfileIds || []);
  const normEmail = activeEmail ? activeEmail.toLowerCase() : null;
  const isProfileActive = (p: ProfileMetadata): boolean =>
    Boolean(
      (normEmail && p.email.toLowerCase() === normEmail) ||
        (!normEmail && activeProfileId && p.id === activeProfileId)
    );

  return [...profiles].sort((a, b) => {
    const aActive = isProfileActive(a);
    const bActive = isProfileActive(b);
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;

    const aClaimed = claimedSet.has(a.id);
    const bClaimed = claimedSet.has(b.id);
    if (aClaimed && !bClaimed) return -1;
    if (!aClaimed && bClaimed) return 1;

    return compareProfilesByTier(a, b);
  });
}

const hoverIconDataUriCache = new Map<string, string>();

function readMediaFileSafe(relPath: string): string | null {
  const candidates: string[] = [];
  if (typeof __dirname !== 'undefined' && __dirname) {
    candidates.push(path.join(__dirname, '..', 'media', relPath));
  }
  candidates.push(path.join(process.cwd(), 'media', relPath));
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, 'utf8');
      }
    } catch {}
  }
  return null;
}

/**
 * Returns a clean, DOMPurify-safe 15x15 SVG `<img>` badge for Hover Markdown headers,
 * selecting theme-appropriate inks (`white` on dark, `ink` on light for Codex;
 * `#92D6BE` on dark, `#166F52` on light for Antigravity).
 */
export function getHoverProviderIconHtml(
  provider: ActiveProviderId,
  isLight = false
): string {
  const key = `${provider}:${isLight ? 'light' : 'dark'}`;
  let dataUri = hoverIconDataUriCache.get(key);
  if (!dataUri) {
    let svg: string | null = null;
    if (provider === 'codex') {
      svg = readMediaFileSafe(
        path.join('codex', isLight ? 'codex-small-ink.svg' : 'codex-small-white.svg')
      );
    } else {
      const raw = readMediaFileSafe(path.join('glyphs', 'antigravity-star.svg'));
      if (raw) {
        const hex = isLight ? '#166F52' : '#92D6BE';
        svg = raw
          .replace(/fill="currentColor"/i, `fill="${hex}"`)
          .replace('<svg ', '<svg width="16" height="16" ');
      }
    }
    if (svg) {
      dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
      hoverIconDataUriCache.set(key, dataUri);
    }
  }
  if (dataUri) {
    const alt = provider === 'codex' ? 'Codex' : 'Antigravity';
    return `<img src="${dataUri}" width="15" height="15" alt="${alt}" />`;
  }
  return provider === 'codex'
    ? '$(charlier-codex-prompt)'
    : '$(charlier-antigravity-star)';
}

export function formatUnifiedStatusBarText(options: {
  provider: ActiveProviderId;
  label: string;
  needsReauth: boolean;
  needsVerification?: boolean;
  showStatusBarQuota: boolean;
  quotaText: string;
  claimedCount?: number;
  includeHoverCue?: boolean;
}): string {
  const icon =
    options.provider === 'codex'
      ? '$(charlier-codex-prompt)'
      : '$(charlier-antigravity-star)';
  const parts = [`${icon} ${options.label}`];
  if (options.needsReauth) {
    parts.push('$(warning) RE-AUTH (stale)');
  } else if (options.needsVerification) {
    parts.push('$(shield) VERIFY NEEDED');
  } else if (options.showStatusBarQuota && options.quotaText) {
    parts.push(options.quotaText);
  }
  const claimedCount = options.claimedCount ?? 0;
  if (claimedCount > 0) {
    parts.push(claimedCount > 1 ? `$(terminal) ${claimedCount}` : '$(terminal)');
  }
  const body = parts.join(' · ');
  return options.includeHoverCue ? `${body} $(chevron-up)` : body;
}

export function needsCodexLiveProbe(
  rawMetric: CachedQuotaMetric | null | undefined,
  activeAuthStatus: AuthHealthStatus | undefined,
  liveAuthStatus: AuthHealthStatus | undefined,
  now = Date.now(),
  ttlMs = 120000
): boolean {
  if (
    activeAuthStatus === 'revoked' ||
    activeAuthStatus === 'expired' ||
    liveAuthStatus === 'revoked' ||
    liveAuthStatus === 'expired'
  ) {
    return true;
  }
  if (!rawMetric || !rawMetric.updatedAt) {
    return true;
  }
  return now - rawMetric.updatedAt > ttlMs;
}

function splitShellSegments(cmdLine: string): string[] {
  const segments: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmdLine.length; i++) {
    const ch = cmdLine[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < cmdLine.length) {
        const next = cmdLine[i + 1];
        const isWinTrailingPathSep =
          next === '"' &&
          /^"(?:[a-z]:\\|\\\\)/i.test(cur) &&
          !cur.endsWith('\\');
        if (isWinTrailingPathSep) {
          cur += ch;
          continue;
        }
        cur += ch + cmdLine[++i];
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '&' && cmdLine[i + 1] === '&') {
      segments.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === '|' && cmdLine[i + 1] === '|') {
      segments.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
      segments.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) segments.push(cur);
  return segments;
}

function tokenizeSegment(seg: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < seg.length) {
        const next = seg[i + 1];
        const isWinTrailingPathSep =
          next === '"' &&
          /^(?:[a-z]:\\|\\\\)/i.test(cur) &&
          !cur.endsWith('\\');
        if (isWinTrailingPathSep) {
          cur += ch;
          continue;
        }
        cur += seg[++i];
        continue;
      }
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

const SHELL_WRAPPERS = new Set([
  'env',
  'sudo',
  'nohup',
  'time',
  'command',
  'exec',
  'npx',
  'pnpx',
  'bunx',
  'cross-env',
  'dotenv',
  'dotenvx',
  'wsl',
  'wsl.exe',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'sh',
  'bash',
  'zsh',
  'set',
  'export'
]);

const CODEX_BINS = new Set([
  'codex',
  'codex.cmd',
  'codex.exe',
  'codex.bat',
  'codex.ps1'
]);

const ANTIGRAVITY_BINS = new Set([
  'agy',
  'agy.cmd',
  'agy.exe',
  'agy.bat',
  'agy.ps1',
  'antigravity',
  'antigravity.cmd',
  'antigravity.exe',
  'antigravity.bat',
  'antigravity.ps1',
  'antigravity-ide',
  'antigravity-ide.cmd',
  'antigravity-ide.exe',
  'antigravity-ide.bat',
  'antigravity-ide.ps1'
]);

export function detectProviderFromTerminalCommand(
  cmdLine: string,
  depth = 0
): ActiveProviderId | null {
  const trimmed = (cmdLine || '').trim();
  if (!trimmed) return null;

  const segments = splitShellSegments(trimmed);
  for (let s = segments.length - 1; s >= 0; s--) {
    const tokens = tokenizeSegment(segments[s]);
    if (tokens.length === 0) continue;

    let inWrapper = false;
    for (let i = 0; i < tokens.length; i++) {
      const rawToken = tokens[i];
      const rawLower = rawToken.toLowerCase();
      if (!rawLower) continue;
      if (
        /^[a-z_][a-z0-9_]*=.*/i.test(rawLower) ||
        rawLower.startsWith('$env:') ||
        rawLower === '&' ||
        rawLower === 'call'
      ) {
        // Handle PowerShell `$env:NAME = value` cleanly by skipping `=` + rhs when spaced
        if (rawLower.startsWith('$env:') && !rawLower.includes('=') && tokens[i + 1] === '=') {
          i += 2;
        }
        continue;
      }

      const raw =
        rawLower.startsWith('&') && rawLower.length > 1
          ? rawLower.slice(1)
          : rawLower;
      if (inWrapper && depth < 2 && /[\s;&|]/.test(rawToken)) {
        const inner = detectProviderFromTerminalCommand(
          rawToken.startsWith('&') ? rawToken.slice(1) : rawToken,
          depth + 1
        );
        if (inner) return inner;
      }

      const cleanBase = (raw.split(/[\\/]/).pop() || '')
        .replace(/^@[^/]+\//, '')
        .replace(/@[a-z0-9._-]+$/i, '');
      if (CODEX_BINS.has(cleanBase)) {
        return 'codex';
      }
      if (ANTIGRAVITY_BINS.has(cleanBase)) {
        return 'antigravity';
      }

      if (
        (cleanBase === 'pnpm' || cleanBase === 'yarn') &&
        (tokens[i + 1] || '').toLowerCase() === 'dlx'
      ) {
        inWrapper = true;
        i++;
        continue;
      }
      if (
        (cleanBase === 'dotenv' ||
          cleanBase === 'dotenvx' ||
          cleanBase === 'op' ||
          cleanBase === 'doppler') &&
        (tokens[i + 1] || '').toLowerCase() === 'run'
      ) {
        inWrapper = true;
        i++;
        continue;
      }
      if (
        cleanBase === 'mise' &&
        (tokens[i + 1] || '').toLowerCase().match(/^(x|exec)$/)
      ) {
        inWrapper = true;
        i++;
        continue;
      }
      if (SHELL_WRAPPERS.has(cleanBase)) {
        inWrapper = true;
        continue;
      }
      if (inWrapper && (raw === '--' || raw.startsWith('-') || raw === '/c' || raw === '/k')) {
        if (
          (raw === '-d' || raw === '--distribution' || raw === '-u' || raw === '--user' || raw === '--cd' || raw === '-e' || raw === '--env') &&
          i + 1 < tokens.length
        ) {
          i++;
        }
        continue;
      }
      // Once a real non-wrapper executable is hit (e.g. `git`, `echo`, `cd`), stop scanning its arguments.
      break;
    }
  }
  return null;
}

export function isCodexAppServerProcess(
  handle: any,
  allowExited = false
): boolean {
  if (!handle || typeof handle !== 'object') return false;
  if (
    !allowExited &&
    ((handle.exitCode !== null && handle.exitCode !== undefined) ||
      Boolean(handle.signalCode) ||
      Boolean(handle.killed))
  ) {
    return false;
  }
  if (typeof handle.spawnfile !== 'string' || !Array.isArray(handle.spawnargs)) {
    return false;
  }
  const args = handle.spawnargs.map((a: any) => String(a || ''));
  const hasAppServer = args.some(
    (a: string) => a === 'app-server' || /(?:^|\s|["'])app-server(?:$|\s|["'])/.test(a)
  );
  if (!hasAppServer) return false;
  const joined = `${handle.spawnfile} ${args.join(' ')}`.toLowerCase();
  return /(?:^|[\\/\s"'])codex(?:\.exe|\.cmd|\.bat)?(?:$|[\\/\s"'])/.test(joined);
}

/**
 * Matches an active Antigravity language-server `--hub` child handle owned by
 * the current Extension Host across Windows, macOS, and Linux (direct or shell-wrapped).
 */
export function isAntigravityHubProcess(handle: any): number | null {
  if (!handle || typeof handle !== 'object') return null;
  if (
    (handle.exitCode !== null && handle.exitCode !== undefined) ||
    Boolean(handle.signalCode) ||
    Boolean(handle.killed)
  ) {
    return null;
  }
  const pid = typeof handle.pid === 'number' && handle.pid > 0 ? handle.pid : null;
  if (!pid) return null;
  if (typeof handle.spawnfile !== 'string' || !Array.isArray(handle.spawnargs)) {
    return null;
  }
  const args = handle.spawnargs.map((a: any) => String(a || '').toLowerCase());
  if (!args.some((a: string) => /(?:^|\s|["'])--hub(?:=|\s|$|["'])/.test(a))) {
    return null;
  }
  const joined = `${handle.spawnfile} ${args.join(' ')}`.toLowerCase();
  return /(?:^|[\\/\s"'])(?:agy|antigravity|language_server)(?:[^\\/\s"']*)(?:$|[\\/\s"'])/.test(
    joined
  )
    ? pid
    : null;
}

export interface BestStandbyRecommendation {
  profile: ProfileMetadata;
  scorePct: number;
  band: 'healthy-paid' | 'thin-paid' | 'free';
}

export function resolveAntigravityPrimaryPools(
  p: ProfileMetadata | null,
  liveMetrics?: CachedQuotaMetric | null,
  quota?: QuotaSummary | null,
  fallbackEmail?: string | null
): { plan: string; gPct: number | null; cPct: number | null; avgPct: number | null } {
  const m = liveMetrics || p?.cachedQuota;
  const plan = (
    p?.planOverride ||
    quota?.planTier ||
    m?.plan ||
    'FREE'
  ).toUpperCase();
  const summary = formatAntigravityStatusBarSummary({
    activeProfile: p,
    liveEmail: fallbackEmail || p?.email || null,
    quota: quota || null,
    liveMetrics: liveMetrics || null
  });
  let gPct = percentFromText(m?.gemini);
  let cPct = plan === 'FREE' ? null : percentFromText(m?.claudeGpt);
  if (quota && quota.groups.length > 0) {
    const minGroupPct = (pred: (lower: string) => boolean): number | null => {
      const vals = quota.groups
        .filter((g) => pred((g.displayName || '').toLowerCase()))
        .flatMap((g) => g.buckets || [])
        .filter((b) => !b.disabled)
        .map((b) => percentFromFraction(b.remainingFraction))
        .filter((n): n is number => n !== null);
      return vals.length > 0 ? Math.min(...vals) : null;
    };
    if (gPct === null) {
      gPct = minGroupPct(
        (l) => l.includes('gemini') && !l.includes('argon') && !l.includes('carbon')
      );
    }
    if (plan !== 'FREE' && cPct === null) {
      cPct = minGroupPct((l) => l.includes('claude') || l.includes('gpt'));
    }
  }
  return { plan, gPct, cPct, avgPct: summary.minPct };
}

/**
 * Recommends the best healthy standby account when the active Hero drops below
 * 15% overall, hits a <15% primary-pool bottleneck (e.g. Claude exhausted while
 * Gemini remains high), or requires RE-AUTH / VERIFY NEEDED / sign-in.
 *
 * Ranking uses Healthy-Tier Bands (zero I/O or extra RPCs):
 * 1. Unclaimed profiles precede CLI CLAIMED profiles (preserves 1-click failover).
 * 2. Band order: Healthy Paid (Ultra/Enterprise/Pro/Team/Edu/Plus) > Thin Paid (15-49%) > Free (>=15%).
 *    - Healthy Paid requires: Codex min(5h,7d) >= 50%; Antigravity Gemini >= 50% & (Claude >= 25% if paid & present).
 *    - Within Paid bands, higher plan tier wins first (e.g. Ultra 50% > Pro 100%), while Pro 100% beats Ultra 20%,
 *      and Thin Paid (Ultra 20%) still beats Free 100%.
 *    - Within Free band (or same paid tier), higher % headroom wins first.
 */
export function resolveBestStandbyProfile(options: {
  provider: ActiveProviderId;
  profiles: ProfileMetadata[];
  activeProfileId: string | null;
  activeMinPct: number | null;
  activeNeedsAction: boolean;
  activePrimaryPools?: { gemini?: number | null; claude?: number | null };
  claimedProfileIds?: ReadonlySet<string> | readonly string[] | null;
  normalizeCodexMetric?: (
    metric: CachedQuotaMetric | undefined,
    authMode?: 'chatgpt' | 'apikey'
  ) => CachedQuotaMetric | undefined;
}): BestStandbyRecommendation | null {
  const lowGemini =
    options.provider === 'antigravity' &&
    options.activePrimaryPools?.gemini !== undefined &&
    options.activePrimaryPools.gemini !== null &&
    options.activePrimaryPools.gemini < 15;
  const lowClaude =
    options.provider === 'antigravity' &&
    options.activePrimaryPools?.claude !== undefined &&
    options.activePrimaryPools.claude !== null &&
    options.activePrimaryPools.claude < 15;
  const overallDegraded =
    options.activeNeedsAction ||
    (options.activeMinPct !== null && options.activeMinPct < 15);
  const degraded = overallDegraded || lowGemini || lowClaude;
  if (!degraded || options.profiles.length === 0) {
    return null;
  }

  const claimedSet =
    options.claimedProfileIds instanceof Set
      ? options.claimedProfileIds
      : new Set(options.claimedProfileIds || []);

  const candidates: Array<{
    profile: ProfileMetadata;
    scorePct: number;
    band: 'healthy-paid' | 'thin-paid' | 'free';
    bandRank: number;
    claimed: boolean;
    tierRank: number;
  }> = [];

  for (const p of options.profiles) {
    if (p.id === options.activeProfileId) continue;
    if (
      p.authStatus === 'revoked' ||
      p.authStatus === 'expired' ||
      p.authStatus === 'unverified'
    ) {
      continue;
    }

    const plan = (p.planOverride || p.cachedQuota?.plan || '').toUpperCase();
    const tierRank = getPlanTierRank(plan || undefined);
    const isFreeTier = tierRank <= 10;

    let scorePct: number | null = null;
    let isHealthyPaid = false;

    if (options.provider === 'codex') {
      if (p.authMode === 'apikey' || plan === 'API_KEY') continue;
      const m = options.normalizeCodexMetric
        ? options.normalizeCodexMetric(p.cachedQuota, p.authMode)
        : codexMetricForDisplay(p.cachedQuota, p.authMode);
      const p5 = percentFromText(m?.codex5h);
      const p7 = percentFromText(m?.codex7d);
      const known = [p5, p7].filter((n): n is number => n !== null);
      if (known.length === 0) continue;
      scorePct = Math.min(...known);
      isHealthyPaid = !isFreeTier && scorePct >= 50;
    } else {
      const pools = resolveAntigravityPrimaryPools(p);
      if (
        pools.gPct === 0 &&
        !options.activeNeedsAction &&
        (options.activeMinPct ?? 0) > 0
      ) {
        continue;
      }
      if (
        lowClaude &&
        !overallDegraded &&
        (pools.cPct === null ||
          pools.cPct < Math.max(25, (options.activePrimaryPools?.claude ?? 0) + 15))
      ) {
        // Triggered purely because Claude was depleted on Hero; avoid pointing to another empty-Claude card
        continue;
      }
      if (
        lowGemini &&
        !overallDegraded &&
        (pools.gPct === null ||
          pools.gPct < Math.max(25, (options.activePrimaryPools?.gemini ?? 0) + 15))
      ) {
        continue;
      }
      scorePct = pools.avgPct;
      const gOk = pools.gPct !== null ? pools.gPct >= 50 : (scorePct ?? 0) >= 50;
      const cOk = pools.cPct !== null ? pools.cPct >= 25 : true;
      isHealthyPaid = !isFreeTier && gOk && cOk;
    }

    if (scorePct === null || scorePct < 15) continue;
    if (
      !options.activeNeedsAction &&
      !lowGemini &&
      !lowClaude &&
      options.activeMinPct !== null &&
      scorePct < options.activeMinPct + 10
    ) {
      continue;
    }

    const band: 'healthy-paid' | 'thin-paid' | 'free' = isFreeTier
      ? 'free'
      : isHealthyPaid
        ? 'healthy-paid'
        : 'thin-paid';
    const bandRank = band === 'healthy-paid' ? 3 : band === 'thin-paid' ? 2 : 1;

    candidates.push({
      profile: p,
      scorePct,
      band,
      bandRank,
      claimed: claimedSet.has(p.id),
      tierRank
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.claimed !== b.claimed) return a.claimed ? 1 : -1;
    if (a.bandRank !== b.bandRank) return b.bandRank - a.bandRank;
    if (a.bandRank >= 2 && a.tierRank !== b.tierRank) {
      return b.tierRank - a.tierRank;
    }
    if (a.scorePct !== b.scorePct) return b.scorePct - a.scorePct;
    return (b.profile.updatedAt || 0) - (a.profile.updatedAt || 0);
  });

  return {
    profile: candidates[0].profile,
    scorePct: candidates[0].scorePct,
    band: candidates[0].band
  };
}

export type _UnusedLiveTypeRef = LiveSessionInfo;
