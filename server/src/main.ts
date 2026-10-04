import { buildApp } from './app.js';
import { LOOPBACK_HOSTS } from './config.js';
import { spawn } from 'node:child_process';

async function main() {
  const { app, ctx, close } = await buildApp({ logger: false });
  const { host, port, dataRoot } = ctx.config;
  if (!LOOPBACK_HOSTS.has(host)) {
    console.warn(`\n⚠  Binding to ${host}. This server runs code and AI CLIs as your user; only expose it on networks you trust.\n`);
  }
  if (ctx.seedErrors.length) console.warn(`Seed problem errors:\n  ${ctx.seedErrors.join('\n  ')}`);
  await app.listen({ host, port });
  console.log(`\nDesign Dojo (LLD + HLD practice) is running at http://127.0.0.1:${port}`);
  console.log(`Data folder: ${dataRoot}\n`);
  if (process.argv.includes('--open')) {
    const opener = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [`http://127.0.0.1:${port}`], { stdio: 'ignore', detached: true });
    opener.on('error', () => console.warn('Could not open a browser. Open the local URL above manually.'));
    opener.unref();
  }

  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    console.log(`\n${sig} received — stopping running builds and AI jobs…`);
    await close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
