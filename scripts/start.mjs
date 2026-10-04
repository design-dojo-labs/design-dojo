// One command to run the studio: builds the UI if needed, then starts the local server.
// Usage: npm start [-- --open]
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { BIN, ROOT, checkNode, run, webBuildStale } from './lib.mjs';

checkNode();
if (webBuildStale()) {
  console.log('Building the web UI…');
  await run(join(BIN, 'vite'), ['build', '--logLevel', 'warn'], { cwd: join(ROOT, 'web') });
}
const port = process.env.LLD_STUDIO_PORT ?? '4317';
const server = spawn(join(BIN, 'tsx'), [join(ROOT, 'server', 'src', 'main.ts')], { cwd: ROOT, stdio: 'inherit', env: process.env });
if (process.argv.includes('--open')) {
  setTimeout(() => spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [`http://127.0.0.1:${port}`], { stdio: 'ignore', detached: true }).unref(), 1500);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));
server.on('exit', (code) => process.exit(code ?? 0));
