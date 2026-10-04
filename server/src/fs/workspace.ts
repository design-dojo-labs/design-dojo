import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
  cpSync,
  realpathSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import type { ExcludedEntry, FileContent, ManifestEntry, SearchMatch, TreeEntry } from '@lld/shared';
import { HttpError, normalizeRelPath, resolveInside } from './paths.js';

export const LIMITS = {
  maxFileBytes: 512 * 1024,
  maxFiles: 400,
  maxTotalBytes: 8 * 1024 * 1024,
};

/** Build/IDE output that is never shown, snapshotted, exported or sent for review. */
const IGNORED_TOP = new Set(['target', '.git', '.idea', '.vscode', '.settings', 'out', 'node_modules']);
const IGNORED_ANY = new Set(['.DS_Store', '.classpath', '.project']);
const IGNORED_EXT = ['.class', '.jar', '.iml'];
const TMP_PREFIX = '.lldtmp-';

/** Build-template files the studio controls; they are read-only in the UI and verified before builds. */
export const MANAGED_PATHS = ['mvnw', 'mvnw.cmd', '.mvn/wrapper/maven-wrapper.properties'];
export function isManaged(rel: string): boolean {
  return MANAGED_PATHS.includes(rel) || rel === '.mvn' || rel.startsWith('.mvn/');
}

export function ignoredReason(rel: string): string | null {
  const segs = rel.split('/');
  if (IGNORED_TOP.has(segs[0])) return segs[0] === 'target' ? 'build output' : 'IDE/VCS metadata';
  const name = segs[segs.length - 1];
  if (name.startsWith(TMP_PREFIX)) return 'temporary file';
  if (IGNORED_ANY.has(name)) return 'IDE/OS metadata';
  if (IGNORED_EXT.some((e) => name.endsWith(e))) return 'compiled/binary artifact';
  return null;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Writes via a temp file + rename in the same directory so readers never see partial content. */
export function atomicWrite(absPath: string, data: string | Buffer, mode = 0o644): void {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = join(dirname(absPath), `${TMP_PREFIX}${randomBytes(6).toString('hex')}`);
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, absPath);
}

interface WalkEntry {
  rel: string;
  abs: string;
  type: 'file' | 'dir';
  size: number;
  mtimeMs: number;
}

/**
 * A learner workspace rooted at a directory. Every operation validates paths with
 * normalizeRelPath/resolveInside, so nothing outside the root can be read or written.
 */
export class Workspace {
  private locks = new Map<string, Promise<void>>();

  constructor(
    public readonly root: string,
    private trashRoot: string,
  ) {}

  /** Walks the workspace without following symlinks. Symlinks and ignored paths are reported separately. */
  walk(): { entries: WalkEntry[]; skipped: ExcludedEntry[] } {
    const entries: WalkEntry[] = [];
    const skipped: ExcludedEntry[] = [];
    const rootReal = realpathSync(this.root);
    const visit = (dirAbs: string) => {
      let names: string[];
      try {
        names = readdirSync(dirAbs).sort();
      } catch {
        return;
      }
      for (const name of names) {
        const abs = join(dirAbs, name);
        const rel = relative(rootReal, abs).split(sep).join('/');
        const reason = ignoredReason(rel);
        if (reason) {
          if (!name.startsWith(TMP_PREFIX) && rel.split('/').length === 1) skipped.push({ path: rel, reason });
          continue;
        }
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) {
          skipped.push({ path: rel, reason: 'symbolic link (not followed)' });
          continue;
        }
        if (st.isDirectory()) {
          entries.push({ rel, abs, type: 'dir', size: 0, mtimeMs: st.mtimeMs });
          visit(abs);
        } else if (st.isFile()) {
          entries.push({ rel, abs, type: 'file', size: st.size, mtimeMs: st.mtimeMs });
        } else {
          skipped.push({ path: rel, reason: 'special file' });
        }
      }
    };
    visit(rootReal);
    return { entries, skipped };
  }

  tree(): { entries: TreeEntry[]; skipped: ExcludedEntry[] } {
    const { entries, skipped } = this.walk();
    return {
      skipped,
      entries: entries.map((e) => ({
        path: e.rel,
        type: e.type,
        size: e.size,
        mtimeMs: e.mtimeMs,
        hash: e.type === 'file' && e.size <= LIMITS.maxFileBytes ? sha256(readFileSync(e.abs)) : null,
        locked: isManaged(e.rel),
      })),
    };
  }

  read(relInput: string): FileContent {
    const rel = normalizeRelPath(relInput);
    if (ignoredReason(rel)) throw new HttpError(400, `${rel} is excluded from the workspace view`);
    const abs = resolveInside(this.root, rel, { mustExist: true });
    const st = lstatSync(abs);
    if (!st.isFile()) throw new HttpError(400, `${rel} is not a file`);
    if (st.size > LIMITS.maxFileBytes) throw new HttpError(413, `${rel} is larger than ${LIMITS.maxFileBytes / 1024} KB`);
    const buf = readFileSync(abs);
    if (isBinary(buf)) throw new HttpError(415, `${rel} looks like a binary file and cannot be edited here`);
    return { path: rel, content: buf.toString('utf8'), hash: sha256(buf), mtimeMs: st.mtimeMs, locked: isManaged(rel) };
  }

  /** Serializes operations per path so concurrent saves cannot interleave. */
  private async withLock<T>(key: string, fn: () => T): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.locks.set(key, prev.then(() => next));
    await prev;
    try {
      return fn();
    } finally {
      release();
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }

  /**
   * Saves a file only if the disk content still matches baseHash (the version the client edited).
   * A mismatch means either a newer save already landed or the file was edited externally; the
   * client receives 409 with the current disk state and must resolve explicitly.
   */
  async write(relInput: string, content: string, baseHash: string | null, force = false): Promise<{ path: string; hash: string; mtimeMs: number }> {
    const rel = normalizeRelPath(relInput);
    this.assertWritable(rel);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > LIMITS.maxFileBytes) throw new HttpError(413, `file exceeds ${LIMITS.maxFileBytes / 1024} KB limit`);
    return this.withLock('tree', () => {
      const abs = resolveInside(this.root, rel);
      let current: Buffer | null = null;
      if (existsSync(abs)) {
        const st = lstatSync(abs);
        if (!st.isFile()) throw new HttpError(400, `${rel} is not a regular file`);
        current = readFileSync(abs);
      }
      const currentHash = current ? sha256(current) : null;
      if (!force && currentHash !== baseHash) {
        throw new HttpError(409, baseHash === null ? `${rel} already exists` : `${rel} changed on disk since it was opened`, {
          conflict: true,
          path: rel,
          currentHash,
          currentContent: current && !isBinary(current) ? current.toString('utf8') : null,
        });
      }
      if (!current) this.assertCapacity(bytes, 1);
      else this.assertCapacity(bytes - current.length, 0);
      atomicWrite(abs, content);
      const st = lstatSync(abs);
      return { path: rel, hash: sha256(content), mtimeMs: st.mtimeMs };
    });
  }

  async mkdir(relInput: string): Promise<void> {
    const rel = normalizeRelPath(relInput);
    this.assertWritable(rel);
    await this.withLock('tree', () => {
      const abs = resolveInside(this.root, rel);
      if (existsSync(abs)) throw new HttpError(409, `${rel} already exists`);
      mkdirSync(abs, { recursive: true });
    });
  }

  async rename(fromInput: string, toInput: string): Promise<void> {
    const from = normalizeRelPath(fromInput);
    const to = normalizeRelPath(toInput);
    this.assertWritable(from);
    this.assertWritable(to);
    if (to === from) return;
    if (to.startsWith(from + '/')) throw new HttpError(400, 'cannot move a folder into itself');
    await this.withLock('tree', () => {
      const src = resolveInside(this.root, from, { mustExist: true });
      const dst = resolveInside(this.root, to);
      if (existsSync(dst)) throw new HttpError(409, `${to} already exists`);
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(src, dst);
    });
  }

  /** Moves the path to the trash instead of deleting it. Returns the trash location. */
  async remove(relInput: string): Promise<string> {
    const rel = normalizeRelPath(relInput);
    this.assertWritable(rel);
    return this.withLock('tree', () => {
      const abs = resolveInside(this.root, rel, { mustExist: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = join(this.trashRoot, `${stamp}-${randomBytes(3).toString('hex')}`, rel);
      mkdirSync(dirname(dest), { recursive: true });
      try {
        renameSync(abs, dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
        cpSync(abs, dest, { recursive: true });
        rmSync(abs, { recursive: true, force: true });
      }
      return dest;
    });
  }

  search(query: string, opts: { regex?: boolean; caseSensitive?: boolean; maxResults?: number }): { matches: SearchMatch[]; truncated: boolean } {
    if (!query) return { matches: [], truncated: false };
    let re: RegExp;
    try {
      const flags = opts.caseSensitive ? 'g' : 'gi';
      re = opts.regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch (e) {
      throw new HttpError(400, `invalid regular expression: ${(e as Error).message}`);
    }
    const max = opts.maxResults ?? 500;
    const matches: SearchMatch[] = [];
    for (const e of this.walk().entries) {
      if (e.type !== 'file' || e.size > LIMITS.maxFileBytes) continue;
      const buf = readFileSync(e.abs);
      if (isBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (m) {
          matches.push({ path: e.rel, line: i + 1, column: m.index + 1, preview: lines[i].slice(0, 300) });
          if (matches.length >= max) return { matches, truncated: true };
        }
      }
    }
    return { matches, truncated: false };
  }

  /** Text source files eligible for snapshots/exports, plus everything that was left out and why. */
  collectSources(): { files: { rel: string; abs: string; size: number }[]; excluded: ExcludedEntry[] } {
    const { entries, skipped } = this.walk();
    const files: { rel: string; abs: string; size: number }[] = [];
    const excluded: ExcludedEntry[] = [...skipped];
    for (const e of entries) {
      if (e.type !== 'file') continue;
      if (e.size > LIMITS.maxFileBytes) {
        excluded.push({ path: e.rel, reason: `larger than ${LIMITS.maxFileBytes / 1024} KB` });
        continue;
      }
      if (isBinary(readFileSync(e.abs))) {
        excluded.push({ path: e.rel, reason: 'binary file' });
        continue;
      }
      files.push({ rel: e.rel, abs: e.abs, size: e.size });
    }
    return { files, excluded };
  }

  private assertWritable(rel: string): void {
    if (isManaged(rel)) throw new HttpError(403, `${rel} is part of the managed build template and is read-only`);
    const reason = ignoredReason(rel);
    if (reason) throw new HttpError(400, `${rel} is reserved (${reason})`);
  }

  private assertCapacity(addedBytes: number, addedFiles: number): void {
    const { entries } = this.walk();
    const files = entries.filter((e) => e.type === 'file');
    const total = files.reduce((s, e) => s + e.size, 0);
    if (files.length + addedFiles > LIMITS.maxFiles) throw new HttpError(413, `workspace file limit (${LIMITS.maxFiles}) reached`);
    if (total + addedBytes > LIMITS.maxTotalBytes) throw new HttpError(413, `workspace size limit (${LIMITS.maxTotalBytes / 1024 / 1024} MB) reached`);
  }
}

/** Builds the manifest for a set of files (content hash per file + aggregate hash). */
export function buildManifest(files: { rel: string; content: Buffer }[]): { manifest: ManifestEntry[]; contentHash: string } {
  const manifest = files
    .map((f) => ({
      path: f.rel,
      size: f.content.length,
      sha256: sha256(f.content),
      lines: f.content.toString('utf8').split('\n').length,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const contentHash = sha256(manifest.map((m) => `${m.path}\0${m.sha256}`).join('\n'));
  return { manifest, contentHash };
}
