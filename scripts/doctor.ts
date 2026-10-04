// Diagnostics: local checks only (no AI inference requests are sent).
import { createServer } from 'node:net';
import { buildApp } from '../server/src/app.js';

const ok = (b: boolean) => (b ? '✓' : '✗');
const { ctx, close } = await buildApp({ config: { port: 0 }, recover: false });
console.log(`Node.js           ${process.versions.node}`);
console.log(`Data folder       ${ctx.config.dataRoot}`);
const problems = ctx.problems.list();
console.log(`Problem bank      ${ok(problems.length >= 15)} ${problems.length} problems${ctx.seedErrors.length ? ` (${ctx.seedErrors.length} seed errors)` : ''}`);
for (const e of ctx.seedErrors) console.log(`                    ${e}`);
const hld = ctx.hld.listProblems();
console.log(`HLD bank          ${ok(hld.length >= 10)} ${hld.length} problems`);
const java = await ctx.javaStatus(true);
console.log(`Java              ${ok(java.ok)} ${java.javaHome ? `${java.javaVersion} at ${java.javaHome} (${java.source})` : 'not found'}`);
console.log(`Maven/JUnit cache ${ok(java.maven.distributionCached && java.maven.dependenciesCached)} ${java.maven.userHome}`);
console.log(`                  ${java.detail}`);
const settings = ctx.settings.get();
console.log(`Selected AI       ${settings.provider}`);
for (const p of await ctx.providers.statuses(true)) {
  console.log(`${p.label.padEnd(18)}${ok(p.state === 'authenticated' || p.state === 'mock')} ${p.state}${p.version ? ` (${p.version})` : ''}${p.authMode ? `, ${p.authMode} mode` : ''}`);
  console.log(`                  ${p.detail}`);
}
const port = ctx.config.port || 4317;
const free = await new Promise<boolean>((resolve) => {
  const s = createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
  s.listen(Number(process.env.LLD_STUDIO_PORT ?? 4317), '127.0.0.1');
});
console.log(`Port ${process.env.LLD_STUDIO_PORT ?? 4317}         ${free ? '✓ free' : '• in use (the studio may already be running)'}`);
void port;
await close();
