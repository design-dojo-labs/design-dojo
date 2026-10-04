// Validates the bundled HLD (system design) problems. Usage: npx tsx scripts/validate-hld-problems.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HldSeedProblem, checkHldProblemSemantics, titleSimilarity } from '../shared/src/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'problems', 'hld-seed');
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
let failed = 0;
const titles: string[] = [];
for (const f of files) {
  const parsed = HldSeedProblem.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  if (!parsed.success) {
    failed++;
    console.error(`✗ ${f}`);
    for (const i of parsed.error.issues) console.error(`   ${i.path.join('.')}: ${i.message}`);
    continue;
  }
  const issues = [...checkHldProblemSemantics(parsed.data), ...(`${parsed.data.id}.json` !== f ? ['id must match file name'] : [])];
  if (issues.length) {
    failed++;
    console.error(`✗ ${f}`);
    for (const i of issues) console.error(`   ${i}`);
    continue;
  }
  for (const t of titles) if (titleSimilarity(t, parsed.data.title) >= 0.6) console.warn(`! ${f}: title similar to "${t}"`);
  titles.push(parsed.data.title);
  console.log(`✓ ${f}  (${parsed.data.difficulty}, ${parsed.data.domain})`);
}
console.log(`\n${files.length - failed}/${files.length} valid`);
if (failed || files.length < 10) {
  if (files.length < 10) console.error(`expected at least 10 HLD problems, found ${files.length}`);
  process.exit(1);
}
