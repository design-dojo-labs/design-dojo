import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Workspace } from '../src/fs/workspace.js';
import { importZip } from '../src/export.js';
import { tempDir } from './helpers.js';

/** Builds a ZIP with arbitrary (including hostile) entry names using Python's zipfile. */
function hostileZip(dir: string, extraEntry?: string): Buffer {
  const out = join(dir, `evil-${extraEntry ? 'x' : 'plain'}.zip`);
  execFileSync('python3', [
    '-c',
    `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w')
z.writestr('proj/src/main/java/a/Ok.java','class Ok {}')
if len(sys.argv) > 2: z.writestr(sys.argv[2],'nope')
z.writestr('proj/mvnw','rm -rf ~')
z.writestr('proj/target/classes/X.class','bin')
z.writestr('proj/bin.dat', bytes([0,1,2,3]))
info=zipfile.ZipInfo('proj/link'); info.external_attr=(0o120777<<16); z.writestr(info,'/etc/passwd')
z.close()`,
    out,
    ...(extraEntry ? [extraEntry] : []),
  ]);
  return readFileSync(out);
}

describe('ZIP import', () => {
  it('imports plain source files and refuses traversal, absolute paths, symlinks, build output and managed files', async () => {
    const t = tempDir();
    const trash = tempDir();
    mkdirSync(join(t.dir, 'ws'));
    writeFileSync(join(t.dir, 'ws', 'mvnw'), '#!/bin/sh\n');
    const ws = new Workspace(join(t.dir, 'ws'), trash.dir);
    const res = await importZip(hostileZip(t.dir), ws);
    expect(res.imported).toEqual(['src/main/java/a/Ok.java']);
    const skipped = Object.fromEntries(res.skipped.map((s) => [s.path, s.reason]));
    expect(Object.keys(skipped).length).toBe(4);
    expect(existsSync(join(t.dir, 'escape.txt'))).toBe(false);
    expect(readFileSync(join(t.dir, 'ws', 'mvnw'), 'utf8')).toBe('#!/bin/sh\n');
    expect(Object.values(skipped).join(' ')).toMatch(/symbolic link/);
    expect(Object.values(skipped).join(' ')).toMatch(/managed build template/);
    t.cleanup();
    trash.cleanup();
  });

  it.each([['proj/../../escape.txt'], ['/abs/path.txt']])('rejects the whole archive when an entry path is %s', async (bad) => {
    const t = tempDir();
    const trash = tempDir();
    mkdirSync(join(t.dir, 'ws'));
    const ws = new Workspace(join(t.dir, 'ws'), trash.dir);
    await expect(importZip(hostileZip(t.dir, bad), ws)).rejects.toThrow(/unsafe entry path.*Nothing was imported/);
    expect(existsSync(join(t.dir, 'ws', 'src'))).toBe(false);
    expect(existsSync(join(t.dir, 'escape.txt'))).toBe(false);
    t.cleanup();
    trash.cleanup();
  });
});
