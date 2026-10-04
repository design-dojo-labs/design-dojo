import { cpSync, existsSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EditorState, RunConfig, Session, SessionMode, SessionSummary, TimerState } from '@lld/shared';
import { type DB, json, now } from './db.js';
import type { ProblemRepo } from './problems.js';
import type { SettingsStore } from './settings.js';
import { HttpError } from './fs/paths.js';
import { Workspace } from './fs/workspace.js';

/** A timer only advances while the workspace is open; it auto-pauses when heartbeats stop. */
export const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

interface SessionRow {
  id: string;
  problem_id: string;
  problem_version: number;
  mode: SessionMode;
  status: 'active' | 'archived';
  package_name: string;
  workspace_dir: string;
  timer_json: string;
  editor_state_json: string;
  run_config_json: string;
  last_seen_at: string | null;
  solution_revealed: number;
  created_at: string;
  updated_at: string;
}

export function elapsedMs(t: TimerState, at = Date.now()): number {
  return t.accumulatedMs + (t.runningSince ? Math.max(0, at - Date.parse(t.runningSince)) : 0);
}

export function packageFor(problemId: string, title: string): string {
  const base = (problemId.startsWith('gen-') ? title : problemId).toLowerCase().replace(/[^a-z0-9]/g, '');
  const ident = /^[a-z]/.test(base) ? base : `p${base}`;
  return `com.lldstudio.${ident.slice(0, 40) || 'solution'}`;
}

export class SessionStore {
  constructor(
    private db: DB,
    private problems: ProblemRepo,
    private settings: SettingsStore,
    private dataRoot: string,
    private templateDir: string,
  ) {}

  workspace(sessionId: string): Workspace {
    const row = this.row(sessionId);
    return new Workspace(row.workspace_dir, join(this.dataRoot, 'trash', sessionId));
  }

  create(input: { problemId: string; problemVersion?: number; mode: SessionMode; durationMinutes: number | null }): Session {
    const problem = this.problems.get(input.problemId, input.problemVersion);
    if (input.mode === 'interview' && input.durationMinutes == null) {
      throw new HttpError(400, 'Interview mode needs a time limit.');
    }
    const id = randomUUID();
    const dir = join(this.dataRoot, 'workspaces', id);
    const pkg = packageFor(problem.id, problem.content.title);
    this.scaffold(dir, {
      package: pkg,
      artifactId: problem.id.slice(0, 60),
      title: problem.content.title.replace(/[<>&"]/g, ''),
      release: String(this.settings.get().java.release),
    });
    const ts = now();
    const timer: TimerState = { accumulatedMs: 0, runningSince: ts, durationMinutes: input.durationMinutes };
    const main = `src/main/java/${pkg.replace(/\./g, '/')}/Main.java`;
    const editor: EditorState = { openTabs: [main, 'DESIGN_NOTES.md'], activeTab: main };
    const runConfig: RunConfig = { mainClass: `${pkg}.Main`, args: '', stdin: '' };
    this.db
      .prepare(
        `INSERT INTO sessions (id, problem_id, problem_version, mode, status, package_name, workspace_dir, timer_json, editor_state_json, run_config_json, last_seen_at, created_at, updated_at)
         VALUES (?,?,?,?, 'active', ?,?,?,?,?,?,?,?)`,
      )
      .run(id, problem.id, problem.version, input.mode, pkg, dir, JSON.stringify(timer), JSON.stringify(editor), JSON.stringify(runConfig), ts, ts, ts);
    return this.get(id);
  }

  /** Copies the controlled build template and fills in package/title placeholders. */
  private scaffold(dir: string, vars: Record<string, string>): void {
    if (existsSync(dir)) throw new HttpError(500, 'workspace directory already exists');
    cpSync(this.templateDir, dir, { recursive: true });
    const pkgPath = vars.package.replace(/\./g, '/');
    for (const root of ['src/main/java', 'src/test/java']) {
      const from = join(dir, root, '__PACKAGE_PATH__');
      if (existsSync(from)) {
        cpSync(from, join(dir, root, pkgPath), { recursive: true });
        rmSync(from, { recursive: true, force: true });
      }
    }
    const fill = (p: string) => {
      const st = statSync(p);
      if (st.isDirectory()) {
        for (const n of readdirSync(p)) fill(join(p, n));
        return;
      }
      if (!/\.(java|xml|md)$/.test(p)) return;
      const text = readFileSync(p, 'utf8');
      const out = text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
      if (out !== text) writeFileSync(p, out);
    };
    fill(dir);
  }

  row(id: string): SessionRow {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!r) throw new HttpError(404, 'session not found');
    return r;
  }

  get(id: string): Session {
    const r = this.row(id);
    const summary = this.summarize(r);
    return {
      ...summary,
      problem: this.problems.get(r.problem_id, r.problem_version),
      editorState: json<EditorState>(r.editor_state_json, { openTabs: [], activeTab: null }),
      runConfig: json<RunConfig>(r.run_config_json, { mainClass: null, args: '', stdin: '' }),
      workspaceDir: r.workspace_dir,
      packageName: r.package_name,
    };
  }

  list(includeArchived = false): SessionSummary[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${includeArchived ? '' : "WHERE status = 'active'"} ORDER BY updated_at DESC LIMIT 200`)
      .all() as SessionRow[];
    return rows.map((r) => this.summarize(r));
  }

  private summarize(r: SessionRow): SessionSummary {
    const p = this.problems.get(r.problem_id, r.problem_version);
    const stats = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
          (SELECT r.total_score FROM reviews r JOIN submissions s2 ON s2.id = r.submission_id WHERE s2.session_id = ? ORDER BY r.created_at DESC LIMIT 1) AS latest,
          (SELECT MAX(r.total_score) FROM reviews r JOIN submissions s3 ON s3.id = r.submission_id WHERE s3.session_id = ?) AS best
         FROM submissions WHERE session_id = ?`,
      )
      .get(r.id, r.id, r.id) as { n: number; latest: number | null; best: number | null };
    const hints = (this.db.prepare('SELECT COUNT(*) AS n FROM hints WHERE session_id = ?').get(r.id) as { n: number }).n;
    return {
      id: r.id,
      problemId: r.problem_id,
      problemVersion: r.problem_version,
      problemTitle: p.content.title,
      difficulty: p.content.difficulty,
      mode: r.mode,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      submissionCount: stats.n,
      latestScore: stats.latest,
      bestScore: stats.best,
      timer: json<TimerState>(r.timer_json, { accumulatedMs: 0, runningSince: null, durationMinutes: null }),
      hintsUsed: hints,
      solutionRevealed: !!r.solution_revealed,
    };
  }

  patch(id: string, patch: { editorState?: EditorState; runConfig?: RunConfig }): Session {
    const r = this.row(id);
    this.db
      .prepare('UPDATE sessions SET editor_state_json = ?, run_config_json = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.editorState ? JSON.stringify(patch.editorState) : r.editor_state_json,
        patch.runConfig ? JSON.stringify(patch.runConfig) : r.run_config_json,
        now(),
        id,
      );
    return this.get(id);
  }

  timer(id: string, action: 'pause' | 'resume'): Session {
    const r = this.row(id);
    if (r.mode === 'interview') throw new HttpError(403, 'The timer cannot be paused in interview mode.');
    const t = json<TimerState>(r.timer_json, { accumulatedMs: 0, runningSince: null, durationMinutes: null });
    const ts = now();
    if (action === 'pause' && t.runningSince) {
      t.accumulatedMs = elapsedMs(t);
      t.runningSince = null;
    } else if (action === 'resume' && !t.runningSince) {
      t.runningSince = ts;
      delete t.autoPaused;
    }
    this.db.prepare('UPDATE sessions SET timer_json = ?, last_seen_at = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(t), ts, ts, id);
    return this.get(id);
  }

  /** Records that the workspace is open; resumes a timer that was auto-paused for inactivity. */
  heartbeat(id: string): TimerState {
    const r = this.row(id);
    const t = json<TimerState>(r.timer_json, { accumulatedMs: 0, runningSince: null, durationMinutes: null });
    const ts = now();
    if (!t.runningSince && t.autoPaused) {
      t.runningSince = ts;
      delete t.autoPaused;
    }
    this.db.prepare('UPDATE sessions SET timer_json = ?, last_seen_at = ? WHERE id = ?').run(JSON.stringify(t), ts, id);
    return t;
  }

  /**
   * Pauses running timers whose workspace has not been seen recently (browser closed or server
   * restarted). Time is credited only up to the last heartbeat.
   */
  pauseStaleTimers(staleMs = HEARTBEAT_STALE_MS): number {
    const rows = this.db.prepare(`SELECT * FROM sessions WHERE status = 'active'`).all() as SessionRow[];
    let n = 0;
    for (const r of rows) {
      const t = json<TimerState>(r.timer_json, { accumulatedMs: 0, runningSince: null, durationMinutes: null });
      if (!t.runningSince) continue;
      const last = r.last_seen_at ? Date.parse(r.last_seen_at) : Date.parse(t.runningSince);
      if (Date.now() - last < staleMs) continue;
      t.accumulatedMs = elapsedMs(t, Math.max(last, Date.parse(t.runningSince)));
      t.runningSince = null;
      t.autoPaused = true;
      this.db.prepare('UPDATE sessions SET timer_json = ? WHERE id = ?').run(JSON.stringify(t), r.id);
      n++;
    }
    return n;
  }

  setStatus(id: string, status: 'active' | 'archived'): Session {
    this.row(id);
    this.db.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    return this.get(id);
  }

  markSolutionRevealed(id: string): void {
    this.db.prepare('UPDATE sessions SET solution_revealed = 1, updated_at = ? WHERE id = ?').run(now(), id);
  }

  touch(id: string): void {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now(), id);
  }
}
