import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Workspace, sha256, buildManifest } from '../src/fs/workspace.js';
import { HttpError } from '../src/fs/paths.js';
import { tempDir } from './helpers.js';

let t: ReturnType<typeof tempDir>;
let trash: ReturnType<typeof tempDir>;
let ws: Workspace;
beforeEach(() => {
  t = tempDir();
  trash = tempDir();
  mkdirSync(join(t.dir, '.mvn', 'wrapper'), { recursive: true });
  writeFileSync(join(t.dir, 'mvnw'), '#!/bin/sh\n');
  writeFileSync(join(t.dir, '.mvn', 'wrapper', 'maven-wrapper.properties'), 'x=1\n');
  ws = new Workspace(t.dir, trash.dir);
});
afterEach(() => {
  t.cleanup();
  trash.cleanup();
});

describe('Workspace writes', () => {
  it('creates nested files and returns the content hash', async () => {
    const res = await ws.write('src/main/java/a/b/A.java', 'class A {}', null);
    expect(res.hash).toBe(sha256('class A {}'));
    expect(readFileSync(join(t.dir, 'src/main/java/a/b/A.java'), 'utf8')).toBe('class A {}');
  });

  it('rejects a stale autosave whose base hash is no longer on disk', async () => {
    const v1 = await ws.write('A.java', 'v1', null);
    const v2 = await ws.write('A.java', 'v2', v1.hash);
    // A delayed request still based on v1 must not overwrite v2.
    await expect(ws.write('A.java', 'stale', v1.hash)).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(t.dir, 'A.java'), 'utf8')).toBe('v2');
    // An explicit force (user chose "keep my version") is allowed.
    await ws.write('A.java', 'mine', v1.hash, true);
    expect(readFileSync(join(t.dir, 'A.java'), 'utf8')).toBe('mine');
    expect(v2.hash).not.toBe(v1.hash);
  });

  it('reports an external edit as a conflict carrying the disk content', async () => {
    const v1 = await ws.write('B.java', 'one', null);
    writeFileSync(join(t.dir, 'B.java'), 'edited elsewhere');
    const err = (await ws.write('B.java', 'two', v1.hash).catch((e) => e)) as HttpError;
    expect(err.status).toBe(409);
    expect(err.body?.currentContent).toBe('edited elsewhere');
  });

  it('serializes concurrent saves so exactly one stale write wins', async () => {
    const v1 = await ws.write('C.java', 'base', null);
    const results = await Promise.allSettled([ws.write('C.java', 'x', v1.hash), ws.write('C.java', 'y', v1.hash)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('protects managed build files and ignored folders', async () => {
    await expect(ws.write('mvnw', 'rm -rf /', sha256('#!/bin/sh\n'))).rejects.toMatchObject({ status: 403 });
    await expect(ws.write('.mvn/wrapper/maven-wrapper.properties', 'x', null)).rejects.toMatchObject({ status: 403 });
    await expect(ws.write('target/classes/X.class', 'x', null)).rejects.toMatchObject({ status: 400 });
  });

  it('refuses paths that escape the workspace', async () => {
    await expect(ws.write('../escape.txt', 'x', null)).rejects.toBeInstanceOf(HttpError);
    await expect(ws.rename('mvnw', '../x')).rejects.toBeInstanceOf(HttpError);
    const outside = tempDir();
    symlinkSync(outside.dir, join(t.dir, 'linked'));
    await expect(ws.write('linked/evil.txt', 'x', null)).rejects.toMatchObject({ status: 400 });
    expect(existsSync(join(outside.dir, 'evil.txt'))).toBe(false);
    outside.cleanup();
  });
});

describe('Workspace file operations', () => {
  it('renames/moves files and folders, and deletes into the trash', async () => {
    await ws.write('src/a/A.java', 'A', null);
    await ws.write('src/a/B.java', 'B', null);
    await ws.rename('src/a', 'src/b');
    expect(existsSync(join(t.dir, 'src/b/A.java'))).toBe(true);
    await expect(ws.rename('src/b', 'src/b/inner')).rejects.toBeInstanceOf(HttpError);
    const trashed = await ws.remove('src/b/A.java');
    expect(existsSync(join(t.dir, 'src/b/A.java'))).toBe(false);
    expect(readFileSync(trashed, 'utf8')).toBe('A');
  });

  it('lists files without following symlinks, hiding build output', async () => {
    await ws.write('src/A.java', 'class A {}', null);
    mkdirSync(join(t.dir, 'target/classes'), { recursive: true });
    writeFileSync(join(t.dir, 'target/classes/A.class'), 'x');
    const outside = tempDir();
    symlinkSync(outside.dir, join(t.dir, 'outside'));
    const tree = ws.tree();
    const paths = tree.entries.map((e) => e.path);
    expect(paths).toContain('src/A.java');
    expect(paths.some((p) => p.startsWith('target'))).toBe(false);
    expect(paths).not.toContain('outside');
    expect(tree.skipped.map((s) => s.path)).toEqual(expect.arrayContaining(['target', 'outside']));
    expect(tree.entries.find((e) => e.path === 'mvnw')?.locked).toBe(true);
    outside.cleanup();
  });

  it('searches with literal and regex queries', async () => {
    await ws.write('src/A.java', 'class A {\n  int count = 0;\n}\n', null);
    expect(ws.search('count', {}).matches).toEqual([expect.objectContaining({ path: 'src/A.java', line: 2 })]);
    expect(ws.search('c.unt', { regex: true }).matches).toHaveLength(1);
    expect(ws.search('c.unt', {}).matches).toHaveLength(0);
    expect(() => ws.search('(', { regex: true })).toThrow(HttpError);
  });

  it('builds a stable manifest hash independent of file order', () => {
    const a = buildManifest([
      { rel: 'b.txt', content: Buffer.from('b') },
      { rel: 'a.txt', content: Buffer.from('a') },
    ]);
    const b = buildManifest([
      { rel: 'a.txt', content: Buffer.from('a') },
      { rel: 'b.txt', content: Buffer.from('b') },
    ]);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.manifest.map((m) => m.path)).toEqual(['a.txt', 'b.txt']);
  });
});
