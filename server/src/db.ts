import Database from 'better-sqlite3';
import { join } from 'node:path';

export type DB = Database.Database;

/**
 * Ordered, append-only migrations. Never edit a shipped migration; add a new one.
 */
const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE problems (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('seed','generated')),
        latest_version INTEGER NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE problem_versions (
        problem_id TEXT NOT NULL REFERENCES problems(id),
        version INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        rubric_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        generated_by_json TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (problem_id, version)
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        problem_id TEXT NOT NULL,
        problem_version INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('practice','interview')),
        status TEXT NOT NULL CHECK (status IN ('active','archived')),
        package_name TEXT NOT NULL,
        workspace_dir TEXT NOT NULL,
        timer_json TEXT NOT NULL,
        editor_state_json TEXT NOT NULL,
        run_config_json TEXT NOT NULL,
        last_seen_at TEXT,
        solution_revealed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (problem_id, problem_version) REFERENCES problem_versions(problem_id, version)
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','cancelled','interrupted')),
        provider TEXT,
        session_id TEXT,
        submission_id TEXT,
        dedupe_key TEXT,
        params_json TEXT NOT NULL DEFAULT '{}',
        progress_json TEXT NOT NULL DEFAULT '[]',
        error_json TEXT,
        result_json TEXT,
        pid INTEGER,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE UNIQUE INDEX jobs_active_dedupe ON jobs(dedupe_key) WHERE state IN ('queued','running') AND dedupe_key IS NOT NULL;
      CREATE INDEX jobs_session ON jobs(session_id);

      CREATE TABLE exec_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        submission_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('compile','run','test')),
        state TEXT NOT NULL,
        phase TEXT,
        exit_code INTEGER,
        main_class TEXT,
        command TEXT NOT NULL,
        stdout TEXT NOT NULL DEFAULT '',
        stderr TEXT NOT NULL DEFAULT '',
        truncated INTEGER NOT NULL DEFAULT 0,
        diagnostics_json TEXT NOT NULL DEFAULT '[]',
        tests_json TEXT,
        pid INTEGER,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX exec_runs_session ON exec_runs(session_id, started_at);

      CREATE TABLE submissions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        problem_id TEXT NOT NULL,
        problem_version INTEGER NOT NULL,
        rubric_version TEXT NOT NULL,
        rubric_json TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        excluded_json TEXT NOT NULL,
        build_state TEXT NOT NULL,
        compile_run_id TEXT,
        test_run_id TEXT,
        hints_used INTEGER NOT NULL,
        solution_revealed INTEGER NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, seq)
      );

      CREATE TABLE reviews (
        id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL REFERENCES submissions(id),
        job_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        is_mock INTEGER NOT NULL,
        prompt_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        rubric_version TEXT NOT NULL,
        total_score INTEGER NOT NULL,
        review_json TEXT NOT NULL,
        raw_output_json TEXT NOT NULL,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX reviews_submission ON reviews(submission_id, created_at);

      CREATE TABLE findings (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES reviews(id),
        idx INTEGER NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        file_path TEXT,
        line_start INTEGER,
        line_end INTEGER,
        reference TEXT NOT NULL,
        requirement_id TEXT
      );
      CREATE INDEX findings_review ON findings(review_id);

      CREATE TABLE hints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        job_id TEXT NOT NULL,
        requested_level INTEGER NOT NULL,
        requirement_id TEXT,
        question TEXT,
        hint_json TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        is_mock INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE reference_solutions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        job_id TEXT NOT NULL,
        reference_json TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        is_mock INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE provider_checks (
        provider TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'hld-practice',
    sql: `
      CREATE TABLE hld_problems (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('seed','generated')),
        latest_version INTEGER NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE hld_problem_versions (
        problem_id TEXT NOT NULL REFERENCES hld_problems(id),
        version INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        rubric_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        generated_by_json TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (problem_id, version)
      );

      CREATE TABLE hld_sessions (
        id TEXT PRIMARY KEY,
        problem_id TEXT NOT NULL,
        problem_version INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('practice','interview')),
        status TEXT NOT NULL CHECK (status IN ('active','archived')),
        doc_json TEXT NOT NULL,
        doc_hash TEXT NOT NULL,
        timer_json TEXT NOT NULL,
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (problem_id, problem_version) REFERENCES hld_problem_versions(problem_id, version)
      );

      CREATE TABLE hld_submissions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES hld_sessions(id),
        seq INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        doc_json TEXT NOT NULL,
        graph_json TEXT NOT NULL,
        rubric_json TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, seq)
      );

      CREATE TABLE hld_reviews (
        id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL REFERENCES hld_submissions(id),
        job_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        is_mock INTEGER NOT NULL,
        total_score INTEGER NOT NULL,
        review_json TEXT NOT NULL,
        raw_output_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX hld_reviews_submission ON hld_reviews(submission_id, created_at);
    `,
  },
  {
    version: 3,
    name: 'interactive review: follow-up threads, resolved marks, fix suggestions, mock interviews',
    sql: `
      CREATE TABLE review_threads (
        id TEXT PRIMARY KEY,
        track TEXT NOT NULL CHECK (track IN ('lld','hld')),
        review_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (review_id, item_key)
      );
      CREATE TABLE review_thread_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES review_threads(id),
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        text TEXT NOT NULL,
        code_snippet TEXT,
        job_id TEXT,
        provider TEXT,
        model TEXT,
        is_mock INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX review_thread_messages_thread ON review_thread_messages(thread_id, created_at);
      CREATE TABLE review_marks (
        review_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        track TEXT NOT NULL CHECK (track IN ('lld','hld')),
        submission_id TEXT NOT NULL,
        resolved INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (review_id, item_key)
      );
      CREATE TABLE fix_suggestions (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        suggestion_json TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        is_mock INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX fix_suggestions_review ON fix_suggestions(review_id, finding_id, created_at);
      CREATE TABLE interview_sessions (
        id TEXT PRIMARY KEY,
        track TEXT NOT NULL CHECK (track IN ('lld','hld')),
        review_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active','ended')),
        questions_json TEXT NOT NULL,
        remaining_json TEXT NOT NULL,
        current_question TEXT,
        last_kind TEXT,
        max_turns INTEGER NOT NULL,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX interview_sessions_review ON interview_sessions(review_id, created_at);
      CREATE TABLE interview_turns (
        id TEXT PRIMARY KEY,
        interview_id TEXT NOT NULL REFERENCES interview_sessions(id),
        idx INTEGER NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        feedback TEXT NOT NULL,
        score TEXT NOT NULL,
        job_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX interview_turns_interview ON interview_turns(interview_id, idx);
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function openDatabase(dataRoot: string, file = 'studio.db'): DB {
  const db = new Database(file === ':memory:' ? ':memory:' : join(dataRoot, file));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
  const maxApplied = Math.max(0, ...applied);
  if (maxApplied > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${maxApplied} is newer than this build supports (${LATEST_SCHEMA_VERSION}). Refusing to start to avoid data loss.`,
    );
  }
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, now());
    })();
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function json<T>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
