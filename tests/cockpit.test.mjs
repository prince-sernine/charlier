import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as esbuild from 'esbuild';

const nodeRequire = createRequire(import.meta.url);
const result = await esbuild.build({
  entryPoints: ['src/sidebar.ts'], bundle: true, platform: 'node', format: 'cjs',
  external: ['vscode'], write: false, logLevel: 'silent'
});
const module = { exports: {} };
const requireModule = (name) => name === 'vscode' ? {} : nodeRequire(name);
new Function('require', 'module', 'exports', '__dirname', result.outputFiles[0].text)(
  requireModule, module, module.exports, path.resolve('dist')
);
const { CharlierSidebarProvider } = module.exports;

const profile = (id, provider = 'codex') => ({
  id, provider, name: `Account ${id}`, email: `${id}@example.test`,
  planOverride: provider === 'codex' ? 'PLUS' : 'PRO', updatedAt: Date.now(),
  cachedQuota: provider === 'codex'
    ? { plan: 'PLUS', gemini: '--', claudeGpt: '--', argon: '--', codex5h: '58%', codex7d: '81%', updatedAt: Date.now(), codex5hWindowMins: 300 }
    : { plan: 'PRO', gemini: '70%', claudeGpt: '20%', argon: '0%', updatedAt: Date.now() }
});
const liveSession = (email = null) => ({ email, accountId: null, hasOAuthCreds: Boolean(email), tokenExpiryDate: null, isExpired: false });
const state = (provider, profiles, activeProfileId = null, sessionKind = 'none') => ({
  selectedProvider: provider,
  antigravity: {
    profiles: provider === 'antigravity' ? profiles : [],
    activeProfileId: provider === 'antigravity' ? activeProfileId : null,
    sessionKind: provider === 'antigravity' ? sessionKind : 'none',
    liveSession: liveSession(provider === 'antigravity' && activeProfileId ? `${activeProfileId}@example.test` : null),
    liveMetrics: null, formatReset: () => ''
  },
  codex: {
    profiles: provider === 'codex' ? profiles : [],
    activeProfileId: provider === 'codex' ? activeProfileId : null,
    sessionKind: provider === 'codex' ? sessionKind : 'none',
    liveSession: liveSession(provider === 'codex' && activeProfileId ? `${activeProfileId}@example.test` : null),
    liveMetrics: null
  }
});

const provider = new CharlierSidebarProvider({});
const html = (frame) => provider.buildHtml(frame);

test('saved Codex active profile appears only in hero without redundant VIEW_DETAILS button', () => {
  const output = html(state('codex', [profile('active'), profile('other')], 'active', 'saved'));
  assert.equal((output.match(/data-profile-card data-search=/g) || []).length, 1);
  assert.doesNotMatch(output, /data-action="VIEW_DETAILS"/);
  assert.match(output, /5h Fast Pool/);
  assert.match(output, /Codex · 7-Day Weekly Pool/);
  assert.match(output, /data-action="REFRESH_SINGLE" data-provider="codex" data-profile-id="active"/);
  assert.match(output, /data-action="RENAME_PROFILE" data-provider="codex" data-profile-id="active"/);
  assert.match(output, /class="btn-icon danger is-disabled" data-action="DELETE_PROFILE" data-provider="codex" data-profile-id="active" aria-disabled="true" title="Switch to another account or use \+ Add Account to make inactive before deleting"/);
  assert.match(output, /class="btn-icon danger" data-action="DELETE_PROFILE" data-provider="codex" data-profile-id="other"/);
  assert.match(output, /data-cli-only="true"/);
  assert.match(output, /data-toggle-drawer="other" data-provider="codex"/);
  assert.match(output, /id="drawer-other" data-drawer-for="other" data-provider="codex" hidden/);
  assert.match(output, /script-src 'nonce-/);
  assert.match(output, /charlier-codex-prompt|<svg[^>]+viewBox="0 0 24 24"/);
});

test('Antigravity hero includes Claude 5h pool inline, preserves .included color, and decks reconcile smoothly', () => {
  const activeAgy = {
    ...profile('active', 'antigravity'),
    cachedQuota: {
      plan: 'PRO', gemini: '80%', gemini5h: '90%', gemini7d: '80%',
      claudeGpt: '55%', claude5h: '65%', claude7d: '55%',
      argon: '100%', carbon: '100%', updatedAt: Date.now()
    }
  };
  const standbyAgy = profile('standby', 'antigravity');
  const proHtml = html(state('antigravity', [activeAgy, standbyAgy], 'active', 'saved'));
  assert.doesNotMatch(proHtml, /data-action="VIEW_DETAILS"/);
  assert.match(proHtml, /Claude &amp; GPT · 5h Fast Pool/);
  assert.match(proHtml, /Claude &amp; GPT · 7d Pool/);
  assert.match(proHtml, /data-toggle-drawer="standby" data-provider="antigravity"/);
  assert.match(proHtml, /id="drawer-standby" data-drawer-for="standby" data-provider="antigravity" hidden/);
  assert.match(proHtml, /deck-snap/);
  assert.match(proHtml, /expandedCardIds/);
  assert.doesNotMatch(proHtml, /root\.innerHTML\s*=\s*['"]/);

  const ultraAgy = {
    ...profile('ultra', 'antigravity'),
    planOverride: 'ULTRA',
    cachedQuota: {
      plan: 'ULTRA', gemini: '100%', gemini5h: '100%', gemini7d: '100%',
      claudeGpt: '80%', claude5h: '90%', claude7d: '80%',
      argon: '--', carbon: '--', updatedAt: Date.now()
    }
  };
  const ultraHtml = html(state('antigravity', [ultraAgy], 'ultra', 'saved'));
  assert.match(ultraHtml, /style="--gauge-count:2"/);
  assert.doesNotMatch(ultraHtml, /Argon/);
  assert.match(ultraHtml, /\.wheel-item\.included \.wheel-center/);

  const freeRow = { ...profile('free-acc', 'antigravity'), name: 'Charlier Labs', planOverride: 'FREE', updatedAt: 900 };
  const proRow = { ...profile('pro-acc', 'antigravity'), name: 'Rénine', planOverride: 'PRO', updatedAt: 100 };
  const sortedHtml = html(state('antigravity', [ultraAgy, freeRow, proRow], 'ultra', 'saved'));
  assert.ok(sortedHtml.indexOf('Rénine') < sortedHtml.indexOf('Charlier Labs'));
});

test('revoked profiles surface RE-AUTH badges, active warning banner, drawer guidance, Code Review parity, and reset credits wording', () => {
  const revokedActive = {
    ...profile('bad1', 'codex'),
    authStatus: 'revoked',
    authErrorCode: 'token_revoked',
    cachedQuota: {
      plan: 'PRO', gemini: '--', claudeGpt: '--', argon: '--',
      codex5h: '80%', codex7d: '65%', codex5hReset: '1s', codex7dReset: '4d 6h',
      codexResetCredits: 3, codexCreditsBalance: '$14.50', updatedAt: Date.now() - 10 * 60_000
    }
  };
  const revokedStandby = {
    ...profile('bad2', 'codex'),
    authStatus: 'revoked',
    authErrorCode: 'invalid_grant',
    cachedQuota: {
      plan: 'PRO', gemini: '--', claudeGpt: '--', argon: '--',
      codex5h: '62%', codex7d: '45%', codex5hReset: '1s', codex7dReset: '5d 2h',
      codexResetCredits: 3, updatedAt: Date.now() - 10 * 60_000
    }
  };
  const claimedStandby = {
    ...profile('cli2', 'codex'),
    cachedQuota: {
      plan: 'PRO', gemini: '--', claudeGpt: '--', argon: '--',
      codex5h: '76%', codex7d: '84%', updatedAt: Date.now() - 60_000
    }
  };
  const frame = state('codex', [revokedActive, revokedStandby, claimedStandby], 'bad1', 'saved');
  frame.codex.claimedProfileIds = ['cli2'];
  const output = html(frame);
  assert.match(output, /class="hero-card needs-reauth"/);
  assert.match(output, /class="reauth-badge">RE-AUTH<\/span>/);
  assert.match(output, /class="stale-badge">STALE<\/span>/);
  assert.match(output, /Stale snapshot \([^)]+\) · Re-auth for live quota/);
  assert.match(output, /class="snap-age">stale · /);
  assert.match(output, /stroke="var\(--quota-unknown\)"/);
  assert.match(output, /class="reauth-banner"[^>]*role="alert"/);
  assert.match(output, /Session revoked or signed out \(token_revoked\)/);
  assert.match(output, /class="drawer-reauth-note">OAuth session revoked or signed out \(invalid_grant\)\. Click ⇄ Switch to load and re-authenticate\./);
  assert.match(output, /Codex · Code Review Pool[\s\S]*On demand/);
  assert.match(output, /⚡ 3 reset credits/);
  assert.match(output, /⚡ 3 Reset Credits/);
  assert.match(output, /\$14\.50/);
  assert.match(output, /hero-card needs-reauth[\s\S]*?5h Fast Pool[\s\S]*?80%/);
  assert.match(output, /account-card[^>]*needs-reauth[\s\S]*?62%/);
  assert.doesNotMatch(output, /5h Fast Pool[\s\S]{0,200}>100%</);
  assert.match(output, /class="claimed-tag"[^>]*>CLI CLAIMED<\/span>/);
  assert.match(output, /class="btn-cli-only is-claimed"[^>]*>&gt;_ Focus CLI<\/button>/);
});

test('unsaved and unidentified sessions never receive destructive hero actions', () => {
  const unsaved = state('antigravity', [], null, 'unsaved');
  unsaved.antigravity.liveSession = liveSession('new@example.test');
  assert.match(html(unsaved), /data-action="SAVE_ACTIVE" data-provider="antigravity"/);
  assert.doesNotMatch(html(unsaved), /data-action="DELETE_PROFILE"/);
  const unidentified = state('codex', [], null, 'unidentified');
  assert.match(html(unidentified), /account identity is unavailable/);
  assert.doesNotMatch(html(unidentified), /data-action="SAVE_ACTIVE"/);
});

test('search appears at six saved accounts and filters only roster cards', () => {
  const five = Array.from({ length: 5 }, (_, i) => profile(`p${i}`));
  assert.doesNotMatch(html(state('codex', five)), /id="vault-search"/);
  const six = [...five, profile('p5')];
  const output = html(state('codex', six, 'p0', 'saved'));
  assert.match(output, /id="vault-search"/);
  assert.equal((output.match(/data-profile-card data-search=/g) || []).length, 5);
  assert.match(output, /No standby accounts match this search/);
  assert.match(output, /vscode\.getState\(\)/);
});

test('API key and missing Codex quota never show a full gauge', () => {
  const key = profile('key');
  key.authMode = 'apikey';
  key.planOverride = 'API_KEY';
  const output = html(state('codex', [key], 'key', 'saved'));
  assert.match(output, /rate windows are unavailable for API key sessions/);
  assert.doesNotMatch(output, />100%</);
  const missing = profile('missing');
  missing.cachedQuota = undefined;
  const unknown = html(state('codex', [missing], 'missing', 'saved'));
  assert.match(unknown, /Quota not yet synced/);
  assert.doesNotMatch(unknown, />100%</);
});

test('all webview actions keep their provider, profile routing, and scoped CLEAR_BUSY payload', async () => {
  const calls = [];
  const posted = [];
  let receive;
  const callbacks = Object.fromEntries([
    'onSelectProvider', 'onSwitchProfile', 'onRefreshAll', 'onRefreshSingle',
    'onSaveActive', 'onAddAccount', 'onRenameProfile', 'onDeleteProfile'
  ].map((name) => [name, async (...args) => { calls.push([name, ...args]); }]));
  const cockpit = new CharlierSidebarProvider(callbacks);
  cockpit.resolveWebviewView({ webview: {
    options: {},
    postMessage: (m) => { posted.push(m); },
    onDidReceiveMessage: (handler) => { receive = handler; }
  } }, {}, {});
  cockpit.render(state('codex', [profile('p1')], 'p1', 'saved'));
  const profileActions = [
    ['SWITCH_PROFILE', 'onSwitchProfile'], ['REFRESH_SINGLE', 'onRefreshSingle'],
    ['RENAME_PROFILE', 'onRenameProfile'], ['DELETE_PROFILE', 'onDeleteProfile']
  ];
  for (const [type, expected] of profileActions) {
    await receive({ type, provider: 'codex', profileId: 'p1', cliOnly: type === 'SWITCH_PROFILE' });
    assert.equal(calls.at(-1)[0], expected);
    assert.equal(calls.at(-1)[1], 'codex');
    assert.equal(calls.at(-1)[2], 'p1');
    const clearMsg = posted.findLast((m) => m.type === 'CLEAR_BUSY');
    assert.deepEqual(clearMsg, { type: 'CLEAR_BUSY', action: type, provider: 'codex', profileId: 'p1' });
  }
  assert.equal(calls[0][3], true);
  for (const [type, expected] of [
    ['SELECT_PROVIDER', 'onSelectProvider'], ['REFRESH_ALL', 'onRefreshAll'],
    ['SAVE_ACTIVE', 'onSaveActive'], ['ADD_ACCOUNT', 'onAddAccount']
  ]) {
    await receive({ type, provider: 'codex' });
    assert.equal(calls.at(-1)[0], expected);
  }
  const before = calls.length;
  await receive({ type: 'DELETE_PROFILE', provider: 'codex', profileId: '../other' });
  await receive({ type: 'SAVE_ACTIVE', provider: 'unknown' });
  assert.equal(calls.length, before);
});

test('cockpit keys hero blocks and wheels, updates busy button origText without flip-flop, and skips redundant visibility reloads', async () => {
  const codexOut = html(state('codex', [profile('p1', 'codex')], 'p1', 'saved'));
  assert.match(codexOut, /data-card-key="hero-header"/);
  assert.match(codexOut, /data-card-key="hero-wheels"/);
  assert.match(codexOut, /data-card-key="hero-pools"/);
  assert.match(codexOut, /data-card-key="hero-actions"/);
  assert.match(codexOut, /data-card-key="wheel-5h Fast Pool"/);
  assert.match(codexOut, /data-card-key="wheel-7d Weekly"/);
  assert.match(codexOut, /data-card-key="wheel-Code Review"/);
  assert.match(codexOut, /if \(to\.textContent !== null && to\.textContent !== undefined\)\s*\{\s*from\.dataset\.origText = to\.textContent;/);
  assert.match(codexOut, /if \(preserveBusy && attr\.name === 'class'\)/);

  let visibilityCb;
  let htmlWrites = 0;
  let currentHtml = '';
  const posted = [];
  const view = {
    visible: true,
    onDidChangeVisibility: (cb) => { visibilityCb = cb; return { dispose() {} }; },
    webview: {
      options: {},
      get html() { return currentHtml; },
      set html(v) { htmlWrites++; currentHtml = v; },
      postMessage: async (m) => { posted.push(m); },
      onDidReceiveMessage: () => {}
    }
  };
  const cockpit = new CharlierSidebarProvider({});
  cockpit.resolveWebviewView(view, {}, {});
  cockpit.render(state('codex', [profile('p1', 'codex')], 'p1', 'saved'));
  assert.equal(htmlWrites, 1);

  // No PATCH_DOM sent yet -> visibility change must NOT trigger redundant full HTML rebuild
  visibilityCb();
  assert.equal(htmlWrites, 1);

  // Retained webview (postMessage === true) delivers PATCH_DOM without triggering full HTML rebuild on show
  let retainedHtmlWrites = 0;
  let retainedHtml = '';
  let retainedVisCb;
  const retainedView = {
    visible: true,
    onDidChangeVisibility: (cb) => { retainedVisCb = cb; return { dispose() {} }; },
    webview: {
      options: {},
      get html() { return retainedHtml; },
      set html(v) { retainedHtmlWrites++; retainedHtml = v; },
      postMessage: async () => true,
      onDidReceiveMessage: () => {}
    }
  };
  const retainedCockpit = new CharlierSidebarProvider({});
  retainedCockpit.resolveWebviewView(retainedView, {}, {});
  retainedCockpit.render(state('antigravity', [profile('p1', 'antigravity')], 'p1', 'saved'));
  assert.equal(retainedHtmlWrites, 1);
  retainedCockpit.render(state('codex', [profile('p2', 'codex')], 'p2', 'saved'));
  await new Promise((r) => setTimeout(r, 15));
  retainedVisCb();
  assert.equal(retainedHtmlWrites, 1, 'retained webview confirmed delivery must skip full HTML reload on show');

  // Unretained fallback (postMessage resolves undefined) -> next visibility show rebuilds from latest state
  cockpit.render(state('codex', [profile('p2', 'codex')], 'p2', 'saved'));
  assert.equal(posted.length, 1);
  assert.equal(htmlWrites, 1);
  visibilityCb();
  assert.equal(htmlWrites, 2);
});

test('unverified profiles surface VERIFY NEEDED badges, active verification banner, CLI Locked standby button, drawer guidance, and VERIFY_ACCOUNT routing', async () => {
  const activeOk = profile('a-ok', 'antigravity');
  const standbyUnverified = profile('a-verify', 'antigravity');
  standbyUnverified.authStatus = 'unverified';
  standbyUnverified.authErrorCode = 'VALIDATION_REQUIRED';
  standbyUnverified.authErrorMessage = 'Verify your account to continue.';
  standbyUnverified.validationUrl = 'https://accounts.google.com/signin/continue?Email=a-verify%40example.test';
  standbyUnverified.cachedQuota = undefined;

  const standbyOut = html(state('antigravity', [activeOk, standbyUnverified], 'a-ok', 'saved'));
  assert.match(standbyOut, /account-card[^>]*needs-verify/);
  assert.match(standbyOut, /VERIFY NEEDED/);
  assert.match(standbyOut, /btn-cli-only is-disabled"/);
  assert.match(standbyOut, />CLI Locked</);
  assert.match(standbyOut, /drawer-verify-note/);

  const activeUnverified = { ...standbyUnverified };
  const activeSt = state('antigravity', [activeUnverified], 'a-verify', 'saved');
  activeSt.antigravity.liveMetrics = null;
  const activeOut = html(activeSt);
  assert.match(activeOut, /hero-card[^"]*needs-verify/);
  assert.match(activeOut, /verify-banner/);
  assert.match(activeOut, /complete Google phone\/QR verification in Antigravity to unlock quota/);
  assert.match(activeOut, /data-action="VERIFY_ACCOUNT"/);

  let verifiedArgs = null;
  let receive;
  const posted = [];
  const cockpit = new CharlierSidebarProvider({
    onVerifyAccount: async (...args) => {
      verifiedArgs = args;
    }
  });
  cockpit.resolveWebviewView({
    webview: {
      options: {},
      postMessage: (m) => posted.push(m),
      onDidReceiveMessage: (h) => {
        receive = h;
      }
    }
  }, {}, {});
  cockpit.render(activeSt);
  await receive({ type: 'VERIFY_ACCOUNT', provider: 'antigravity', profileId: 'a-verify' });
  assert.deepEqual(verifiedArgs, ['antigravity', 'a-verify']);
  assert.deepEqual(posted.at(-1), {
    type: 'CLEAR_BUSY',
    action: 'VERIFY_ACCOUNT',
    provider: 'antigravity',
    profileId: 'a-verify'
  });
});

test('cockpit renders theme-adaptive hero watermarks, keyed pool rows, and floats CLI CLAIMED standby cards above unclaimed tiers', () => {
  const active = { ...profile('act', 'codex'), planOverride: 'PRO', updatedAt: 500 };
  const standbyUltra = { ...profile('ultra', 'codex'), name: 'Idle Ultra', planOverride: 'ULTRA', updatedAt: 400 };
  const claimedFree = { ...profile('cli-free', 'codex'), name: 'Claimed Free', planOverride: 'FREE', updatedAt: 100 };
  const st = state('codex', [active, standbyUltra, claimedFree], 'act', 'saved');
  st.codex.claimedProfileIds = ['cli-free'];
  const codexOut = html(st);
  assert.match(codexOut, /<div class="hero-watermark" data-card-key="hero-watermark" aria-hidden="true"><svg/);
  assert.match(codexOut, /data-card-key="pool-Codex · 5-Hour Fast Pool"/);
  assert.ok(
    codexOut.indexOf('Claimed Free') < codexOut.indexOf('Idle Ultra'),
    'CLI CLAIMED lower-tier card must appear above unclaimed higher-tier standby cards'
  );
  assert.match(
    codexOut,
    /class="btn-icon danger is-disabled" data-action="DELETE_PROFILE" data-provider="codex" data-profile-id="cli-free" aria-disabled="true"/
  );
  assert.doesNotMatch(
    codexOut,
    /class="btn-icon danger is-disabled"[^>]*data-profile-id="ultra"/
  );

  // Scalloped Codex glyph in media/glyphs/codex-prompt.svg contains 4 contours (outer ring + prompt > and _)
  const fs = nodeRequire('fs');
  const glyphSvg = fs.readFileSync('media/glyphs/codex-prompt.svg', 'utf8');
  assert.match(glyphSvg, /viewBox="0 0 24 24" fill="currentColor"/);
  assert.ok(glyphSvg.length > 2000, 'Expected scalloped Codex contour glyph rather than old bare >_');
});

test('cockpit guards FREE Carbon leakage, single-window FREE Codex strips, API_KEY labels, wheels-4 class, provider-keyed buttons, and HC CSS', () => {
  const freeWithStrayCarbon = {
    ...profile('free-agy', 'antigravity'),
    planOverride: 'FREE',
    cachedQuota: { plan: 'FREE', gemini: '95%', claudeGpt: '80%', argon: '70%', carbon: '88%', updatedAt: Date.now() }
  };
  const standbyFreeAgy = { ...freeWithStrayCarbon, id: 'free-agy-2', name: 'Standby Free' };
  const freeOut = html(state('antigravity', [freeWithStrayCarbon, standbyFreeAgy], 'free-agy', 'saved'));
  assert.doesNotMatch(freeOut, /Gemini 4 Carbon/);
  assert.doesNotMatch(freeOut, /class="mini-label">Carbon</);

  const proWithCarbon = {
    ...profile('pro-agy', 'antigravity'),
    planOverride: 'PRO',
    cachedQuota: { plan: 'PRO', gemini: '90%', claudeGpt: '85%', argon: '80%', carbon: '75%', updatedAt: Date.now() }
  };
  const proOut = html(state('antigravity', [proWithCarbon], 'pro-agy', 'saved'));
  assert.match(proOut, /style="--gauge-count:3"/);
  assert.doesNotMatch(proOut, /Argon/);

  const standbyCodexWithCredits = {
    ...profile('codex-standby-credits', 'codex'),
    cachedQuota: { plan: 'PLUS', codex5h: '72%', codex7d: '88%', codexResetCredits: 2, codexCreditsBalance: '$12.50', updatedAt: Date.now() }
  };

  const standbyFreeCodex = {
    ...profile('codex-free-single', 'codex'),
    planOverride: 'FREE',
    cachedQuota: { plan: 'FREE', codex5h: '90%', updatedAt: Date.now() }
  };
  const standbyApiKey = {
    ...profile('codex-apikey', 'codex'),
    authMode: 'apikey',
    planOverride: undefined,
    cachedQuota: undefined
  };
  const codexOut = html(state('codex', [profile('c-act', 'codex'), standbyCodexWithCredits, standbyFreeCodex, standbyApiKey], 'c-act', 'saved'));
  assert.match(codexOut, /data-card-key="codex-standby-credits"[\s\S]*?class="credits-tag"[^>]*>⚡ 2 Reset Credits<\/span>/);
  assert.match(codexOut, /data-card-key="codex-standby-credits"[\s\S]*?class="credits-tag balance-tag"[^>]*>\$12\.50<\/span>/);
  assert.match(codexOut, /data-card-key="refresh-all"[^>]*data-provider="codex"/);
  assert.match(codexOut, /data-card-key="add-account"[^>]*data-provider="codex"/);
  assert.match(codexOut, /class="mini-label">Primary</);
  assert.doesNotMatch(codexOut, /data-card-key="codex-free-single"[\s\S]*?7d Pool/);
  assert.match(codexOut, /data-card-key="codex-apikey"[\s\S]*?>API_KEY<\/span>[\s\S]*?API key usage unavailable/);
  assert.match(codexOut, /busyProvider/);
  assert.match(codexOut, /!btn\.classList\.contains\('is-disabled'\)/);

  const fs = nodeRequire('fs');
  const css = fs.readFileSync('media/cockpit.css', 'utf8');
  assert.match(css, /\.wheels-grid\.wheels-4/);
  assert.match(css, /body\.vscode-high-contrast \.verify-badge/);
  assert.match(css, /body\.vscode-high-contrast \.reauth-badge/);
  assert.match(css, /body\.vscode-high-contrast \.card-drawer,\s*body\.vscode-high-contrast-light \.card-drawer\s*\{\s*background:\s*var\(--bg-card\)/);
});

test('cockpit recovers cleanly when hidden postMessage resolves false and renders latest deck on reopen', async () => {
  let visibilityCb;
  let visible = true;
  let currentHtml = '';
  let postResult = true;
  const view = {
    get visible() { return visible; },
    onDidChangeVisibility: (cb) => { visibilityCb = cb; return { dispose() {} }; },
    webview: {
      options: {},
      get html() { return currentHtml; },
      set html(v) { currentHtml = v; },
      postMessage: async () => postResult,
      onDidReceiveMessage: () => {}
    }
  };
  const cockpit = new CharlierSidebarProvider({});
  cockpit.resolveWebviewView(view, {}, {});
  const agyState = state('antigravity', [profile('p1', 'antigravity')], 'p1', 'saved');
  const codexState = state('codex', [profile('c1', 'codex')], 'c1', 'saved');

  cockpit.render(agyState);
  assert.match(currentHtml, /data-card-key="refresh-all"[^>]*data-provider="antigravity"/);

  // Switch away from Charlier so postMessage returns false (hidden webview)
  visible = false;
  postResult = false;
  cockpit.render(codexState);
  await new Promise((r) => setTimeout(r, 20));

  // Switching back with same state (must NOT early-return!) and reopening must paint Codex
  visible = true;
  postResult = true;
  visibilityCb();
  assert.match(currentHtml, /data-card-key="refresh-all"[^>]*data-provider="codex"/);

  // Flipping back to Antigravity while hidden and re-calling render(agyState) also recovers cleanly
  visible = false;
  postResult = false;
  cockpit.render(agyState);
  await new Promise((r) => setTimeout(r, 20));
  cockpit.render(agyState);
  visible = true;
  postResult = true;
  visibilityCb();
  assert.match(currentHtml, /data-card-key="refresh-all"[^>]*data-provider="antigravity"/);
});

test('cockpit renders Best Standby pit-stop banner & NEXT UP tag on degraded hero, omits when healthy, and ships keyboard search + HC styles', () => {
  const now = Date.now();
  const lowCodexHero = {
    ...profile('c-low', 'codex'),
    cachedQuota: { plan: 'PRO', codex5h: '5%', codex7d: '70%', updatedAt: now }
  };
  const freshCodexStandby = {
    ...profile('c-fresh', 'codex'),
    cachedQuota: { plan: 'PLUS', codex5h: '94%', codex7d: '88%', updatedAt: now }
  };
  const degradedHtml = html(state('codex', [lowCodexHero, freshCodexStandby], 'c-low', 'saved'));
  assert.match(degradedHtml, /data-card-key="hero-pitstop"/);
  assert.match(degradedHtml, /Low reserve \(5%\)/);
  assert.match(degradedHtml, /data-action="SWITCH_PROFILE" data-provider="codex" data-profile-id="c-fresh"/);
  assert.match(degradedHtml, /account-card[^>]*is-next-up[\s\S]*data-card-key="c-fresh"[\s\S]*<span class="nextup-tag"[^>]*>NEXT UP<\/span>/);
  assert.match(degradedHtml, /e\.key === '\/'/);
  assert.match(degradedHtml, /e\.key === 'Escape'/);

  const healthyCodexHero = {
    ...profile('c-ok', 'codex'),
    cachedQuota: { plan: 'PRO', codex5h: '82%', codex7d: '75%', updatedAt: now }
  };
  const healthyHtml = html(state('codex', [healthyCodexHero, freshCodexStandby], 'c-ok', 'saved'));
  assert.doesNotMatch(healthyHtml, /data-card-key="hero-pitstop"/);
  assert.doesNotMatch(healthyHtml, /<span class="nextup-tag"/);

  // Antigravity Ultra Hero with Claude depleted (0%) triggers bottleneck banner even with Gemini 85%
  const claudeZeroHero = {
    ...profile('a-cl0', 'antigravity'),
    planOverride: 'ULTRA',
    cachedQuota: { plan: 'ULTRA', gemini: '85%', claudeGpt: '0%', argon: 'incl.', updatedAt: now }
  };
  const ultraStandby = {
    ...profile('a-u55', 'antigravity'),
    planOverride: 'ULTRA',
    cachedQuota: { plan: 'ULTRA', gemini: '55%', claudeGpt: '30%', argon: 'incl.', updatedAt: now }
  };
  const pro100Standby = {
    ...profile('a-p100', 'antigravity'),
    planOverride: 'PRO',
    cachedQuota: { plan: 'PRO', gemini: '100%', claudeGpt: '100%', argon: '100%', updatedAt: now }
  };
  const agyBottleneckHtml = html(state('antigravity', [claudeZeroHero, pro100Standby, ultraStandby], 'a-cl0', 'saved'));
  assert.match(agyBottleneckHtml, /Claude depleted \(0%\)/);
  assert.match(agyBottleneckHtml, /data-action="SWITCH_PROFILE" data-provider="antigravity" data-profile-id="a-u55"/);

  const fs = nodeRequire('fs');
  const css = fs.readFileSync('media/cockpit.css', 'utf8');
  assert.match(css, /\.pitstop-banner/);
  assert.match(css, /body\.vscode-high-contrast \.pitstop-banner/);
  assert.match(css, /body\.vscode-high-contrast \.nextup-tag/);
});

test('cockpit emits onVisibilityChanged and guards overlapping postMessage deliveries with renderSeq', async () => {
  let visibilityCb;
  let visible = true;
  let currentHtml = '';
  const visEvents = [];
  const pendingPosts = [];
  const view = {
    get visible() { return visible; },
    onDidChangeVisibility: (cb) => { visibilityCb = cb; return { dispose() {} }; },
    webview: {
      options: {},
      get html() { return currentHtml; },
      set html(v) { currentHtml = v; },
      postMessage: (msg) => new Promise((resolve) => pendingPosts.push({ msg, resolve })),
      onDidReceiveMessage: () => {}
    }
  };
  const cockpit = new CharlierSidebarProvider({
    onVisibilityChanged: (v) => visEvents.push(v)
  });
  cockpit.resolveWebviewView(view, {}, {});
  assert.deepEqual(visEvents, [true]);

  const s1 = state('antigravity', [profile('p1', 'antigravity')], 'p1', 'saved');
  const s2 = state('codex', [profile('c1', 'codex')], 'c1', 'saved');
  const s3 = state('antigravity', [profile('p1', 'antigravity'), profile('p2', 'antigravity')], 'p1', 'saved');

  cockpit.render(s1);
  cockpit.render(s2);
  cockpit.render(s3);
  assert.equal(pendingPosts.length, 2);

  // Newer render resolves true FIRST, then stale older render resolves false -> must NOT clobber newer frame
  const htmlBefore = currentHtml;
  pendingPosts[1].resolve(true);
  await new Promise((r) => setTimeout(r, 15));
  pendingPosts[0].resolve(false);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(currentHtml, htmlBefore, 'stale postMessage rejection/false must not trigger full HTML rebuild over newer confirmed render');

  visible = false;
  visibilityCb();
  visible = true;
  visibilityCb();
  assert.deepEqual(visEvents, [true, false, true]);
});
