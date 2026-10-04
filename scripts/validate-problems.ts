// Validates every bundled seed problem against the shared schema and semantic checks.
// Usage: npx tsx scripts/validate-problems.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SeedProblem, checkProblemSemantics, titleSimilarity } from '../shared/src/problem.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'problems', 'seed');
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
let failed = 0;
const titles: { id: string; title: string }[] = [];
for (const f of files) {
  const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const parsed = SeedProblem.safeParse(raw);
  if (!parsed.success) {
    failed++;
    console.error(`✗ ${f}`);
    for (const i of parsed.error.issues) console.error(`   ${i.path.join('.')}: ${i.message}`);
    continue;
  }
  if (`${parsed.data.id}.json` !== f) {
    failed++;
    console.error(`✗ ${f}: id "${parsed.data.id}" must match the file name`);
    continue;
  }
  const issues = checkProblemSemantics(parsed.data);
  if (issues.length) {
    failed++;
    console.error(`✗ ${f}`);
    for (const i of issues) console.error(`   ${i}`);
    continue;
  }
  for (const t of titles) {
    if (titleSimilarity(t.title, parsed.data.title) >= 0.6) console.warn(`! ${f}: title is very similar to ${t.id}`);
  }
  titles.push({ id: parsed.data.id, title: parsed.data.title });
  console.log(`✓ ${f}  (${parsed.data.difficulty}, ${parsed.data.requirements.length} reqs)`);
}
console.log(`\n${files.length - failed}/${files.length} valid`);
if (failed || files.length < 15) {
  if (files.length < 15) console.error(`expected at least 15 seed problems, found ${files.length}`);
  process.exit(1);
}
