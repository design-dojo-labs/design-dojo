// Packaged-runtime smoke check. No network, port, user data or provider invocation.
import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SeedProblem, HldSeedProblem } from '@lld/shared';
import { REPO_ROOT } from '../server/src/config.js';
import { buildApp } from '../server/src/app.js';

if (typeof buildApp !== 'function') throw new Error('Server entry point is missing');
const db = new Database(':memory:');
db.prepare('SELECT 1').get();
db.close();
for (const [bank, schema] of [['seed', SeedProblem], ['hld-seed', HldSeedProblem]] as const) {
  const dir = join(REPO_ROOT, 'problems', bank);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (!files.length) throw new Error(`Missing ${bank} problems`);
  for (const name of files) schema.parse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
}
for (const rel of ['web/dist/index.html', 'java-template/.mvn/wrapper/maven-wrapper.properties', 'prompts/generate-problem.v3.md', 'prompts/hld-generate.v3.md']) {
  if (!existsSync(join(REPO_ROOT, rel))) throw new Error(`Missing runtime resource: ${rel}`);
}
console.log('Packaged runtime OK');
