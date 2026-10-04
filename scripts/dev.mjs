// Development mode: API server with auto-restart + Vite dev server with hot reload.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { BIN, ROOT, checkNode } from './lib.mjs';

checkNode();
const env = { ...process.env, LLD_STUDIO_DEV_ORIGIN: 'http://127.0.0.1:5173' };
const procs = [
  spawn(join(BIN, 'tsx'), ['watch', '--clear-screen=false', join(ROOT, 'server', 'src', 'main.ts')], { cwd: ROOT, stdio: 'inherit', env }),
  spawn(join(BIN, 'vite'), [], { cwd: join(ROOT, 'web'), stdio: 'inherit', env }),
];
console.log('\nDev UI: http://127.0.0.1:5173  (API on 127.0.0.1:4317)\n');
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', () => (stop(), process.exit(0))));
