import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const nodeRequire = createRequire(import.meta.url);
const result = await esbuild.build({
  entryPoints: ['src/cli-isolation.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  write: false,
  logLevel: 'silent'
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', '__dirname', result.outputFiles[0].text)(
  (name) => (name === 'vscode' ? {} : nodeRequire(name)),
  mod,
  mod.exports,
  path.resolve('dist')
);

const {
  buildAntigravityCliTokenFromOAuth,
  buildIsolatedCodexConfigToml,
  cleanupProfileCliHome,
  prepareAntigravityCliHome,
  prepareCodexCliHome,
  resolveSafeProfileSubdir,
  syncAntigravityCliHomeToVault,
  syncCodexCliHomeToVault
} = mod.exports;

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'charlier-isolation-test-'));
  const realHome = path.join(root, 'home');
  const realCodex = path.join(realHome, '.codex');
  const realGemini = path.join(realHome, '.gemini');
  const charlierDir = path.join(realGemini, 'charlier');
  const profilesDir = path.join(charlierDir, 'profiles');
  const codexProfilesDir = path.join(charlierDir, 'providers', 'codex', 'profiles');
  for (const d of [realHome, realCodex, realGemini, charlierDir, profilesDir, codexProfilesDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return {
    root,
    roots: {
      charlierDir,
      profilesDir,
      codexProfilesDir,
      realHomeDir: realHome,
      realCodexHomeDir: realCodex,
      realGeminiHomeDir: realGemini
    },
    realHome,
    realCodex,
    realGemini,
    profilesDir,
    codexProfilesDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

test('resolveSafeProfileSubdir blocks traversal and empty identifiers', () => {
  const base = path.join(os.tmpdir(), 'charlier-safe-base');
  assert.equal(resolveSafeProfileSubdir(base, 'sernine'), path.resolve(base, 'sernine'));
  for (const bad of ['', '   ', '.', '..', '../evil', 'a/b', 'a\\b', 'bad\0id']) {
    assert.throws(() => resolveSafeProfileSubdir(base, bad));
  }
});

test('buildIsolatedCodexConfigToml strips root keyring setting and prepends file store before trailing [projects] tables', () => {
  const input = [
    'model = "gpt-5.4"',
    'cli_auth_credentials_store = "keyring"',
    '',
    '[projects."S:\\\\Projects\\\\Charlier"]',
    'trust_level = "trusted"',
    ''
  ].join('\r\n');

  const out = buildIsolatedCodexConfigToml(input);
  const lines = out.split(/\r\n/);
  assert.equal(lines[0], 'cli_auth_credentials_store = "file"');
  assert.equal(lines.includes('cli_auth_credentials_store = "keyring"'), false);
  const fileStoreIdx = lines.indexOf('cli_auth_credentials_store = "file"');
  const projectIdx = lines.findIndex((l) => l.startsWith('[projects.'));
  assert.equal(fileStoreIdx, 0);
  assert.ok(projectIdx > fileStoreIdx);

  // Also works cleanly when user has no config.toml
  assert.equal(buildIsolatedCodexConfigToml(''), 'cli_auth_credentials_store = "file"\n');
});

test('Codex CLI isolation materializes isolated CODEX_HOME, syncs fresher RTR back to vault, and cleans up safely', () => {
  const sb = makeSandbox();
  try {
    const profileId = 'bakup';
    const profileDir = path.join(sb.codexProfilesDir, profileId);
    fs.mkdirSync(profileDir, { recursive: true });
    const vaultAuth = {
      auth_mode: 'chatgpt',
      last_refresh: '2026-11-15T10:00:00.000Z',
      tokens: { access_token: 'tok-v1', refresh_token: 'rt-v1', account_id: 'acc-b' }
    };
    fs.writeFileSync(path.join(profileDir, 'auth.json'), JSON.stringify(vaultAuth), 'utf8');
    fs.writeFileSync(path.join(sb.realCodex, 'auth.json'), JSON.stringify({ tokens: { access_token: 'ide-hero', refresh_token: 'rt-hero' } }), 'utf8');
    fs.writeFileSync(
      path.join(sb.realCodex, 'config.toml'),
      'cli_auth_credentials_store = "auto"\n\n[projects."foo"]\ntrust_level = "trusted"\n',
      'utf8'
    );
    fs.mkdirSync(path.join(sb.realCodex, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(sb.realCodex, 'skills', 'demo.md'), '# skill', 'utf8');
    fs.writeFileSync(path.join(sb.realCodex, 'AGENTS.md'), '# instructions', 'utf8');

    const res = prepareCodexCliHome(profileId, { ...sb.roots, platform: 'win32', env: { PATH: 'C:\\Windows\\System32' } });
    assert.equal(res.env.CODEX_HOME, res.homeDir);
    assert.equal(JSON.parse(fs.readFileSync(path.join(res.homeDir, 'auth.json'), 'utf8')).tokens.refresh_token, 'rt-v1');
    assert.match(fs.readFileSync(path.join(res.homeDir, 'config.toml'), 'utf8'), /^cli_auth_credentials_store = "file"/);
    assert.equal(fs.existsSync(path.join(res.homeDir, 'skills', 'demo.md')), true);
    assert.equal(fs.existsSync(path.join(res.homeDir, 'AGENTS.md')), true);
    // Global IDE auth untouched
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.realCodex, 'auth.json'), 'utf8')).tokens.refresh_token, 'rt-hero');

    // Simulate Codex CLI rotating single-use RTR inside isolated home
    const rotatedCliAuth = {
      auth_mode: 'chatgpt',
      last_refresh: '2026-11-15T12:00:00.000Z',
      tokens: { access_token: 'tok-v2', refresh_token: 'rt-v2', account_id: 'acc-b' }
    };
    fs.writeFileSync(path.join(res.homeDir, 'auth.json'), JSON.stringify(rotatedCliAuth), 'utf8');

    // Syncing or re-preparing preserves fresher rotated token in vault instead of overwriting with stale rt-v1
    assert.equal(syncCodexCliHomeToVault(profileId, sb.roots), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(profileDir, 'auth.json'), 'utf8')).tokens.refresh_token, 'rt-v2');
    prepareCodexCliHome(profileId, { ...sb.roots, platform: 'win32', env: { PATH: 'C:\\Windows\\System32' } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(res.homeDir, 'auth.json'), 'utf8')).tokens.refresh_token, 'rt-v2');

    // Cleanup removes isolated home without deleting symlinked/junctioned shared skill file
    cleanupProfileCliHome('codex', profileId, sb.roots);
    assert.equal(fs.existsSync(res.homeDir), false);
    assert.equal(fs.existsSync(path.join(sb.realCodex, 'skills', 'demo.md')), true);
  } finally {
    sb.cleanup();
  }
});

test('Antigravity CLI isolation emits cross-OS file-store env, materializes token with OAuth fallback, syncs fresher CLI tokens, and never touches real home', () => {
  const sb = makeSandbox();
  try {
    const profileId = 'standby';
    const profileDir = path.join(sb.profilesDir, profileId);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'google_accounts.json'),
      JSON.stringify({ active: 'standby@example.test', old: [] }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(profileDir, 'oauth_creds.json'),
      JSON.stringify({ access_token: 'agy-at-1', refresh_token: 'agy-rt-1', token_type: 'Bearer', expiry_date: 1795000000000 }),
      'utf8'
    );
    fs.mkdirSync(path.join(sb.realHome, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(sb.realHome, '.ssh', 'known_hosts'), 'github.com', 'utf8');
    fs.mkdirSync(path.join(sb.realGemini, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(sb.realGemini, 'skills', 'charlier.md'), 'hi', 'utf8');
    fs.mkdirSync(path.join(sb.realGemini, 'antigravity'), { recursive: true });
    fs.writeFileSync(path.join(sb.realGemini, 'antigravity', 'ide_only.txt'), 'secret', 'utf8');

    // Win32
    const winRes = prepareAntigravityCliHome(profileId, { ...sb.roots, platform: 'win32', env: { PATH: 'C:\\Windows\\System32' } });
    assert.equal(winRes.env.HOME, winRes.homeDir);
    assert.equal(winRes.env.USERPROFILE, winRes.homeDir);
    assert.equal(winRes.env.WSL_DISTRO_NAME, 'Charlier');

    // macOS (darwin)
    const macRes = prepareAntigravityCliHome(profileId, { ...sb.roots, platform: 'darwin', env: { PATH: '/usr/bin' } });
    assert.equal(macRes.env.HOME, macRes.homeDir);
    assert.equal(macRes.env.USERPROFILE, undefined);
    assert.equal(macRes.env.WSL_DISTRO_NAME, 'Charlier');

    // Linux
    fs.mkdirSync(path.join(sb.realHome, '.config', 'secret'), { recursive: true });
    fs.mkdirSync(path.join(sb.realHome, '.local', 'share'), { recursive: true });
    const linRes = prepareAntigravityCliHome(profileId, { ...sb.roots, platform: 'linux', env: { PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' } });
    assert.equal(linRes.env.HOME, linRes.homeDir);
    assert.equal(linRes.env.XDG_CONFIG_HOME, path.join(linRes.homeDir, '.xdg', 'config'));
    assert.equal(linRes.env.XDG_DATA_HOME, path.join(linRes.homeDir, '.xdg', 'data'));
    assert.equal(linRes.env.XDG_STATE_HOME, path.join(linRes.homeDir, '.xdg', 'state'));
    assert.equal(linRes.env.DBUS_SESSION_BUS_ADDRESS, null);
    assert.equal(linRes.env.GNOME_KEYRING_CONTROL, null);
    assert.equal(linRes.env.WSL_DISTRO_NAME, undefined);
    assert.equal(fs.existsSync(path.join(linRes.homeDir, '.config')), false);
    assert.equal(fs.existsSync(path.join(linRes.homeDir, '.local')), false);

    // Synthesized keyring token exists in exact binary path <home>/.gemini/antigravity-cli/antigravity-oauth-token
    const tokenPath = path.join(winRes.homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    const tokenObj = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    assert.equal(tokenObj.auth_method, 'consumer');
    assert.equal(tokenObj.id_token_email, 'standby@example.test');
    assert.equal(tokenObj.token.refresh_token, 'agy-rt-1');

    // Safe mirroring includes .ssh & .gemini/skills while excluding IDE .gemini/antigravity
    assert.equal(fs.existsSync(path.join(winRes.homeDir, '.ssh', 'known_hosts')), true);
    assert.equal(fs.existsSync(path.join(winRes.homeDir, '.gemini', 'skills', 'charlier.md')), true);
    assert.equal(fs.existsSync(path.join(winRes.homeDir, '.gemini', 'antigravity')), false);

    // Newer CLI token refreshes back into vault and clears stale revoked status
    fs.writeFileSync(
      path.join(profileDir, 'metadata.json'),
      JSON.stringify({ id: profileId, name: 'Standby', email: 'standby@example.test', authStatus: 'revoked', authErrorCode: 'token_revoked' }),
      'utf8'
    );
    const newerCliToken = JSON.parse(buildAntigravityCliTokenFromOAuth({
      access_token: 'agy-at-2',
      refresh_token: 'agy-rt-1',
      expiry_date: 1796000000000
    }, 'standby@example.test'));
    fs.writeFileSync(tokenPath, JSON.stringify(newerCliToken), 'utf8');
    assert.equal(syncAntigravityCliHomeToVault(profileId, sb.roots), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(profileDir, 'keyring_credential.json'), 'utf8')).token.access_token, 'agy-at-2');
    assert.equal(JSON.parse(fs.readFileSync(path.join(profileDir, 'oauth_creds.json'), 'utf8')).access_token, 'agy-at-2');
    assert.equal(JSON.parse(fs.readFileSync(path.join(profileDir, 'metadata.json'), 'utf8')).authStatus, 'ok');

    // Codex CLI token rotation also heals stale revoked status in metadata.json
    const codexProfileDir = path.join(sb.codexProfilesDir, 'codex-revoked');
    fs.mkdirSync(codexProfileDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexProfileDir, 'metadata.json'),
      JSON.stringify({ id: 'codex-revoked', name: 'Codex Revoked', email: 'c@example.test', provider: 'codex', authStatus: 'revoked' }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(codexProfileDir, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'c-at-1', refresh_token: 'c-rt-1' }, last_refresh: '2026-01-01T00:00:00.000Z' }),
      'utf8'
    );
    const codexEnv = prepareCodexCliHome('codex-revoked', sb.roots);
    fs.writeFileSync(
      path.join(codexEnv.homeDir, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'c-at-2', refresh_token: 'c-rt-2' }, last_refresh: '2026-02-01T00:00:00.000Z' }),
      'utf8'
    );
    assert.equal(syncCodexCliHomeToVault('codex-revoked', sb.roots), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(codexProfileDir, 'metadata.json'), 'utf8')).authStatus, 'ok');

    // Safe cleanup preserves real ~/.ssh
    cleanupProfileCliHome('antigravity', profileId, sb.roots);
    assert.equal(fs.existsSync(winRes.homeDir), false);
    assert.equal(fs.existsSync(path.join(sb.realHome, '.ssh', 'known_hosts')), true);
  } finally {
    sb.cleanup();
  }
});
