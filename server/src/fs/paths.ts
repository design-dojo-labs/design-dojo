import { lstatSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const MAX_PATH_LENGTH = 512;
export const MAX_SEGMENT_LENGTH = 120;
export const MAX_DEPTH = 24;

/**
 * Validates and normalizes a workspace-relative path supplied by a client, an archive or an AI provider.
 * Only plain relative POSIX paths are accepted: no absolute paths, drive letters, backslashes,
 * '.'/'..' segments, empty segments, control characters or NUL bytes.
 */
export function normalizeRelPath(input: unknown): string {
  if (typeof input !== 'string') throw new HttpError(400, 'path must be a string');
  let p = input.trim();
  if (!p) throw new HttpError(400, 'path is empty');
  if (p.length > MAX_PATH_LENGTH) throw new HttpError(400, `path is longer than ${MAX_PATH_LENGTH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) throw new HttpError(400, 'path contains control characters');
  if (p.includes('\\')) throw new HttpError(400, 'backslashes are not allowed in paths');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) throw new HttpError(400, 'absolute paths are not allowed');
  while (p.startsWith('./')) p = p.slice(2);
  if (p.endsWith('/')) p = p.slice(0, -1);
  const segs = p.split('/');
  if (segs.length > MAX_DEPTH) throw new HttpError(400, 'path is nested too deeply');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') throw new HttpError(400, `invalid path segment "${s}"`);
    if (s.length > MAX_SEGMENT_LENGTH) throw new HttpError(400, 'path segment is too long');
    if (/[<>:"|?*]/.test(s)) throw new HttpError(400, `path segment "${s}" contains reserved characters`);
  }
  return segs.join('/');
}

/**
 * Resolves a validated relative path under root, refusing to traverse symlinks at any level.
 * The root itself is canonicalized with realpath so a symlinked data root still works.
 */
export function resolveInside(root: string, rel: string, opts: { mustExist?: boolean } = {}): string {
  const rootReal = realpathSync(root);
  const norm = normalizeRelPath(rel);
  let cur = rootReal;
  const segs = norm.split('/');
  for (let i = 0; i < segs.length; i++) {
    cur = join(cur, segs[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        if (opts.mustExist) throw new HttpError(404, `not found: ${norm}`);
        break; // remaining segments will be created as real directories/files
      }
      throw e;
    }
    if (st.isSymbolicLink()) throw new HttpError(400, `symbolic links are not allowed inside the workspace (${segs.slice(0, i + 1).join('/')})`);
    if (i < segs.length - 1 && !st.isDirectory()) throw new HttpError(400, `${segs.slice(0, i + 1).join('/')} is not a directory`);
  }
  const abs = join(rootReal, ...segs);
  if (abs !== rootReal && !abs.startsWith(rootReal + sep)) throw new HttpError(400, 'path escapes the workspace');
  return abs;
}
