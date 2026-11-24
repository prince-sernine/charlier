import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ActiveProviderId, CachedQuotaMetric, LiveSessionInfo, ProfileMetadata } from './types';
import { formatTimeAgo, healExpiredAntigravityMetric } from './quota';
import { healExpiredCodexMetric } from './codex';
import {
  BestStandbyRecommendation,
  codexMetricForDisplay,
  percentFromText,
  resolveAntigravityPrimaryPools,
  resolveBestStandbyProfile,
  resolveEffectiveAuthStatus,
  sortProfilesForDisplay
} from './quota-values';

const mediaDir = path.join(__dirname, '..', 'media');
const cockpitCss = fs.readFileSync(path.join(mediaDir, 'cockpit.css'), 'utf8');
const codexGlyph = fs.readFileSync(path.join(mediaDir, 'glyphs', 'codex-prompt.svg'), 'utf8');
const codexRegularGlyph = fs.readFileSync(path.join(mediaDir, 'glyphs', 'codex-regular.svg'), 'utf8');
const antigravityGlyph = fs.readFileSync(path.join(mediaDir, 'glyphs', 'antigravity-star.svg'), 'utf8');
type SessionKind = 'saved' | 'unsaved' | 'unidentified' | 'none';

export interface CockpitRenderState {
  selectedProvider: ActiveProviderId;
  antigravity: {
    profiles: ProfileMetadata[];
    activeProfileId: string | null;
    cliProfileId?: string | null;
    claimedProfileIds?: string[];
    sessionKind: SessionKind;
    liveSession: LiveSessionInfo;
    liveMetrics: CachedQuotaMetric | null;
    formatReset: (iso?: string) => string;
  };
  codex: {
    profiles: ProfileMetadata[];
    activeProfileId: string | null;
    cliProfileId?: string | null;
    claimedProfileIds?: string[];
    sessionKind: SessionKind;
    liveSession: LiveSessionInfo;
    liveMetrics: CachedQuotaMetric | null;
  };
}

export interface CockpitCallbacks {
  onSelectProvider: (provider: ActiveProviderId) => Promise<void>;
  onSwitchProfile: (provider: ActiveProviderId, profileId: string, cliOnly?: boolean) => Promise<void>;
  onRefreshAll: (provider: ActiveProviderId) => Promise<void>;
  onRefreshSingle: (provider: ActiveProviderId, profileId: string) => Promise<void>;
  onSaveActive: (provider: ActiveProviderId) => Promise<void>;
  onAddAccount: (provider: ActiveProviderId) => Promise<void>;
  onVerifyAccount?: (provider: ActiveProviderId, profileId?: string) => Promise<void>;
  onRenameProfile: (provider: ActiveProviderId, profileId: string) => Promise<void>;
  onDeleteProfile: (provider: ActiveProviderId, profileId: string) => Promise<void>;
  onViewDetails?: (provider: ActiveProviderId, profileId: string) => Promise<void>;
  onVisibilityChanged?: (visible: boolean) => void;
}

function escapeHtml(str: string | undefined | null): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function profileTone(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 4;
}

function parsePercent(val: string | undefined): number | null {
  return percentFromText(val);
}

function getGaugeColor(
  pct: number | null,
  isStale = false
): { stroke: string; glow: string; badgeBg: string; text: string } {
  if (isStale || pct === null) {
    return {
      stroke: 'var(--quota-unknown)',
      glow: 'transparent',
      badgeBg: 'var(--surface-muted)',
      text: 'var(--text-muted)'
    };
  }
  if (pct >= 50) {
    return {
      stroke: 'var(--quota-green)',
      glow: 'var(--quota-green-glow)',
      badgeBg: 'var(--surface-muted)',
      text: 'var(--quota-green-text)'
    };
  }
  if (pct >= 15) {
    return {
      stroke: 'var(--quota-amber)',
      glow: 'var(--quota-amber-glow)',
      badgeBg: 'var(--surface-muted)',
      text: 'var(--quota-amber-text)'
    };
  }
  return {
    stroke: 'var(--quota-red)',
    glow: 'var(--quota-red-glow)',
    badgeBg: 'var(--surface-muted)',
    text: 'var(--quota-red-text)'
  };
}

function renderRadialWheel(
  label: string,
  valStr: string,
  subLabel: string,
  linkedValStr?: string,
  isStale = false
): string {
  const pct = valStr === 'incl.' ? (parsePercent(linkedValStr) ?? 100) : parsePercent(valStr);
  const colors = getGaugeColor(pct, isStale);
  const radius = 24;
  const circumference = +(2 * Math.PI * radius).toFixed(2);
  const dashOffset = pct !== null ? +(((100 - pct) / 100) * circumference).toFixed(2) : circumference;
  const displayVal = valStr === 'incl.' ? 'INCL' : pct !== null ? `${pct}%` : '--';
  const spokenValue = valStr === 'incl.' ? 'included in another pool' : pct !== null ? `${pct} percent remaining` : 'usage unavailable';

  return `
    <div class="wheel-item ${valStr === 'incl.' ? 'included' : ''}" data-card-key="wheel-${escapeHtml(label)}" role="img" aria-label="${escapeHtml(label)}, ${spokenValue}, ${escapeHtml(subLabel)}">
      <div class="wheel-svg-wrap">
        <svg class="wheel-svg" width="62" height="62" viewBox="0 0 62 62">
          <circle
            class="wheel-track"
            cx="31"
            cy="31"
            r="${radius}"
            fill="none"
            stroke="var(--track)"
            stroke-width="5"
          />
          <circle
            class="wheel-fill"
            cx="31"
            cy="31"
            r="${radius}"
            fill="none"
            stroke="${colors.stroke}"
            stroke-width="5"
            stroke-linecap="round"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${dashOffset}"
            transform="rotate(-90 31 31)"
            style="filter: drop-shadow(0 0 4px ${colors.glow});"
          />
        </svg>
        <div class="wheel-center"${valStr === 'incl.' ? '' : ` style="color: ${colors.text};"`}>${escapeHtml(displayVal)}</div>
      </div>
      <div class="wheel-label">${escapeHtml(label)}</div>
      <div class="wheel-sub">${escapeHtml(subLabel || 'Ready')}</div>
    </div>
  `;
}

function renderPoolBarRow(
  title: string,
  valStr: string | undefined,
  resetStr: string | undefined,
  linkedValStr?: string,
  includedStatus = 'In Gemini',
  isStale = false
): string {
  const safeVal = valStr && valStr !== '--' ? valStr : '--';
  const pct = safeVal === 'incl.' ? (parsePercent(linkedValStr) ?? 100) : parsePercent(safeVal);
  const colors = getGaugeColor(pct, isStale);
  const widthPct = pct !== null ? pct : 0;
  const status =
    safeVal === 'incl.'
      ? includedStatus
      : pct === null
        ? 'Unavailable'
        : pct === 0
          ? 'Depleted'
          : '';
  const resetBadge = status
    ? `<span class="pool-reset ${pct === 0 && !isStale ? 'depleted' : ''}">${status}</span>`
    : pct !== 100 && resetStr && resetStr !== 'now'
      ? `<span class="pool-reset">${escapeHtml(resetStr)}</span>`
      : `<span class="pool-reset ready">${isStale ? 'Stale' : 'Active'}</span>`;
  const resetNote = status && resetStr && resetStr !== 'now'
    ? `<span class="pool-reset">${escapeHtml(resetStr)}</span>` : '';

  return `
    <div class="pool-row" data-card-key="pool-${escapeHtml(title)}" role="img" aria-label="${escapeHtml(title)}, ${safeVal === 'incl.' ? 'included in another pool' : pct === null ? 'usage unavailable' : `${pct} percent remaining`}${resetStr ? `, resets ${escapeHtml(resetStr)}` : ''}">
      <div class="pool-row-top">
        <span class="pool-title">${escapeHtml(title)}</span>
        <span class="pool-meta">
          ${resetBadge}
          ${resetNote}
          <span class="pool-val" style="color: ${colors.text};">${escapeHtml(safeVal)}</span>
        </span>
      </div>
      <div class="pool-bar-track">
        <div class="pool-bar-fill" style="width: ${widthPct}%; background: ${colors.stroke}; box-shadow: 0 0 6px ${colors.glow};"></div>
      </div>
    </div>
  `;
}

export class CharlierSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'charlier.cockpitView';
  private view?: vscode.WebviewView;
  private lastState?: CockpitRenderState;
  private lastNormalizedHtml?: string;
  private patchedSinceHtml = false;
  private hasPendingSync = false;
  private renderSeq = 0;
  private readonly callbacks: CockpitCallbacks;

  constructor(callbacks: CockpitCallbacks) {
    this.callbacks = callbacks;
  }

  public isVisible(): boolean {
    return Boolean(this.view?.visible);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    this.lastNormalizedHtml = undefined;
    this.patchedSinceHtml = false;
    this.hasPendingSync = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    };

    if (typeof (webviewView as any).onDidChangeVisibility === 'function') {
      // A hidden webview is destroyed and reloaded from its last html, which would be stale
      // if later frames were delivered as patches. Rebuild only when patched, pending sync, or blank.
      webviewView.onDidChangeVisibility(() => {
        if (
          webviewView.visible &&
          this.lastState &&
          (this.patchedSinceHtml || this.hasPendingSync || !webviewView.webview.html)
        ) {
          this.patchedSinceHtml = false;
          this.hasPendingSync = false;
          this.lastNormalizedHtml = undefined;
          webviewView.webview.html = this.buildHtml(this.lastState);
          this.lastNormalizedHtml = this.buildBodyHtml(this.lastState);
        }
        try {
          this.callbacks.onVisibilityChanged?.(Boolean(webviewView.visible));
        } catch {}
      });
    }

    if (typeof (webviewView as any).onDidDispose === 'function') {
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
          this.lastNormalizedHtml = undefined;
          this.patchedSinceHtml = false;
          this.hasPendingSync = false;
          try {
            this.callbacks.onVisibilityChanged?.(false);
          } catch {}
        }
      });
    }

    webviewView.webview.onDidReceiveMessage(async (msg: any) => {
      try {
        await this.handleWebviewMessage(msg);
      } finally {
        // Always release matching busy buttons, even if the action failed or was cancelled.
        const wv: any = this.view?.webview;
        if (wv && typeof wv.postMessage === 'function') {
          Promise.resolve(
            wv.postMessage({
              type: 'CLEAR_BUSY',
              action: typeof msg?.type === 'string' ? msg.type : undefined,
              provider: typeof msg?.provider === 'string' ? msg.provider : undefined,
              profileId: typeof msg?.profileId === 'string' ? msg.profileId : undefined
            })
          ).then(undefined, () => {});
        }
      }
    });

    if (this.lastState) {
      this.render(this.lastState);
    }
    try {
      this.callbacks.onVisibilityChanged?.(Boolean(webviewView.visible));
    } catch {}
  }

  private async handleWebviewMessage(msg: any): Promise<void> {
    {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.provider !== 'codex' && msg.provider !== 'antigravity') return;
      const provider: ActiveProviderId = msg.provider;
      const profileActions = ['SWITCH_PROFILE', 'REFRESH_SINGLE', 'RENAME_PROFILE', 'DELETE_PROFILE'];
      if (profileActions.includes(msg.type) &&
        (typeof msg.profileId !== 'string' ||
          !this.lastState?.[provider].profiles.some(p => p.id === msg.profileId))) return;

      switch (msg.type) {
        case 'SELECT_PROVIDER':
          await this.callbacks.onSelectProvider(provider);
          break;
        case 'SWITCH_PROFILE':
          if (msg.profileId) {
            await this.callbacks.onSwitchProfile(provider, String(msg.profileId), Boolean(msg.cliOnly));
          }
          break;
        case 'REFRESH_ALL':
          await this.callbacks.onRefreshAll(provider);
          break;
        case 'REFRESH_SINGLE':
          if (msg.profileId) {
            await this.callbacks.onRefreshSingle(provider, String(msg.profileId));
          }
          break;
        case 'SAVE_ACTIVE':
          await this.callbacks.onSaveActive(provider);
          break;
        case 'ADD_ACCOUNT':
          await this.callbacks.onAddAccount(provider);
          break;
        case 'VERIFY_ACCOUNT':
          await this.callbacks.onVerifyAccount?.(
            provider,
            msg.profileId ? String(msg.profileId) : undefined
          );
          break;
        case 'RENAME_PROFILE':
          if (msg.profileId) {
            await this.callbacks.onRenameProfile(provider, String(msg.profileId));
          }
          break;
        case 'DELETE_PROFILE':
          if (msg.profileId) {
            await this.callbacks.onDeleteProfile(provider, String(msg.profileId));
          }
          break;
      }
    }
  }

  public render(state: CockpitRenderState): void {
    this.lastState = state;
    if (!this.view) return;
    const bodyHtml = this.buildBodyHtml(state);
    if (
      this.lastNormalizedHtml === bodyHtml &&
      this.view.webview.html &&
      !this.hasPendingSync
    ) {
      return;
    }
    this.lastNormalizedHtml = bodyHtml;
    const seq = ++this.renderSeq;
    if (!this.view.webview.html) {
      this.patchedSinceHtml = false;
      this.hasPendingSync = false;
      this.view.webview.html = this.buildHtml(state, bodyHtml);
    } else if (typeof this.view.webview.postMessage === 'function') {
      this.patchedSinceHtml = true;
      Promise.resolve(
        this.view.webview.postMessage({
          type: 'PATCH_DOM',
          selectedProvider: state.selectedProvider,
          bodyHtml
        })
      ).then(
        (delivered) => {
          if (!this.view || seq !== this.renderSeq) return;
          if (delivered === true) {
            this.patchedSinceHtml = false;
            this.hasPendingSync = false;
          } else if (delivered === false) {
            this.hasPendingSync = true;
            this.lastNormalizedHtml = undefined;
            this.patchedSinceHtml = true;
            if (this.view.visible && this.lastState) {
              const latestBody = this.buildBodyHtml(this.lastState);
              this.hasPendingSync = false;
              this.patchedSinceHtml = false;
              this.view.webview.html = this.buildHtml(this.lastState, latestBody);
              this.lastNormalizedHtml = latestBody;
            }
          } else {
            this.hasPendingSync = false;
          }
        },
        () => {
          if (this.view && seq === this.renderSeq) {
            this.hasPendingSync = false;
            this.patchedSinceHtml = false;
            const latestState = this.lastState || state;
            const latestBody = this.buildBodyHtml(latestState);
            this.lastNormalizedHtml = latestBody;
            this.view.webview.html = this.buildHtml(latestState, latestBody);
          }
        }
      );
    } else {
      this.patchedSinceHtml = false;
      this.hasPendingSync = false;
      this.view.webview.html = this.buildHtml(state, bodyHtml);
    }
  }

  private buildBodyHtml(state: CockpitRenderState): string {
    const isCodex = state.selectedProvider === 'codex';
    const nextProvider: ActiveProviderId = isCodex ? 'antigravity' : 'codex';

    const deck = isCodex ? state.codex : state.antigravity;
    const profiles = deck.profiles;
    const activeProfile = profiles.find(p => p.id === deck.activeProfileId) || null;

    const claimedSet = new Set(deck.claimedProfileIds || []);
    const sortedProfiles = sortProfilesForDisplay(
      profiles,
      deck.activeProfileId,
      claimedSet
    );

    const isHeroClaimed = Boolean(activeProfile && claimedSet.has(activeProfile.id));
    const activeAuthStatus = resolveEffectiveAuthStatus(
      activeProfile?.authStatus,
      deck.liveSession.authStatus
    );
    const activeNeedsAction =
      activeAuthStatus === 'revoked' ||
      activeAuthStatus === 'expired' ||
      (!isCodex && activeAuthStatus === 'unverified') ||
      (!activeProfile && deck.sessionKind !== 'unsaved');
    let activeMinPct: number | null = null;
    let activePrimaryPools: { gemini?: number | null; claude?: number | null } | undefined;
    let activeBottleneck: { label: string; pct: number } | null = null;
    if (isCodex) {
      const rawMetric = deck.liveMetrics || activeProfile?.cachedQuota;
      const m = codexMetricForDisplay(
        activeNeedsAction ? rawMetric : healExpiredCodexMetric(rawMetric),
        activeProfile?.authMode || deck.liveSession.authMode
      );
      const known = [parsePercent(m?.codex5h), parsePercent(m?.codex7d)].filter(
        (n): n is number => n !== null
      );
      activeMinPct = known.length ? Math.min(...known) : null;
    } else {
      const activePools = resolveAntigravityPrimaryPools(
        activeProfile,
        deck.liveMetrics,
        null,
        deck.liveSession.email
      );
      activePrimaryPools = { gemini: activePools.gPct, claude: activePools.cPct };
      if (activePools.gPct !== null && activePools.gPct < 15) {
        activeBottleneck = { label: 'Gemini', pct: activePools.gPct };
      } else if (activePools.cPct !== null && activePools.cPct < 15) {
        activeBottleneck = { label: 'Claude', pct: activePools.cPct };
      }
      activeMinPct = activePools.avgPct;
    }
    const bestStandby = resolveBestStandbyProfile({
      provider: state.selectedProvider,
      profiles,
      activeProfileId: deck.activeProfileId,
      activeMinPct,
      activeNeedsAction,
      activePrimaryPools,
      claimedProfileIds: claimedSet,
      normalizeCodexMetric: isCodex
        ? (m, am) => codexMetricForDisplay(healExpiredCodexMetric(m), am)
        : undefined
    });
    const pitstopHtml = this.renderPitstopBanner(
      state.selectedProvider,
      bestStandby,
      activeMinPct,
      activeNeedsAction,
      activeBottleneck
    );

    const heroHtml = isCodex
      ? this.renderCodexHero(
          activeProfile,
          deck.sessionKind,
          deck.liveSession,
          deck.liveMetrics,
          isHeroClaimed,
          pitstopHtml
        )
      : this.renderAntigravityHero(
          activeProfile,
          deck.sessionKind,
          deck.liveSession,
          deck.liveMetrics,
          state.antigravity.formatReset,
          isHeroClaimed,
          pitstopHtml
        );

    const roster = sortedProfiles.filter(p => p.id !== deck.activeProfileId);
    const cardsHtml = roster
      .map(p =>
        isCodex
          ? this.renderCodexProfileCard(
              p,
              p.id === deck.activeProfileId,
              deck.liveMetrics,
              p.id === deck.cliProfileId,
              claimedSet.has(p.id),
              bestStandby?.profile.id === p.id
            )
          : this.renderAntigravityProfileCard(
              p,
              p.id === deck.activeProfileId,
              deck.liveMetrics,
              state.antigravity.formatReset,
              p.id === deck.cliProfileId,
              claimedSet.has(p.id),
              bestStandby?.profile.id === p.id
            )
      )
      .join('');

    return `
  <!-- Top Provider Carousel Wheel -->
  <div class="provider-wheel" data-card-key="provider-wheel">
    <button class="wheel-arrow" data-action="SELECT_PROVIDER" data-provider="${nextProvider}" title="Previous provider deck" aria-label="Previous provider deck">‹</button>
    <div class="provider-pills">
      <button class="provider-pill ${!isCodex ? 'active' : ''}" data-action="SELECT_PROVIDER" data-provider="antigravity" aria-pressed="${!isCodex}">
        ${antigravityGlyph}
        <span>Antigravity</span>
        <span class="provider-count">(${state.antigravity.profiles.length})</span>
      </button>
      <button class="provider-pill ${isCodex ? 'active' : ''}" data-action="SELECT_PROVIDER" data-provider="codex" aria-pressed="${isCodex}">
        ${codexGlyph}
        <span>Codex</span>
        <span class="provider-count">(${state.codex.profiles.length})</span>
      </button>
    </div>
    <button class="wheel-arrow" data-action="SELECT_PROVIDER" data-provider="${nextProvider}" title="Next provider deck" aria-label="Next provider deck">›</button>
  </div>

  <div id="hero-section">${heroHtml}</div>

  <div class="section-header" data-card-key="section-header">
    <span>${isCodex ? 'Codex Vault' : 'Antigravity Vault'} · ${roster.length} Standby</span>
    <button class="section-action" data-card-key="refresh-all" data-action="REFRESH_ALL" data-provider="${state.selectedProvider}" title="Refresh both provider vaults" aria-label="Refresh all Antigravity and Codex accounts">↻ Refresh All</button>
  </div>

  ${profiles.length >= 6 ? `<div class="vault-search" data-card-key="vault-search"><label for="vault-search">Find an account</label><input id="vault-search" type="text" role="searchbox" autocomplete="off" placeholder="Name or email" aria-controls="accounts-deck" /><div id="search-result-count" class="hero-freshness" aria-live="polite"></div></div>` : ''}

  <div class="accounts-deck" id="accounts-deck">
    ${cardsHtml || `<div class="empty-state">${profiles.length === 0 ? `No saved ${isCodex ? 'Codex' : 'Antigravity'} accounts yet.` : 'No standby accounts.'}</div>`}
    <div class="empty-state" id="search-empty" hidden>No standby accounts match this search.</div>
  </div>

  <div class="cockpit-footer" data-card-key="cockpit-footer">
    <button class="btn-footer" data-card-key="add-account" data-action="ADD_ACCOUNT" data-provider="${state.selectedProvider}">+ Add ${isCodex ? 'Codex' : 'Antigravity'} Account</button>
  </div>`;
  }

  private buildHtml(state: CockpitRenderState, prebuiltBody?: string): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const bodyContent = prebuiltBody ?? this.buildBodyHtml(state);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>${cockpitCss}</style>
</head>
<body>
  <div id="cockpit-root">${bodyContent}</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let selectedProvider = '${state.selectedProvider}';
    const root = document.getElementById('cockpit-root');

    const saveDeck = (change, providerKey = selectedProvider) => {
      const old = vscode.getState() || {};
      const decks = old.decks || {};
      vscode.setState({ ...old, provider: selectedProvider, decks: {
        ...decks, [providerKey]: { ...(decks[providerKey] || {}), ...change }
      }});
    };
    const deckState = () => ((vscode.getState() || {}).decks || {})[selectedProvider] || {};

    const filterCards = () => {
      const search = document.getElementById('vault-search');
      const cards = Array.from(document.querySelectorAll('[data-profile-card]'));
      const searchEmpty = document.getElementById('search-empty');
      const searchCount = document.getElementById('search-result-count');
      const query = search ? search.value.trim().toLocaleLowerCase() : '';
      let shown = 0;
      for (const card of cards) {
        card.hidden = Boolean(query && !(card.dataset.search || '').toLocaleLowerCase().includes(query));
        if (!card.hidden) shown++;
      }
      if (searchEmpty) searchEmpty.hidden = !query || shown > 0;
      if (searchCount) searchCount.textContent = query ? shown + ' of ' + cards.length + ' standby accounts' : '';
    };

    const restoreSearch = (previousProvider, restoreFocus) => {
      const search = document.getElementById('vault-search');
      if (!search) {
        saveDeck({ query: '', focusSearch: false });
        filterCards();
        return;
      }
      const saved = deckState();
      if (search.value !== (saved.query || '')) search.value = saved.query || '';
      filterCards();
      if (restoreFocus && previousProvider === selectedProvider && saved.focusSearch && document.visibilityState === 'visible') {
        search.focus({ preventScroll: true });
        if (typeof saved.caret === 'number') search.setSelectionRange(saved.caret, saved.caret);
      }
    };

    const syncDrawers = () => {
      const savedIds = deckState().expandedCardIds;
      const openSet = new Set(Array.isArray(savedIds) ? savedIds : []);
      for (const btn of document.querySelectorAll('[data-toggle-drawer]')) {
        const id = btn.getAttribute('data-toggle-drawer');
        const isOpen = Boolean(id && openSet.has(id));
        btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        btn.classList.toggle('active', isOpen);
      }
      for (const drawer of document.querySelectorAll('[data-drawer-for]')) {
        const id = drawer.getAttribute('data-drawer-for');
        drawer.hidden = !Boolean(id && openSet.has(id));
      }
    };

    // Minimal in-place DOM morph: untouched nodes keep identity (hover, focus, CSS transitions),
    // so gauges animate to new values instead of the whole panel repainting.
    const isLocallyBusy = (el) =>
      Boolean(
        el &&
        el.nodeType === 1 &&
        el.classList &&
        el.classList.contains('is-busy') &&
        Number(el.dataset.busyUntil || 0) > Date.now() &&
        (!el.dataset.busyProvider || el.dataset.busyProvider === selectedProvider)
      );

    const syncAttrs = (from, to) => {
      const stateful = from.hasAttribute('data-profile-card') || from.id === 'search-empty' || from.hasAttribute('data-drawer-for');
      const preserveBusy = isLocallyBusy(from);
      const preserveToggle = from.hasAttribute('data-toggle-drawer');
      for (const attr of Array.from(from.attributes)) {
        if (stateful && attr.name === 'hidden') continue;
        if (preserveToggle && attr.name === 'aria-expanded') continue;
        if (preserveBusy && (attr.name === 'class' || attr.name === 'aria-busy' || attr.name === 'data-orig-text' || attr.name === 'data-busy-until' || attr.name === 'data-busy-provider')) continue;
        if (!to.hasAttribute(attr.name)) from.removeAttribute(attr.name);
      }
      for (const attr of Array.from(to.attributes)) {
        if (stateful && attr.name === 'hidden') continue;
        if (preserveToggle && attr.name === 'aria-expanded') continue;
        if (preserveBusy && (attr.name === 'aria-busy' || attr.name === 'data-orig-text' || attr.name === 'data-busy-until' || attr.name === 'data-busy-provider')) continue;
        if (preserveBusy && attr.name === 'class') {
          const wanted = attr.value
            ? (attr.value.split(/\\s+/).includes('is-busy') ? attr.value : attr.value + ' is-busy')
            : 'is-busy';
          if (from.getAttribute('class') !== wanted) from.setAttribute('class', wanted);
          continue;
        }
        if (from.getAttribute(attr.name) !== attr.value) from.setAttribute(attr.name, attr.value);
      }
    };
    const keyOf = (n) => {
      if (n.nodeType !== 1) return null;
      const explicit = n.getAttribute('data-card-key') || n.id;
      if (explicit) return explicit;
      if (n.classList.contains('unsaved-banner')) return 'unsaved-banner';
      if (n.classList.contains('hero-card')) return 'hero-card';
      return null;
    };
    // Keyed reconcile: matched nodes are moved, never recreated, so hover, focus and
    // CSS transitions survive reorders (e.g. a card becoming the active hero).
    const reconcileChildren = (parent, nextKids) => {
      const original = Array.from(parent.childNodes);
      const byKey = new Map();
      for (const n of original) {
        const k = keyOf(n);
        if (k) byKey.set(k, n);
      }
      const used = new Set();
      let ref = parent.firstChild;
      for (const b of nextKids) {
        const k = keyOf(b);
        let match = null;
        if (k) {
          const found = byKey.get(k);
          if (found && !used.has(found)) match = found;
        } else if (ref && !used.has(ref) && !keyOf(ref) && ref.nodeName === b.nodeName) {
          match = ref;
        }
        if (match) {
          used.add(match);
          if (match === ref) ref = ref.nextSibling;
          else parent.insertBefore(match, ref);
          morph(match, b);
        } else {
          const fresh = b.cloneNode(true);
          used.add(fresh);
          parent.insertBefore(fresh, ref);
        }
      }
      for (const n of original) {
        if (!used.has(n) && n.parentNode === parent) parent.removeChild(n);
      }
    };
    const morph = (from, to) => {
      if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) {
        from.replaceWith(to.cloneNode(true));
        return;
      }
      if (from.nodeType === Node.TEXT_NODE || from.nodeType === Node.COMMENT_NODE) {
        if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
        return;
      }
      if (from.nodeType !== Node.ELEMENT_NODE) return;
      if (from.id === 'search-result-count') return;
      if (
        from.classList.contains('btn-cli-only') &&
        to.classList.contains('is-claimed') &&
        from.classList.contains('is-busy')
      ) {
        clearBusy(from);
      }
      if (
        isLocallyBusy(from) &&
        (!from.dataset.busyProvider || from.dataset.busyProvider === selectedProvider)
      ) {
        syncAttrs(from, to);
        if (to.textContent !== null && to.textContent !== undefined) {
          from.dataset.origText = to.textContent;
        }
        return;
      }
      if (from.nodeName === 'INPUT') {
        syncAttrs(from, to);
        return;
      }
      if (from.nodeName === 'svg' || from.nodeName === 'SVG') {
        if (from.outerHTML !== to.outerHTML) syncSvg(from, to);
        return;
      }
      syncAttrs(from, to);
      reconcileChildren(from, Array.from(to.childNodes));
    };
    const syncSvg = (from, to) => {
      syncAttrs(from, to);
      const fromKids = Array.from(from.childNodes);
      const toKids = Array.from(to.childNodes);
      if (fromKids.length !== toKids.length) {
        from.innerHTML = to.innerHTML;
        return;
      }
      for (let i = 0; i < toKids.length; i++) {
        const a = fromKids[i];
        const b = toKids[i];
        if (a.nodeType === 1 && b.nodeType === 1 && a.nodeName === b.nodeName) syncAttrs(a, b);
        else if (a.nodeType === 3 && b.nodeType === 3) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; }
        else a.replaceWith(b.cloneNode(true));
      }
    };

    syncDrawers();
    restoreSearch(((vscode.getState() || {}).provider), true);
    requestAnimationFrame(() => window.scrollTo(0, Number(deckState().scrollY) || 0));

    document.addEventListener('input', (event) => {
      const search = document.getElementById('vault-search');
      if (!search || event.target !== search) return;
      filterCards();
      saveDeck({ query: search.value, focusSearch: true, caret: search.selectionStart });
    });
    document.addEventListener('focusin', (event) => {
      const search = document.getElementById('vault-search');
      if (search && event.target !== search) saveDeck({ focusSearch: false });
    });
    window.addEventListener('blur', () => {
      saveDeck({ focusSearch: false });
    });

    let scrollPending = false;
    window.addEventListener('scroll', () => {
      if (scrollPending) return;
      scrollPending = true;
      const scrollProvider = selectedProvider;
      requestAnimationFrame(() => {
        if (scrollProvider === selectedProvider) {
          saveDeck({ scrollY: window.scrollY }, scrollProvider);
        }
        scrollPending = false;
      });
    }, { passive: true });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || !root) return;
      if (msg.type === 'CLEAR_BUSY') {
        clearBusy(null, msg);
        return;
      }
      if (msg.type !== 'PATCH_DOM') return;
      const prevProvider = selectedProvider;
      selectedProvider = msg.selectedProvider || selectedProvider;
      const tpl = document.createElement('template');
      tpl.innerHTML = msg.bodyHtml;
      if (prevProvider !== selectedProvider) {
        // Deck flip: reconcile cleanly without innerHTML flash while snapping new gauges without cross-deck tweening.
        document.body.classList.add('deck-snap');
        reconcileChildren(root, Array.from(tpl.content.childNodes));
        syncDrawers();
        restoreSearch(prevProvider, false);
        window.scrollTo(0, Number(deckState().scrollY) || 0);
        requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('deck-snap')));
        return;
      }
      reconcileChildren(root, Array.from(tpl.content.childNodes));
      syncDrawers();
      restoreSearch(prevProvider, false);
    });

    // Scoped per-button busy state: acknowledge the click instantly without unblocking other in-flight actions.
    const clearBusy = (only, scope) => {
      const candidates = only ? [only] : Array.from(document.querySelectorAll('.is-busy'));
      const targets = only || !scope || !scope.action
        ? candidates
        : candidates.filter((el) => {
            if (el.getAttribute('data-action') !== scope.action) return false;
            if (scope.provider && (el.dataset.busyProvider || el.getAttribute('data-provider')) !== scope.provider) return false;
            if (scope.profileId && el.getAttribute('data-profile-id') !== scope.profileId) return false;
            return true;
          });
      for (const el of targets) {
        if (!el.classList.contains('is-busy')) continue;
        el.classList.remove('is-busy');
        el.removeAttribute('aria-busy');
        delete el.dataset.busyUntil;
        delete el.dataset.busyProvider;
        if (el.dataset.origText !== undefined) {
          el.textContent = el.dataset.origText;
          delete el.dataset.origText;
        }
      }
    };
    document.addEventListener('click', (e) => {
      const toggleBtn = e.target.closest('[data-toggle-drawer]');
      if (toggleBtn) {
        const drawerId = toggleBtn.getAttribute('data-toggle-drawer');
        if (drawerId) {
          const saved = Array.isArray(deckState().expandedCardIds) ? [...deckState().expandedCardIds] : [];
          const idx = saved.indexOf(drawerId);
          const opening = idx < 0;
          if (idx >= 0) saved.splice(idx, 1);
          else saved.push(drawerId);
          saveDeck({ expandedCardIds: saved });
          syncDrawers();
          if (opening) {
            const drawerEl = document.querySelector('[data-drawer-for="' + drawerId.replace(/"/g, '\\"') + '"]');
            if (drawerEl) {
              drawerEl.classList.add('is-opening');
              drawerEl.addEventListener('animationend', () => drawerEl.classList.remove('is-opening'), { once: true });
              setTimeout(() => drawerEl.classList.remove('is-opening'), 180);
            }
          }
        }
        return;
      }
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.classList.contains('is-busy')) return;
      const action = btn.getAttribute('data-action');
      const provider = btn.getAttribute('data-provider');
      const profileId = btn.getAttribute('data-profile-id');
      const cliOnly = btn.getAttribute('data-cli-only') === 'true';
      const focusingClaimed = action === 'SWITCH_PROFILE' && cliOnly && btn.classList.contains('is-claimed');
      const heavy = !focusingClaimed && (action === 'SWITCH_PROFILE' || action === 'ADD_ACCOUNT' || action === 'REFRESH_ALL' || action === 'REFRESH_SINGLE' || action === 'SAVE_ACTIVE');
      if (heavy && !btn.classList.contains('is-disabled')) {
        btn.dataset.origText = btn.textContent;
        btn.dataset.busyUntil = String(Date.now() + 5500);
        btn.dataset.busyProvider = provider || '';
        btn.classList.add('is-busy');
        btn.setAttribute('aria-busy', 'true');
        if (action === 'SWITCH_PROFILE') {
          btn.textContent = cliOnly ? 'Launching...' : 'Switching...';
        }
        if (action === 'REFRESH_ALL') btn.textContent = 'Refreshing...';
        if (action === 'SAVE_ACTIVE') btn.textContent = 'Saving...';
        setTimeout(() => { if (btn.isConnected) clearBusy(btn); }, 5500);
      }
      if (action === 'SELECT_PROVIDER' && provider !== selectedProvider) saveDeck({ focusSearch: false });
      vscode.postMessage({
        type: action,
        provider,
        profileId,
        cliOnly
      });
    });
    document.addEventListener('keydown', (e) => {
      const search = document.getElementById('vault-search');
      if (!search) return;
      const active = document.activeElement;
      const inInput = Boolean(
        active && (active === search || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
      );
      if (e.key === '/' && !inInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        search.focus();
        if (typeof search.select === 'function') search.select();
        saveDeck({ focusSearch: true, caret: search.value.length });
      } else if (e.key === 'Escape' && active === search) {
        if (search.value) {
          search.value = '';
          filterCards();
          saveDeck({ query: '', focusSearch: false });
        } else {
          saveDeck({ focusSearch: false });
        }
        if (typeof search.blur === 'function') search.blur();
      }
    });
  </script>
</body>
</html>`;
  }

  private renderHeroActions(provider: ActiveProviderId, activeProfile: ProfileMetadata | null): string {
    if (!activeProfile) return '';
    const id = escapeHtml(activeProfile.id);
    return `<div class="hero-actions" data-card-key="hero-actions" aria-label="Active account actions">
      <div class="card-icon-btns">
        <button class="btn-icon" data-action="REFRESH_SINGLE" data-provider="${provider}" data-profile-id="${id}" title="Refresh limits" aria-label="Refresh limits for ${escapeHtml(activeProfile.name)}">↻</button>
        <button class="btn-icon" data-action="RENAME_PROFILE" data-provider="${provider}" data-profile-id="${id}" title="Rename account" aria-label="Rename ${escapeHtml(activeProfile.name)}">✎</button>
        <button class="btn-icon danger is-disabled" data-action="DELETE_PROFILE" data-provider="${provider}" data-profile-id="${id}" aria-disabled="true" title="Switch to another account or use + Add Account to make inactive before deleting" aria-label="Delete locked while ${escapeHtml(activeProfile.name)} is active in the IDE">✕</button>
      </div>
    </div>`;
  }

  private renderReauthBanner(
    provider: ActiveProviderId,
    authStatus?: string,
    authErrorCode?: string
  ): string {
    if (authStatus !== 'revoked' && authStatus !== 'expired') return '';
    const codeNote = authErrorCode ? ` (${escapeHtml(authErrorCode)})` : '';
    return `
      <div class="reauth-banner" data-card-key="hero-reauth" role="alert">
        <div class="reauth-copy">Session revoked or signed out${codeNote}. Re-authenticate to restore live access.</div>
        <button class="btn-reauth" data-action="ADD_ACCOUNT" data-provider="${provider}">Start Re-Login</button>
      </div>`;
  }

  private renderVerifyBanner(
    provider: ActiveProviderId,
    authStatus?: string,
    profileId?: string
  ): string {
    if (authStatus !== 'unverified') return '';
    const idAttr = profileId ? ` data-profile-id="${escapeHtml(profileId)}"` : '';
    return `
      <div class="verify-banner" data-card-key="hero-verify" role="status">
        <div class="verify-copy">Verification needed: complete Google phone/QR verification in Antigravity to unlock quota.</div>
        <button class="btn-verify" data-action="VERIFY_ACCOUNT" data-provider="${provider}"${idAttr}>Verify Account</button>
      </div>`;
  }

  private renderPitstopBanner(
    provider: ActiveProviderId,
    bestStandby: BestStandbyRecommendation | null,
    activeMinPct: number | null,
    activeNeedsAction: boolean,
    activeBottleneck: { label: string; pct: number } | null = null
  ): string {
    if (!bestStandby) return '';
    const name = escapeHtml(bestStandby.profile.name);
    const id = escapeHtml(bestStandby.profile.id);
    const lead = activeNeedsAction
      ? 'Standby failover ready'
      : activeBottleneck && (activeMinPct === null || activeMinPct >= 15)
        ? activeBottleneck.pct === 0
          ? `${activeBottleneck.label} depleted (0%)`
          : `Low ${activeBottleneck.label} (${activeBottleneck.pct}%)`
        : activeMinPct !== null
          ? activeMinPct === 0
            ? 'Active pool depleted (0%)'
            : `Low reserve (${activeMinPct}%)`
          : 'Standby failover ready';
    return `
      <div class="pitstop-banner" data-card-key="hero-pitstop" role="status">
        <div class="pitstop-copy">${lead} · Best standby: <strong>${name}</strong> (${bestStandby.scorePct}%)</div>
        <button class="btn-pitstop" data-action="SWITCH_PROFILE" data-provider="${provider}" data-profile-id="${id}" data-cli-only="false" title="Switch immediately to ${escapeHtml(bestStandby.profile.email || bestStandby.profile.name)}">⇄ Switch Best</button>
      </div>`;
  }

  private renderAntigravityHero(
    activeProfile: ProfileMetadata | null,
    sessionKind: SessionKind,
    liveSession: LiveSessionInfo,
    liveMetrics: CachedQuotaMetric | null,
    formatReset: (iso?: string) => string,
    isHeroClaimed = false,
    pitstopHtml = ''
  ): string {
    const unsavedBanner = sessionKind === 'unsaved'
      ? `
      <div class="unsaved-banner">
        <div class="unsaved-info">
          <span class="unsaved-title">UNSAVED ACTIVE SESSION</span>
          <span class="unsaved-email">${escapeHtml(liveSession.email)}</span>
        </div>
        <button class="btn-save-unsaved" data-card-key="save-unsaved" data-action="SAVE_ACTIVE" data-provider="antigravity">Save to Vault</button>
      </div>`
      : '';

    if (!activeProfile && sessionKind !== 'unsaved') {
      const message = sessionKind === 'unidentified'
        ? 'Antigravity credentials found, but the account identity is unavailable.'
        : 'No active Antigravity account signed in.';
      return `<div class="hero-card" data-card-key="hero-card"><div class="empty-state">${message}</div>${pitstopHtml}</div>`;
    }

    const authStatus = resolveEffectiveAuthStatus(activeProfile?.authStatus, liveSession.authStatus);
    const authErrorCode = activeProfile?.authErrorCode || liveSession.authErrorCode;
    const needsReauth = authStatus === 'revoked' || authStatus === 'expired';
    const needsVerify = !needsReauth && authStatus === 'unverified';
    const isMutedGauge = needsReauth || needsVerify;
    const rawMetric = liveMetrics || activeProfile?.cachedQuota;
    const m = needsReauth ? rawMetric : healExpiredAntigravityMetric(rawMetric);
    const plan = (activeProfile?.planOverride || m?.plan || 'FREE').toUpperCase();
    const planClass = plan === 'FREE' ? 'free' : plan === 'ULTRA' ? 'ultra' : '';
    const displayName = activeProfile
      ? activeProfile.name
      : (liveSession.email || 'Active').split('@')[0];
    const displayEmail = activeProfile ? activeProfile.email : liveSession.email || '';

    const g5h = m?.gemini5h || m?.gemini || '--';
    const g7d = m?.gemini7d || m?.gemini || '--';
    const c5h = plan === 'FREE' ? '--' : m?.claude5h || '--';
    const c7d = plan === 'FREE' ? '--' : m?.claude7d || m?.claudeGpt || '--';
    const hasStandaloneCarbon =
      plan !== 'FREE' &&
      Boolean(m?.carbon && m.carbon !== '--' && m.carbon !== 'incl.');

    const g5Pct = parsePercent(g5h);
    const g7Pct = parsePercent(g7d);
    const gRst =
      g5Pct !== null && (g7Pct === null || g5Pct < g7Pct)
        ? formatReset(m?.gemini5hReset || m?.geminiReset)
        : formatReset(m?.gemini7dReset || m?.geminiReset);

    const c5Pct = parsePercent(c5h);
    const c7Pct = parsePercent(c7d);
    const cRst =
      c5Pct !== null && (c7Pct === null || c5Pct < c7Pct)
        ? formatReset(m?.claude5hReset || m?.claudeReset)
        : formatReset(m?.claude7dReset || m?.claudeReset);
    const cbRst = formatReset(m?.carbonReset);

    const wheelsList = [
      renderRadialWheel('Gemini', m?.gemini || g7d, gRst || '5h + 7d', undefined, isMutedGauge),
      renderRadialWheel(
        'Claude/GPT',
        plan === 'FREE' ? '--' : m?.claudeGpt || c7d,
        plan === 'FREE' ? 'Pro+ only' : cRst || '5h + 7d',
        undefined,
        isMutedGauge
      )
    ];
    if (hasStandaloneCarbon && m?.carbon) {
      wheelsList.push(
        renderRadialWheel('Carbon', m.carbon, cbRst || 'Weekly', undefined, isMutedGauge)
      );
    }
    const wheels = wheelsList.join('');

    const pools = [
      renderPoolBarRow('Gemini · 5h Fast Pool', g5h, formatReset(m?.gemini5hReset), undefined, 'In Gemini', isMutedGauge),
      renderPoolBarRow('Gemini · 7d Weekly Pool', g7d, formatReset(m?.gemini7dReset || m?.geminiReset), undefined, 'In Gemini', isMutedGauge),
      ...(plan !== 'FREE'
        ? [
            renderPoolBarRow('Claude & GPT · 5h Fast Pool', c5h, formatReset(m?.claude5hReset), undefined, 'In Gemini', isMutedGauge),
            renderPoolBarRow('Claude & GPT · 7d Pool', c7d, formatReset(m?.claude7dReset || m?.claudeReset), undefined, 'In Gemini', isMutedGauge),
            ...(hasStandaloneCarbon && m?.carbon
              ? [renderPoolBarRow('Gemini 4 Carbon · Extra Pool', m.carbon, cbRst, undefined, 'In Gemini', isMutedGauge)]
              : [])
          ]
        : [])
    ].join('');

    const staleFreshness = m?.updatedAt
      ? `Stale snapshot (${escapeHtml(formatTimeAgo(m.updatedAt))}) · Re-auth for live quota`
      : 'Stale snapshot · Re-auth for live quota';
    const verifyFreshness = 'Verification needed · Complete Google check in Antigravity';

    return `
      ${unsavedBanner}
      <div class="hero-card ${needsReauth ? 'needs-reauth' : needsVerify ? 'needs-verify' : ''}" data-card-key="hero-card">
        <div class="hero-watermark" data-card-key="hero-watermark" aria-hidden="true">${antigravityGlyph}</div>
        <div class="hero-header" data-card-key="hero-header">
          <div class="hero-identity">
            <div class="hero-name-row">
              <span class="hero-name">${escapeHtml(displayName)}</span>
              <span class="plan-badge ${planClass}">${escapeHtml(plan)}</span>
              ${needsReauth ? '<span class="reauth-badge">RE-AUTH</span><span class="stale-badge">STALE</span>' : needsVerify ? '<span class="verify-badge">VERIFY NEEDED</span>' : ''}
              ${isHeroClaimed ? '<span class="claimed-tag" title="Dedicated terminal session also claimed on this profile">CLI CLAIMED</span>' : ''}
            </div>
            <div class="hero-email">${escapeHtml(displayEmail)}</div>
            <div class="hero-freshness">${needsReauth ? staleFreshness : needsVerify ? verifyFreshness : liveMetrics ? 'Live quota' : m?.updatedAt ? `Cached · ${escapeHtml(formatTimeAgo(m.updatedAt))}` : 'Quota unavailable'}</div>
          </div>
        </div>
        ${this.renderReauthBanner('antigravity', authStatus, authErrorCode)}
        ${this.renderVerifyBanner('antigravity', authStatus, activeProfile?.id)}
        ${pitstopHtml}
        <div class="wheels-grid${wheelsList.length === 4 ? ' wheels-4' : ''}" data-card-key="hero-wheels" style="--gauge-count:${wheelsList.length}">${wheels}</div>
        <div class="pools-list" data-card-key="hero-pools">${pools}</div>
        ${this.renderHeroActions('antigravity', activeProfile)}
      </div>
    `;
  }

  private renderCodexHero(
    activeProfile: ProfileMetadata | null,
    sessionKind: SessionKind,
    liveSession: LiveSessionInfo,
    liveMetrics: CachedQuotaMetric | null,
    isHeroClaimed = false,
    pitstopHtml = ''
  ): string {
    const unsavedBanner = sessionKind === 'unsaved'
      ? `
      <div class="unsaved-banner">
        <div class="unsaved-info">
          <span class="unsaved-title">UNSAVED CODEX SESSION</span>
          <span class="unsaved-email">${escapeHtml(liveSession.email)}</span>
        </div>
        <button class="btn-save-unsaved" data-card-key="save-unsaved" data-action="SAVE_ACTIVE" data-provider="codex">Save to Vault</button>
      </div>`
      : '';

    if (!activeProfile && sessionKind !== 'unsaved') {
      const message = sessionKind === 'unidentified'
        ? 'Codex credentials found, but the account identity is unavailable. Refresh the Codex sign-in before saving.'
        : 'No active Codex session found in ~/.codex/auth.json.';
      return `<div class="hero-card" data-card-key="hero-card"><div class="empty-state">${message}</div>${pitstopHtml}</div>`;
    }

    const authStatus = resolveEffectiveAuthStatus(activeProfile?.authStatus, liveSession.authStatus);
    const authErrorCode = activeProfile?.authErrorCode || liveSession.authErrorCode;
    const needsReauth = authStatus === 'revoked' || authStatus === 'expired';
    const rawMetric = liveMetrics || activeProfile?.cachedQuota;
    const m = codexMetricForDisplay(
      needsReauth ? rawMetric : healExpiredCodexMetric(rawMetric),
      activeProfile?.authMode || liveSession.authMode
    );
    const isApiKey = activeProfile?.authMode === 'apikey' || liveSession.authMode === 'apikey' || m?.plan === 'API_KEY';
    const plan = (
      activeProfile?.planOverride ||
      m?.plan ||
      liveSession.planTier ||
      (isApiKey ? 'API_KEY' : 'PLUS')
    ).toUpperCase();
    const planClass = plan === 'FREE' ? 'free' : '';
    const displayName = activeProfile
      ? activeProfile.name
      : (liveSession.email || 'Active').split('@')[0];
    const displayEmail = activeProfile ? activeProfile.email : liveSession.email || '';

    const c5h = m?.codex5h || '--';
    const c7d = m?.codex7d || '--';
    const rst5h = m?.codex5hReset || '';
    const rst7d = m?.codex7dReset || '';
    const isFreeSingleWindow = plan === 'FREE' && (!c7d || c7d === '--');
    const hasCodexLivePools = c5h !== '--' || c7d !== '--';
    const hasExplicitCodeReview = Boolean(m?.codexCodeReview && m.codexCodeReview !== '--');
    const showIncludedCodeReview = !hasExplicitCodeReview && plan !== 'FREE' && !isApiKey && hasCodexLivePools;

    const wheelsList = [
      renderRadialWheel(
        isFreeSingleWindow ? 'Primary Pool' : '5h Fast Pool',
        c5h,
        rst5h ? `Resets ${rst5h}` : isFreeSingleWindow ? 'Active Window' : '5h Window',
        undefined,
        needsReauth
      ),
      renderRadialWheel(
        '7d Weekly',
        c7d,
        isFreeSingleWindow ? 'Plus+ only' : rst7d ? `Resets ${rst7d}` : '7d Window',
        undefined,
        needsReauth
      )
    ];
    if (hasExplicitCodeReview && m?.codexCodeReview) {
      wheelsList.push(
        renderRadialWheel(
          'Code Review',
          m.codexCodeReview,
          m.codexCodeReviewReset ? `Resets ${m.codexCodeReviewReset}` : 'PR allowance',
          undefined,
          needsReauth
        )
      );
    } else if (showIncludedCodeReview) {
      wheelsList.push(
        renderRadialWheel(
          'Code Review',
          'incl.',
          'On demand',
          c5h !== '--' ? c5h : c7d,
          needsReauth
        )
      );
    }

    const poolsList = [
      renderPoolBarRow(
        isFreeSingleWindow ? 'Codex · Primary Allowance Pool' : 'Codex · 5-Hour Fast Pool',
        c5h,
        rst5h,
        undefined,
        'In Gemini',
        needsReauth
      ),
      ...(isFreeSingleWindow
        ? []
        : [renderPoolBarRow('Codex · 7-Day Weekly Pool', c7d, rst7d, undefined, 'In Gemini', needsReauth)])
    ];
    if (hasExplicitCodeReview && m?.codexCodeReview) {
      poolsList.push(
        renderPoolBarRow('Codex · Code Review Pool', m.codexCodeReview, m.codexCodeReviewReset, undefined, 'In Gemini', needsReauth)
      );
    } else if (showIncludedCodeReview) {
      poolsList.push(
        renderPoolBarRow(
          'Codex · Code Review Pool',
          'incl.',
          undefined,
          c5h !== '--' ? c5h : c7d,
          'On demand',
          needsReauth
        )
      );
    }

    const extraBadges: string[] = [];
    if (typeof m?.codexResetCredits === 'number' && m.codexResetCredits > 0) {
      extraBadges.push(`<span class="plan-badge">⚡ ${m.codexResetCredits} Reset Credit${m.codexResetCredits > 1 ? 's' : ''}</span>`);
    }
    if (m?.codexCreditsBalance) {
      extraBadges.push(`<span class="plan-badge">${escapeHtml(m.codexCreditsBalance)}</span>`);
    }
    const resetCreditsNote = extraBadges.length
      ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-left:auto;">${extraBadges.join('')}</div>`
      : '';
    const staleFreshness = m?.updatedAt
      ? `Stale snapshot (${escapeHtml(formatTimeAgo(m.updatedAt))}) · Re-auth for live quota`
      : 'Stale snapshot · Re-auth for live quota';

    return `
      ${unsavedBanner}
      <div class="hero-card ${needsReauth ? 'needs-reauth' : ''}" data-card-key="hero-card">
        <div class="hero-watermark" data-card-key="hero-watermark" aria-hidden="true">${codexRegularGlyph}</div>
        <div class="hero-header" data-card-key="hero-header">
          <div class="hero-identity">
            <div class="hero-name-row">
              <span class="hero-name">${escapeHtml(displayName)}</span>
              <span class="plan-badge ${planClass}">CODEX · ${escapeHtml(plan)}</span>
              ${needsReauth ? '<span class="reauth-badge">RE-AUTH</span><span class="stale-badge">STALE</span>' : ''}
              ${isHeroClaimed ? '<span class="claimed-tag" title="Dedicated terminal session also claimed on this profile">CLI CLAIMED</span>' : ''}
            </div>
            <div class="hero-email">${escapeHtml(displayEmail)}</div>
            <div class="hero-freshness">${needsReauth ? staleFreshness : isApiKey ? 'Usage unavailable for API key' : m?.updatedAt ? `Updated ${escapeHtml(formatTimeAgo(m.updatedAt))}` : 'Quota not yet synced'}</div>
          </div>
          ${resetCreditsNote}
        </div>
        ${this.renderReauthBanner('codex', authStatus, authErrorCode)}
        ${pitstopHtml}
        ${isApiKey ? '<div class="quota-unavailable" data-card-key="hero-quota-unavailable">Codex rate windows are unavailable for API key sessions.</div>' : `<div class="wheels-grid" data-card-key="hero-wheels" style="--gauge-count:${wheelsList.length}">${wheelsList.join('')}</div><div class="pools-list" data-card-key="hero-pools">${poolsList.join('')}</div>`}
        ${this.renderHeroActions('codex', activeProfile)}
      </div>
    `;
  }

  private renderMiniMetricCell(
    label: string,
    valStr: string | undefined,
    linkedValStr?: string,
    isStale = false
  ): string {
    const safe = valStr && valStr !== '--' ? valStr : '--';
    const pct = safe === 'incl.' ? (parsePercent(linkedValStr) ?? 100) : parsePercent(safe);
    const colors = getGaugeColor(pct, isStale);
    const widthPct = pct !== null ? pct : 0;
    return `
      <div class="mini-metric">
        <div class="mini-metric-top">
          <span class="mini-label">${escapeHtml(label)}</span>
          <span class="mini-val" style="color:${colors.text};">${escapeHtml(safe)}</span>
        </div>
        <div class="mini-track">
          <div class="mini-fill" style="width:${widthPct}%; background:${colors.stroke};"></div>
        </div>
      </div>
    `;
  }

  private renderStandbyDrawer(
    provider: ActiveProviderId,
    p: ProfileMetadata,
    m: CachedQuotaMetric | undefined,
    plan: string,
    formatReset: (iso?: string) => string,
    isActive = false
  ): string {
    const id = escapeHtml(p.id);
    const needsReauth = p.authStatus === 'revoked' || p.authStatus === 'expired';
    const needsVerify = !needsReauth && p.authStatus === 'unverified';
    const isMutedGauge = needsReauth || needsVerify;
    const reauthHeadline = p.authStatus === 'expired'
      ? 'OAuth token expired'
      : 'OAuth session revoked or signed out';
    const reauthGuidance = isActive
      ? 'Click Start Re-Login above to re-authenticate.'
      : 'Click ⇄ Switch to load and re-authenticate.';
    const verifyGuidance = isActive
      ? 'Click Verify Account above to complete Google verification.'
      : 'CLI Only is locked until verified. Click ⇄ Switch to verify in Antigravity.';
    const reauthNote = needsReauth
      ? `<div class="drawer-reauth-note">${reauthHeadline}${p.authErrorCode ? ` (${escapeHtml(p.authErrorCode)})` : ''}. ${reauthGuidance}</div>`
      : needsVerify
        ? `<div class="drawer-verify-note">Verification needed${p.authErrorCode ? ` (${escapeHtml(p.authErrorCode)})` : ''}. ${verifyGuidance}</div>`
        : '';

    let bodyHtml = '';
    if (provider === 'codex') {
      const isApiKey = p.authMode === 'apikey' || plan === 'API_KEY';
      if (isApiKey) {
        bodyHtml = '<div class="drawer-note">Rate windows unavailable for API key sessions.</div>';
      } else {
        const c5h = m?.codex5h || '--';
        const c7d = m?.codex7d || '--';
        const isFreeSingle = plan === 'FREE' && (!c7d || c7d === '--');
        const hasCodexPools = c5h !== '--' || c7d !== '--';
        const hasExplicitReview = Boolean(m?.codexCodeReview && m.codexCodeReview !== '--');
        const showIncludedReview = !hasExplicitReview && plan !== 'FREE' && hasCodexPools;
        const rows = [
          renderPoolBarRow(
            isFreeSingle ? 'Codex · Primary Allowance Pool' : 'Codex · 5-Hour Fast Pool',
            c5h,
            m?.codex5hReset,
            undefined,
            'In Gemini',
            needsReauth
          ),
          ...(isFreeSingle ? [] : [renderPoolBarRow('Codex · 7-Day Weekly Pool', c7d, m?.codex7dReset, undefined, 'In Gemini', needsReauth)]),
          ...(hasExplicitReview && m?.codexCodeReview
            ? [renderPoolBarRow('Codex · Code Review Pool', m.codexCodeReview, m.codexCodeReviewReset, undefined, 'In Gemini', needsReauth)]
            : showIncludedReview
              ? [
                  renderPoolBarRow(
                    'Codex · Code Review Pool',
                    'incl.',
                    undefined,
                    c5h !== '--' ? c5h : c7d,
                    'On demand',
                    needsReauth
                  )
                ]
              : [])
        ];
        bodyHtml = `<div class="pools-list drawer-pools">${rows.join('')}</div>`;
      }
    } else {
      const g5h = m?.gemini5h || m?.gemini || '--';
      const g7d = m?.gemini7d || m?.gemini || '--';
      const c5h = plan === 'FREE' ? '--' : m?.claude5h || '--';
      const c7d = plan === 'FREE' ? '--' : m?.claude7d || m?.claudeGpt || '--';
      const hasStandaloneCarbon =
        plan !== 'FREE' &&
        Boolean(m?.carbon && m.carbon !== '--' && m.carbon !== 'incl.');

      const rows = [
        renderPoolBarRow('Gemini · 5h Fast Pool', g5h, formatReset(m?.gemini5hReset), undefined, 'In Gemini', isMutedGauge),
        renderPoolBarRow('Gemini · 7d Weekly Pool', g7d, formatReset(m?.gemini7dReset || m?.geminiReset), undefined, 'In Gemini', isMutedGauge),
        ...(plan !== 'FREE'
          ? [
              renderPoolBarRow('Claude & GPT · 5h Fast Pool', c5h, formatReset(m?.claude5hReset), undefined, 'In Gemini', isMutedGauge),
              renderPoolBarRow('Claude & GPT · 7d Pool', c7d, formatReset(m?.claude7dReset || m?.claudeReset), undefined, 'In Gemini', isMutedGauge),
              ...(hasStandaloneCarbon && m?.carbon
                ? [renderPoolBarRow('Gemini 4 Carbon · Extra Pool', m.carbon, formatReset(m?.carbonReset), undefined, 'In Gemini', isMutedGauge)]
                : [])
            ]
          : [])
      ];
      bodyHtml = `<div class="pools-list drawer-pools">${rows.join('')}</div>`;
    }

    const extraMetaParts: string[] = [];
    if (typeof m?.codexResetCredits === 'number' && m.codexResetCredits > 0) {
      extraMetaParts.push(`⚡ ${m.codexResetCredits} reset credit${m.codexResetCredits > 1 ? 's' : ''}`);
    }
    if (m?.codexCreditsBalance) {
      extraMetaParts.push(m.codexCreditsBalance);
    }

    return `
      <div class="card-drawer" id="drawer-${id}" data-drawer-for="${id}" data-provider="${provider}" hidden>
        <div class="drawer-meta">
          <span class="drawer-email">${escapeHtml(p.email)}</span>
          ${extraMetaParts.length ? `<span class="drawer-extras">${escapeHtml(extraMetaParts.join(' · '))}</span>` : ''}
        </div>
        ${reauthNote}
        ${bodyHtml}
      </div>
    `;
  }

  private renderAntigravityProfileCard(
    p: ProfileMetadata,
    isActive: boolean,
    liveMetrics: CachedQuotaMetric | null,
    formatReset: (iso?: string) => string,
    isCliReady: boolean = false,
    isCliClaimed: boolean = false,
    isNextUp: boolean = false
  ): string {
    const needsReauth = p.authStatus === 'revoked' || p.authStatus === 'expired';
    const needsVerify = !needsReauth && p.authStatus === 'unverified';
    const isMutedGauge = needsReauth || needsVerify;
    const rawMetric = isActive && liveMetrics ? liveMetrics : p.cachedQuota;
    const m = needsReauth ? rawMetric : healExpiredAntigravityMetric(rawMetric);
    const plan = (p.planOverride || m?.plan || 'FREE').toUpperCase();
    const snap = needsReauth
      ? (m?.updatedAt ? `stale · ${formatTimeAgo(m.updatedAt)}` : 'stale')
      : needsVerify
        ? 'verify needed'
        : isActive
          ? 'live'
          : formatTimeAgo(m?.updatedAt);
    const hasStandaloneCarbon =
      plan !== 'FREE' &&
      Boolean(m?.carbon && m.carbon !== '--' && m.carbon !== 'incl.');
    const id = escapeHtml(p.id);

    const cliBtn = isCliClaimed
      ? `<button class="btn-cli-only is-claimed" data-action="SWITCH_PROFILE" data-provider="antigravity" data-profile-id="${id}" data-cli-only="true" title="Focus the claimed Antigravity CLI terminal running this profile">&gt;_ Focus CLI</button>`
      : needsVerify
        ? `<button class="btn-cli-only is-disabled" data-action="SWITCH_PROFILE" data-provider="antigravity" data-profile-id="${id}" data-cli-only="true" title="CLI Only is locked until this account completes Google verification in the IDE">CLI Locked</button>`
        : `<button class="btn-cli-only" data-action="SWITCH_PROFILE" data-provider="antigravity" data-profile-id="${id}" data-cli-only="true" title="Stage credentials and spawn an isolated Antigravity CLI (agy) terminal without touching the IDE session">CLI Only</button>`;

    const switchBtns = isActive
      ? `<button class="btn-icon btn-drawer-toggle" data-toggle-drawer="${id}" data-provider="antigravity" aria-expanded="false" aria-controls="drawer-${id}">≡ Details</button>`
      : `<button class="btn-switch" data-action="SWITCH_PROFILE" data-provider="antigravity" data-profile-id="${id}" data-cli-only="false" title="${needsVerify ? 'Switch Antigravity IDE to this account to complete Google verification' : 'Switch Antigravity account (surgical daemon respawn)'}">⇄ Switch</button>
         ${cliBtn}`;

    const roleTag = isActive
      ? '<span class="active-tag">ACTIVE</span>'
      : isCliClaimed
        ? '<span class="claimed-tag" title="Dedicated terminal session claimed on this profile">CLI CLAIMED</span>'
        : isNextUp
          ? '<span class="nextup-tag" title="Highest-headroom healthy standby account">NEXT UP</span>'
          : isCliReady
            ? '<span class="active-tag">CLI READY</span>'
            : '';

    return `
      <div class="account-card tone-${profileTone(p.id)} ${needsReauth ? 'needs-reauth' : needsVerify ? 'needs-verify' : isNextUp ? 'is-next-up' : ''}" data-card-key="${id}" data-profile-card data-search="${escapeHtml(`${p.name} ${p.email}`)}">
        <div class="card-top">
          <div class="card-title-group">
            <span class="card-name" title="${escapeHtml(p.email)}">${escapeHtml(p.name)}</span>
            <span class="plan-badge ${plan === 'FREE' ? 'free' : plan === 'ULTRA' ? 'ultra' : ''}">${escapeHtml(plan)}</span>
            ${needsReauth ? '<span class="reauth-badge">RE-AUTH</span><span class="stale-badge">STALE</span>' : needsVerify ? '<span class="verify-badge">VERIFY NEEDED</span>' : ''}
            ${roleTag}
          </div>
          <span class="snap-age">${escapeHtml(snap)}</span>
        </div>
        <div class="card-metrics-strip">
          ${this.renderMiniMetricCell('Gemini', m?.gemini, undefined, isMutedGauge)}
          ${this.renderMiniMetricCell('Claude', plan === 'FREE' ? '--' : m?.claudeGpt, undefined, isMutedGauge)}
          ${hasStandaloneCarbon ? this.renderMiniMetricCell('Carbon', m?.carbon, undefined, isMutedGauge) : ''}
        </div>
        <div class="card-actions">
          <div class="card-primary-btns">${switchBtns}</div>
          <div class="card-icon-btns">
            ${isActive ? '' : `<button class="btn-icon btn-drawer-toggle" data-toggle-drawer="${id}" data-provider="antigravity" aria-expanded="false" aria-controls="drawer-${id}" title="Toggle quota details" aria-label="Toggle quota details for ${escapeHtml(p.name)}">≡</button>`}
            <button class="btn-icon" data-action="REFRESH_SINGLE" data-provider="antigravity" data-profile-id="${id}" title="Refresh limits" aria-label="Refresh limits for ${escapeHtml(p.name)}">↻</button>
            <button class="btn-icon" data-action="RENAME_PROFILE" data-provider="antigravity" data-profile-id="${id}" title="Rename" aria-label="Rename ${escapeHtml(p.name)}">✎</button>
            ${isCliClaimed
              ? `<button class="btn-icon danger is-disabled" data-action="DELETE_PROFILE" data-provider="antigravity" data-profile-id="${id}" aria-disabled="true" title="Close the claimed CLI terminal before deleting" aria-label="Delete locked while CLI terminal is open for ${escapeHtml(p.name)}">✕</button>`
              : `<button class="btn-icon danger" data-action="DELETE_PROFILE" data-provider="antigravity" data-profile-id="${id}" title="Delete" aria-label="Delete ${escapeHtml(p.name)}">✕</button>`}
          </div>
        </div>
        ${this.renderStandbyDrawer('antigravity', p, m, plan, formatReset, isActive)}
      </div>
    `;
  }

  private renderCodexProfileCard(
    p: ProfileMetadata,
    isActive: boolean,
    liveMetrics: CachedQuotaMetric | null,
    isCliReady: boolean = false,
    isCliClaimed: boolean = false,
    isNextUp: boolean = false
  ): string {
    const needsReauth = p.authStatus === 'revoked' || p.authStatus === 'expired';
    const rawMetric = isActive && liveMetrics ? liveMetrics : p.cachedQuota;
    const m = codexMetricForDisplay(
      needsReauth ? rawMetric : healExpiredCodexMetric(rawMetric),
      p.authMode
    );
    const plan = (
      p.planOverride ||
      m?.plan ||
      (p.authMode === 'apikey' ? 'API_KEY' : 'PLUS')
    ).toUpperCase();
    const isFreeSingle = plan === 'FREE' && (!m?.codex7d || m.codex7d === '--');
    const isApiKey = p.authMode === 'apikey' || plan === 'API_KEY';
    const snap = needsReauth
      ? (m?.updatedAt ? `stale · ${formatTimeAgo(m.updatedAt)}` : 'stale')
      : isActive
        ? 'live'
        : formatTimeAgo(m?.updatedAt);
    const id = escapeHtml(p.id);

    const cliBtn = isCliClaimed
      ? `<button class="btn-cli-only is-claimed" data-action="SWITCH_PROFILE" data-provider="codex" data-profile-id="${id}" data-cli-only="true" title="Focus the claimed Codex CLI terminal running this profile">&gt;_ Focus CLI</button>`
      : `<button class="btn-cli-only" data-action="SWITCH_PROFILE" data-provider="codex" data-profile-id="${id}" data-cli-only="true" title="Stage credentials and spawn an isolated Codex CLI (codex --no-daemon) terminal without touching the IDE session">CLI Only</button>`;

    const switchBtns = isActive
      ? `<button class="btn-icon btn-drawer-toggle" data-toggle-drawer="${id}" data-provider="codex" aria-expanded="false" aria-controls="drawer-${id}">≡ Details</button>`
      : `<button class="btn-switch" data-action="SWITCH_PROFILE" data-provider="codex" data-profile-id="${id}" data-cli-only="false" title="Switch Codex account">⇄ Switch</button>
         ${cliBtn}`;

    const roleTag = isActive
      ? '<span class="active-tag">ACTIVE</span>'
      : isCliClaimed
        ? '<span class="claimed-tag" title="Dedicated terminal session claimed on this profile">CLI CLAIMED</span>'
        : isNextUp
          ? '<span class="nextup-tag" title="Highest-headroom healthy standby account">NEXT UP</span>'
          : isCliReady
            ? '<span class="active-tag">CLI READY</span>'
            : '';
    const resetCreditTag =
      !isApiKey && typeof m?.codexResetCredits === 'number' && m.codexResetCredits > 0
        ? `<span class="credits-tag" title="${m.codexResetCredits} Codex rate-limit reset credit${m.codexResetCredits > 1 ? 's' : ''} available">⚡ ${m.codexResetCredits} Reset Credit${m.codexResetCredits > 1 ? 's' : ''}</span>`
        : '';
    const balanceTag =
      !isApiKey && m?.codexCreditsBalance
        ? `<span class="credits-tag balance-tag" title="Available Codex credit balance">${escapeHtml(m.codexCreditsBalance)}</span>`
        : '';

    return `
      <div class="account-card tone-${profileTone(p.id)} ${needsReauth ? 'needs-reauth' : isNextUp ? 'is-next-up' : ''}" data-card-key="${id}" data-profile-card data-search="${escapeHtml(`${p.name} ${p.email}`)}">
        <div class="card-top">
          <div class="card-title-group">
            <span class="card-name" title="${escapeHtml(p.email)}">${escapeHtml(p.name)}</span>
            <span class="plan-badge ${plan === 'FREE' ? 'free' : ''}">${escapeHtml(plan)}</span>
            ${needsReauth ? '<span class="reauth-badge">RE-AUTH</span><span class="stale-badge">STALE</span>' : ''}
            ${roleTag}
            ${resetCreditTag}
            ${balanceTag}
          </div>
          <span class="snap-age">${escapeHtml(snap)}</span>
        </div>
        <div class="card-metrics-strip">
          ${isApiKey ? '<div class="quota-unavailable mini-unavailable">API key usage unavailable</div>' : `${this.renderMiniMetricCell(isFreeSingle ? 'Primary' : '5h Pool', m?.codex5h || '--', undefined, needsReauth)}${isFreeSingle ? '' : this.renderMiniMetricCell('7d Pool', m?.codex7d || '--', undefined, needsReauth)}`}
        </div>
        <div class="card-actions">
          <div class="card-primary-btns">${switchBtns}</div>
          <div class="card-icon-btns">
            ${isActive ? '' : `<button class="btn-icon btn-drawer-toggle" data-toggle-drawer="${id}" data-provider="codex" aria-expanded="false" aria-controls="drawer-${id}" title="Toggle quota details" aria-label="Toggle quota details for ${escapeHtml(p.name)}">≡</button>`}
            <button class="btn-icon" data-action="REFRESH_SINGLE" data-provider="codex" data-profile-id="${id}" title="Refresh limits" aria-label="Refresh limits for ${escapeHtml(p.name)}">↻</button>
            <button class="btn-icon" data-action="RENAME_PROFILE" data-provider="codex" data-profile-id="${id}" title="Rename" aria-label="Rename ${escapeHtml(p.name)}">✎</button>
            ${isCliClaimed
              ? `<button class="btn-icon danger is-disabled" data-action="DELETE_PROFILE" data-provider="codex" data-profile-id="${id}" aria-disabled="true" title="Close the claimed CLI terminal before deleting" aria-label="Delete locked while CLI terminal is open for ${escapeHtml(p.name)}">✕</button>`
              : `<button class="btn-icon danger" data-action="DELETE_PROFILE" data-provider="codex" data-profile-id="${id}" title="Delete" aria-label="Delete ${escapeHtml(p.name)}">✕</button>`}
          </div>
        </div>
        ${this.renderStandbyDrawer('codex', p, m, plan, () => '', isActive)}
      </div>
    `;
  }
}
