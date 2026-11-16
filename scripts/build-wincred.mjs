import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = path.join(root, 'src-native', 'wincred');
const manifestPath = path.join(crateDir, 'Cargo.toml');
const outDir = path.join(root, 'native');
const outFile = path.join(outDir, 'wincred-win32-x64.node');

execFileSync('cargo', ['build', '--release', '--manifest-path', manifestPath], {
  stdio: 'inherit'
});

const builtDll = path.join(crateDir, 'target', 'release', 'charlier_wincred.dll');
if (!fs.existsSync(builtDll)) {
  throw new Error(`Expected built DLL missing at ${builtDll}`);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(builtDll, outFile);
const sizeKb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`[wincred] Built ${outFile} (${sizeKb} KB)`);
