import { describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRelPath, resolveInside } from '../src/fs/paths.js';
import { tempDir } from './helpers.js';

describe('normalizeRelPath', () => {
  it.each([
    ['../etc/passwd'],
    ['src/../../x'],
    ['/abs/path'],
    ['C:\\windows'],
    ['a\\b'],
    ['a//b'],
    ['a/./b'],
    ['nul\0byte'],
    [''],
    ['   '],
    ['x'.repeat(600)],
  ])('rejects %j', (p) => {
    expect(() => normalizeRelPath(p)).toThrow();
  });

  it('normalizes harmless forms', () => {
    expect(normalizeRelPath('./src/Main.java')).toBe('src/Main.java');
    expect(normalizeRelPath('src/pkg/')).toBe('src/pkg');
  });
});

describe('resolveInside', () => {
  it('refuses to traverse symlinks that escape the root', () => {
    const t = tempDir();
    const outside = tempDir();
    try {
      writeFileSync(join(outside.dir, 'secret.txt'), 'secret');
      mkdirSync(join(t.dir, 'src'));
      symlinkSync(outside.dir, join(t.dir, 'src', 'link'));
      symlinkSync(join(outside.dir, 'secret.txt'), join(t.dir, 'file-link'));
      expect(() => resolveInside(t.dir, 'src/link/secret.txt')).toThrow(/symbolic links/);
      expect(() => resolveInside(t.dir, 'file-link')).toThrow(/symbolic links/);
      expect(resolveInside(t.dir, 'src/New.java')).toBe(join(realpathSync(t.dir), 'src', 'New.java'));
    } finally {
      t.cleanup();
      outside.cleanup();
    }
  });
});
