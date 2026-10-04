// Prepare the application payload for a normal, offline-capable Python wheel/sdist build.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

const runtime = join(ROOT, '.python-build', 'runtime');
const output = join(ROOT, 'python', 'design_dojo', 'runtime.tar.gz');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const pyproject = readFileSync(join(ROOT, 'pyproject.toml'), 'utf8');
const pythonVersion = readFileSync(join(ROOT, 'python/design_dojo/__init__.py'), 'utf8');
if (!pyproject.includes(`version = "${manifest.version}"`) || !pythonVersion.includes(`__version__ = "${manifest.version}"`)) throw new Error('Keep npm, Python and pyproject versions in sync before releasing.');
execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}
await build({
  entryPoints: [
    ...sources(join(ROOT, 'server/src')),
    ...sources(join(ROOT, 'shared/src')),
    ...['doctor', 'prepare-java', 'check-runtime'].map((name) => join(ROOT, `scripts/${name}.ts`)),
  ],
  outbase: ROOT,
  outdir: runtime,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  bundle: false,
});
const rootPackage = { name: 'design-dojo-runtime', version: manifest.version, private: true, type: 'module', workspaces: ['shared', 'server'], engines: { node: '>=22.12 <23' } };
writeFileSync(join(runtime, 'package.json'), JSON.stringify(rootPackage, null, 2));
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
lock.name = rootPackage.name;
lock.packages[''] = rootPackage;
delete lock.packages.web;
delete lock.packages['node_modules/@lld/web'];
for (const name of ['shared', 'server']) {
  const pkg = JSON.parse(readFileSync(join(ROOT, name, 'package.json'), 'utf8'));
  delete pkg.devDependencies;
  delete pkg.scripts;
  delete pkg.types;
  if (pkg.main) pkg.main = pkg.main.replace(/\.ts$/, '.js');
  writeFileSync(join(runtime, name, 'package.json'), JSON.stringify(pkg, null, 2));
  lock.packages[name] = pkg;
}
writeFileSync(join(runtime, 'package-lock.json'), JSON.stringify(lock, null, 2));
// Reconcile/prune the existing exact dependency graph without running lifecycle scripts.
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--cache', join(ROOT, '.python-build/npm-cache')], { cwd: runtime, stdio: 'inherit' });

for (const dir of ['web/dist', 'problems', 'prompts', 'java-template']) {
  cpSync(join(ROOT, dir), join(runtime, dir), { recursive: true, filter: (src) => !src.split('/').some((p) => p === 'target' || p === '.DS_Store') });
}
cpSync(join(ROOT, 'python/README.md'), join(runtime, 'README.md'));
// Carry the notices of installed dependencies whose code/fonts may be in the frontend bundle.
let notices = 'Third-party components included in or used by Design Dojo\n\n';
const sourceLock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
for (const [path, pkg] of Object.entries(sourceLock.packages)) {
  if (!path.includes('node_modules/') || pkg.link || !existsSync(join(ROOT, path))) continue;
  const files = readdirSync(join(ROOT, path)).filter((f) => /^(licen[cs]e|copying|notice|ofl|copyright)([.-].*)?$/i.test(f));
  notices += `\n=== ${path} ${pkg.version ?? ''} (${pkg.license ?? 'see notice'}) ===\n`;
  for (const file of files) {
    const full = join(ROOT, path, file);
    if (readdirSync(join(ROOT, path), { withFileTypes: true }).find((e) => e.name === file)?.isFile()) notices += `\n${file}\n${readFileSync(full, 'utf8')}\n`;
  }
}
writeFileSync(join(runtime, 'THIRD_PARTY_NOTICES.txt'), notices);
execFileSync(process.env.PYTHON ?? 'python3', [join(ROOT, 'scripts/archive-python.py'), runtime, output], { stdio: 'inherit' });
console.log(`Prepared ${relative(ROOT, output)}. Build release archives with: python -m build`);
