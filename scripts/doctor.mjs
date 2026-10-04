import { join } from 'node:path';
import { BIN, ROOT, checkNode, run } from './lib.mjs';
checkNode();
await run(join(BIN, 'tsx'), [join(ROOT, 'scripts', 'doctor.ts')]).catch(() => process.exit(1));
