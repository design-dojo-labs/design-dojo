import { readFileSync } from 'node:fs';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { DESIGN_PRINCIPLE_LABELS, SOLID_LABELS, type Session, type StoredReview, type Submission, type VerifiedRef } from '@lld/shared';
import { HttpError, normalizeRelPath } from './fs/paths.js';
import { ignoredReason, isManaged, LIMITS, type Workspace } from './fs/workspace.js';

/** Zips text sources (no build output, IDE metadata or binaries) from a list of files. */
export function zipFiles(files: { rel: string; content: Buffer | string }[], rootName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const f of files) {
      const mode = f.rel === 'mvnw' ? 0o100755 : 0o100644;
      zip.addBuffer(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content), `${rootName}/${f.rel}`, { mode });
    }
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

export function workspaceZip(ws: Workspace, rootName: string): Promise<Buffer> {
  const { files } = ws.collectSources();
  return zipFiles(files.map((f) => ({ rel: f.rel, content: readFileSync(f.abs) })), rootName);
}

/**
 * Imports source files from a ZIP into a workspace. Every entry name is validated as a plain relative
 * path; absolute paths, '..', symlinks, build output and managed build files are skipped and reported.
 * Existing files that would change are moved to the trash first so the import is recoverable.
 */
export async function importZip(buf: Buffer, ws: Workspace): Promise<{ imported: string[]; replaced: string[]; skipped: { path: string; reason: string }[] }> {
  const entries = await readZip(buf);
  // Strip a single common top-level folder (as produced by our own export).
  const tops = new Set(entries.map((e) => e.name.split('/')[0]));
  const strip = tops.size === 1 && entries.every((e) => e.name.includes('/'));
  const imported: string[] = [];
  const replaced: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let total = 0;
  for (const e of entries) {
    const name = strip ? e.name.split('/').slice(1).join('/') : e.name;
    if (!name || e.isDir) continue;
    let rel: string;
    try {
      rel = normalizeRelPath(name);
    } catch (err) {
      skipped.push({ path: e.name, reason: (err as Error).message });
      continue;
    }
    if (e.isSymlink) {
      skipped.push({ path: rel, reason: 'symbolic link' });
      continue;
    }
    const reason = ignoredReason(rel);
    if (reason) {
      skipped.push({ path: rel, reason });
      continue;
    }
    if (isManaged(rel)) {
      skipped.push({ path: rel, reason: 'managed build template file (kept from the studio template)' });
      continue;
    }
    if (e.data.length > LIMITS.maxFileBytes) {
      skipped.push({ path: rel, reason: 'file too large' });
      continue;
    }
    if (e.data.includes(0)) {
      skipped.push({ path: rel, reason: 'binary file' });
      continue;
    }
    total += e.data.length;
    if (total > LIMITS.maxTotalBytes) throw new HttpError(413, 'Archive exceeds the workspace size limit; nothing further was imported.');
    const content = e.data.toString('utf8');
    let current: string | null = null;
    try {
      current = ws.read(rel).content;
    } catch {
      current = null;
    }
    if (current === content) continue;
    if (current !== null) {
      await ws.remove(rel);
      replaced.push(rel);
    }
    await ws.write(rel, content, null);
    imported.push(rel);
  }
  return { imported, replaced, skipped };
}

interface ZipEntry {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  data: Buffer;
}

function readZip(buf: Buffer): Promise<ZipEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(new HttpError(400, `Not a valid ZIP archive: ${err?.message ?? 'unknown error'}`));
      const out: ZipEntry[] = [];
      let count = 0;
      // yauzl refuses entries with absolute or ".." paths; such an archive is rejected as a whole.
      zip.on('error', (e) =>
        reject(new HttpError(400, /invalid relative path|absolute path/i.test(e.message) ? `The archive contains an unsafe entry path (${e.message.replace(/^.*?: /, '')}). Nothing was imported.` : `ZIP error: ${e.message}`)),
      );
      zip.on('end', () => resolve(out));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (++count > LIMITS.maxFiles * 2) {
          zip.close();
          return reject(new HttpError(413, 'Archive has too many entries.'));
        }
        const isDir = entry.fileName.endsWith('/');
        const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
        const isSymlink = unixMode === 0o120000;
        if (isDir || isSymlink || entry.uncompressedSize > LIMITS.maxFileBytes) {
          out.push({ name: entry.fileName, isDir, isSymlink, data: Buffer.alloc(isDir || isSymlink ? 0 : LIMITS.maxFileBytes + 1) });
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) return reject(new HttpError(400, `Cannot read ${entry.fileName}`));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.push({ name: entry.fileName, isDir, isSymlink, data: Buffer.concat(chunks) });
            zip.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zip.readEntry();
    });
  });
}

/** Markdown export of a review. Content is the learner's own data; nothing is executed. */
export function reviewMarkdown(session: Session, sub: Submission, review: StoredReview): string {
  const L: string[] = [];
  L.push(`# ${session.problem.content.title} — submission #${sub.seq}`);
  L.push('');
  L.push(`> AI practice assessment (not an official interview verdict). Reviewer: ${review.provider}${review.model ? ` / ${review.model}` : ''}${review.isMock ? ' — **MOCK, not a real review**' : ''}.`);
  L.push(`> Problem ${review.problemId} v${review.problemVersion} · ${review.rubricVersion} · ${review.schemaVersion} · prompt ${review.promptVersion} · snapshot ${sub.contentHash.slice(0, 12)} · ${review.createdAt}`);
  L.push('');
  L.push(`**Score: ${review.totalScore}/100** · confidence ${review.confidence} · compile ${sub.compile}${sub.tests ? ` · tests ${sub.tests.passed}/${sub.tests.total} passed` : ' · no tests ran'} · hints used ${sub.hintsUsedAtSubmit}${sub.solutionRevealedAtSubmit ? ' · reference solution had been revealed' : ''}`);
  L.push('', review.summary, '');
  for (const n of review.systemNotes) L.push(`- _${n}_`);
  L.push('', '## Category scores', '', '| Category | Score | Notes |', '|---|---:|---|');
  for (const c of review.categories) L.push(`| ${c.label} | ${c.score}/${c.max} | ${c.rationale.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  L.push('', '## Requirement coverage', '');
  for (const r of review.requirementCoverage) L.push(`- **${r.requirementId}** ${r.status} (${r.basis}) — ${r.evidence}`);
  L.push('', '## Findings', '');
  for (const f of review.findings) {
    const loc = f.filePath ? ` — \`${f.filePath}${f.lineStart ? `:${f.lineStart}${f.lineEnd && f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ''}` : ''}\`${f.reference === 'unverified' ? ' (unverified reference)' : ''}` : '';
    L.push(`### [${f.severity}] ${f.title}${loc}`, '', `Category: ${f.category}${f.requirementId ? ` · ${f.requirementId}` : ''}`, '', f.explanation, '');
    if (f.evidence) L.push('```', f.evidence, '```', '');
    L.push(`**Suggestion:** ${f.suggestion}`, '');
  }
  const da = review.designAssessment;
  if (!da && review.detail && review.detail.status !== 'completed') {
    L.push('## Design assessment', '', review.detail.status === 'pending' ? '_Still being written when this export was made._' : `_Did not complete: ${review.detail.error?.message ?? 'unknown error'}_`, '');
  }
  if (da) {
    const refs = (ev: VerifiedRef[]) =>
      ev.length ? ` (${ev.map((e) => `\`${e.filePath}${e.lineStart ? `:${e.lineStart}` : ''}\`${e.reference === 'unverified' ? ' unverified' : ''}`).join(', ')})` : '';
    L.push('## Design assessment', '', da.overall, '', '### SOLID', '', '| Principle | Verdict | Notes |', '|---|---|---|');
    for (const x of da.solid) L.push(`| ${SOLID_LABELS[x.principle]} | ${x.verdict} | ${x.explanation.replace(/\|/g, '\\|').replace(/\n/g, ' ')}${refs(x.evidence)} |`);
    L.push('', '### Design principles', '', '| Principle | Verdict | Notes |', '|---|---|---|');
    for (const x of da.principles) L.push(`| ${DESIGN_PRINCIPLE_LABELS[x.principle]} | ${x.verdict} | ${x.explanation.replace(/\|/g, '\\|').replace(/\n/g, ' ')}${refs(x.evidence)} |`);
    L.push('', `### Atomic operations: ${da.atomicity.verdict}`, '', da.atomicity.summary, '');
    for (const o of da.atomicity.operations) L.push(`- **${o.operation}**: ${o.atomic}. ${o.risk}${refs(o.evidence)}`);
    L.push('', '### Design patterns', '');
    if (!da.patterns.length) L.push('- None identified or needed.');
    for (const p of da.patterns) L.push(`- **${p.pattern}** (${p.status}) in ${p.where}: ${p.explanation}${refs(p.evidence)}`);
    L.push('');
  }
  if (review.strengths.length) L.push('## Strengths', '', ...review.strengths.map((s) => `- ${s}`), '');
  if (review.tradeoffs.length) L.push('## Trade-offs', '', ...review.tradeoffs.map((t) => `- **${t.title}:** ${t.discussion}`), '');
  if (review.suggestedTests.length) L.push('## Suggested tests', '', ...review.suggestedTests.map((t) => `- **${t.title}**${t.requirementId ? ` (${t.requirementId})` : ''}: ${t.description}`), '');
  L.push('## Next steps', '', ...review.nextSteps.map((s, i) => `${i + 1}. ${s}`), '');
  if (review.followUpQuestions.length) L.push('## Follow-up interview questions', '', ...review.followUpQuestions.map((q) => `- ${q}`), '');
  if (review.limitations.length) L.push('## Limitations', '', ...review.limitations.map((s) => `- ${s}`), '');
  return L.join('\n');
}
