import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = join(ROOT, 'node_modules', '.bin');

export function checkNode() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 12)) {
    console.error(`Node.js 22.12 or newer is required (found ${process.versions.node}). With nvm: nvm install 22 && nvm use 22`);
    process.exit(1);
  }
  if (!existsSync(join(ROOT, 'node_modules'))) {
    console.error('Dependencies are not installed. Run: npm install');
    process.exit(1);
  }
}

function newest(dir) {
  let t = 0;
  if (!existsSync(dir)) return 0;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const s = statSync(p);
    t = Math.max(t, s.isDirectory() ? newest(p) : s.mtimeMs);
  }
  return t;
}

/** True when web/dist is missing or older than the frontend/shared sources. */
export function webBuildStale() {
  const index = join(ROOT, 'web', 'dist', 'index.html');
  if (!existsSync(index)) return true;
  const built = statSync(index).mtimeMs;
  return Math.max(newest(join(ROOT, 'web', 'src')), newest(join(ROOT, 'shared', 'src')), statSync(join(ROOT, 'web', 'index.html')).mtimeMs) > built;
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))));
  });
}
