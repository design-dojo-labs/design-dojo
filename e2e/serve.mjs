// Starts the studio for end-to-end tests with a fresh data folder and the clearly-labelled mock reviewer.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = join(root, '.lld-test-data', 'e2e');
// Submission snapshots are read-only by design; make them writable before removing the old run.
const unlock = (p) => {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return;
  chmodSync(p, st.isDirectory() ? 0o755 : 0o644);
  if (st.isDirectory()) for (const n of readdirSync(p)) unlock(join(p, n));
};
if (existsSync(data)) unlock(data);
rmSync(data, { recursive: true, force: true });
mkdirSync(join(root, '.lld-test-data', 'maven'), { recursive: true });
process.env.LLD_STUDIO_HOME = data;
process.env.LLD_STUDIO_ENABLE_MOCK = '1';
process.env.LLD_MOCK_DELAY_MS = '300';
process.env.LLD_STUDIO_MAVEN_HOME = join(root, '.lld-test-data', 'maven');
await import('../scripts/start.mjs');
