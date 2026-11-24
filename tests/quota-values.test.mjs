import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const nodeRequire = createRequire(import.meta.url);

const vscodeMock = {
  commands: { executeCommand: async () => {} },
  MarkdownString: class {
    value = '';
    appendMarkdown(value) { this.value += value; }
  }
};

async function loadSource(entry, extraModules = {}) {
  const result = await esbuild.build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
    external: ['vscode'], write: false, logLevel: 'silent'
  });
  const module = { exports: {} };
  const requireModule = (name) => {
    if (name === 'vscode') {
      return vscodeMock;
    }
    if (extraModules[name]) return extraModules[name];
    return nodeRequire(name);
  };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    requireModule, module, module.exports
  );
  return module.exports;
}

const values = await loadSource('src/quota-values.ts');
const codex = await loadSource('src/codex.ts');
const quota = await loadSource('src/quota.ts');

const decoded = {
  authMode: 'chatgpt', email: 'reader@example.test', accountId: 'account-1',
  planTier: 'PLUS'
};

test('finite fractions keep zero and genuine full while rejecting missing values', () => {
  assert.equal(values.percentFromFraction(0), 0);
  assert.equal(values.percentFromFraction(1), 100);
  assert.equal(values.percentFromFraction(1.4), 100);
  assert.equal(values.percentFromFraction(-0.4), 0);
  assert.equal(values.percentFromFraction(undefined), null);
  assert.equal(values.percentFromFraction(NaN), null);
  assert.equal(values.remainingFromUsedPercent(0), 100);
  assert.equal(values.remainingFromUsedPercent(100), 0);
  assert.equal(values.remainingFromUsedPercent(Infinity), null);
  assert.equal(values.percentFromText('100%'), 100);
  assert.equal(values.percentFromText('--'), null);
  assert.equal(values.percentFromText('100%junk'), null);
});

test('Codex sparse and malformed payloads stay unknown', () => {
  const service = new codex.CodexQuotaService();
  const missing = service.parseWhamUsagePayload({ rate_limit: {} }, decoded);
  assert.equal(missing.metric.codex5h, '--');
  assert.equal(missing.metric.codex7d, '--');
  assert.equal(missing.summary.groups[0].buckets[0].disabled, true);
  const malformed = service.parseWhamUsagePayload({
    rate_limit: { primary_window: { used_percent: NaN }, secondary_window: { used_percent: 100 } }
  }, decoded);
  assert.equal(malformed.metric.codex5h, '--');
  assert.equal(malformed.metric.codex7d, '0%');
  const full = service.parseWhamUsagePayload({
    rate_limit: { primary_window: { used_percent: 0 }, secondary_window: { used_percent: 0 } }
  }, decoded);
  assert.equal(full.metric.codex5h, '100%');
  assert.equal(full.metric.codex7d, '100%');
});

test('legacy Codex defaults and API key quota stay unavailable', () => {
  const synthetic = {
    plan: 'PLUS', gemini: '--', claudeGpt: '--', argon: '--',
    codex5h: '100%', codex7d: '100%', updatedAt: Date.now()
  };
  assert.equal(values.isSyntheticCodexQuota(synthetic), true);
  assert.equal(values.codexMetricForDisplay(synthetic).codex5h, '--');
  assert.equal(values.codexMetricForDisplay({ ...synthetic, codex5hWindowMins: 300 }).codex5h, '100%');
  assert.equal(values.isSyntheticCodexQuota({ ...synthetic, codexResetCredits: 2 }), false);
  assert.equal(values.codexMetricForDisplay(synthetic, 'apikey').codex7d, '--');
});

test('Antigravity quota requires the active identity before display or caching', () => {
  assert.equal(values.quotaMatchesIdentity('reader@example.test', 'Reader@Example.Test'), true);
  assert.equal(values.quotaMatchesIdentity('other@example.test', 'reader@example.test'), false);
  assert.equal(values.quotaMatchesIdentity(undefined, 'reader@example.test'), false);
  assert.equal(values.quotaMatchesIdentity('reader@example.test', null), false);
});

test('expired Codex reset heals a known window without creating a missing one', () => {
  const metric = {
    plan: 'PLUS', gemini: '--', claudeGpt: '--', argon: '--',
    codex5h: '0%', codex5hResetAtMs: Date.now() - 1000,
    codex7d: '--', updatedAt: Date.now() - 5000
  };
  const healed = codex.healExpiredCodexMetric(metric);
  assert.equal(healed.codex5h, '100%');
  assert.equal(healed.codex7d, '--');
});

test('Antigravity ignores absent and disabled buckets but keeps true depletion', () => {
  const service = new quota.QuotaService();
  const summary = {
    planTier: 'PRO', groups: [
      { displayName: 'Gemini', buckets: [
        { window: '5h', remainingFraction: undefined },
        { window: 'weekly', remainingFraction: 0.42 }
      ] },
      { displayName: 'Claude', buckets: [
        { window: 'weekly', remainingFraction: undefined }
      ] },
      { displayName: 'Argon', buckets: [
        { window: 'weekly', remainingFraction: 0 }
      ] }
    ]
  };
  const parsed = service.parseMetrics(summary);
  assert.equal(parsed.gemini5h, undefined);
  assert.equal(parsed.gemini7d, '42%');
  assert.equal(parsed.gemini, '42%');
  assert.equal(parsed.claudeGpt, '--');
  assert.equal(parsed.argon, '--');
  assert.equal(values.lowestRemainingPercent(summary.groups, false), 0);
  assert.equal(values.lowestRemainingPercent(summary.groups, true), 42);
  assert.equal(values.lowestRemainingPercent([
    { displayName: 'Gemini', buckets: [{ disabled: true, remainingFraction: 1 }] }
  ], true), null);

  const withCarbon = service.parseMetrics({
    planTier: 'PRO',
    groups: [
      { displayName: 'Gemini Models', buckets: [{ window: 'weekly', remainingFraction: 0.85 }] },
      { displayName: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remainingFraction: 0.12 }] },
      { displayName: 'Gemini 4 Carbon', buckets: [{ window: 'weekly', remainingFraction: 0.25 }] },
      {
        displayName: 'Claude & GPT',
        buckets: [
          { window: '5h', disabled: true, remainingFraction: 0 },
          { window: 'weekly', remainingFraction: 0.72 }
        ]
      }
    ]
  });
  assert.equal(withCarbon.gemini, '85%');
  assert.equal(withCarbon.carbon, '25%');
  assert.equal(withCarbon.claude5h, '--');
  assert.equal(withCarbon.claude7d, '72%');
  const carbonGroups = [
    { displayName: 'Gemini Models', buckets: [{ window: 'weekly', remainingFraction: 0.85 }] },
    { displayName: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remainingFraction: 0.12 }] },
    { displayName: 'Gemini 4 Carbon', buckets: [{ window: 'weekly', remainingFraction: 0.25 }] }
  ];
  assert.equal(values.lowestRemainingPercent(carbonGroups, true), 85);
  assert.equal(values.lowestRemainingPercent(carbonGroups, false), 12);

  const dangerDark = values.renderHoverPill('RE-AUTH', 'danger', false);
  assert.match(dangerDark, /#F08C8C/);
  assert.match(dangerDark, /#351B1E/);
  assert.match(dangerDark, /RE-AUTH/);
  const dangerLight = values.renderHoverPill('RE-AUTH', 'danger', true);
  assert.match(dangerLight, /#AD3D3D/);
  assert.match(dangerLight, /#F7E2E2/);
});

test('Codex hover keeps unknown usage empty and only trusts its own actions', () => {
  const service = new codex.CodexQuotaService();
  const unknown = { plan: 'PLUS', gemini: '--', claudeGpt: '--', argon: '--', codex5h: '--', codex7d: '--', updatedAt: 0 };
  const tooltip = service.buildCodexHoverTooltip([
    { id: 'p1', name: 'Reader', email: 'reader@example.test', cachedQuota: unknown }
  ], 'p1', unknown, { email: 'reader@example.test' });
  assert.doesNotMatch(tooltip.value, /100%/);
  assert.match(tooltip.value, /\*\*--\*\*/);
  assert.equal(Array.isArray(tooltip.isTrusted.enabledCommands), true);
  assert.equal(tooltip.isTrusted.enabledCommands.includes('charlier.switchProvider'), true);
});

test('Antigravity status bar summary uses unified 2-pool layout, ignores retired Argon, surfaces standalone extra pool dynamically, and blocks mismatched email', () => {
  const proProfile = {
    id: 'p1',
    name: 'Sernine',
    email: 'sernine@example.test',
    cachedQuota: {
      plan: 'PRO',
      gemini: '60%',
      claudeGpt: '30%',
      argon: '6%',
      updatedAt: Date.now()
    }
  };
  const liveSummary = {
    email: 'sernine@example.test',
    tier: 'Pro Plan',
    planTier: 'PRO',
    hasArgonGroup: false,
    fetchedAt: Date.now(),
    groups: [
      { displayName: 'Gemini Models', buckets: [{ bucketId: 'g5h', displayName: '5h', window: '5h', remainingFraction: 0.6 }] },
      { displayName: 'Claude and GPT models', buckets: [{ bucketId: 'c7d', displayName: '7d', window: 'weekly', remainingFraction: 0.3 }] }
    ]
  };
  const res = values.formatAntigravityStatusBarSummary({
    activeProfile: proProfile,
    liveEmail: 'sernine@example.test',
    quota: liveSummary,
    liveMetrics: null
  });
  assert.equal(res.quotaText, 'G 60% · C 30%');
  assert.equal(res.minPct, 45);
  assert.equal(values.resolveQuotaTone(res.minPct, 'antigravity', false).colorId, 'charlier.quotaWarn');

  const proWithCarbon = values.formatAntigravityStatusBarSummary({
    activeProfile: {
      ...proProfile,
      cachedQuota: { ...proProfile.cachedQuota, carbon: '9%', updatedAt: Date.now() }
    },
    liveEmail: 'sernine@example.test',
    quota: null,
    liveMetrics: null
  });
  assert.equal(proWithCarbon.quotaText, 'G 60% · C 30% · Cb 9%');
  assert.equal(proWithCarbon.minPct, 33);
  assert.equal(values.resolveQuotaTone(proWithCarbon.minPct, 'antigravity', false).colorId, 'charlier.quotaWarn');

  const mismatch = values.formatAntigravityStatusBarSummary({
    activeProfile: {
      id: 'hortense',
      name: 'Hortense',
      email: 'hortense@example.test',
      planOverride: 'ULTRA',
      cachedQuota: { plan: 'ULTRA', gemini: '92%', claudeGpt: '88%', argon: 'incl.', updatedAt: Date.now() }
    },
    liveEmail: 'hortense@example.test',
    quota: liveSummary,
    liveMetrics: null
  });
  assert.equal(mismatch.quotaText, 'G 92% · C 88%');
  assert.equal(mismatch.minPct, 90);
  assert.equal(values.resolveQuotaTone(mismatch.minPct, 'antigravity', false).colorId, 'charlier.antigravityAccent');
});

test('unified status bar text, tier sorting, Hover Matrix Carbon column, Codex live probe gating, and terminal command parsing handle edge cases', () => {
  assert.equal(
    values.formatUnifiedStatusBarText({
      provider: 'codex',
      label: 'Sernine',
      needsReauth: false,
      showStatusBarQuota: true,
      quotaText: '5h 82% · 7d 68%'
    }),
    '$(charlier-codex-prompt) Sernine · 5h 82% · 7d 68%'
  );
  assert.equal(
    values.formatUnifiedStatusBarText({
      provider: 'antigravity',
      label: 'Sernine',
      needsReauth: true,
      showStatusBarQuota: true,
      quotaText: 'G 90%'
    }),
    '$(charlier-antigravity-star) Sernine · $(warning) RE-AUTH (stale)'
  );
  assert.equal(
    values.formatUnifiedStatusBarText({
      provider: 'codex',
      label: 'Sernine',
      needsReauth: false,
      showStatusBarQuota: true,
      quotaText: '5h 82%',
      includeHoverCue: true
    }),
    '$(charlier-codex-prompt) Sernine · 5h 82% $(chevron-up)'
  );

  const tierList = [
    { id: 'free-1', cachedQuota: { plan: 'FREE' }, updatedAt: 500 },
    { id: 'pro-old', cachedQuota: { plan: 'PRO' }, updatedAt: 100 },
    { id: 'ultra-1', planOverride: 'ULTRA', cachedQuota: { plan: 'PRO' }, updatedAt: 50 },
    { id: 'pro-new', cachedQuota: { plan: 'PRO' }, updatedAt: 300 },
    { id: 'team-1', cachedQuota: { plan: 'TEAM' }, updatedAt: 400 }
  ];
  tierList.sort(values.compareProfilesByTier);
  assert.deepEqual(
    tierList.map((p) => p.id),
    ['ultra-1', 'pro-new', 'pro-old', 'team-1', 'free-1']
  );

  const agyService = new quota.QuotaService();
  const agyHover = agyService.buildAccountsHoverTooltip(
    [
      {
        id: 'hortense',
        name: 'Hortense ♛',
        email: 'hortense@charlier.dev',
        planOverride: 'ULTRA',
        cachedQuota: { plan: 'ULTRA', gemini: '96%', claudeGpt: '88%', argon: 'incl.', carbon: 'incl.', updatedAt: 100 },
        updatedAt: 100
      },
      {
        id: 'labs',
        name: 'Charlier Labs',
        email: 'labs@charlier.dev',
        cachedQuota: { plan: 'FREE', gemini: '91%', claudeGpt: '--', argon: '--', updatedAt: 400 },
        updatedAt: 400
      },
      {
        id: 'renine',
        name: 'Rénine',
        email: 'renine@charlier.dev',
        cachedQuota: { plan: 'PRO', gemini: '84%', claudeGpt: '79%', argon: '71%', updatedAt: 200 },
        updatedAt: 200
      }
    ],
    'hortense',
    'hortense@charlier.dev',
    null
  );
  assert.doesNotMatch(agyHover.value, /Argon/);
  assert.doesNotMatch(agyHover.value, /\|\s*&nbsp;Carbon&nbsp;\s*\|/);
  assert.match(agyHover.value, /Hydrogen, Neon, Carbon/);
  assert.ok(agyHover.value.indexOf('Rénine') < agyHover.value.indexOf('Charlier&nbsp;Labs'));

  const now = 500_000;
  assert.equal(values.needsCodexLiveProbe({ updatedAt: now - 5_000 }, 'ok', undefined, now, 120_000), false);
  assert.equal(values.needsCodexLiveProbe({ updatedAt: now - 5_000 }, 'revoked', undefined, now, 120_000), true);
  assert.equal(values.needsCodexLiveProbe({ updatedAt: now - 5_000 }, 'ok', 'expired', now, 120_000), true);

  assert.equal(values.detectProviderFromTerminalCommand('FOO=1 codex --model gpt-5'), 'codex');
  assert.equal(values.detectProviderFromTerminalCommand("$env:CODEX_HOME='C:\\tmp'; codex.ps1"), 'codex');
  assert.equal(values.detectProviderFromTerminalCommand('cd s:\\Projects\\Charlier && agy'), 'antigravity');
  assert.equal(values.detectProviderFromTerminalCommand('npx -y @openai/codex'), 'codex');
  assert.equal(values.detectProviderFromTerminalCommand('wsl -d Ubuntu codex'), 'codex');
  assert.equal(values.detectProviderFromTerminalCommand('git commit -m "switch codex and agy"'), null);
});

test('RE-AUTH and expired hover tooltips show STALE pill, muted gauges, crimson stale age, and freeze expired Codex heal', () => {
  const pastUpdatedAt = Date.now() - 2 * 3600_000;
  const expiredMetric = {
    plan: 'PRO',
    gemini: '--',
    claudeGpt: '--',
    argon: '--',
    codex5h: '40%',
    codex5hReset: '1s',
    codex5hWindowMins: 300,
    codex7d: '55%',
    codex7dReset: '3d',
    updatedAt: pastUpdatedAt
  };
  const revokedCodex = {
    id: 'codex-revoked',
    name: 'Revoked Codex',
    email: 'revoked@codex.test',
    authStatus: 'revoked',
    authErrorCode: 'refresh_token_reused',
    cachedQuota: expiredMetric
  };
  const codexService = new codex.CodexQuotaService();
  const codexHover = codexService.buildCodexHoverTooltip(
    [revokedCodex],
    'codex-revoked',
    expiredMetric,
    { email: 'revoked@codex.test' }
  );
  assert.match(codexHover.value, /RE-AUTH/);
  assert.match(codexHover.value, /STALE/);
  assert.match(codexHover.value, /#7E909B/);
  assert.match(codexHover.value, /stale(?:&nbsp;| )·(?:&nbsp;| )/);
  assert.match(codexHover.value, /\*\*40%\*\*/);
  assert.doesNotMatch(codexHover.value, /5-Hour Fast Pool[\s\S]*\*\*100%\*\*/);

  const agyService = new quota.QuotaService();
  const revokedAgy = {
    id: 'agy-revoked',
    name: 'Revoked Agy',
    email: 'revoked@agy.test',
    authStatus: 'expired',
    authErrorCode: 'invalid_grant',
    cachedQuota: {
      plan: 'PRO',
      gemini: '35%',
      claudeGpt: '48%',
      argon: '22%',
      updatedAt: pastUpdatedAt
    }
  };
  const agyHover = agyService.buildAccountsHoverTooltip([revokedAgy], 'agy-revoked', 'revoked@agy.test', null);
  assert.match(agyHover.value, /RE-AUTH/);
  assert.match(agyHover.value, /STALE/);
  assert.match(agyHover.value, /#7E909B/);
  assert.match(agyHover.value, /stale(?:&nbsp;| )·(?:&nbsp;| )/);
});

test('hotSwapCodexAppServer(null) and logoutCodexAppServer reset local UI without sending account/logout RPC', async () => {
  const { EventEmitter } = nodeRequire('events');
  const { PassThrough } = nodeRequire('stream');
  const stdinLines = [];
  const parserWrites = [];
  const mockCp = {
    spawn: () => {
      const child = new EventEmitter();
      child.pid = 99999;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.stdin.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stdinLines.push(text);
        if (text.includes('"init-graft"')) {
          setImmediate(() => child.stdout.write(`${JSON.stringify({ id: 'init-graft', result: {} })}\n`));
        }
      });
      child.kill = () => true;
      return child;
    }
  };
  const parser = new PassThrough();
  parser.on('data', (chunk) => parserWrites.push(chunk.toString('utf8')));
  const codexMocked = await loadSource('src/codex.ts', { child_process: mockCp });
  const service = new codexMocked.CodexQuotaService();
  service.graftedRootProc = { spawnfile: 'codex', spawnargs: ['codex', 'app-server'], kill: () => true };
  service.graftedCurrentChild = { removeAllListeners: () => {} };
  service.graftedParser = parser;

  const status = await service.hotSwapCodexAppServer(null);
  assert.equal(status, 'swapped');
  assert.equal(stdinLines.some((l) => l.includes('account/logout')), false);
  assert.equal(parserWrites.some((l) => l.includes('"authMode":null')), true);
  assert.equal(parserWrites.some((l) => l.includes('account/login/completed')), false);

  stdinLines.length = 0;
  parserWrites.length = 0;
  const logoutRes = await service.logoutCodexAppServer();
  assert.equal(logoutRes, 'logged-out');
  assert.equal(stdinLines.some((l) => l.includes('account/logout')), false);
});

test('Codex syncActiveCredentialsToProfile preserves revoked on identical tokens, recovers on rotation, autoSave preserves liveMetric, and refresh guards claimed/unlinked disk', async () => {
  const fs = nodeRequire('fs');
  const os = nodeRequire('os');
  const path = nodeRequire('path');
  const { EventEmitter } = nodeRequire('events');

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-codex-test-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.CODEX_HOME;

  const makeJwt = (email, accountId, expSec) => {
    const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({
      email,
      exp: expSec,
      'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'pro' }
    })).toString('base64url');
    return `${h}.${p}.sig`;
  };

  let oauthRefreshCalls = 0;
  const mockHttps = {
    request: (opts, cb) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        if (String(opts.hostname).includes('auth.openai.com')) {
          oauthRefreshCalls++;
          res.statusCode = 200;
          cb(res);
          res.emit('data', JSON.stringify({
            access_token: makeJwt('vault@example.test', 'acc-vault', Math.floor(Date.now() / 1000) + 3600),
            refresh_token: 'rt-rotated-new'
          }));
          res.emit('end');
        } else {
          res.statusCode = 200;
          cb(res);
          res.emit('data', JSON.stringify({
            plan_type: 'pro',
            rate_limit: {
              primary_window: { used_percent: 15, reset_after_seconds: 1200, limit_window_seconds: 18000 },
              secondary_window: { used_percent: 25, reset_after_seconds: 86400, limit_window_seconds: 604800 }
            }
          }));
          res.emit('end');
        }
      };
      return req;
    }
  };

  try {
    const codexMod = await loadSource('src/codex.ts', { https: mockHttps });
    const codexDir = path.join(tmpHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const expiringJwt = makeJwt('vault@example.test', 'acc-vault', Math.floor(Date.now() / 1000) + 60);
    const oldAuth = {
      tokens: {
        access_token: expiringJwt,
        refresh_token: 'rt-old-broken',
        id_token: expiringJwt,
        account_id: 'acc-vault'
      }
    };
    fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify(oldAuth, null, 2));

    const vault = new codexMod.CodexVault();
    const liveMetric = {
      plan: 'PRO', gemini: '--', claudeGpt: '--', argon: '--',
      codex5h: '88%', codex7d: '79%', updatedAt: Date.now()
    };
    const autoSaved = vault.autoSaveUnsavedActiveSession(liveMetric);
    assert.ok(autoSaved);
    assert.equal(autoSaved.cachedQuota.codex5h, '88%');
    assert.equal(vault.autoSaveUnsavedActiveSession(liveMetric), null);

    vault.updateProfileAuthHealth(autoSaved.id, {
      authStatus: 'revoked',
      authErrorCode: 'token_revoked'
    });
    const sameDecoded = vault.readDecodedActiveAuth();
    assert.equal(vault.syncActiveCredentialsToProfile(autoSaved.id, oldAuth, sameDecoded), false);
    assert.equal(vault.listProfiles().find((p) => p.id === autoSaved.id).authStatus, 'revoked');

    const freshJwt = makeJwt('vault@example.test', 'acc-vault', Math.floor(Date.now() / 1000) + 7200);
    const freshAuth = {
      tokens: {
        access_token: freshJwt,
        refresh_token: 'rt-fresh-1',
        id_token: freshJwt,
        account_id: 'acc-vault'
      }
    };
    assert.equal(vault.syncActiveCredentialsToProfile(autoSaved.id, freshAuth, { ...sameDecoded, rawAuthJson: freshAuth }), true);
    assert.equal(vault.listProfiles().find((p) => p.id === autoSaved.id).authStatus, 'ok');

    // Expiring token with claimed profile skips OAuth refresh to avoid RTR collision with live CLI process
    const claimedDir = path.join(tmpHome, '.gemini', 'charlier', 'providers', 'codex', 'profiles', autoSaved.id);
    fs.writeFileSync(path.join(claimedDir, 'auth.json'), JSON.stringify(oldAuth, null, 2));
    const service = new codexMod.CodexQuotaService();
    service.setClaimedProfileIdsProvider(() => new Set([autoSaved.id]));
    await service.refreshProfileQuota(autoSaved.id, vault, true);
    assert.equal(oauthRefreshCalls, 0);

    // Unclaimed profile refreshes standby vault file when active auth.json is absent without recreating auth.json
    fs.unlinkSync(path.join(codexDir, 'auth.json'));
    service.setClaimedProfileIdsProvider(() => new Set());
    await service.refreshProfileQuota(autoSaved.id, vault, true);
    assert.equal(oauthRefreshCalls, 1);
    assert.equal(fs.existsSync(path.join(codexDir, 'auth.json')), false);
    const savedProfileAuth = JSON.parse(fs.readFileSync(path.join(claimedDir, 'auth.json'), 'utf8'));
    assert.equal(savedProfileAuth.tokens.refresh_token, 'rt-rotated-new');
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('extractGoogleValidationInfo parses loadCodeAssist ineligibleTiers, 403 ErrorInfo, and gRPC-web trailers while hover and status bar surface VERIFY NEEDED', () => {
  const fromLoadCodeAssist = quota.extractGoogleValidationInfo({
    ineligibleTiers: [
      {
        reasonCode: 'VALIDATION_REQUIRED',
        reasonMessage: 'Verify your account to continue.',
        validationUrl: 'https://accounts.google.com/signin/continue?Email=verify.user%40example.test&flowName=GlifWebSignIn'
      }
    ]
  });
  assert.equal(fromLoadCodeAssist.isValidationRequired, true);
  assert.equal(fromLoadCodeAssist.message, 'Verify your account to continue.');
  assert.equal(fromLoadCodeAssist.emailFromUrl, 'verify.user@example.test');
  assert.match(fromLoadCodeAssist.validationUrl, /^https:\/\/accounts\.google\.com\/signin\/continue/);

  const from403ErrorInfo = quota.extractGoogleValidationInfo(JSON.stringify({
    error: {
      code: 403,
      message: 'Verify your account to continue.',
      status: 'PERMISSION_DENIED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'VALIDATION_REQUIRED',
          domain: 'cloudcode-pa.googleapis.com',
          metadata: {
            validation_url: 'https://accounts.google.com/AccountChooser?Email=gate%40example.test&continue=https%3A%2F%2Fmyaccount.google.com',
            validation_error_message: 'Complete phone verification to unlock Antigravity.'
          }
        }
      ]
    }
  }));
  assert.equal(from403ErrorInfo.isValidationRequired, true);
  assert.equal(from403ErrorInfo.message, 'Verify your account to continue.');
  assert.equal(from403ErrorInfo.emailFromUrl, 'gate@example.test');

  const fromGrpcTrailer = quota.extractGoogleValidationInfo(
    'grpc-status: 7\r\ngrpc-message: PERMISSION_DENIED: VALIDATION_REQUIRED Verify your account at https://accounts.google.com/signin/v2/challenge'
  );
  assert.equal(fromGrpcTrailer.isValidationRequired, true);
  assert.equal(fromGrpcTrailer.validationUrl, 'https://accounts.google.com/signin/v2/challenge');

  const clean = quota.extractGoogleValidationInfo({ currentTier: { id: 'g1-pro-tier' } });
  assert.equal(clean.isValidationRequired, false);

  const tone = values.resolveQuotaTone(null, 'antigravity', false, true);
  assert.equal(tone.bgId, 'statusBarItem.warningBackground');
  assert.equal(
    values.formatUnifiedStatusBarText({
      provider: 'antigravity',
      label: 'Verify User',
      needsReauth: false,
      needsVerification: true,
      showStatusBarQuota: true,
      quotaText: ''
    }),
    '$(charlier-antigravity-star) Verify User · $(shield) VERIFY NEEDED'
  );

  const agyService = new quota.QuotaService();
  const unverifiedProfile = {
    id: 'unverified-1',
    name: 'Verify User',
    email: 'verify.user@example.test',
    authStatus: 'unverified',
    authErrorCode: 'VALIDATION_REQUIRED',
    authErrorMessage: 'Verify your account to continue.',
    validationUrl: 'https://accounts.google.com/signin/continue?Email=verify.user%40example.test'
  };
  const hover = agyService.buildAccountsHoverTooltip(
    [unverifiedProfile],
    'unverified-1',
    'verify.user@example.test',
    {
      email: 'verify.user@example.test',
      planTier: 'FREE',
      groups: [],
      fetchedAt: Date.now(),
      source: 'daemon',
      authStatus: 'unverified',
      authErrorCode: 'VALIDATION_REQUIRED',
      authErrorMessage: 'Verify your account to continue.',
      validationUrl: unverifiedProfile.validationUrl
    }
  );
  assert.match(hover.value, /VERIFY(?:&nbsp;| )NEEDED/);
  assert.match(hover.value, /command:charlier\.verifyAccount/);
  assert.match(hover.value, /\*verify needed\*/);
});

test('Vault and CodexVault prune broken Unknown stubs, unlink empty google_accounts.json on prepareNewLogin, and deduplicate repeated saves across custom names', async () => {
  const fs = nodeRequire('fs');
  const os = nodeRequire('os');
  const path = nodeRequire('path');

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-vault-dedupe-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.CODEX_HOME;

  try {
    const vaultMod = await loadSource('src/vault.ts');
    const codexMod = await loadSource('src/codex.ts');
    const mockKeyring = {
      read: () => null,
      readAsync: async () => null,
      write: () => false,
      writeAsync: async () => false,
      delete: () => true,
      deleteAsync: async () => true
    };

    const geminiDir = path.join(tmpHome, '.gemini');
    const profilesDir = path.join(geminiDir, 'charlier', 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true });

    // Create 3 broken "Unknown" stub folders without tokens (reproducing the old bug)
    for (const stubId of ['broken-stub-1', 'broken-stub-2', 'broken-stub-3']) {
      const dir = path.join(profilesDir, stubId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'metadata.json'),
        JSON.stringify({
          id: stubId,
          name: stubId,
          email: 'Unknown',
          createdAt: 1000,
          lastSwitchedAt: 1000
        })
      );
      fs.writeFileSync(path.join(dir, 'google_accounts.json'), JSON.stringify({ active: '', old: [] }));
    }

    const v = new vaultMod.Vault(mockKeyring);
    // Broken tokenless "Unknown" stubs are self-healed and removed on listProfiles()
    assert.deepEqual(v.listProfiles(), []);
    assert.equal(fs.existsSync(path.join(profilesDir, 'broken-stub-1')), false);

    // Saving a daemon-only unverified session via sessionHint stores real email + unverified status
    const saved1 = await v.saveCurrentAsProfileAsync('Gate Initial', null, {
      email: 'gate.user@example.test',
      authStatus: 'unverified',
      authErrorCode: 'VALIDATION_REQUIRED',
      authErrorMessage: 'Verify your account to continue.',
      validationUrl: 'https://accounts.google.com/signin/continue?Email=gate.user%40example.test'
    });
    assert.equal(saved1.email, 'gate.user@example.test');
    assert.equal(saved1.authStatus, 'unverified');
    assert.equal(v.listProfiles().length, 1);

    // Re-saving the same active account under a DIFFERENT name updates in-place with zero duplicates
    const saved2 = await v.saveCurrentAsProfileAsync('Gate Renamed', null, {
      email: 'gate.user@example.test',
      authStatus: 'unverified',
      validationUrl: 'https://accounts.google.com/signin/continue?Email=gate.user%40example.test'
    });
    assert.equal(saved2.id, saved1.id);
    assert.equal(saved2.name, 'Gate Renamed');
    assert.equal(v.listProfiles().length, 1);

    // prepareNewLoginAsync unlinks google_accounts.json instead of writing a 31-byte {"active":""} stub
    await v.prepareNewLoginAsync({
      sessionHint: {
        email: 'gate.user@example.test',
        authStatus: 'unverified'
      }
    });
    assert.equal(fs.existsSync(path.join(geminiDir, 'google_accounts.json')), false);
    assert.equal(v.getState().activeProfileId, null);

    // Rejects saving when both disk and sessionHint have no real email (even if a 31-byte {"active":""} stub exists)
    fs.writeFileSync(path.join(geminiDir, 'google_accounts.json'), JSON.stringify({ active: '', old: [] }));
    await assert.rejects(
      () => v.saveCurrentAsProfileAsync('Broken Stub'),
      /No active Antigravity credentials found to save|Could not detect the signed-in Google account email/
    );

    // CodexVault also prunes broken Unknown stubs and deduplicates API_KEY / OAuth saves across renames
    const codexVault = new codexMod.CodexVault();
    const codexDir = path.join(tmpHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-test-key-1234567890' })
    );
    const c1 = codexVault.saveCurrentAsProfile('Key One');
    const c2 = codexVault.saveCurrentAsProfile('Key Two');
    assert.equal(c1.id, c2.id);
    assert.equal(c2.name, 'Key Two');
    assert.equal(codexVault.listProfiles().length, 1);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('CLI CLAIMED priority sorting, Status Bar terminal badge, scalloped Codex theme icons, and Hover 4-row overflow', () => {
  assert.equal(
    values.formatUnifiedStatusBarText({
      provider: 'codex',
      label: 'Sernine',
      needsReauth: false,
      showStatusBarQuota: true,
      quotaText: '5h 82% · 7d 68%',
      claimedCount: 1
    }),
    '$(charlier-codex-prompt) Sernine · 5h 82% · 7d 68% · $(terminal)'
  );
  assert.equal(
    values.formatUnifiedStatusBarText({
      provider: 'antigravity',
      label: 'Hortense',
      needsReauth: false,
      showStatusBarQuota: true,
      quotaText: 'G 86% · C 91%',
      claimedCount: 2
    }),
    '$(charlier-antigravity-star) Hortense · G 86% · C 91% · $(terminal) 2'
  );

  // Scalloped Codex header icon adapts to theme (`white` on dark, `ink` on light)
  const darkCodexIcon = values.getHoverProviderIconHtml('codex', false);
  const lightCodexIcon = values.getHoverProviderIconHtml('codex', true);
  assert.match(darkCodexIcon, /^<img src="data:image\/svg\+xml;base64,/);
  const darkSvg = Buffer.from(darkCodexIcon.match(/base64,([^"]+)/)[1], 'base64').toString('utf8');
  const lightSvg = Buffer.from(lightCodexIcon.match(/base64,([^"]+)/)[1], 'base64').toString('utf8');
  assert.match(darkSvg, /fill="#F2F0E8"/);
  assert.match(lightSvg, /fill="#17312D"/);

  // Active -> CLI CLAIMED (tier-sorted) -> Standby (tier-sorted)
  const mixedCodex = [
    { id: 'c-active', name: 'Main', email: 'm@example.test', planOverride: 'PRO', updatedAt: 500, cachedQuota: { plan: 'PRO', codex5h: '80%', codex7d: '70%', updatedAt: Date.now() } },
    { id: 'c-ultra', name: 'Standby Ultra', email: 'u@example.test', planOverride: 'ULTRA', updatedAt: 400, cachedQuota: { plan: 'ULTRA', codex5h: '90%', codex7d: '90%', updatedAt: Date.now() } },
    { id: 'c-free-cli', name: 'Claimed Free', email: 'f@example.test', planOverride: 'FREE', updatedAt: 100, cachedQuota: { plan: 'FREE', codex5h: '100%', updatedAt: Date.now() } },
    { id: 'c-plus-cli', name: 'Claimed Plus', email: 'p@example.test', planOverride: 'PLUS', updatedAt: 200, cachedQuota: { plan: 'PLUS', codex5h: '60%', codex7d: '80%', updatedAt: Date.now() } },
    { id: 'c-team-cli', name: 'Claimed Team', email: 't@example.test', planOverride: 'TEAM', updatedAt: 300, cachedQuota: { plan: 'TEAM', codex5h: '75%', codex7d: '85%', updatedAt: Date.now() } },
    { id: 'c-extra-cli', name: 'Overflow Claimed', email: 'o@example.test', planOverride: 'API_KEY', updatedAt: 50, authMode: 'apikey', cachedQuota: { plan: 'API_KEY', updatedAt: Date.now() } }
  ];
  const sorted = values.sortProfilesForDisplay(
    mixedCodex,
    'c-active',
    ['c-free-cli', 'c-plus-cli', 'c-team-cli', 'c-extra-cli']
  );
  assert.deepEqual(
    sorted.map((p) => p.id),
    ['c-active', 'c-team-cli', 'c-plus-cli', 'c-extra-cli', 'c-free-cli', 'c-ultra']
  );

  // Codex hover shows Claimed Free/Plus/Team inside the 4-row cap ahead of unclaimed Standby Ultra,
  // emits *live* on active row, and flags hidden CLI claimed count in overflow note
  const codexSvc = new codex.CodexQuotaService();
  const codexHover = codexSvc.buildCodexHoverTooltip(
    mixedCodex,
    'c-active',
    mixedCodex[0].cachedQuota,
    { email: 'm@example.test', hasOAuthCreds: true, tokenExpiryDate: null, isExpired: false },
    new Set(['c-free-cli', 'c-plus-cli', 'c-team-cli', 'c-extra-cli'])
  );
  assert.match(codexHover.value, /### <img src="data:image\/svg\+xml;base64,/);
  assert.match(codexHover.value, /\*\*CLI\*\*/);
  assert.match(codexHover.value, /\$\(terminal\)/);
  assert.match(codexHover.value, /\*live\*/);
  assert.doesNotMatch(codexHover.value, /Standby&nbsp;Ultra/);
  assert.match(codexHover.value, /\+ 2 more accounts \(1 CLI claimed\) in Cockpit/);
  assert.match(codexHover.value, /\[Open Cockpit\]\(command:charlier\.openCockpit\)/);
  assert.match(codexHover.value, /\$\(charlier-antigravity-star\)&nbsp;Antigravity/);
  assert.match(codexHover.value, /\$\(charlier-codex-prompt\)&nbsp;\*\*Codex\*\*/);

  // Antigravity hover trusts charlier.verifyAccount and surfaces CLI Claimed sorting + pill
  const agySvc = new quota.QuotaService();
  const agyHover = agySvc.buildAccountsHoverTooltip(
    [
      { id: 'a-main', name: 'Hortense', email: 'h@example.test', planOverride: 'ULTRA', updatedAt: 500, cachedQuota: { plan: 'ULTRA', gemini: '90%', claudeGpt: '85%', argon: 'incl.', carbon: 'incl.', updatedAt: Date.now() } },
      { id: 'a-pro', name: 'Standby Pro', email: 'sp@example.test', planOverride: 'PRO', updatedAt: 400, cachedQuota: { plan: 'PRO', gemini: '80%', claudeGpt: '70%', argon: '60%', updatedAt: Date.now() } },
      { id: 'a-cli', name: 'Rénine CLI', email: 'r@example.test', planOverride: 'FREE', updatedAt: 100, cachedQuota: { plan: 'FREE', gemini: '95%', claudeGpt: '--', argon: '--', updatedAt: Date.now() } }
    ],
    'a-main',
    'h@example.test',
    null,
    new Set(['a-cli'])
  );
  assert.equal(agyHover.isTrusted.enabledCommands.includes('charlier.verifyAccount'), true);
  assert.match(agyHover.value, /Rénine&nbsp;CLI/);
  assert.ok(agyHover.value.indexOf('Rénine&nbsp;CLI') < agyHover.value.indexOf('Standby&nbsp;Pro'));
  assert.match(agyHover.value, /\*\*CLI\*\*/);
});

test('Codex refreshProfileQuota preserves active RTR token without rollback and Vault preserves tokenless revoked status', async () => {
  const fs = nodeRequire('fs');
  const os = nodeRequire('os');
  const path = nodeRequire('path');
  const { EventEmitter } = nodeRequire('events');

  const encodeJwt = (email, accountId, expSec) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({
      email,
      sub: accountId,
      exp: expSec,
      'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'pro' }
    })).toString('base64url');
    return `${h}.${p}.sig`;
  };

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-rtr-preserve-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.CODEX_HOME;

  try {
    const codexDir = path.join(tmpHome, '.codex');
    const geminiDir = path.join(tmpHome, '.gemini');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.mkdirSync(geminiDir, { recursive: true });

    const nowSec = Math.floor(Date.now() / 1000);
    const expiredJwt = encodeJwt('rtr-active@example.test', 'acc-rtr', nowSec - 300);
    const rotatedJwt = encodeJwt('rtr-active@example.test', 'acc-rtr', nowSec + 7200);
    fs.writeFileSync(
      path.join(codexDir, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: expiredJwt,
          refresh_token: 'rt-old-active',
          id_token: expiredJwt,
          account_id: 'acc-rtr'
        }
      }, null, 2),
      'utf8'
    );

    const mockHttps = {
      request: (opts, cb) => {
        const req = new EventEmitter();
        req.write = () => {};
        req.destroy = () => {};
        req.end = () => {
          const res = new EventEmitter();
          res.statusCode = 200;
          cb(res);
          if (String(opts.hostname).includes('auth.openai.com')) {
            res.emit('data', JSON.stringify({
              access_token: rotatedJwt,
              refresh_token: 'rt-new-active',
              id_token: rotatedJwt
            }));
          } else {
            res.emit('data', JSON.stringify({
              plan_type: 'pro',
              rate_limit: {
                primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 7200 },
                secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 400000 }
              }
            }));
          }
          res.emit('end');
        };
        return req;
      }
    };

    const codexMod = await loadSource('src/codex.ts', { https: mockHttps });
    const vaultMod = await loadSource('src/vault.ts');
    const codexVault = new codexMod.CodexVault();
    const saved = codexVault.saveCurrentAsProfile('RTR Active');

    const codexSvc = new codexMod.CodexQuotaService();
    const metric = await codexSvc.refreshProfileQuota(saved.id, codexVault, true);
    assert.equal(metric.codex5h, '75%');

    const activeAfter = JSON.parse(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8'));
    const vaultAfter = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.gemini', 'charlier', 'providers', 'codex', 'profiles', saved.id, 'auth.json'), 'utf8')
    );
    assert.equal(activeAfter.tokens.refresh_token, 'rt-new-active');
    assert.equal(vaultAfter.tokens.refresh_token, 'rt-new-active');

    // Tokenless Antigravity profile preserves revoked status across identical sync
    const mockKeyring = {
      read: () => null,
      readAsync: async () => null,
      write: () => false,
      writeAsync: async () => false,
      delete: () => true,
      deleteAsync: async () => true
    };
    const agyVault = new vaultMod.Vault(mockKeyring);
    fs.writeFileSync(path.join(geminiDir, 'google_accounts.json'), JSON.stringify({ active: 'tokless@example.test', old: [] }));
    fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify({ access_token: 'at-only', token_type: 'Bearer' }));
    const agySaved = await agyVault.saveCurrentAsProfileAsync('Tokless');
    agyVault.updateProfileAuthHealth(agySaved.id, { authStatus: 'revoked', authErrorCode: 'token_revoked' });
    await agyVault.syncActiveCredentialsToProfileAsync(agySaved.id);
    assert.equal(agyVault.listProfiles().find((p) => p.id === agySaved.id).authStatus, 'revoked');
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('QuotaService.respawnActiveDaemon isolates local window PIDs, guards cooldown, and stops at 2 respawns in 10m across OSes', async () => {
  const fs = nodeRequire('fs');
  const path = nodeRequire('path');
  const os = nodeRequire('os');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-daemon-guard-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  const origKill = process.kill;
  const origGetHandles = process._getActiveHandles;

  try {
    const qvMod = await loadSource('src/quota-values.ts');
    assert.equal(
      qvMod.isAntigravityHubProcess({
        pid: 101,
        exitCode: null,
        signalCode: null,
        killed: false,
        spawnfile: 'C:\\Users\\dev\\.gemini\\bin\\agy.exe',
        spawnargs: ['agy.exe', '--hub', '--hub-port=5001', '--app_data_dir=antigravity-ide']
      }),
      101
    );
    assert.equal(
      qvMod.isAntigravityHubProcess({
        pid: 202,
        exitCode: null,
        signalCode: null,
        killed: false,
        spawnfile: '/bin/sh',
        spawnargs: ['/bin/sh', '-c', '/Users/dev/.gemini/bin/agy --hub --hub-port=5002']
      }),
      202
    );
    assert.equal(
      qvMod.isAntigravityHubProcess({
        pid: 303,
        exitCode: null,
        signalCode: null,
        killed: false,
        spawnfile: '/usr/local/bin/codex',
        spawnargs: ['codex', 'app-server']
      }),
      null
    );

    let appName = 'Visual Studio Code';
    const quotaMod = await loadSource('src/quota.ts', {
      vscode: {
        env: { get appName() { return appName; } },
        workspace: { getConfiguration: () => ({ get: (_k, d) => d }) }
      }
    });
    const svc = new quotaMod.QuotaService();

    const agyIdeDaemonDir = path.join(tmpHome, '.gemini', 'antigravity-ide', 'daemon');
    const vscDaemonDir = path.join(tmpHome, '.gemini', 'antigravity', 'daemon');
    fs.mkdirSync(agyIdeDaemonDir, { recursive: true });
    fs.mkdirSync(vscDaemonDir, { recursive: true });

    // Without local handles, VS Code (default config) must NOT kill Antigravity IDE daemon
    fs.writeFileSync(
      path.join(agyIdeDaemonDir, 'hub_14987.json'),
      JSON.stringify({ pid: 4001, httpPort: 14987, csrfToken: 'tok-ide' })
    );
    const killedPids = [];
    process.kill = (pid, sig) => {
      if (sig === 0 || sig === undefined) return true;
      killedPids.push(pid);
      return true;
    };
    process._getActiveHandles = () => [];

    assert.equal(await svc.respawnActiveDaemon(), 'not-running');
    assert.deepEqual(killedPids, [], 'VS Code default host must never kill Antigravity IDE daemon');

    // When both share antigravity-ide/daemon, localHandle matching kills ONLY this window's PID (4002)
    const writeLocalHub = (pid, port) => {
      fs.writeFileSync(
        path.join(agyIdeDaemonDir, `hub_${port}.json`),
        JSON.stringify({ pid, httpPort: port, csrfToken: `tok-${port}` })
      );
      process._getActiveHandles = () => [
        {
          pid,
          exitCode: null,
          signalCode: null,
          killed: false,
          spawnfile: 'agy.exe',
          spawnargs: ['agy.exe', '--hub', `--hub-port=${port}`, '--app_data_dir=antigravity-ide']
        }
      ];
    };

    writeLocalHub(4002, 5002);
    assert.equal(await svc.respawnActiveDaemon(), 'respawned');
    assert.deepEqual(killedPids, [4002], 'kills only local window PID, leaving 4001 alive');

    // Rapid follow-up within cooldown/inflight returns budget-exhausted with zero kill
    writeLocalHub(4003, 5003);
    assert.equal(await svc.respawnActiveDaemon(), 'budget-exhausted');
    assert.deepEqual(killedPids, [4002]);

    // Wait out cooldown & force clear inflight guard for simulation of 2nd kill, then verify 3rd hits budget cap
    svc.respawnInFlight = false;
    svc.lastRespawnAt = Date.now() - 5000;
    assert.equal(await svc.respawnActiveDaemon(), 'respawned');
    assert.deepEqual(killedPids, [4002, 4003]);

    writeLocalHub(4004, 5004);
    svc.respawnInFlight = false;
    svc.lastRespawnAt = Date.now() - 5000;
    assert.equal(await svc.respawnActiveDaemon(), 'budget-exhausted', '3rd respawn in 10m must block SIGTERM to prevent process_exit_nonzero');
    assert.deepEqual(killedPids, [4002, 4003]);
  } finally {
    process.kill = origKill;
    process._getActiveHandles = origGetHandles;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('resolveBestStandbyProfile recommends highest-headroom unclaimed healthy standby across Hero degradation and surfaces NEXT pills in Hover Matrix', () => {
  const now = Date.now();
  const codexProfiles = [
    {
      id: 'c-active',
      name: 'Active Low',
      email: 'a@example.test',
      cachedQuota: { plan: 'PRO', codex5h: '8%', codex7d: '80%', updatedAt: now }
    },
    {
      id: 'c-revoked',
      name: 'Dead Vault',
      email: 'd@example.test',
      authStatus: 'revoked',
      cachedQuota: { plan: 'PRO', codex5h: '99%', codex7d: '99%', updatedAt: now }
    },
    {
      id: 'c-claimed',
      name: 'Claimed CLI',
      email: 'c@example.test',
      cachedQuota: { plan: 'PRO', codex5h: '96%', codex7d: '94%', updatedAt: now }
    },
    {
      id: 'c-best',
      name: 'Ready Standby',
      email: 'b@example.test',
      cachedQuota: { plan: 'PLUS', codex5h: '88%', codex7d: '84%', updatedAt: now }
    }
  ];

  // Healthy active profile (>=15% and auth ok) returns null
  assert.equal(
    values.resolveBestStandbyProfile({
      provider: 'codex',
      profiles: codexProfiles,
      activeProfileId: 'c-active',
      activeMinPct: 55,
      activeNeedsAction: false
    }),
    null
  );

  // Degraded (<15%) prefers unclaimed healthy Ready Standby (84%) over Claimed CLI (94%) and skips revoked
  const pickedCodex = values.resolveBestStandbyProfile({
    provider: 'codex',
    profiles: codexProfiles,
    activeProfileId: 'c-active',
    activeMinPct: 8,
    activeNeedsAction: false,
    claimedProfileIds: new Set(['c-claimed'])
  });
  assert.ok(pickedCodex);
  assert.equal(pickedCodex.profile.id, 'c-best');
  assert.equal(pickedCodex.scorePct, 84);

  const codexSvc = new codex.CodexQuotaService();
  const codexHover = codexSvc.buildCodexHoverTooltip(
    codexProfiles,
    'c-active',
    { plan: 'PRO', codex5h: '8%', codex7d: '80%', updatedAt: now },
    { email: 'a@example.test' },
    new Set(['c-claimed'])
  );
  assert.match(codexHover.value, /\*\*Best Standby:\*\* \[Ready&nbsp;Standby\]/);
  assert.match(codexHover.value, /\*\*NEXT\*\*/);
  assert.match(codexHover.value, /\*\*incl\.\*\*/, 'paid standby Codex rows show incl. Review parity');

  const agyProfiles = [
    {
      id: 'a-rev',
      name: 'Active Verified Issue',
      email: 'ar@example.test',
      authStatus: 'unverified',
      cachedQuota: { plan: 'PRO', gemini: '90%', claudeGpt: '90%', argon: '90%', updatedAt: now }
    },
    {
      id: 'a-unv',
      name: 'Other Unverified',
      email: 'au@example.test',
      authStatus: 'unverified',
      cachedQuota: { plan: 'ULTRA', gemini: '100%', claudeGpt: '100%', argon: 'incl.', updatedAt: now }
    },
    {
      id: 'a-ok',
      name: 'Healthy Pro',
      email: 'ao@example.test',
      cachedQuota: { plan: 'PRO', gemini: '92%', claudeGpt: '86%', argon: '80%', updatedAt: now }
    }
  ];
  const pickedAgy = values.resolveBestStandbyProfile({
    provider: 'antigravity',
    profiles: agyProfiles,
    activeProfileId: 'a-rev',
    activeMinPct: 90,
    activeNeedsAction: true
  });
  assert.ok(pickedAgy);
  assert.equal(pickedAgy.profile.id, 'a-ok');
  assert.equal(pickedAgy.scorePct, 89);

  const agySvc = new quota.QuotaService();
  const agyHover = agySvc.buildAccountsHoverTooltip(agyProfiles, 'a-rev', 'ar@example.test', null);
  assert.match(agyHover.value, /\*\*Best Standby:\*\* \[Healthy&nbsp;Pro\]/);
  assert.match(agyHover.value, /\*\*NEXT\*\*/);
});

test('resolveBestStandbyProfile applies Healthy-Tier Bands and primary-pool bottlenecks accurately across tiers', () => {
  const now = Date.now();
  const activeHero = {
    id: 'active',
    name: 'Active Ultra',
    email: 'act@example.test',
    planOverride: 'ULTRA',
    cachedQuota: { plan: 'ULTRA', gemini: '85%', claudeGpt: '0%', argon: 'incl.', updatedAt: now }
  };
  const ultraHealthy = {
    id: 'u-50',
    name: 'Ultra 50',
    email: 'u50@example.test',
    planOverride: 'ULTRA',
    cachedQuota: { plan: 'ULTRA', gemini: '55%', claudeGpt: '30%', argon: 'incl.', updatedAt: now }
  };
  const ultraThin = {
    id: 'u-20',
    name: 'Ultra 20',
    email: 'u20@example.test',
    planOverride: 'ULTRA',
    cachedQuota: { plan: 'ULTRA', gemini: '20%', claudeGpt: '20%', argon: 'incl.', updatedAt: now }
  };
  const proFull = {
    id: 'p-100',
    name: 'Pro 100',
    email: 'p100@example.test',
    planOverride: 'PRO',
    cachedQuota: { plan: 'PRO', gemini: '100%', claudeGpt: '100%', argon: '100%', updatedAt: now }
  };
  const proNoClaude = {
    id: 'p-nocl',
    name: 'Pro No Claude',
    email: 'pnocl@example.test',
    planOverride: 'PRO',
    cachedQuota: { plan: 'PRO', gemini: '100%', claudeGpt: '0%', argon: '100%', updatedAt: now }
  };
  const freeFull = {
    id: 'f-100',
    name: 'Free 100',
    email: 'f100@example.test',
    planOverride: 'FREE',
    cachedQuota: { plan: 'FREE', gemini: '100%', claudeGpt: '--', argon: '--', updatedAt: now }
  };
  const freeMid = {
    id: 'f-60',
    name: 'Free 60',
    email: 'f60@example.test',
    planOverride: 'FREE',
    cachedQuota: { plan: 'FREE', gemini: '60%', claudeGpt: '--', argon: '--', updatedAt: now }
  };

  // 1. Active Ultra has Claude 0% (avg 43%) -> bottleneck triggers; Healthy Ultra (G 55%, C 30%) beats Pro 100% and ignores 0%-Claude Pro
  const pickUltraOverPro = values.resolveBestStandbyProfile({
    provider: 'antigravity',
    profiles: [activeHero, proNoClaude, proFull, ultraHealthy, freeFull],
    activeProfileId: 'active',
    activeMinPct: 43,
    activeNeedsAction: false,
    activePrimaryPools: { gemini: 85, claude: 0 }
  });
  assert.ok(pickUltraOverPro);
  assert.equal(pickUltraOverPro.profile.id, 'u-50');
  assert.equal(pickUltraOverPro.band, 'healthy-paid');

  // 2. When Ultra is thin (20%), Healthy Pro 100% beats thin Ultra 20%
  const pickProOverThinUltra = values.resolveBestStandbyProfile({
    provider: 'antigravity',
    profiles: [activeHero, ultraThin, proFull, freeFull],
    activeProfileId: 'active',
    activeMinPct: 5,
    activeNeedsAction: false
  });
  assert.ok(pickProOverThinUltra);
  assert.equal(pickProOverThinUltra.profile.id, 'p-100');
  assert.equal(pickProOverThinUltra.band, 'healthy-paid');

  // 3. When only Thin Ultra (20%) vs Free 100% remain, Paid Ultra 20% still beats Free 100%
  const pickThinUltraOverFree = values.resolveBestStandbyProfile({
    provider: 'antigravity',
    profiles: [activeHero, ultraThin, freeFull],
    activeProfileId: 'active',
    activeMinPct: 0,
    activeNeedsAction: false
  });
  assert.ok(pickThinUltraOverFree);
  assert.equal(pickThinUltraOverFree.profile.id, 'u-20');
  assert.equal(pickThinUltraOverFree.band, 'thin-paid');

  // 4. When only Free accounts remain, Free picks max % headroom (100% > 60%)
  const pickBestFree = values.resolveBestStandbyProfile({
    provider: 'antigravity',
    profiles: [activeHero, freeMid, freeFull],
    activeProfileId: 'active',
    activeMinPct: 0,
    activeNeedsAction: false
  });
  assert.ok(pickBestFree);
  assert.equal(pickBestFree.profile.id, 'f-100');
  assert.equal(pickBestFree.band, 'free');

  // 5. Same Healthy-Tier Bands apply on Codex (Healthy PRO 55% > Healthy PLUS 100%; Healthy PLUS 100% > Thin PRO 20%; Thin PRO 20% > FREE 100%)
  const cAct = { id: 'ca', name: 'Act', email: 'ca@example.test', cachedQuota: { plan: 'PRO', codex5h: '5%', codex7d: '80%', updatedAt: now } };
  const cPro55 = { id: 'cp55', name: 'Pro 55', email: 'cp55@example.test', planOverride: 'PRO', cachedQuota: { plan: 'PRO', codex5h: '55%', codex7d: '90%', updatedAt: now } };
  const cPro20 = { id: 'cp20', name: 'Pro 20', email: 'cp20@example.test', planOverride: 'PRO', cachedQuota: { plan: 'PRO', codex5h: '20%', codex7d: '80%', updatedAt: now } };
  const cPlus100 = { id: 'cpl100', name: 'Plus 100', email: 'cpl@example.test', planOverride: 'PLUS', cachedQuota: { plan: 'PLUS', codex5h: '100%', codex7d: '100%', updatedAt: now } };
  const cFree100 = { id: 'cf100', name: 'Free 100', email: 'cf@example.test', planOverride: 'FREE', cachedQuota: { plan: 'FREE', codex5h: '100%', updatedAt: now } };

  assert.equal(values.resolveBestStandbyProfile({
    provider: 'codex', profiles: [cAct, cPro55, cPlus100, cFree100], activeProfileId: 'ca', activeMinPct: 5, activeNeedsAction: false
  })?.profile.id, 'cp55');
  assert.equal(values.resolveBestStandbyProfile({
    provider: 'codex', profiles: [cAct, cPro20, cPlus100, cFree100], activeProfileId: 'ca', activeMinPct: 5, activeNeedsAction: false
  })?.profile.id, 'cpl100');
  assert.equal(values.resolveBestStandbyProfile({
    provider: 'codex', profiles: [cAct, cPro20, cFree100], activeProfileId: 'ca', activeMinPct: 5, activeNeedsAction: false
  })?.profile.id, 'cp20');
});

test('Codex attachStdoutObserver parses live account/rateLimits/updated, emits turn/completed, dedupes partial chunks & exit+close, and serializes concurrent RTR refreshes + CLI CLAIMED read-only reads', async () => {
  const fs = nodeRequire('fs');
  const os = nodeRequire('os');
  const path = nodeRequire('path');
  const { EventEmitter } = nodeRequire('events');

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-codex-live-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.CODEX_HOME;

  const makeJwt = (email, accountId, expSec) => {
    const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({
      email,
      exp: expSec,
      'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'pro' }
    })).toString('base64url');
    return `${h}.${p}.sig`;
  };

  let oauthCalls = 0;
  let whamTokensSeen = [];
  let force401 = false;
  const mockHttps = {
    request: (opts, cb) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        if (String(opts.hostname).includes('auth.openai.com')) {
          oauthCalls++;
          setTimeout(() => {
            res.statusCode = 200;
            cb(res);
            res.emit('data', JSON.stringify({
              access_token: makeJwt('rtr@example.test', 'acc-rtr', Math.floor(Date.now() / 1000) + 3600),
              refresh_token: 'rt-rotated-once'
            }));
            res.emit('end');
          }, 25);
        } else {
          whamTokensSeen.push(opts.headers?.Authorization || '');
          res.statusCode = force401 ? 401 : 200;
          cb(res);
          res.emit('data', force401
            ? JSON.stringify({ error: { code: 'token_expired', message: 'Access token expired' } })
            : JSON.stringify({
                plan_type: 'pro',
                rate_limit: {
                  primary_window: { used_percent: 30, reset_after_seconds: 1800, limit_window_seconds: 18000 },
                  secondary_window: { used_percent: 12, reset_after_seconds: 86400, limit_window_seconds: 604800 }
                }
              }));
          res.emit('end');
        }
      };
      return req;
    }
  };

  try {
    const codexMod = await loadSource('src/codex.ts', { https: mockHttps });
    const codexDir = path.join(tmpHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const expJwt = makeJwt('rtr@example.test', 'acc-rtr', Math.floor(Date.now() / 1000) + 30);
    const activeAuth = {
      last_refresh: '2026-11-20T00:00:00.000Z',
      tokens: { access_token: expJwt, refresh_token: 'rt-initial', id_token: expJwt, account_id: 'acc-rtr' }
    };
    fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify(activeAuth, null, 2));

    const vault = new codexMod.CodexVault();
    const prof = vault.autoSaveUnsavedActiveSession();
    assert.ok(prof);

    const svc = new codexMod.CodexQuotaService();
    const events = [];
    const rlPushes = [];
    let exitCount = 0;
    svc.onActivity((e) => events.push(e));
    svc.onRateLimitsUpdated((rl) => rlPushes.push(rl));
    svc.onProcessExited(() => exitCount++);

    // 1. Partial chunks do not duplicate turn/started; rateLimits/updated & turn/completed parse cleanly; exit+close fires once
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stdin = { write: () => true };
    fakeProc.exitCode = null;
    fakeProc.signalCode = null;
    fakeProc.killed = false;
    svc.attachStdoutObserver(fakeProc);

    fakeProc.stdout.emit('data', '{"method":"turn/started","params":{');
    fakeProc.stdout.emit('data', '"id":"1"}}\n');
    fakeProc.stdout.emit('data', JSON.stringify({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          planType: 'pro',
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
          secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 }
        }
      }
    }) + '\n');
    fakeProc.stdout.emit('data', '{"method":"turn/completed","params":{"threadId":"t1"}}\n');
    fakeProc.emit('exit', 0);
    fakeProc.emit('close', 0);

    assert.equal(events.filter((e) => e === 'turn/started').length, 1);
    assert.equal(events.filter((e) => e === 'turn/completed').length, 1);
    assert.equal(events.filter((e) => e === 'rateLimits/updated').length, 1);
    assert.equal(rlPushes.length, 1);
    assert.equal(exitCount, 1, 'exit + close must notify processExitListeners only once');

    const pushedMetric = svc.applyLiveRateLimitsPush(vault, rlPushes[0]);
    assert.ok(pushedMetric);
    assert.equal(pushedMetric.codex5h, '58%');
    assert.equal(pushedMetric.codex7d, '80%');
    assert.equal(vault.listProfiles().find((p) => p.id === prof.id)?.cachedQuota?.codex5h, '58%');

    // 2. Concurrent getActiveQuotaSummary + refreshProfileQuota serialize OAuth RTR into ONE /oauth/token call
    oauthCalls = 0;
    svc.invalidateCache();
    await Promise.all([
      svc.getActiveQuotaSummary(vault, true),
      svc.refreshProfileQuota(prof.id, vault, true)
    ]);
    assert.equal(oauthCalls, 1, 'concurrent active + profile refresh must serialize single-use RTR token rotation');

    // 3. CLI CLAIMED profile reads fresher CLI home auth read-only & plain 401 never falsely marks revoked
    const cliHomeDir = path.join(tmpHome, '.gemini', 'charlier', 'cli-homes', 'codex', prof.id);
    fs.mkdirSync(cliHomeDir, { recursive: true });
    const cliFreshJwt = makeJwt('rtr@example.test', 'acc-rtr', Math.floor(Date.now() / 1000) + 7200);
    fs.writeFileSync(path.join(cliHomeDir, 'auth.json'), JSON.stringify({
      last_refresh: new Date(Date.now() + 86_400_000).toISOString(),
      tokens: { access_token: cliFreshJwt, refresh_token: 'rt-cli-live', id_token: cliFreshJwt, account_id: 'acc-rtr' }
    }));
    fs.unlinkSync(path.join(codexDir, 'auth.json'));
    whamTokensSeen = [];
    svc.setClaimedProfileIdsProvider(() => new Set([prof.id]));
    const claimedMetric = await svc.refreshProfileQuota(prof.id, vault, false);
    assert.ok(claimedMetric);
    assert.equal(claimedMetric.codex5h, '70%');
    assert.ok(whamTokensSeen.some((h) => h.includes(cliFreshJwt)), 'must use fresher CLI home access_token read-only');

    force401 = true;
    await svc.refreshProfileQuota(prof.id, vault, false);
    assert.notEqual(
      vault.listProfiles().find((p) => p.id === prof.id)?.authStatus,
      'revoked',
      'plain 401 while refresh skipped for CLI CLAIMED must never falsely mark profile revoked'
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('QuotaService preserves cached summary on transient empty daemon response and reuses unexpired access token in refreshInactiveProfile', async () => {
  const svc = new quota.QuotaService();
  const validSummary = {
    email: 'hero@example.test',
    tier: 'Pro Plan',
    planTier: 'PRO',
    groups: [{ displayName: 'Gemini', description: '', buckets: [{ bucketId: 'g', displayName: '5h', description: '', window: '5h', remainingFraction: 0.72 }] }],
    hasArgonGroup: false,
    fetchedAt: Date.now() - 20_000
  };
  svc.cachedSummary = validSummary;
  svc.fetchFromDaemon = async () => ({
    email: 'hero@example.test',
    tier: 'Pro Plan',
    planTier: 'PRO',
    groups: [],
    hasArgonGroup: false,
    fetchedAt: Date.now()
  });
  const res = await svc.getQuotaSummary(true);
  assert.equal(res?.groups?.length, 1, 'transient empty groups response must not poison cached quota summary');

  // Unexpired access token reuse in refreshInactiveProfile avoids redundant OAuth minting
  let mintCalls = 0;
  let savedQuota = null;
  svc.mintAccessTokenFromRefresh = async () => {
    mintCalls++;
    return { ok: true, access_token: 'minted-at', expires_in: 3600 };
  };
  svc.postCloudCodeJson = async (_at, ep) => {
    if (ep.includes('loadCodeAssist')) return { status: 200, data: { paidTier: { id: 'g1-pro-tier' } } };
    if (ep.includes('fetchAvailableModels')) return { status: 200, data: { models: { 'gemini-2.5-pro': { quotaInfo: { remainingFraction: 0.9 } } } } };
    return { status: 200, data: { groups: [] } };
  };
  svc.getAICodeJson = async () => ({ status: 200, data: {} });
  const fakeVault = {
    getProfileAccessToken: () => ({ accessToken: 'cached-valid-at', expiryMs: Date.now() + 600_000 }),
    getProfileRefreshToken: () => 'rt-unused',
    updateInactiveProfileToken: () => {},
    updateProfileAuthHealth: () => true,
    updateProfileCachedQuota: (_id, m) => { savedQuota = m; }
  };
  const metric = await svc.refreshInactiveProfile(
    {
      id: 'standby-1',
      name: 'Standby',
      email: 's@example.test',
      createdAt: 1,
      updatedAt: 1,
      cachedQuota: { plan: 'PRO', gemini: '10%', gemini7d: '10%', claudeGpt: '80%', argon: '80%', updatedAt: 1 }
    },
    fakeVault,
    true
  );
  assert.equal(mintCalls, 0, 'unexpired cached access_token must skip redundant OAuth token mint');
  assert.equal(metric?.gemini, '90%', 'un-resettable stale gemini7d without reset timestamp must not cap fresh gemini5h');
  assert.equal(metric?.argon, '--', 'retired Argon must be wiped to -- on refreshInactiveProfile');
  assert.equal(savedQuota?.gemini, '90%');
});

test('Cloud Code proto payloads omit metadata on models/quota, prioritize gemini-4-hydrogen, hydrateActiveDaemonInPlace runs zero-kill HasAuthToken, and Codex Hover Matrix surfaces reset credits on Active + Standby rows', async () => {
  const svc = new quota.QuotaService();
  const postedPayloads = [];
  let forceFirstModels401 = true;
  let mintCount = 0;
  svc.mintAccessTokenFromRefresh = async () => {
    mintCount++;
    return { ok: true, access_token: 'fresh-minted-token', expires_in: 3600 };
  };
  svc.postCloudCodeJson = async (at, ep, body) => {
    postedPayloads.push({ at, ep, body });
    if (ep.includes('loadCodeAssist')) {
      return { status: 200, data: { cloudaicompanionProject: 'proj-1' } };
    }
    if (forceFirstModels401) {
      forceFirstModels401 = false;
      return { status: 401, data: null };
    }
    if (ep.includes('fetchAvailableModels')) {
      return {
        status: 200,
        data: {
          models: {
            'tab_flash_lite_preview': { quotaInfo: { remainingFraction: 1 } },
            'gemini-4-hydrogen-sonar': { quotaInfo: { remainingFraction: 0.77, resetTime: new Date(Date.now() + 3600_000).toISOString() } },
            'gemini-3.8-flash-tiered': { quotaInfo: { remainingFraction: 0.11 } }
          }
        }
      };
    }
    return {
      status: 200,
      data: {
        groups: [
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { window: '5h', remainingFraction: 0.64 },
              { window: 'weekly', remainingFraction: 0.82 }
            ]
          }
        ]
      }
    };
  };
  svc.getAICodeJson = async () => ({ status: 200, data: {} });

  const refreshed = await svc.refreshInactiveProfile(
    {
      id: 'pro-standby',
      name: 'Standby Pro',
      email: 'pro@charlier.dev',
      createdAt: 1,
      updatedAt: 1,
      cachedQuota: { plan: 'FREE', gemini: '--', claudeGpt: '--', argon: '100%', updatedAt: 1 }
    },
    {
      getProfileAccessToken: () => ({ accessToken: 'expired-cached-token', expiryMs: Date.now() + 500_000 }),
      getProfileRefreshToken: () => 'valid-rt',
      updateInactiveProfileToken: () => {},
      updateProfileAuthHealth: () => true,
      updateProfileCachedQuota: () => {}
    },
    true
  );
  const modelsReq = postedPayloads.find((p) => p.ep.includes('fetchAvailableModels'));
  const quotaReq = postedPayloads.find((p) => p.ep.includes('retrieveUserQuotaSummary'));
  assert.equal('metadata' in (modelsReq?.body || {}), false, 'fetchAvailableModels must NOT send metadata field');
  assert.equal('metadata' in (quotaReq?.body || {}), false, 'retrieveUserQuotaSummary must NOT send metadata field');
  assert.equal(mintCount, 1, '401 on cached token must remint and retry cleanly');
  assert.equal(refreshed?.plan, 'PRO', '3p-5h bucket presence must resolve PRO even when paidTier is omitted');
  assert.equal(refreshed?.gemini, '77%', 'must prioritize gemini-4-hydrogen-sonar over retiring 3.8-flash and tab_*');
  assert.equal(refreshed?.claudeGpt, '64%');
  assert.equal(refreshed?.argon, '--');

  // Zero-kill in-place HasAuthToken hydration: must NOT call slow GetAuthStatus (~4s)
  // and must fire `antigravity.reconnect` immediately after HasAuthToken before waiting on GetUserStatus
  const rpcCalls = [];
  const timeline = [];
  let reconnectCalled = 0;
  vscodeMock.commands.executeCommand = async (cmd) => {
    if (cmd === 'antigravity.reconnect') {
      reconnectCalled++;
      timeline.push('reconnect');
    }
  };
  svc.findActiveDaemon = () => ({ pid: 99999, httpPort: 41234, csrfToken: 'csrf' });
  svc.queryDaemonRpcWithMeta = async (_d, rpcPath) => {
    rpcCalls.push(rpcPath);
    if (rpcPath.endsWith('/HasAuthToken')) {
      timeline.push('HasAuthToken');
      return { status: 200, data: { hasToken: true } };
    }
    if (rpcPath.endsWith('/GetUserStatus')) {
      timeline.push('GetUserStatus');
      return { status: 200, data: { userStatus: { email: 'hortense@charlier.dev' } } };
    }
    return { status: 0, data: null };
  };
  let hydratedCallback = 0;
  const hStatus = await svc.hydrateActiveDaemonInPlace('hortense@charlier.dev', () => {
    hydratedCallback++;
  });
  assert.equal(hStatus, 'hydrated');
  assert.equal(hydratedCallback, 1);
  assert.equal(reconnectCalled, 1);
  assert.equal(
    rpcCalls.some((p) => p.endsWith('/GetAuthStatus')),
    false,
    'hydrateActiveDaemonInPlace must NOT call blocking ~4s GetAuthStatus RPC'
  );
  assert.deepEqual(
    timeline,
    ['HasAuthToken', 'reconnect', 'GetUserStatus'],
    'antigravity.reconnect must fire immediately after HasAuthToken before waiting on GetUserStatus'
  );

  // Extra dynamic upstream pool consistency between parseMetrics and Status Bar / Hover
  const extraParsed = svc.parseMetrics({
    planTier: 'PRO',
    groups: [
      { displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.9 }] },
      { displayName: 'Claude and GPT models', buckets: [{ window: '5h', remainingFraction: 0.8 }] },
      { displayName: 'Experimental Pool', buckets: [{ window: 'weekly', remainingFraction: 0.55 }] }
    ]
  });
  assert.equal(extraParsed.carbon, '55%', 'parseMetrics must surface unexpected extra paid pools consistently');

  // gRPC-Web HTTP 200 error (grpcStatus !== '0' / data: null) must NOT fire reconnect or pass HasAuthToken
  let errReconnectCalled = 0;
  let errUserStatusCalled = 0;
  vscodeMock.commands.executeCommand = async (cmd) => {
    if (cmd === 'antigravity.reconnect') errReconnectCalled++;
  };
  svc.queryDaemonRpcWithMeta = async (_d, rpcPath) => {
    if (rpcPath.endsWith('/HasAuthToken')) return { status: 200, data: null, grpcStatus: '12' };
    if (rpcPath.endsWith('/GetUserStatus')) {
      errUserStatusCalled++;
      return { status: 200, data: { userStatus: { email: 'hortense@charlier.dev' } } };
    }
    return { status: 0, data: null };
  };
  const errHStatus = await svc.hydrateActiveDaemonInPlace('hortense@charlier.dev');
  assert.equal(errHStatus, 'needs-respawn', 'gRPC-Web UNIMPLEMENTED (status 200, grpcStatus 12, data null) must immediately fall back to needs-respawn');
  assert.equal(errReconnectCalled, 0, 'failed HasAuthToken must not fire antigravity.reconnect');
  assert.equal(errUserStatusCalled, 0, 'failed HasAuthToken must not burn time polling GetUserStatus');

  // Offline / timeout across all Cloud Code endpoints must preserve existing PRO cachedQuota and authStatus
  const offlineSvc = new quota.QuotaService();
  offlineSvc.postCloudCodeJson = async () => ({ status: 0, data: null });
  offlineSvc.getAICodeJson = async () => ({ status: 0, data: null });
  let offlineSavedQuota = null;
  let offlineSavedHealth = null;
  const preservedPro = {
    plan: 'PRO',
    gemini: '82%',
    claudeGpt: '74%',
    argon: '--',
    updatedAt: 1000
  };
  const offlineResult = await offlineSvc.refreshInactiveProfile(
    {
      id: 'offline-pro',
      name: 'Offline Pro',
      email: 'offline@charlier.dev',
      createdAt: 1,
      updatedAt: 1,
      authStatus: 'expired',
      cachedQuota: preservedPro
    },
    {
      getProfileAccessToken: () => ({ accessToken: 'cached-valid-token', expiryMs: Date.now() + 600_000 }),
      getProfileRefreshToken: () => 'rt-offline',
      updateInactiveProfileToken: () => {},
      updateProfileAuthHealth: (_id, h) => { offlineSavedHealth = h; return true; },
      updateProfileCachedQuota: (_id, q) => { offlineSavedQuota = q; }
    },
    true
  );
  assert.equal(offlineResult?.plan, 'PRO', 'all-endpoint offline failure must keep cached PRO plan');
  assert.equal(offlineResult?.claudeGpt, '74%', 'all-endpoint offline failure must not wipe cached claudeGpt to --');
  assert.equal(offlineSavedQuota, null, 'all-endpoint offline failure must not overwrite disk cachedQuota');
  assert.equal(offlineSavedHealth, null, 'all-endpoint offline failure must not falsely stamp authStatus ok');

  // Codex Hover Matrix: reset credits inline badge on BOTH Active and Standby rows (when > 0)
  const codexSvc = new codex.CodexQuotaService();
  const codexHover = codexSvc.buildCodexHoverTooltip(
    [
      {
        id: 'c-active',
        name: 'Hortense',
        email: 'hortense@charlier.dev',
        cachedQuota: { plan: 'PLUS', gemini: '80%', claudeGpt: '90%', argon: '--', codex5h: '80%', codex7d: '90%', codexResetCredits: 2, updatedAt: Date.now() },
        updatedAt: Date.now()
      },
      {
        id: 'c-standby',
        name: 'Renine',
        email: 'renine@charlier.dev',
        cachedQuota: { plan: 'PLUS', gemini: '70%', claudeGpt: '85%', argon: '--', codex5h: '70%', codex7d: '85%', codexResetCredits: 3, updatedAt: Date.now() },
        updatedAt: Date.now() - 1000
      },
      {
        id: 'c-zero',
        name: 'Victoire',
        email: 'victoire@charlier.dev',
        cachedQuota: { plan: 'PLUS', gemini: '95%', claudeGpt: '95%', argon: '--', codex5h: '95%', codex7d: '95%', codexResetCredits: 0, updatedAt: Date.now() },
        updatedAt: Date.now() - 2000
      }
    ],
    'c-active',
    null,
    { email: 'hortense@charlier.dev' }
  );
  assert.match(codexHover.value, /\*\*Hortense\*\*[\s\S]*?\$\(zap\)&nbsp;2/, 'Active row in Hover Matrix must include $(zap) 2 badge');
  assert.match(codexHover.value, /\[Renine\][\s\S]*?\$\(zap\)&nbsp;3/, 'Standby row in Hover Matrix must include $(zap) 3 badge');
  assert.doesNotMatch(codexHover.value, /\[Victoire\][^\n]*\$\(zap\)/, 'Zero reset credits must not render noisy badge');

  // applyLiveRateLimitsPush clears stale balance when hasCredits becomes false & flags reset jump
  codexSvc.cachedMetric = {
    plan: 'PLUS',
    gemini: '10%',
    claudeGpt: '80%',
    argon: '--',
    codex5h: '10%',
    codex7d: '80%',
    codexResetCredits: 2,
    codexCreditsBalance: '$14.00',
    updatedAt: Date.now()
  };
  const fakeCodexVault = {
    readDecodedActiveAuth: () => ({ email: 'hortense@charlier.dev', accountId: 'acc-h', authMode: 'chatgpt', planTier: 'PLUS' }),
    findMatchingProfile: () => null,
    updateProfileCachedQuota: () => {},
    updateProfileAuthHealth: () => {}
  };
  const pushed = codexSvc.applyLiveRateLimitsPush(fakeCodexVault, {
    primary: { usedPercent: 0, resetsAt: Math.floor(Date.now() / 1000) + 18000 },
    secondary: { usedPercent: 20, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
    credits: { hasCredits: false, balance: null }
  });
  assert.equal(pushed?.codex5h, '100%');
  assert.equal(pushed?.codexCreditsBalance, undefined, 'hasCredits:false must clear stale codexCreditsBalance');
  assert.equal(codexSvc.getLastFetchTime(), 0, 'mid-session 5h jump from 10% -> 100% with credits > 0 must arm immediate wham/usage sync');

  // Codex hotSwapCodexAppServer: immediate visual remount pulse (< 80ms even when initialize takes 140ms)
  // and FIFO buffering of rootProc.stdin writes until replacement app-server completes initialize
  const { PassThrough, Writable } = nodeRequire('stream');
  const parserWrites = [];
  const parserMock = new Writable({
    write(chunk, _enc, cb) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) parserWrites.push({ at: Date.now(), line });
      }
      cb();
    }
  });
  const mockServerScript = [
    "setTimeout(() => process.exit(0), 4000).unref();",
    "let buf='';",
    "process.stdin.on('data', d => {",
    "  buf += d.toString('utf8');",
    "  const lines = buf.split('\\n'); buf = lines.pop() ?? '';",
    "  for (const l of lines) {",
    "    if (!l.trim()) continue;",
    "    const msg = JSON.parse(l);",
    "    if (msg.method === 'initialize') {",
    "      setTimeout(() => process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + '\\n'), 140);",
    "    } else if (msg.method === 'account/read') {",
    "      process.stdout.write(JSON.stringify({ id: msg.id, result: { account: { email: 'buffered@charlier.dev' } } }) + '\\n');",
    "    }",
    "  }",
    "});"
  ].join('');
  const oldStdout = new PassThrough();
  oldStdout._readableState = { pipes: parserMock };
  const fakeRootProc = {
    pid: -1,
    spawnfile: process.execPath,
    spawnargs: [process.execPath, '-e', mockServerScript],
    stdout: oldStdout,
    stdin: new PassThrough(),
    stderr: new PassThrough(),
    removeAllListeners() {},
    kill() { return true; }
  };
  const swapSvc = new codex.CodexQuotaService();
  swapSvc.graftedRootProc = fakeRootProc;
  swapSvc.graftedCurrentChild = fakeRootProc;
  swapSvc.graftedParser = parserMock;
  swapSvc.ensureGraftedHandles = () => true;

  try {
    const swapStart = Date.now();
    const swapPromise = swapSvc.hotSwapCodexAppServer('chatgpt');
    // Wait 75ms: pulse (prime + null + login/completed + authMode) must already have fired
    // BEFORE the 140ms mock initialize finishes, and writing to fakeRootProc.stdin must buffer safely!
    await new Promise((r) => setTimeout(r, 75));
    const preInitMethods = parserWrites.map((w) => JSON.parse(w.line).method);
    assert.ok(
      preInitMethods.includes('account/updated') && preInitMethods.includes('account/login/completed'),
      `Visual remount pulse must fire immediately before initialize completes (got: ${preInitMethods.join(',')})`
    );
    let bufferedWriteAcked = false;
    fakeRootProc.stdin.write(
      JSON.stringify({ id: 'buf-req-1', method: 'account/read', params: { refreshToken: false } }) + '\n',
      (err) => {
        if (!err) bufferedWriteAcked = true;
      }
    );
    const swapRes = await swapPromise;
    assert.equal(swapRes, 'swapped');
    assert.ok(Date.now() - swapStart >= 130, 'mock initialize must have actually completed');
    // Wait briefly for buffered account/read echo to arrive on parserMock
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(bufferedWriteAcked, true, 'buffered stdin write callback must settle after flush');
    assert.ok(
      parserWrites.some((w) => w.line.includes('"buf-req-1"') && w.line.includes('buffered@charlier.dev')),
      'buffered JSON-RPC request written during respawn must flush FIFO to replacement app-server'
    );
  } finally {
    try {
      fakeRootProc.kill('SIGKILL');
    } catch {}
  }

  // Regression guard: synchronous spawn failure inside hotSwapCodexAppServer must restore rootProc.stdin
  // and settle buffered callbacks with error instead of leaving rootProc.stdin wedged on bufferedStdin
  const brokenOrigStdin = new PassThrough();
  const brokenRootProc = {
    pid: -1,
    spawnfile: nodeRequire('path').join(nodeRequire('os').tmpdir(), 'charlier-nonexistent-codex-binary-xyz-99999'),
    spawnargs: ['nonexistent'],
    stdout: new PassThrough(),
    stdin: brokenOrigStdin,
    stderr: new PassThrough(),
    removeAllListeners() {},
    kill() { return true; }
  };
  const brokenSwapSvc = new codex.CodexQuotaService();
  brokenSwapSvc.graftedRootProc = brokenRootProc;
  brokenSwapSvc.graftedCurrentChild = brokenRootProc;
  brokenSwapSvc.graftedParser = parserMock;
  brokenSwapSvc.ensureGraftedHandles = () => true;
  const brokenRes = await brokenSwapSvc.hotSwapCodexAppServer('chatgpt');
  assert.equal(brokenRes, 'failed');
  assert.equal(brokenRootProc.stdin, brokenOrigStdin, 'failed hotSwapCodexAppServer must restore previous rootProc.stdin cleanly');
});

test('healExpiredAntigravityMetric, inactive >6h weekly horizon classification, force_refresh=true daemon RPC, and Hover Claude 5h/7d parity', async () => {
  const pastIso = new Date(Date.now() - 600_000).toISOString();
  const future3h = new Date(Date.now() + 3 * 3600_000).toISOString();
  const future6d = new Date(Date.now() + 6 * 86400_000).toISOString();

  // 1. healExpiredAntigravityMetric promotes expired 5h & claude5h, strips bogus >6h gemini5hReset, and recomputes summary min
  const healed = quota.healExpiredAntigravityMetric({
    plan: 'PRO',
    gemini: '32%',
    claudeGpt: '0%',
    argon: '--',
    gemini5h: '32%',
    gemini5hReset: pastIso,
    gemini7d: '73%',
    gemini7dReset: future6d,
    claude5h: '0%',
    claude5hReset: pastIso,
    claude7d: '34%',
    claude7dReset: future6d,
    updatedAt: Date.now() - 1000
  });
  assert.equal(healed.gemini5h, '100%');
  assert.equal(healed.gemini5hReset, undefined);
  assert.equal(healed.gemini7d, '73%');
  assert.equal(healed.gemini, '73%', 'summary gemini recomputes to min(100%, 73%)');
  assert.equal(healed.claude5h, '100%');
  assert.equal(healed.claudeGpt, '34%', 'summary claudeGpt recomputes to min(100%, 34%)');

  // Legacy corrupted snapshot where a 7d reset timestamp leaked into gemini5hReset gets sanitized
  const sanitized = quota.healExpiredAntigravityMetric({
    plan: 'FREE',
    gemini: '100%',
    claudeGpt: '--',
    argon: '--',
    gemini5h: '100%',
    gemini5hReset: future6d,
    gemini7d: '100%',
    updatedAt: Date.now()
  });
  assert.equal(sanitized.gemini5hReset, undefined, '7-day timestamp must never remain on gemini5hReset');
  assert.equal(sanitized.gemini7dReset, future6d, '7-day timestamp migrates cleanly to gemini7dReset');

  // 2. refreshInactiveProfile classifies fetchAvailableModels resetTime > 6h as gemini7d (NEVER overwriting gemini5h or stamping 6d onto 5h)
  const svc = new quota.QuotaService();
  svc.postCloudCodeJson = async (_at, ep) => {
    if (ep.includes('loadCodeAssist')) return { status: 200, data: { paidTier: { id: 'g1-pro-tier' } } };
    if (ep.includes('fetchAvailableModels')) {
      return {
        status: 200,
        data: {
          models: {
            'gemini-4-hydrogen-sonar': {
              quotaInfo: { remainingFraction: 0.72, resetTime: future6d }
            }
          }
        }
      };
    }
    return { status: 200, data: { groups: [] } };
  };
  svc.getAICodeJson = async () => ({ status: 200, data: {} });
  const fakeVault = {
    getProfileAccessToken: () => ({ accessToken: 'valid-at', expiryMs: Date.now() + 600_000 }),
    getProfileRefreshToken: () => 'rt',
    updateInactiveProfileToken: () => {},
    updateProfileAuthHealth: () => true,
    updateProfileCachedQuota: () => {}
  };
  const weeklyTightMetric = await svc.refreshInactiveProfile(
    {
      id: 'weekly-tight',
      name: 'WeeklyTight',
      email: 'wt@charlier.dev',
      createdAt: 1,
      updatedAt: 1,
      cachedQuota: {
        plan: 'PRO',
        gemini: '73%',
        claudeGpt: '34%',
        argon: '--',
        gemini5h: '90%',
        gemini5hReset: future3h,
        gemini7d: '73%',
        gemini7dReset: future6d,
        updatedAt: Date.now() - 60_000
      }
    },
    fakeVault,
    true
  );
  assert.equal(weeklyTightMetric?.gemini7d, '72%', '>6h resetTime must update gemini7d');
  assert.equal(weeklyTightMetric?.gemini7dReset, future6d);
  assert.equal(weeklyTightMetric?.gemini5h, '90%', '>6h weekly bucket must NOT clobber higher valid gemini5h');
  assert.equal(weeklyTightMetric?.gemini5hReset, future3h, '5h reset timestamp must remain intact');
  assert.equal(weeklyTightMetric?.gemini, '72%', 'summary gemini reflects tighter 72% weekly limit');

  // 3. fetchFromDaemon always passes force_refresh: true to RetrieveUserQuotaSummary so agy never returns stale internal cache
  const daemonSvc = new quota.QuotaService();
  let capturedPayload = null;
  daemonSvc.findActiveDaemon = () => ({ pid: 123, httpPort: 9999, csrfToken: 'tok' });
  daemonSvc.queryDaemonRpcWithMeta = async (_d, pathStr, payload) => {
    if (pathStr.includes('RetrieveUserQuotaSummary')) {
      capturedPayload = payload;
      return {
        status: 200,
        data: {
          response: {
            groups: [
              { displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.9 }, { window: 'weekly', remainingFraction: 0.72 }] }
            ]
          }
        }
      };
    }
    return { status: 200, data: { userStatus: { email: 'live@charlier.dev', userTier: { id: 'g1-pro-tier' } } } };
  };
  await daemonSvc.getQuotaSummary(false);
  assert.deepEqual(capturedPayload, { force_refresh: true }, 'RetrieveUserQuotaSummary must pass force_refresh: true on cache miss');

  // 4. Hover tooltip shows both 5h and 7d on Claude & GPT in both live (even when 5h === 100%) and cached fallback modes
  const hoverSvc = new quota.QuotaService();
  const liveHover = hoverSvc.buildAccountsHoverTooltip(
    [{ id: 'p1', name: 'Pro', email: 'p@charlier.dev', updatedAt: Date.now() }],
    'p1',
    'p@charlier.dev',
    {
      email: 'p@charlier.dev',
      planTier: 'PRO',
      tier: 'Pro Plan',
      fetchedAt: Date.now(),
      groups: [
        { displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.9, resetTime: future3h }, { window: 'weekly', remainingFraction: 0.72, resetTime: future6d }] },
        { displayName: 'Claude and GPT models', buckets: [{ window: '5h', remainingFraction: 1, resetTime: future3h }, { window: 'weekly', remainingFraction: 0.34, resetTime: future6d }] }
      ]
    }
  );
  assert.ok(liveHover.value.includes('5h:') && liveHover.value.includes('100%') && liveHover.value.includes('34%'), 'live Claude row must show both 5h and 7d even when 5h is 100%');

  const cachedHover = hoverSvc.buildAccountsHoverTooltip(
    [{
      id: 'p1',
      name: 'Pro',
      email: 'p@charlier.dev',
      updatedAt: Date.now(),
      cachedQuota: {
        plan: 'PRO',
        gemini: '72%',
        claudeGpt: '0%',
        argon: '--',
        gemini5h: '90%',
        gemini5hReset: future3h,
        gemini7d: '72%',
        gemini7dReset: future6d,
        claude5h: '0%',
        claude5hReset: future3h,
        claude7d: '34%',
        claude7dReset: future6d,
        updatedAt: Date.now()
      }
    }],
    'p1',
    'p@charlier.dev',
    null
  );
  assert.ok(cachedHover.value.includes('5h:') && cachedHover.value.includes('0%') && cachedHover.value.includes('34%'), 'cached Claude row must render both 5h and 7d with accurate 5h reset');

  // 5. healExpiredCodexMetric suppresses bogus future countdowns on 100% Codex bars
  const fullCodex = codex.healExpiredCodexMetric({
    plan: 'FREE',
    gemini: '100%',
    claudeGpt: '--',
    argon: '--',
    codex5h: '100%',
    codex5hResetAtMs: Date.now() + 25 * 86400_000,
    updatedAt: Date.now()
  });
  assert.equal(fullCodex.codex5hReset, undefined, '100% Codex pool must not display a countdown string');
});
