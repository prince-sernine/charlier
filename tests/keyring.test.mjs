import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'os';
import * as path from 'path';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

test('src/keyring.ts contains zero PowerShell, Add-Type, or EncodedCommand paths', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'keyring.ts'), 'utf8');
  assert.equal(src.includes('powershell'), false, 'src/keyring.ts must not invoke powershell');
  assert.equal(src.includes('Add-Type'), false, 'src/keyring.ts must not invoke Add-Type');
  assert.equal(src.includes('EncodedCommand'), false, 'src/keyring.ts must not use EncodedCommand');
});

test('KeyringManager bundles cleanly via esbuild with module/createRequire', async () => {
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src', 'keyring.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode']
  });
  const code = result.outputFiles[0].text;
  const mod = { exports: {} };
  const req = createRequire(path.join(root, 'dist', 'extension.js'));
  const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', code);
  fn(req, mod, mod.exports, path.join(root, 'dist', 'extension.js'), path.join(root, 'dist'));

  const km = new mod.exports.KeyringManager(root);
  assert.equal(typeof km.read, 'function');
  assert.equal(typeof km.readAsync, 'function');
  assert.equal(typeof km.write, 'function');
  assert.equal(typeof km.writeAsync, 'function');
  assert.equal(typeof km.delete, 'function');
  assert.equal(typeof km.deleteAsync, 'function');
  km.dispose();
});

test('Windows native N-API wincred addon roundtrips UTF-8 JSON on dummy target', { skip: os.platform() !== 'win32' || os.arch() !== 'x64' }, () => {
  const addonPath = path.join(root, 'native', 'wincred-win32-x64.node');
  assert.equal(fs.existsSync(addonPath), true, `Missing native addon at ${addonPath}`);

  const req = createRequire(addonPath);
  const addon = req(addonPath);
  const target = `charlier:unit_test_${process.pid}_${Date.now()}`;
  const payload = JSON.stringify({
    token: { access_token: 'tok-test-123', refresh_token: 'ref-utf8-café', token_type: 'Bearer' },
    auth_method: 'consumer'
  });

  try {
    assert.equal(addon.readCredential(target), null);
    assert.equal(addon.writeCredential(target, 'antigravity', payload), true);
    assert.equal(addon.readCredential(target), payload);
    assert.equal(addon.deleteCredential(target), true);
    assert.equal(addon.readCredential(target), null);
  } finally {
    try {
      addon.deleteCredential(target);
    } catch {}
  }
});

test('Linux D-Bus session check and delete guard behave cleanly without secret-tool', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'keyring.ts'), 'utf8');
  assert.match(src, /if \(platform === 'linux'\)[\s\S]*if \(!hasLinuxDbusSession\(\)\) return false;[\s\S]*let cleared = false/);
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, 'src', 'keyring.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode']
  });
  const mod = { exports: {} };
  const req = createRequire(path.join(root, 'dist', 'extension.js'));
  new Function('require', 'module', 'exports', '__filename', '__dirname', result.outputFiles[0].text)(
    req,
    mod,
    mod.exports,
    path.join(root, 'dist', 'extension.js'),
    path.join(root, 'dist')
  );
  assert.equal(mod.exports.hasLinuxDbusSession({}), false);
  assert.equal(mod.exports.hasLinuxDbusSession({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }), true);
});
