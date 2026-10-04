// Prepares Maven + JUnit in the studio's isolated Maven cache using the same code path as the UI.
import { buildApp } from '../server/src/app.js';
import { startToolchainBootstrap } from '../server/src/java/bootstrap.js';

const { ctx, close } = await buildApp({ config: { port: 0 }, recover: false });
const java = await ctx.javaStatus(true);
if (!java.ok) {
  console.error(`     Java is not ready: ${java.detail}`);
  await close();
  process.exit(1);
}
console.log(`     Using JDK ${java.javaVersion} at ${java.javaHome}`);
const job = startToolchainBootstrap({ jobs: ctx.jobs, settings: ctx.settings, dataRoot: ctx.config.dataRoot, templateDir: ctx.config.resources.javaTemplate, javaStatus: ctx.javaStatus });
let printed = 0;
const final = await new Promise<import('@lld/shared').Job>((resolve) => {
  const unsub = ctx.bus.subscribe((ev) => {
    if (ev.type !== 'job' || ev.job.id !== job.id) return;
    for (const p of ev.job.progress.slice(printed)) console.log(`     ${p.message}`);
    printed = ev.job.progress.length;
    if (!['queued', 'running'].includes(ev.job.state)) {
      unsub();
      resolve(ev.job);
    }
  });
});
await close();
if (final.state !== 'completed') {
  console.error(`     Toolchain preparation ${final.state}: ${final.error?.message ?? ''}`);
  for (const d of final.error?.details ?? []) console.error(`       ${d}`);
  process.exit(1);
}
console.log('     ok — Maven and JUnit are cached; builds now work offline.');
