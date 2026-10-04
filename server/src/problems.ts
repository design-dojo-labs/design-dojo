import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  RUBRIC_VERSION,
  buildRubric,
  checkProblemSemantics,
  ProblemContent,
  SeedProblem,
  type Difficulty,
  type ProblemSummary,
  type ProblemVersion,
  type Rubric,
  type Target,
  type Topic,
} from '@lld/shared';
import { type DB, json, now } from './db.js';
import { sha256 } from './fs/workspace.js';
import { HttpError } from './fs/paths.js';

interface VersionRow {
  problem_id: string;
  version: number;
  content_json: string;
  rubric_json: string;
  content_hash: string;
  generated_by_json: string | null;
  created_at: string;
  source: 'seed' | 'generated';
}

export class ProblemRepo {
  constructor(private db: DB) {}

  /**
   * Imports bundled seed problems. A changed seed file becomes a new version; existing versions
   * (and the sessions pinned to them) are never modified.
   */
  syncSeeds(dir: string): { added: number; updated: number; errors: string[] } {
    let added = 0;
    let updated = 0;
    const errors: string[] = [];
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return { added, updated, errors: [`seed directory not found: ${dir}`] };
    }
    for (const f of files) {
      let parsed;
      try {
        parsed = SeedProblem.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      } catch (e) {
        errors.push(`${f}: ${(e as Error).message}`);
        continue;
      }
      if (!parsed.success) {
        errors.push(`${f}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        continue;
      }
      const { id, ...content } = parsed.data;
      const semantic = checkProblemSemantics(content);
      if (semantic.length) {
        errors.push(`${f}: ${semantic.join('; ')}`);
        continue;
      }
      const hash = versionHash(content);
      const existing = this.db.prepare('SELECT latest_version FROM problems WHERE id = ?').get(id) as { latest_version: number } | undefined;
      if (!existing) {
        this.insert(id, 'seed', 1, content, null);
        added++;
        continue;
      }
      const latest = this.db.prepare('SELECT content_hash FROM problem_versions WHERE problem_id = ? AND version = ?').get(id, existing.latest_version) as
        | { content_hash: string }
        | undefined;
      if (latest?.content_hash !== hash) {
        this.insert(id, 'seed', existing.latest_version + 1, content, null);
        updated++;
      }
    }
    return { added, updated, errors };
  }

  private insert(id: string, source: 'seed' | 'generated', version: number, content: ProblemContent, generatedBy: ProblemVersion['generatedBy']): void {
    const rubric = buildRubric(content.rubricGuidance);
    const ts = now();
    this.db.transaction(() => {
      // Parent row first (problem_versions references problems).
      this.db
        .prepare(
          `INSERT INTO problems (id, source, latest_version, title, created_at) VALUES (?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET latest_version = excluded.latest_version, title = excluded.title`,
        )
        .run(id, source, version, content.title, ts);
      this.db
        .prepare(
          `INSERT INTO problem_versions (problem_id, version, content_json, rubric_json, content_hash, generated_by_json, created_at) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(id, version, JSON.stringify(content), JSON.stringify(rubric), versionHash(content), generatedBy ? JSON.stringify(generatedBy) : null, ts);
    })();
  }

  saveGenerated(content: ProblemContent, generatedBy: NonNullable<ProblemVersion['generatedBy']>): ProblemVersion {
    const slug = content.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'problem';
    const id = `gen-${slug}-${randomBytes(2).toString('hex')}`;
    this.insert(id, 'generated', 1, content, generatedBy);
    return this.get(id, 1);
  }

  get(id: string, version?: number): ProblemVersion {
    const row = this.db
      .prepare(
        `SELECT v.*, p.source FROM problem_versions v JOIN problems p ON p.id = v.problem_id
         WHERE v.problem_id = ? AND v.version = COALESCE(?, p.latest_version)`,
      )
      .get(id, version ?? null) as VersionRow | undefined;
    if (!row) throw new HttpError(404, `problem ${id}${version ? ` v${version}` : ''} not found`);
    return toVersion(row);
  }

  list(filter: { difficulty?: Difficulty; target?: Target; topic?: Topic } = {}): ProblemSummary[] {
    const rows = this.db
      .prepare(
        `SELECT v.*, p.source,
           (SELECT COUNT(*) FROM sessions s WHERE s.problem_id = p.id) AS attempts,
           (SELECT MAX(r.total_score) FROM reviews r JOIN submissions sb ON sb.id = r.submission_id
              WHERE sb.problem_id = p.id AND r.is_mock = 0) AS best
         FROM problems p JOIN problem_versions v ON v.problem_id = p.id AND v.version = p.latest_version
         WHERE p.archived = 0 ORDER BY p.source DESC, p.title`,
      )
      .all() as (VersionRow & { attempts: number; best: number | null })[];
    return rows
      .map((r) => {
        const c = json<ProblemContent>(r.content_json, {} as ProblemContent);
        return {
          id: r.problem_id,
          version: r.version,
          title: c.title,
          summary: c.summary,
          difficulty: c.difficulty,
          targets: c.targets,
          topics: c.topics,
          estimatedMinutes: c.estimatedMinutes,
          source: r.source,
          createdAt: r.created_at,
          attempts: r.attempts,
          bestScore: r.best,
        } satisfies ProblemSummary;
      })
      .filter(
        (p) =>
          (!filter.difficulty || p.difficulty === filter.difficulty) &&
          (!filter.target || p.targets.includes(filter.target)) &&
          (!filter.topic || p.topics.includes(filter.topic)),
      );
  }

  /** Picks a random matching problem, preferring ones not attempted yet. */
  random(filter: { difficulty?: Difficulty; target?: Target; topic?: Topic; excludeIds?: string[] }): ProblemSummary {
    const all = this.list(filter).filter((p) => !filter.excludeIds?.includes(p.id));
    if (!all.length) throw new HttpError(404, 'No problems match these filters. Try widening them or generate a new problem.');
    const fresh = all.filter((p) => p.attempts === 0);
    const pool = fresh.length ? fresh : all;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  recentTitles(limit = 30): string[] {
    return (this.db.prepare('SELECT title FROM problems ORDER BY created_at DESC LIMIT ?').all(limit) as { title: string }[]).map((r) => r.title);
  }

  allTitles(): string[] {
    return (this.db.prepare('SELECT title FROM problems').all() as { title: string }[]).map((r) => r.title);
  }
}

/** Identity of a problem version: its content plus the rubric version it is scored with. */
function versionHash(content: ProblemContent): string {
  return sha256(`${RUBRIC_VERSION}\n${JSON.stringify(content)}`);
}

function toVersion(row: VersionRow): ProblemVersion {
  return {
    id: row.problem_id,
    version: row.version,
    source: row.source,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    content: json<ProblemContent>(row.content_json, {} as ProblemContent),
    rubric: json<Rubric>(row.rubric_json, {} as Rubric),
    generatedBy: json(row.generated_by_json, null),
  };
}
