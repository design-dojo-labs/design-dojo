import type { FileContent, TreeEntry } from '@lld/shared';
import { ApiError, errorMessage, get, put } from '../lib/api';
import { languageFor, monaco } from './monaco';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface FileBuffer {
  path: string;
  model: monaco.editor.ITextModel;
  savedHash: string | null;
  savedContent: string;
  state: SaveState;
  locked: boolean;
  error: string | null;
  /** Disk state when a save was rejected or an external edit collided with unsaved changes. */
  conflict: { diskContent: string | null; diskHash: string | null } | null;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<void> | null;
  resave: boolean;
  suppressChange: boolean;
}

export function wsUri(sessionId: string, path: string) {
  return monaco.Uri.from({ scheme: 'file', path: `/ws/${sessionId}/${path}` });
}

/**
 * Open workspace files backed by Monaco models, with debounced autosave, per-file serialized saves,
 * hash-based stale-write protection (the server rejects a save whose base hash is no longer on disk)
 * and explicit conflict states for external edits.
 */
export class WorkspaceFiles {
  private buffers = new Map<string, FileBuffer>();
  private listeners = new Set<() => void>();
  private version = 0;
  private readonlyModels = new Map<string, monaco.editor.ITextModel>();
  /** Serializes external-change checks (tree polls and change events can overlap). */
  private checking: Promise<void> = Promise.resolve();
  onExternalReload: (path: string) => void = () => {};
  /** Called after this tab saved a file, e.g. to tell other tabs of the same browser. */
  onSaved: (path: string, hash: string) => void = () => {};

  constructor(
    private sessionId: string,
    private delay: () => number,
  ) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  get(path: string): FileBuffer | undefined {
    return this.buffers.get(path);
  }
  all(): FileBuffer[] {
    return [...this.buffers.values()];
  }

  /** Open files waiting for a conflict decision. */
  conflictPaths(): string[] {
    return this.all()
      .filter((b) => b.state === 'conflict')
      .map((b) => b.path);
  }

  aggregate(): SaveState {
    const states = this.all().map((b) => b.state);
    if (states.includes('conflict')) return 'conflict';
    if (states.includes('error')) return 'error';
    if (states.includes('saving')) return 'saving';
    if (states.includes('dirty')) return 'dirty';
    return 'saved';
  }

  async open(path: string): Promise<FileBuffer> {
    const existing = this.buffers.get(path);
    if (existing) return existing;
    const f = await get<FileContent>(`/api/sessions/${this.sessionId}/file?path=${encodeURIComponent(path)}`);
    const again = this.buffers.get(path);
    if (again) return again;
    const uri = wsUri(this.sessionId, path);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(f.content, languageFor(path), uri);
    if (model.getValue() !== f.content) model.setValue(f.content);
    const b: FileBuffer = {
      path,
      model,
      savedHash: f.hash,
      savedContent: f.content,
      state: 'saved',
      locked: f.locked,
      error: null,
      conflict: null,
      timer: null,
      inflight: null,
      resave: false,
      suppressChange: false,
    };
    model.onDidChangeContent(() => {
      if (b.suppressChange || b.locked) return;
      if (b.state !== 'conflict') b.state = model.getValue() === b.savedContent ? 'saved' : 'dirty';
      this.schedule(b);
      this.emit();
    });
    this.buffers.set(path, b);
    this.emit();
    return b;
  }

  private schedule(b: FileBuffer) {
    if (b.timer) clearTimeout(b.timer);
    if (b.state !== 'dirty') return;
    b.timer = setTimeout(() => {
      b.timer = null;
      void this.save(b.path);
    }, this.delay());
  }

  async save(path: string, force = false): Promise<void> {
    const b = this.buffers.get(path);
    if (!b || b.locked) return;
    if (b.timer) {
      clearTimeout(b.timer);
      b.timer = null;
    }
    if (b.inflight) {
      b.resave = true;
      return b.inflight;
    }
    if (b.state === 'conflict' && !force) return;
    const content = b.model.getValue();
    if (!force && content === b.savedContent) {
      if (b.state !== 'saved') {
        b.state = 'saved';
        this.emit();
      }
      return;
    }
    b.state = 'saving';
    this.emit();
    b.inflight = (async () => {
      try {
        const res = await put<{ hash: string }>(`/api/sessions/${this.sessionId}/file`, { path, content, baseHash: b.savedHash, force });
        b.savedHash = res.hash;
        b.savedContent = content;
        b.conflict = null;
        b.error = null;
        b.state = b.model.getValue() === content ? 'saved' : 'dirty';
        this.onSaved(path, res.hash);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const diskContent = (e.body.currentContent as string | null) ?? null;
          const diskHash = (e.body.currentHash as string | null) ?? null;
          if (diskContent !== null && diskHash && diskContent === content) {
            // Someone else already saved exactly this text (e.g. the same edit in another tab): nothing to decide.
            b.savedHash = diskHash;
            b.savedContent = content;
            b.conflict = null;
            b.error = null;
            b.state = b.model.getValue() === content ? 'saved' : 'dirty';
          } else {
            b.state = 'conflict';
            b.conflict = { diskContent, diskHash };
          }
        } else {
          b.state = 'error';
          b.error = errorMessage(e);
        }
      } finally {
        b.inflight = null;
        this.emit();
      }
      if (b.resave) {
        b.resave = false;
        if (b.state === 'dirty') await this.save(path);
      } else if (b.state === 'dirty') this.schedule(b);
    })();
    return b.inflight;
  }

  /** Saves everything pending. Resolves with the files that could not be saved (conflicts/errors). */
  async flushAll(): Promise<string[]> {
    for (let round = 0; round < 3; round++) {
      const pending = this.all().filter((b) => !b.locked && (b.state === 'dirty' || b.state === 'saving' || b.inflight || b.state === 'error'));
      if (!pending.length) break;
      await Promise.all(pending.map((b) => (b.inflight ? b.inflight.then(() => this.save(b.path)) : this.save(b.path))));
    }
    return this.all()
      .filter((b) => b.state === 'conflict' || b.state === 'error' || b.state === 'dirty')
      .map((b) => b.path);
  }

  /** Replaces the editor content with the disk version (used for conflict resolution and external reloads). */
  async loadFromDisk(path: string): Promise<void> {
    const b = this.buffers.get(path);
    if (!b) return;
    this.applyDisk(b, await this.fetchFile(path));
  }

  private fetchFile(path: string): Promise<FileContent> {
    return get<FileContent>(`/api/sessions/${this.sessionId}/file?path=${encodeURIComponent(path)}`);
  }

  private applyDisk(b: FileBuffer, f: FileContent): void {
    if (b.timer) {
      clearTimeout(b.timer);
      b.timer = null;
    }
    b.suppressChange = true;
    try {
      if (b.model.getValue() !== f.content) {
        b.model.pushEditOperations([], [{ range: b.model.getFullModelRange(), text: f.content }], () => null);
      }
    } finally {
      b.suppressChange = false;
    }
    b.savedHash = f.hash;
    b.savedContent = f.content;
    b.state = 'saved';
    b.conflict = null;
    b.error = null;
    this.emit();
  }

  async keepMine(path: string): Promise<void> {
    const b = this.buffers.get(path);
    if (!b) return;
    b.state = 'dirty';
    b.conflict = null;
    await this.save(path, true);
  }

  /**
   * Compares open buffers with a tree listing to detect edits made elsewhere (another tab, another
   * editor, an import). Clean buffers reload silently; buffers with unsaved edits enter the conflict
   * state so the user decides. Runs are serialized so overlapping polls and change events can't race.
   */
  checkExternal(entries: TreeEntry[]): Promise<void> {
    const run = this.checking.then(() => this.runExternalCheck(entries));
    this.checking = run.catch(() => {});
    return run;
  }

  private async runExternalCheck(entries: TreeEntry[]): Promise<void> {
    const disk = new Map(entries.filter((e) => e.type === 'file').map((e) => [e.path, e.hash]));
    for (const b of this.all()) {
      if (b.inflight || b.state === 'saving' || this.buffers.get(b.path) !== b) continue;
      const h = disk.has(b.path) ? disk.get(b.path)! : undefined;
      if (h === b.savedHash) continue;
      if (h === undefined) {
        if (b.state !== 'conflict') {
          b.state = 'conflict';
          b.conflict = { diskContent: null, diskHash: null };
          this.emit();
        }
        continue;
      }
      if (b.state === 'conflict') continue;
      const f = await this.fetchFile(b.path).catch(() => null);
      // The buffer may have been closed, saved or edited while the file was being fetched.
      if (!f || this.buffers.get(b.path) !== b || b.inflight || f.hash === b.savedHash) continue;
      const current = b.model.getValue();
      if (f.content === current) {
        // Disk already holds exactly what the editor shows: adopt the new hash, nothing to decide.
        b.savedHash = f.hash;
        b.savedContent = f.content;
        b.state = 'saved';
        b.conflict = null;
        this.emit();
      } else if (b.state === 'saved' && current === b.savedContent) {
        this.applyDisk(b, f);
        this.onExternalReload(b.path);
      } else {
        b.state = 'conflict';
        b.conflict = { diskContent: f.content, diskHash: f.hash };
        this.emit();
      }
    }
  }

  close(path: string): void {
    const b = this.buffers.get(path);
    if (!b) return;
    if (b.timer) clearTimeout(b.timer);
    b.model.dispose();
    this.buffers.delete(path);
    this.emit();
  }

  /** Paths of open buffers under (or equal to) a path — used before rename/delete. */
  under(path: string): FileBuffer[] {
    return this.all().filter((b) => b.path === path || b.path.startsWith(path + '/'));
  }

  readonlyModel(key: string, path: string, load: () => Promise<string>): Promise<monaco.editor.ITextModel> {
    const existing = this.readonlyModels.get(key);
    if (existing && !existing.isDisposed()) return Promise.resolve(existing);
    return load().then((content) => {
      const uri = monaco.Uri.from({ scheme: 'readonly', path: `/${key}` });
      const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, languageFor(path), uri);
      this.readonlyModels.set(key, model);
      return model;
    });
  }

  dispose(): void {
    for (const b of this.all()) {
      if (b.timer) clearTimeout(b.timer);
      b.model.dispose();
    }
    for (const m of this.readonlyModels.values()) m.dispose();
    this.buffers.clear();
    this.readonlyModels.clear();
    this.listeners.clear();
  }
}
