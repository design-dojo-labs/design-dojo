// First-time setup: checks prerequisites, builds the UI, validates the problem bank and prepares
// the Java toolchain (Maven Wrapper download + JUnit) so later builds work offline.
// Usage: npm run setup [-- --skip-java]
import { join } from 'node:path';
import { BIN, ROOT, checkNode, run } from './lib.mjs';

checkNode();
console.log('1/3  Validating the bundled problem bank…');
await run(join(BIN, 'tsx'), [join(ROOT, 'scripts', 'validate-problems.ts')], { stdio: ['ignore', 'ignore', 'inherit'] });
console.log('     ok');
console.log('2/3  Building the web UI…');
await run(join(BIN, 'vite'), ['build', '--logLevel', 'warn'], { cwd: join(ROOT, 'web') });
console.log('     ok');
if (process.argv.includes('--skip-java')) {
  console.log('3/3  Skipped Java toolchain preparation (--skip-java). You can run it later from Settings.');
} else {
  console.log('3/3  Preparing the Java toolchain (first run downloads ~25 MB)…');
  await run(join(BIN, 'tsx'), [join(ROOT, 'scripts', 'prepare-java.ts')]);
}
console.log('\nDone. Start the studio with: npm start   (then open http://127.0.0.1:4317)');
console.log('Run `npm run doctor` any time to check Java and the AI CLIs.');
